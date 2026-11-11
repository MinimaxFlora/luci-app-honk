#!/bin/sh
#
# 把一个目录里的 .apk 做成 apk 仓库索引（OpenWrt 25.x / apk-tools 3）：
#
#   packages.adb    客户端读的索引；给了 EC 私钥就用它签名（客户端用公钥验证）
#   index.json      给人看的包名 → 版本清单
#
# 用法：
#   APK=<apk 二进制> sh scripts/apk-repo.sh <目录> [EC 私钥]
#
# 不给私钥就生成未签名索引，客户端只能 apk add --allow-untrusted。
#
set -eu

dir=${1:?用法: apk-repo.sh <目录> [EC 私钥]}
key=${2:-}
apk=${APK:-apk}

[ -d "$dir" ] || { echo "apk-repo: $dir 不是目录" >&2; exit 1; }

cd "$dir"
set -- ./*.apk
if [ ! -f "$1" ]; then
	echo "apk-repo: $dir 里没有 .apk，跳过"
	exit 0
fi

rm -f packages.adb index.json

# apk 读包头，不看文件名；--pkgname-spec 只是让索引里的文件名和实际文件对得上
if [ -n "$key" ] && [ -f "$key" ]; then
	"$apk" --sign-key "$key" mkndx --allow-untrusted \
		--pkgname-spec '${name}-${version}.apk' -o packages.adb "$@" 2>&1 |
		grep -vE '^WARNING' || true
	signed=yes
else
	"$apk" mkndx --allow-untrusted \
		--pkgname-spec '${name}-${version}.apk' -o packages.adb "$@" 2>&1 |
		grep -vE '^WARNING' || true
	signed=no
fi

[ -s packages.adb ] || { echo "apk-repo: 索引没有生成" >&2; exit 1; }

# index.json：从 adbdump 里抓 name/version
"$apk" adbdump packages.adb 2>/dev/null | python3 -c '
import json, sys
pkgs, name = {}, None
for line in sys.stdin:
    s = line.strip()
    if s.startswith("- name:"):
        name = s.split(":", 1)[1].strip()
    elif s.startswith("version:") and name:
        pkgs[name] = s.split(":", 1)[1].strip()
        name = None
print(json.dumps({"version": 2, "packages": pkgs}, indent=2, ensure_ascii=False, sort_keys=True))
' > index.json

echo "apk-repo: $dir 共 $(ls -1 ./*.apk | wc -l) 个包，索引 $(stat -c%s packages.adb) 字节，签名=${signed}"
