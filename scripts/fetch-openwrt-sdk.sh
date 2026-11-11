#!/bin/sh
#
# 下载并解压某个 OpenWrt 版本的 SDK。
#
# 先到 releases/<版本>/targets/<target>/<subtarget>/ 的目录列表里找出这个
# target 的 SDK 文件名（gcc 版本会随版本变化，所以不写死），再依次尝试官方源和
# 镜像下载，并用同目录的 sha256sums 校验。校验不通过就换下一个源，避免把坏包
# 带到编译阶段。
#
# 环境变量：
#   OPENWRT_VERSION    必填，例如 25.12.6
#   OPENWRT_TARGET     必填，例如 x86
#   OPENWRT_SUBTARGET  必填，例如 64
#   RUNNER_TEMP        解压目录（Gitea / GitHub 都会设置），默认用 mktemp
#   GITHUB_ENV         设置时把 SDK_DIR 交给后续步骤
set -eu

version="${OPENWRT_VERSION:?OPENWRT_VERSION is not set}"
target="${OPENWRT_TARGET:?OPENWRT_TARGET is not set}"
subtarget="${OPENWRT_SUBTARGET:?OPENWRT_SUBTARGET is not set}"
work_dir="${RUNNER_TEMP:-$(mktemp -d)}"
sdk_root="${work_dir}/sdk"
download_dir="${work_dir}/sdk-dl"
rel_dir="targets/${target}/${subtarget}"

# 官方源优先，其余镜像的路径结构与 releases/ 相同
hosts="
https://downloads.openwrt.org/releases/${version}
https://ftp.nluug.nl/os/Linux/distr/openwrt/releases/${version}
https://openwrt.pixeldeck.net/releases/${version}
https://archive.openwrt.org/releases/${version}
"

echo "OpenWrt ${version}: ${target}/${subtarget}"

# 找到这个 target 的 SDK 文件名；gcc 版本和构建机后缀都在名字里，不写死
sdk_name=""
for host in ${hosts}; do
	name="$(curl -fsSL --http1.1 --retry 2 --retry-delay 3 --connect-timeout 20 --max-time 60 \
		"${host}/${rel_dir}/" 2>/dev/null \
		| grep -o "openwrt-sdk-${version}-${target}-${subtarget}_[^\"]*\.tar\.zst" \
		| head -n1 || true)"
	if [ -z "${name}" ]; then
		echo "  ${host}: 没有 ${version} 的 SDK，跳过"
		continue
	fi
	sdk_name="${name}"
	echo "  ${host}: ${sdk_name}"
	break
done

if [ -z "${sdk_name}" ]; then
	echo "::error::没有找到 OpenWrt ${version} ${target}/${subtarget} 的 SDK"
	exit 1
fi

# 发布方在同一目录给出的校验值；目录没有 sha256sums 时返回空
expected_sha256() {
	curl -fsSL --http1.1 --retry 2 --retry-delay 3 --connect-timeout 20 --max-time 60 \
		"$1/${rel_dir}/sha256sums" 2>/dev/null \
		| awk -v name="${sdk_name}" '($2 == name || $2 == "*" name) { print $1; exit }'
}

mkdir -p "${download_dir}" "${sdk_root}"
downloaded=""
for host in ${hosts}; do
	echo "下载 ${host}/${rel_dir}/${sdk_name}"
	rm -f "${download_dir}/${sdk_name}"
	if ! curl -fL --http1.1 --retry 5 --retry-delay 5 --retry-connrefused \
		--connect-timeout 20 --speed-limit 1024 --speed-time 60 \
		-o "${download_dir}/${sdk_name}" "${host}/${rel_dir}/${sdk_name}"; then
		echo "::warning::从 ${host} 下载失败，换下一个源"
		continue
	fi
	expected="$(expected_sha256 "${host}")"
	if [ -z "${expected}" ]; then
		echo "::warning::${host} 的 sha256sums 里没有 ${sdk_name}，无法校验"
	else
		actual="$(sha256sum "${download_dir}/${sdk_name}" | cut -d' ' -f1)"
		if [ "${actual}" != "${expected}" ]; then
			echo "::warning::${host} 的包 sha256 不匹配（${actual}），换下一个源"
			continue
		fi
		echo "sha256 校验通过（${host}）"
	fi
	downloaded="${host}"
	break
done

if [ -z "${downloaded}" ]; then
	echo "::error::${sdk_name} 在所有源上都下载失败"
	exit 1
fi

case "${sdk_name}" in
	*.tar.zst) tar_opts=--zstd ;;
	*.tar.xz)  tar_opts=-J ;;
	*)         tar_opts= ;;
esac
# shellcheck disable=SC2086 # tar_opts 是有意留成“一个参数或空”的
tar ${tar_opts} -C "${sdk_root}" -xf "${download_dir}/${sdk_name}"
rm -rf "${download_dir}"

sdk_dir="$(find "${sdk_root}" -mindepth 1 -maxdepth 1 -type d -name 'openwrt-sdk-*' | head -n1)"
if [ -z "${sdk_dir}" ]; then
	echo "::error::解压后没有 openwrt-sdk-* 目录"
	exit 1
fi
echo "SDK: ${sdk_dir}"

if [ -n "${GITHUB_ENV:-}" ]; then
	echo "SDK_DIR=${sdk_dir}" >> "${GITHUB_ENV}"
fi
