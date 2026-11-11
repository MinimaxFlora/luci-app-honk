#!/bin/sh
#
# 检查一个文件是不是合法的 detached BTF。
#
#   sh check-btf.sh <文件>
#
# BTF 头（小端）：magic(u16)=0xeb9f version(u8) flags(u8) hdr_len(u32)
#                 type_off(u32) type_len(u32) str_off(u32) str_len(u32)
#
# 这段逻辑单独成脚本，不写在 Makefile 的 recipe 里：OpenWrt 的 Build/Compile
# 会被二次展开，recipe 里的 $$(...) 会先变 $(...) 再被当成 Make 变量吃掉，导致
# 校验条件永远成立（踩过）。
#

set -u

f="${1:-}"
if [ -z "$f" ]; then
	echo "用法: $0 <btf 文件>" >&2
	exit 2
fi

if [ ! -f "$f" ]; then
	echo "找不到 $f" >&2
	exit 1
fi

size=$(wc -c < "$f" | tr -d ' ')
if [ "$size" -lt 24 ]; then
	echo "$f 只有 $size 字节，不可能是 BTF" >&2
	exit 1
fi

magic=$(od -An -tx1 -N2 "$f" | tr -d ' \n')
if [ "$magic" != "9feb" ]; then
	echo "$f 不是 BTF（开头是 '$magic'，应为 '9feb'）" >&2
	exit 1
fi

# hdr_len 在偏移 4，4 字节小端
hdr_len=$(od -An -tu4 -j4 -N4 "$f" | tr -d ' ')
if [ -z "$hdr_len" ] || [ "$hdr_len" -lt 24 ] || [ "$hdr_len" -ge "$size" ]; then
	echo "$f 的 BTF 头长度不对（hdr_len=$hdr_len，文件 $size 字节）" >&2
	exit 1
fi

echo "$f: $size 字节，BTF 头 $hdr_len 字节"
