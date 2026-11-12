#!/bin/sh
#
# 把一个目录里的 .ipk 做成 opkg 仓库索引（OpenWrt 24.x）：
#
#   Packages       纯文本索引
#   Packages.gz    gzip 过的同一份
#   Packages.sig   给了 usign 私钥才有（opkg 用它校验索引）
#
# 用法：sh scripts/ipk-repo.sh <目录> [usign 私钥]
#
# .ipk 是 gzip tar（debian-binary + control.tar.gz + data.tar.gz）。control 里的
# 字段原样抄进索引，再补 Filename / Size / SHA256sum —— opkg 靠这三个找包。
#
set -eu

dir=${1:?用法: ipk-repo.sh <目录> [usign 私钥]}
key=${2:-}
usign=${USIGN:-usign}

[ -d "$dir" ] || { echo "ipk-repo: $dir 不是目录" >&2; exit 1; }

cd "$dir"
rm -f Packages Packages.gz Packages.sig

count=0
skipped=0
for ipk in *.ipk; do
	[ -f "$ipk" ] || continue

	tmp=$(mktemp -d)
	control=

	# 1) 从 .ipk 里取出 control.tar.gz
	if tar -xzf "$ipk" -C "$tmp" ./control.tar.gz 2>/dev/null ||
		tar -xzf "$ipk" -C "$tmp" control.tar.gz 2>/dev/null; then
		# 2) 再取出 control
		if tar -xzf "$tmp/control.tar.gz" -C "$tmp" ./control 2>/dev/null ||
			tar -xzf "$tmp/control.tar.gz" -C "$tmp" control 2>/dev/null; then
			[ -s "$tmp/control" ] && control="$tmp/control"
		fi
	fi

	if [ -z "$control" ]; then
		echo "ipk-repo: 跳过 $ipk（control 读不出来）" >&2
		skipped=$((skipped + 1))
		rm -rf "$tmp"
		continue
	fi

	{
		# control 不一定以换行结尾
		sed -e '$a\' "$control"
		printf 'Filename: %s\n' "$ipk"
		printf 'Size: %s\n' "$(wc -c < "$ipk" | tr -d ' ')"
		printf 'SHA256sum: %s\n\n' "$(sha256sum "$ipk" | cut -d' ' -f1)"
	} >> Packages

	count=$((count + 1))
	rm -rf "$tmp"
done

[ "$count" -gt 0 ] || { echo "ipk-repo: $dir 里没有可用的 .ipk" >&2; exit 1; }

gzip -9 -n -c Packages > Packages.gz

signed=no
if [ -n "$key" ] && [ -f "$key" ]; then
	if ! "$usign" -S -m Packages -s "$key" -x Packages.sig; then
		echo "ipk-repo: 签名索引失败" >&2
		exit 1
	fi
	signed=yes
fi

printf 'ipk-repo: %s 共 %s 个包（跳过 %s），索引 %s 字节，签名=%s\n' \
	"$dir" "$count" "$skipped" "$(wc -c < Packages | tr -d ' ')" "$signed"
