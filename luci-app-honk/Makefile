#
# OpenWrt package: luci-app-honk
#
# LuCI page for honk: the Start at boot switch, an editor with syntax
# highlighting for /etc/honk/config.dae and every file it includes, the service
# log and the package updates. The shared page that upstream keeps in
# luci-lib-daeuniverse lives here, in htdocs/luci-static/resources/honk/service.js
# and po/, so this feed needs no separate library package. Needs the luci feed
# in the SDK, as luci.mk comes from there.
#
# This file is free software, licensed under the GNU General Public License v3
# or later.

include $(TOPDIR)/rules.mk

PKG_LICENSE:=GPL-3.0-or-later

LUCI_TITLE:=LuCI support for honk
LUCI_DEPENDS:=+luci-base +honk +jshn +flock
LUCI_PKGARCH:=all

# luci.mk 默认用 git 提交时间算版本，编译目录没有 .git 时退回文件 mtime——那样每个
# CI job 算出来的版本号都不一样。CI 传 LUCI_APP_VERSION（= honk 版本）把版本钉住；
# 本地不传就沿用 luci.mk 自己算的。
ifneq ($(LUCI_APP_VERSION),)
  PKG_VERSION:=$(LUCI_APP_VERSION)
  PKG_PO_VERSION:=$(LUCI_APP_VERSION)
endif

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
