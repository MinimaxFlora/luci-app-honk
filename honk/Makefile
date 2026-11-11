#
# OpenWrt package: honk (https://github.com/daeuniverse/honk)
#
# The sources come from ./src when it is there (the CI workflow and local
# development check it out at that path), otherwise the package downloads the
# upstream tag from https://github.com/daeuniverse/honk.git, so the feed can be
# dropped into an OpenWrt tree and built with a plain make:
#
#   git clone https://github.com/daeuniverse/honk src   # optional, offline use
#
# Apart from the embedded dashboard (downloaded as a release archive, never
# compiled here), nothing is fetched while building. build.sh downloads the
# doona UI pinned in .github/ci/pins.env, builds the eBPF object with the
# nightly toolchain pinned in crates/honk-ebpf/rust-toolchain.toml, compiles
# honk-core with the crate's own pinned stable toolchain, and uses the OpenWrt
# cross gcc/g++ of the SDK (TARGET_CROSS) for BoringSSL, SQLite and the final
# link. HONK_VERSION is the package version (0.1.0_beta6, apk spells the beta
# pre-release with "_beta") and HONK_GIT_TAG the upstream tag the sources come
# from (v0.1.0-beta.6), which is the version honk's build script embeds.
#
# The binary is built with the full feature set: the crate defaults
# (clash-api, jemalloc, rprx) plus ebpf and native-ui. native-ui embeds the
# pinned doona dashboard at build time and implies native-api.
#
# The package also installs an OpenWrt procd init script (files/honk.init), its
# UCI configuration (files/honk.config) and a minimal /etc/honk/config.dae with
# the embedded UI enabled on loopback. The service is disabled by default;
# run /etc/init.d/honk enable and start it after adding nodes and routing
# rules. files/honk.uci-defaults moves the boot setting of earlier versions
# (UCI option enabled) to that rc.d link.
#
# This file is free software, licensed under the GNU General Public License v3
# or later.

# $(CURDIR) points at the buildroot root, and $(MAKEFILE_LIST) grows with every
# included file, so the package directory has to be resolved before the first
# include. abspath keeps it valid when a recipe runs from another directory.
PKG_DIR:=$(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))

include $(TOPDIR)/rules.mk

PKG_NAME:=honk
PKG_VERSION:=$(if $(HONK_VERSION),$(HONK_VERSION),0.1.0_beta6)
PKG_RELEASE:=1

# Upstream release the sources are checked out from. honk's build script derives
# the version it embeds from the tag in GITHUB_REF, so build.sh exports it.
HONK_GIT_TAG:=$(if $(HONK_GIT_TAG),$(HONK_GIT_TAG),v0.1.0-beta.6)

PKG_LICENSE:=GPL-3.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)

# 本地 ./src（CI 会 clone 进来，本地开发也一样）优先；没有就按上游 tag 自己下载，
# 这样把 feed 丢进 OpenWrt 源码树里直接 make 也能编。
HONK_LOCAL_SRC:=$(firstword $(wildcard $(PKG_DIR)/src/Cargo.toml))

ifneq ($(HONK_LOCAL_SRC),)
  HONK_SRC:=$(PKG_DIR)/src
else
  PKG_SOURCE_PROTO:=git
  PKG_SOURCE_URL:=https://github.com/daeuniverse/honk.git
  PKG_SOURCE_VERSION:=$(HONK_GIT_TAG)
  PKG_SOURCE:=$(PKG_NAME)-$(HONK_GIT_TAG).tar.gz
  PKG_MIRROR_HASH:=skip
  HONK_SRC:=$(PKG_BUILD_DIR)
endif

include $(INCLUDE_DIR)/package.mk


define Package/honk
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=eBPF transparent proxy engine (honk-core) with embedded UI
  URL:=https://github.com/daeuniverse/honk
  LICENSE:=GPL-3.0-only
  # honk-core is linked against the musl and the C++ runtime of OpenWrt. Its
  # eBPF datapath needs TC-bpf and a veth pair plus the daens namespace, and
  # its NFQUEUE staging uses nftables queue expressions over nfnetlink_queue.
  # Its BTF comes from vmlinux-btf, as for dae. The geo packages ship the dat
  # files; this package links them into /usr/share/honk, which honk searches
  # before the dae locations.
  DEPENDS:=+libstdcpp +kmod-veth +kmod-sched-core +kmod-sched-bpf \
           +kmod-nft-core +kmod-nft-queue +kmod-nfnetlink-queue \
           +kmod-nf-conntrack +vmlinux-btf +v2ray-geoip +v2ray-geosite
endef

define Package/honk/description
 honk is an eBPF transparent proxy engine. honk-core embeds its eBPF object and
 needs kernel BTF for CO-RE relocations, which vmlinux-btf provides. This
 build enables the Clash API, the native API and the embedded doona dashboard
 (native-ui), which is served at /ui on the native API listener.
endef

# 有本地源码才需要这一步拷贝；交给 PKG_SOURCE 时 package.mk 的默认 prepare 负责解包
ifneq ($(HONK_LOCAL_SRC),)
define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) $(HONK_SRC)/. $(PKG_BUILD_DIR)/
endef
endif

define Build/Compile
	HONK_SRC="$(PKG_BUILD_DIR)" \
	HONK_VERSION="$(PKG_VERSION)" \
	HONK_GIT_TAG="$(HONK_GIT_TAG)" \
	HONK_ARCH_PACKAGES="$(ARCH_PACKAGES)" \
	OPENWRT_CC="$(TARGET_CROSS)gcc" \
	OPENWRT_CXX="$(TARGET_CROSS)g++" \
	sh "$(PKG_DIR)/build.sh"
endef

define Package/honk/conffiles
/etc/config/honk
/etc/honk/config.dae
endef

# apk replaces a conffile the user never edited with the packaged one, which
# has no option enabled, so the boot setting of earlier versions is saved here
# for files/honk.uci-defaults. The apk pre-install and pre-upgrade scripts are
# made from this (pre-upgrade without the shebang line, after PKG_UPGRADE=1).
define Package/honk/preinst
#!/bin/sh
[ -z "$${IPKG_INSTROOT}" ] || exit 0
enabled="$$(uci -q get honk.config.enabled)"
[ -z "$$enabled" ] || echo "$$enabled" > /tmp/honk-autostart
exit 0
endef

# With apk this runs after default_postinst, in post-install and, sourced, in
# post-upgrade. The restart picks up a new binary of an enabled service; the
# init script's package guard keeps it from starting a disabled one.
define Package/honk/postinst
#!/bin/sh
[ -z "$${IPKG_INSTROOT}" ] || exit 0
/etc/init.d/honk enabled && /etc/init.d/honk restart
exit 0
endef

define Package/honk/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/honk-core $(1)/usr/bin/honk-core
	$(INSTALL_DIR) $(1)/usr/share/licenses/honk
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/LICENSE $(1)/usr/share/licenses/honk/LICENSE
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) $(PKG_DIR)/files/honk.init $(1)/etc/init.d/honk
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) $(PKG_DIR)/files/honk.config $(1)/etc/config/honk
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) $(PKG_DIR)/files/honk.uci-defaults $(1)/etc/uci-defaults/90-honk-autostart
	$(INSTALL_DIR) $(1)/etc/honk
	$(INSTALL_CONF) $(PKG_DIR)/files/config.dae $(1)/etc/honk/config.dae
	$(INSTALL_DIR) $(1)/lib/upgrade/keep.d
	printf '%s\n' '/etc/honk/data/' > $(1)/lib/upgrade/keep.d/honk
	# v2ray-geoip/geosite install the files under /usr/share/v2ray. honk's
	# find_dat looks in /usr/share/honk before /usr/share/dae.
	$(INSTALL_DIR) $(1)/usr/share/honk
	$(LN) ../v2ray/geoip.dat $(1)/usr/share/honk/geoip.dat
	$(LN) ../v2ray/geosite.dat $(1)/usr/share/honk/geosite.dat
endef

$(eval $(call BuildPackage,honk))
