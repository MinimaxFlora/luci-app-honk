#
# OpenWrt package: vmlinux-btf
#
# CO-RE eBPF 程序（honk）要的 detached 内核 BTF。有两种来源：
#
#   1. 整机编译（buildroot）：Build/Compile 直接用 $(LINUX_DIR) 里已经配好的内核头
#      （含该 target 的 autoconf.h）把 src/shadow_btf_*.c 编成 DWARF，再用 pahole
#      编码成 BTF。不用另下内核源码，也不用重新编内核。
#   2. 只编包（SDK / CI）：外部传 VMLINUX_BTF_SRC=<blob>，本包只负责安装。
#      CI 用 scripts/build-btf.sh 从 SDK 的 kernel tree 生成那个 blob。
#
# 安装位置就是 libbpf / bpftool 找的地方：
#   /usr/lib/debug/boot/vmlinux  +  /usr/lib/debug/boot/vmlinux-<uname -r>
# BTF 描述的是结构体布局，所以包版本就是内核版本，并用 EXTRA_DEPENDS 锁死内核。
#
# 本文件按 GPL-3.0-or-later 发布。
#

# $(CURDIR) 会随 include 变化，包目录要在第一个 include 之前取
VMLINUX_BTF_DIR:=$(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))

include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/kernel.mk

VMLINUX_BTF_SRC:=$(strip $(VMLINUX_BTF_SRC))

PKG_NAME:=vmlinux-btf
PKG_VERSION:=$(if $(VMLINUX_BTF_VERSION),$(VMLINUX_BTF_VERSION),$(LINUX_VERSION))
PKG_RELEASE:=1

# BTF 来自内核源码，跟着内核的许可证
PKG_LICENSE:=GPL-2.0-only

PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)

include $(INCLUDE_DIR)/package.mk

# 软链接的名字要和 uname -r 一致：优先用调用方给的，其次内核树里的 UTS_RELEASE
VMLINUX_BTF_KERNEL_RELEASE:=$(strip $(VMLINUX_BTF_KERNEL_RELEASE))
ifeq ($(VMLINUX_BTF_KERNEL_RELEASE),)
  VMLINUX_BTF_KERNEL_RELEASE:=$(shell sed -n 's/^#define UTS_RELEASE "\(.*\)"$$/\1/p' "$(LINUX_DIR)/include/generated/utsrelease.h" 2>/dev/null)
endif
ifeq ($(VMLINUX_BTF_KERNEL_RELEASE),)
  VMLINUX_BTF_KERNEL_RELEASE:=$(shell cat "$(LINUX_DIR)/include/config/kernel.release" 2>/dev/null)
endif
ifeq ($(VMLINUX_BTF_KERNEL_RELEASE),)
  VMLINUX_BTF_KERNEL_RELEASE:=$(PKG_VERSION)
endif

# 编桩文件用的交叉 gcc 和 pahole（宿主机的 dwarves）
BTF_CC?=$(if $(TARGET_CC_NOCACHE),$(TARGET_CC_NOCACHE),$(TARGET_CROSS)gcc)
BTF_PAHOLE?=$(firstword $(wildcard $(STAGING_DIR_HOST)/bin/pahole /usr/bin/pahole /usr/local/bin/pahole) $(shell command -v pahole 2>/dev/null) pahole)

# 上游 QiuSimons/vmlinux-btf 的 BTF_CFLAGS，$(LINUX_DIR) 就是它的内核树
BTF_CFLAGS:= \
	-nostdinc \
	-isystem $(shell $(BTF_CC) -print-file-name=include) \
	-D__KERNEL__ \
	-include $(LINUX_DIR)/include/linux/kconfig.h \
	$(if $(wildcard $(LINUX_DIR)/include/linux/compiler-version.h),-include $(LINUX_DIR)/include/linux/compiler-version.h) \
	$(if $(wildcard $(LINUX_DIR)/include/linux/compiler_types.h),-include $(LINUX_DIR)/include/linux/compiler_types.h) \
	-I$(LINUX_DIR)/arch/$(LINUX_KARCH)/include \
	-I$(LINUX_DIR)/arch/$(LINUX_KARCH)/include/generated \
	-I$(LINUX_DIR)/include \
	-I$(LINUX_DIR)/include/generated \
	-I$(LINUX_DIR)/arch/$(LINUX_KARCH)/include/uapi \
	-I$(LINUX_DIR)/arch/$(LINUX_KARCH)/include/generated/uapi \
	-I$(LINUX_DIR)/include/uapi \
	-I$(LINUX_DIR)/include/generated/uapi \
	-I$(LINUX_DIR) \
	$(filter -m% -march=% -mcpu=% -mtune=% -EB -EL,$(TARGET_CFLAGS)) \
	-std=gnu11 -funsigned-char -fshort-wchar -fno-common -fno-PIE \
	-O2 -g -gdwarf-4 -fno-eliminate-unused-debug-types \
	-Wno-error -Wno-unused-function -Wno-unused-variable

# 合法性检查单独成脚本：OpenWrt 的 recipe 会被二次展开，$$(...) 会被当成 Make 变量
VMLINUX_BTF_CHECK:=sh $(VMLINUX_BTF_DIR)/check-btf.sh

define Package/vmlinux-btf
  SECTION:=kernel
  CATEGORY:=Kernel
  TITLE:=Detached kernel BTF (vmlinux) for CO-RE eBPF programs
  URL:=https://github.com/QiuSimons/vmlinux-btf
  LICENSE:=GPL-2.0-only
  # 运行时什么都不需要
  DEPENDS:=
  # BTF 只描述这一个内核，像 kmod 一样锁住内核版本，别的点版本/target 装不上，
  # 免得 CO-RE 解析到错误的结构体布局
  EXTRA_DEPENDS:=kernel (=$(LINUX_VERSION)~$(LINUX_VERMAGIC)-r$(LINUX_RELEASE))
endef

define Package/vmlinux-btf/description
 Detached BTF blob of this kernel, built from the kernel headers and the .config
 of the build it belongs to. Install it to make CO-RE eBPF programs (honk) work
 on a kernel whose image carries no BTF.
endef

# 注意：make 的 ifneq/else 不能写在 define 里面（展开成 recipe 时会报
# "extraneous 'else'"），所以这里按来源给两套 Build/Prepare 和 Build/Compile。

ifneq ($(VMLINUX_BTF_SRC),)

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	@$(VMLINUX_BTF_CHECK) "$(VMLINUX_BTF_SRC)" || exit 1
	$(CP) "$(VMLINUX_BTF_SRC)" $(PKG_BUILD_DIR)/vmlinux
endef

define Build/Compile
	@echo "vmlinux-btf: 使用外部 BTF $(VMLINUX_BTF_SRC)（$(PKG_BUILD_DIR)/vmlinux）"
endef

else

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) $(VMLINUX_BTF_DIR)/src/* $(PKG_BUILD_DIR)/
endef

define Build/Compile
	@if [ ! -f "$(LINUX_DIR)/include/generated/autoconf.h" ]; then \
		echo "vmlinux-btf: 找不到内核头文件 $(LINUX_DIR)/include/generated/autoconf.h"; \
		echo "vmlinux-btf: 整机编译请先准备好内核（make target/linux/compile），"; \
		echo "vmlinux-btf: 或者用 VMLINUX_BTF_SRC=<现成的 BTF> 指定"; \
		exit 1; \
	fi
	@if ! $(BTF_PAHOLE) --version >/dev/null 2>&1; then \
		echo "vmlinux-btf: 需要 pahole 生成 BTF（Debian/Ubuntu: apt install dwarves）"; \
		exit 1; \
	fi
	@echo "vmlinux-btf: 从 $(LINUX_DIR) 生成 BTF（pahole: $(BTF_PAHOLE)）"
	$(BTF_CC) $(BTF_CFLAGS) -c $(PKG_BUILD_DIR)/shadow_btf_core.c -o $(PKG_BUILD_DIR)/shadow_btf_core.o
	-$(BTF_CC) $(BTF_CFLAGS) -c $(PKG_BUILD_DIR)/shadow_btf_modules.c -o $(PKG_BUILD_DIR)/shadow_btf_modules.o 2>/dev/null
	-$(BTF_CC) $(BTF_CFLAGS) -c $(PKG_BUILD_DIR)/shadow_btf_private.c -o $(PKG_BUILD_DIR)/shadow_btf_private.o 2>/dev/null
	$(TARGET_CROSS)ld -r -o $(PKG_BUILD_DIR)/shadow_btf.o $(PKG_BUILD_DIR)/shadow_btf_*.o
	if $(BTF_PAHOLE) --help 2>&1 | grep -q -- '--btf_encode_detached'; then \
		$(BTF_PAHOLE) --btf_encode_detached=$(PKG_BUILD_DIR)/vmlinux $(PKG_BUILD_DIR)/shadow_btf.o; \
	else \
		$(BTF_PAHOLE) -J $(PKG_BUILD_DIR)/shadow_btf.o && \
		$(TARGET_CROSS)objcopy --dump-section .BTF=$(PKG_BUILD_DIR)/vmlinux $(PKG_BUILD_DIR)/shadow_btf.o; \
	fi
	@$(VMLINUX_BTF_CHECK) $(PKG_BUILD_DIR)/vmlinux
endef

endif

define Package/vmlinux-btf/install
	$(INSTALL_DIR) $(1)/usr/lib/debug/boot
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/vmlinux $(1)/usr/lib/debug/boot/vmlinux
	$(LN) vmlinux $(1)/usr/lib/debug/boot/vmlinux-$(VMLINUX_BTF_KERNEL_RELEASE)
	$(INSTALL_DIR) $(1)/usr/share/vmlinux-btf
	printf '%s\n' "$(PKG_VERSION)" > $(1)/usr/share/vmlinux-btf/version
endef

$(eval $(call BuildPackage,vmlinux-btf))
