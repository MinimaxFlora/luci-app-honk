#!/bin/sh
#
# 给 SDK 产出的 .apk 签名并校验。
#
# OpenWrt 25.12 的 SDK 用 apk-tools 3.0.x，它的 mkpkg 不能签名，所以包出来是
# 未签名的；apk adbsign 可以就地补上签名。私钥来自仓库 secret
# APK_PRIVATE_KEY（PEM 格式的 EC 私钥），公钥由它推导后写进 keys/，只在本机
# 校验用。
#
# 没有设置 APK_PRIVATE_KEY 时直接跳过：包照样能用，但设备上安装需要
#   apk add --allow-untrusted <包>
#
# 环境变量：
#   SDK_DIR          SDK 目录（下载步骤写入）
#   APK_PRIVATE_KEY  secret，可空
set -eu

repo_dir="${GITHUB_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
sdk_dir="${SDK_DIR:?SDK_DIR is not set}"
keys_dir="${repo_dir}/keys"
private_key="${keys_dir}/private-key.pem"
public_key="${keys_dir}/public-key.pem"
apk="${sdk_dir}/staging_dir/host/bin/apk"

if [ "$#" -gt 0 ]; then
	package_dir="$1"
elif [ -d "${sdk_dir}/bin/packages" ]; then
	package_dir="${sdk_dir}/bin/packages"
else
	echo "::error::找不到 .apk 输出目录"
	exit 1
fi

packages="$(find "${package_dir}" -type f -name '*.apk' 2>/dev/null | sort)"
if [ -z "${packages}" ]; then
	echo "::error::没有可签名的 .apk"
	exit 1
fi

if [ -z "${APK_PRIVATE_KEY:-}" ]; then
	echo "APK_PRIVATE_KEY 未设置，跳过签名（安装时用 apk add --allow-untrusted）"
	exit 0
fi

if [ ! -x "${apk}" ]; then
	echo "::error::${apk} 不存在，无法签名"
	exit 1
fi

mkdir -p "${keys_dir}"
(umask 077; printf '%s\n' "${APK_PRIVATE_KEY}" > "${private_key}")
if ! openssl ec -in "${private_key}" -pubout -out "${public_key}" 2>/dev/null; then
	echo "::error::APK_PRIVATE_KEY 不是有效的 EC 私钥"
	rm -f "${private_key}"
	exit 1
fi

printf '%s\n' "${packages}" | while IFS= read -r package; do
	echo "签名 ${package##*/}"
	"${apk}" --allow-untrusted adbsign \
		--sign-key "${private_key}" --reset-signatures "${package}"
done

printf '%s\n' "${packages}" | while IFS= read -r package; do
	"${apk}" --keys-dir "${keys_dir}" verify -v "${package}" > /dev/null
	echo "校验通过 ${package##*/}"
done
