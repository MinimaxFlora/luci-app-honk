#!/bin/sh
#
# 用 SDK 里已经准备好的内核头文件生成 detached BTF（就是 vmlinux-btf 要装的那个
# 文件），做法与 QiuSimons/vmlinux-btf 的 Makefile 一致：
#   vmlinux-btf/src/shadow_btf_*.c 用 SDK 的交叉 gcc 按目标内核的 autoconf.h 编译成 DWARF，
#   再用 pahole 编码成 BTF。
#
# 不做内核 configure / 编译：SDK 自带 build_dir 下的内核树（头文件、generated
# include、autoconf.h、Module.symvers），BTF 只需要它们。
#
# 环境变量（前三个必填）：
#   SDK_DIR        解压后的 SDK
#   KERNEL_ARCH    x86_64 或 arm64
#   OPENWRT_ARCH   例如 aarch64_cortex-a53，用来选 -mcpu
#   RUNNER_TEMP    输出目录，结果在 ${RUNNER_TEMP}/btf/vmlinux
#
# 输出：
#   ${RUNNER_TEMP}/btf/vmlinux      BTF 数据
#   ${RUNNER_TEMP}/btf/vars         KERNEL_VERSION=... / KERNEL_RELEASE=...
#   GITHUB_ENV 里也会写入同样两个变量
set -eu

sdk_dir="${SDK_DIR:?SDK_DIR is not set}"
kernel_arch="${KERNEL_ARCH:?KERNEL_ARCH is not set}"
openwrt_arch="${OPENWRT_ARCH:?OPENWRT_ARCH is not set}"
out="${RUNNER_TEMP:-$(mktemp -d)}/btf"
repo_dir="${GITHUB_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"

# 1. SDK 准备的内核树：找带 include/generated/autoconf.h 的那一份
kdir=""
for candidate in $(find "${sdk_dir}/build_dir" -maxdepth 4 -type d -path '*linux-*/linux-*' | sort); do
	if [ -f "${candidate}/include/generated/autoconf.h" ]; then
		kdir="${candidate}"
		break
	fi
done
if [ -z "${kdir}" ]; then
	echo "::error::SDK 里没有准备好的内核树（build_dir/*/linux-*/linux-*/include/generated/autoconf.h）"
	exit 1
fi

kernel_version="${kdir##*/linux-}"
kernel_release="$(sed -n 's/^#define UTS_RELEASE "\(.*\)"$/\1/p' \
	"${kdir}/include/generated/utsrelease.h" 2>/dev/null | head -n1)"
if [ -z "${kernel_release}" ]; then
	kernel_release="${kernel_version}"
	echo "::warning::内核树里没有 UTS_RELEASE，vmlinux-<release> 用 ${kernel_release}"
fi
echo "内核树: ${kdir}"
echo "内核版本: ${kernel_version}，uname -r: ${kernel_release}"

# 2. 交叉工具链与 sysroot
cross_gcc="$(find "${sdk_dir}"/staging_dir/toolchain-*/bin -maxdepth 1 \
	-name '*-openwrt-linux-musl-gcc' | head -n1)"
if [ -z "${cross_gcc}" ]; then
	echo "::error::SDK 里没有交叉工具链"
	exit 1
fi
toolchain_bin="$(dirname "${cross_gcc}")"
cross="${toolchain_bin}/$(basename "${cross_gcc}" | sed 's/gcc$//')"
staging="$(find "${sdk_dir}/staging_dir" -mindepth 1 -maxdepth 1 -type d -name 'target-*' | head -n1)"
if [ -z "${staging}" ]; then
	echo "::error::SDK 里没有 staging_dir/target-*"
	exit 1
fi
export STAGING_DIR="${staging}"
export STAGING_DIR_HOST="${sdk_dir}/staging_dir/host"
export PATH="${toolchain_bin}:${PATH}"
echo "工具链: ${cross}"
echo "STAGING_DIR: ${STAGING_DIR}"

# 3. 编译 shadow_btf_*.c
case "${kernel_arch}" in
	x86_64) karch=x86 ;;
	arm64)  karch=arm64 ;;
	*)
		echo "::error::不支持的内核架构 ${kernel_arch}"
		exit 1
		;;
esac

arch_flags=""
case "${openwrt_arch}" in
	aarch64_cortex-a53) arch_flags="-mcpu=cortex-a53" ;;
	aarch64_cortex-a72) arch_flags="-mcpu=cortex-a72" ;;
	aarch64_cortex-a76) arch_flags="-mcpu=cortex-a76" ;;
esac

cc="${cross}gcc"

# QiuSimons/vmlinux-btf 的 BTF_CFLAGS，只是把 $(LINUX_DIR) 换成 SDK 的 kdir
flags="-nostdinc -isystem $("${cc}" -print-file-name=include) -D__KERNEL__"
flags="${flags} -include ${kdir}/include/linux/kconfig.h"
for extra in "${kdir}/include/linux/compiler-version.h" "${kdir}/include/linux/compiler_types.h"; do
	if [ -f "${extra}" ]; then
		flags="${flags} -include ${extra}"
	fi
done
flags="${flags} -I${kdir}/arch/${karch}/include -I${kdir}/arch/${karch}/include/generated"
flags="${flags} -I${kdir}/include -I${kdir}/include/generated"
flags="${flags} -I${kdir}/arch/${karch}/include/uapi -I${kdir}/arch/${karch}/include/generated/uapi"
flags="${flags} -I${kdir}/include/uapi -I${kdir}/include/generated/uapi -I${kdir}"
flags="${flags} ${arch_flags}"
flags="${flags} -std=gnu11 -funsigned-char -fshort-wchar -fno-common -fno-PIE"
flags="${flags} -O2 -g -gdwarf-4 -fno-eliminate-unused-debug-types"
flags="${flags} -Wno-error -Wno-unused-function -Wno-unused-variable"

rm -rf "${out}"
mkdir -p "${out}"

echo "编译 vmlinux-btf/src/shadow_btf_core.c"
# shellcheck disable=SC2086 # flags 是有意拼成一个参数串的
"${cc}" ${flags} -c "${repo_dir}/vmlinux-btf/src/shadow_btf_core.c" -o "${out}/shadow_btf_core.o"

# 这两个单元能否编译取决于目标的 .config，上游同样容忍失败
for unit in modules private; do
	if ! "${cc}" ${flags} -c "${repo_dir}/vmlinux-btf/src/shadow_btf_${unit}.c" \
		-o "${out}/shadow_btf_${unit}.o" 2> "${out}/shadow_btf_${unit}.err"; then
		echo "::warning::vmlinux-btf/src/shadow_btf_${unit}.c 在这个 target 上编译不过，跳过（上游也容忍）"
		sed -n '1,20p' "${out}/shadow_btf_${unit}.err" || true
		rm -f "${out}/shadow_btf_${unit}.o"
	fi
done

# shellcheck disable=SC2086
"${cross}ld" -r -o "${out}/shadow_btf.o" "${out}"/shadow_btf_*.o
if ! "${cross}readelf" -S "${out}/shadow_btf.o" | grep -q '\.debug_info'; then
	echo "::error::桩对象里没有 .debug_info，pahole 没有东西可转"
	exit 1
fi

# 4. 编码成 detached BTF
if pahole --help 2>&1 | grep -q -- '--btf_encode_detached'; then
	pahole --btf_encode_detached="${out}/vmlinux" "${out}/shadow_btf.o"
else
	echo "这个 pahole 不能直接写 detached BTF，改用 -J + objcopy"
	pahole -J "${out}/shadow_btf.o"
	"${cross}objcopy" --dump-section .BTF="${out}/vmlinux" "${out}/shadow_btf.o"
fi

if [ ! -s "${out}/vmlinux" ]; then
	echo "::error::pahole 没有产出 BTF"
	exit 1
fi

# 5. 校验 BTF 头：magic 0xeb9f、类型区非空
python3 - "${out}/vmlinux" <<'PY'
import struct
import sys

data = open(sys.argv[1], "rb").read()
if len(data) < 24:
    sys.exit("BTF 太短（%d 字节）" % len(data))
magic, version, flags, hdr_len, type_off, type_len, str_off, str_len = struct.unpack(
    "<HBBIIIII", data[:24]
)
if magic != 0xEB9F:
    sys.exit("不是 BTF：magic %#x" % magic)
if type_len == 0:
    sys.exit("BTF 里没有类型")
print("BTF ok: version=%d type_len=%d string_len=%d size=%d" % (version, type_len, str_len, len(data)))
PY

# 上游的最终检查是 `pahole -C sk_buff <桩对象>`，但它的前提是对象里有 .BTF 段：
# --btf_encode_detached 只写出独立文件，不往对象里加段，新版 pahole 就会报
# "failed to find '.BTF' ELF section"。所以这里直接看 BTF 字符串表：类型都按
# 名字索引，核心结构体在就说明 DWARF 类型确实转过来了。
python3 - "${out}/vmlinux" <<'PY'
import struct
import sys

data = open(sys.argv[1], "rb").read()
magic, version, flags, hdr_len, type_off, type_len, str_off, str_len = struct.unpack(
    "<HBBIIIII", data[:24]
)

# 类型条目：name_off(4) info(4) size/type(4)，逐条走一遍统计条数
types = 0
pos = hdr_len + type_off
end = pos + type_len
while pos < end:
    name_off, info, size_type = struct.unpack("<III", data[pos:pos + 12])
    kind = (info >> 24) & 0x1f
    pos += 12
    if kind == 3:      # ARRAY 多一个 12 字节的额外数据
        pos += 12
    elif kind == 4:    # STRUCT/UNION 后面跟成员
        pos += 12 * (info & 0xffff)
    elif kind == 5:    # ENUM
        pos += 8 * (info & 0xffff)
    elif kind == 14:   # FUNC_PROTO
        pos += 8 * (info & 0xffff)
    elif kind == 15:   # VAR
        pos += 4
    elif kind == 17:   # DECL_TAG
        pos += 4
    elif kind == 19:   # ENUM64
        pos += 12 * (info & 0xffff)
    types += 1

strings = data[hdr_len + str_off:hdr_len + str_off + str_len]
names = set(strings.split(b"\0"))
required = [b"sk_buff", b"task_struct", b"net_device", b"bpf_map"]
missing = [name.decode() for name in required if name not in names]
if missing:
    sys.exit("BTF 里缺少这些类型: " + ", ".join(missing))
if types < 1000:
    sys.exit("BTF 里的类型太少（%d 条），桩对象可能没编全" % types)
print("BTF 类型数 %d，sk_buff/task_struct/net_device/bpf_map 都在" % types)
PY
ls -lh "${out}/vmlinux"

# 6. 把两个版本号交给后续步骤
printf 'KERNEL_VERSION=%s\nKERNEL_RELEASE=%s\n' "${kernel_version}" "${kernel_release}" > "${out}/vars"
if [ -n "${GITHUB_ENV:-}" ]; then
	cat "${out}/vars" >> "${GITHUB_ENV}"
fi
echo "BTF 已生成: ${out}/vmlinux"
