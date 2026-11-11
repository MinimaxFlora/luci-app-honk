# honk 的 OpenWrt 打包 feed

[honk](https://github.com/daeuniverse/honk) 是一个 eBPF 透明代理引擎。这个仓库把它、
它的 LuCI 页面，以及 CO-RE 需要的内核 BTF 打成 OpenWrt 包。仓库根目录本身就是一个
feed，可以直接 `src-link` 到 OpenWrt SDK 里编译。

| 目录 | 包名 | 内容 |
|---|---|---|
| [`honk/`](honk) | `honk` | `/usr/bin/honk-core`（eBPF 透明代理引擎，内嵌 doona 面板）、procd init 脚本、`/etc/config/honk`、`/etc/honk/config.dae` |
| [`luci-app-honk/`](luci-app-honk) | `luci-app-honk` + `luci-i18n-honk-zh-cn` / `-zh-tw` | LuCI 页面（服务状态、带语法高亮的配置编辑器、日志、软件更新）、菜单项、ACL、中文翻译 |
| [`vmlinux-btf/`](vmlinux-btf) | `vmlinux-btf` | `/usr/lib/debug/boot/vmlinux`（CO-RE 用的 BTF 数据），包版本就是内核版本；整机编译时由包自己从内核头文件生成 |

CI 在 `ubuntu-26.04` 上跑，同时产出两种包格式：**ipk**（OpenWrt 24.10 / opkg）和
**apk**（OpenWrt 25.12 / apk-tools 3），覆盖 x86_64 和四种 aarch64 架构。

## 目录结构

```
.
├── .github/workflows/build.yml  # CI：ipk + apk
├── honk/                        # 包 honk：Makefile + build.sh + files/
├── luci-app-honk/               # 包 luci-app-honk：页面、翻译、honk-pkg 助手
├── vmlinux-btf/                 # 包 vmlinux-btf：Makefile 从内核头文件生成 BTF（整机编译），
│   ├── src/                     # 也接受外部给的 blob（SDK/CI 用）；src/ 是 shadow_btf_*.c
│   └── check-btf.sh             # 校验产物是不是合法 BTF
└── scripts/
    ├── fetch-openwrt-sdk.sh     # 按版本/target 找 SDK，官方源失败换镜像，sha256 校验
    ├── build-btf.sh             # 用 SDK 的内核头文件生成 BTF
    └── sign-apk.sh              # 可选：给 .apk 签名（需要 secret APK_PRIVATE_KEY）
```

`honk/src`（honk 源码）不进 git：CI 编译前把它 clone 到一个临时 feed 目录，
本地编译时手动放到 `honk/src`：

```sh
git clone --depth 1 --branch v0.1.0-beta.6 https://github.com/daeuniverse/honk honk/src
```

## 工作流

`.github/workflows/build.yml` 在 `ubuntu-26.04` 上跑，矩阵是 **(包格式 × 架构)**，
一个 job 下一次 SDK，把三个包都编出来：

| 格式 | OpenWrt 版本 | 架构 → target |
|---|---|---|
| `apk` | 25.12.x（默认 25.12.6） | `x86_64` → x86/64，`aarch64_generic` → armsr/armv8，`aarch64_cortex-a53` → mediatek/filogic，`aarch64_cortex-a72` → bcm27xx/bcm2711，`aarch64_cortex-a76` → bcm27xx/bcm2712 |
| `ipk` | 24.10.x（默认 24.10.8） | 同上 |

组合由 `plan` 作业按输入算出来（job 级 `if` 里不能引用 `matrix`，所以用
`fromJSON(needs.plan.outputs.matrix)`）。手动触发时可以填：

| 参数 | 默认 | 说明 |
|---|---|---|
| `honk_ref` | `v0.1.0-beta.6` | honk 上游 tag；包版本由它推出（`v0.1.0-beta.6` → `0.1.0_beta6`） |
| `apk_version` | `25.12.6` | 编 apk 用的 OpenWrt 版本 |
| `ipk_version` | `24.10.8` | 编 ipk 用的 OpenWrt 版本 |
| `formats` | `apk,ipk` | 只编一种就填 `apk` 或 `ipk` |
| `arches` | `all` | 只编某些架构就填 `x86_64` 或 `x86_64,aarch64_cortex-a53` |

每个 job 的产物是一组 `.ipk`/`.apk` 加 `SHA256SUMS-<格式>-<架构>`，作为 artifact
上传，名字是 `packages-<格式>-<架构>`。

几点说明：

* `runs-on: ubuntu-26.04` 用的是 GitHub 托管的 26.04 镜像；如果这个标签还没上线，
  换成 `ubuntu-latest`（`plan` 和 `build` 各有一处）。
* 三个包各自从一个**只放它自己的临时 feed 目录**编译。这是有意的：整个仓库作为
  feed 时，`luci-app-honk → honk → vmlinux-btf` 这条 DEPENDS 链会把别的包甚至整个
  内核拉进来编；而 CI 里只编包，`vmlinux-btf` 走 `VMLINUX_BTF_SRC` 那条路。
* honk 是 Rust + eBPF，需要 honk 自己钉的 stable 和 nightly（带 `rust-src`）
  两个工具链，以及 `.github/ci/pins.env` 里钉的 `bpf-linker`，工作流会自动装。
* 编译很吃时间：单架构 Rust 编译通常 20 分钟以上，10 个 job 会排队，按需用
  `formats` / `arches` 收窄。
* apk 的签名是可选的：仓库 secret 里放 `APK_PRIVATE_KEY`（PEM 格式的 EC 私钥）
  就会用 SDK 的 `apk adbsign` 签名并校验；不放就是未签名包，安装时要
  `apk add --allow-untrusted`。ipk 没有签名机制。

## 本地编译

```sh
# 1. 上游源码
git clone --depth 1 --branch v0.1.0-beta.6 https://github.com/daeuniverse/honk honk/src

# 2. SDK（脚本把 SDK_DIR 写进 $GITHUB_ENV）
mkdir -p .work
GITHUB_ENV=$PWD/.work/env RUNNER_TEMP=$PWD/.work \
  OPENWRT_VERSION=25.12.6 OPENWRT_TARGET=x86 OPENWRT_SUBTARGET=64 \
  bash scripts/fetch-openwrt-sdk.sh
. .work/env

# 3. 只放 honk 的临时 feed（避免 vmlinux-btf 被当依赖先编）
mkdir -p .work/feed/honk
cp -a honk/Makefile honk/build.sh honk/files .work/feed/honk/
ln -s "$PWD/honk/src" .work/feed/honk/src

cd "$SDK_DIR"
printf 'src-link local %s\n' "$OLDPWD/.work/feed" > feeds.conf
./scripts/feeds update local && ./scripts/feeds install -p local honk
echo 'CONFIG_PACKAGE_honk=m' >> .config && make defconfig
HONK_VERSION=0.1.0_beta6 HONK_GIT_TAG=v0.1.0-beta.6 make package/honk/compile V=s
```

`luci-app-honk` 的步骤见工作流：feeds.conf 里要同时保留 SDK 的 `base` 和 `luci`
feed，并 `feeds install -p luci luci-base`（`po2lmo`、`jsmin` 这些主机工具只有
luci-base 进了 package 树才会编），然后 `make package/luci-app-honk/compile` 一次
编出 app 和两个翻译包。

`vmlinux-btf` 的 BTF 从哪来，见下一节。

## BTF 从哪来

BTF 只描述**某一个内核**的结构体布局，所以它必须跟着编它的那棵内核树走。`vmlinux-btf`
两种用法：

* **整机编译**（把 honk 编进固件）：什么都不用准备。包的 `Build/Compile` 用
  `$(LINUX_DIR)` 里已经配好的内核头文件和 `$(TARGET_CC)`，把 `src/shadow_btf_*.c`
  编成 DWARF，再用宿主机的 `pahole` 编码成 BTF。宿主机要有 dwarves：

  ```sh
  sudo apt install dwarves        # Debian/Ubuntu，提供 pahole
  ```

  包版本取内核版本，`EXTRA_DEPENDS` 把内核版本锁死（和 kmod 一样），换个点版本或
  target 都装不上，免得 CO-RE 读到错误的结构体布局。
* **只编包**（SDK / CI）：SDK 里带着完整的 kernel tree，所以
  `make package/vmlinux-btf/compile` 也能走上面那条路；CI 为了控制版本，先用
  `bash scripts/build-btf.sh`（需要 `SDK_DIR`、`KERNEL_ARCH`、`OPENWRT_ARCH`、
  `RUNNER_TEMP`）生成 blob，再通过 `VMLINUX_BTF_SRC=<blob>` 交给包，版本用
  `VMLINUX_BTF_VERSION=<内核版本>`、`VMLINUX_BTF_KERNEL_RELEASE=<uname -r>`。

## 编进自己的 OpenWrt 固件

```sh
cd ~/openwrt
# 仓库根目录就是 feed
echo "src-link honk $HOME/luci-app-honk" >> feeds.conf.default
./scripts/feeds update honk
./scripts/feeds install -a -p honk

make menuconfig      # Network → honk，LuCI → Applications → luci-app-honk
                     # 勾 honk 会自己带出 vmlinux-btf
sudo apt install dwarves     # pahole，编 BTF 用
make -j$(nproc) V=s
```

`honk/src` 得先放好（包的 Makefile 只在本地找源码，不联网）：

```sh
git clone --depth 1 --branch v0.1.0-beta.6 https://github.com/daeuniverse/honk honk/src
```

honk 本体要 Rust：`rustup`、crate 里钉的 stable 与 nightly（带 `rust-src`）、
以及 `.github/ci/pins.env` 里钉的 `bpf-linker`，`honk/build.sh` 会在编译时检查并按
需要安装，编 honk 之前请保证构建机能联网。

## 安装

apk（OpenWrt 25.12）：

```sh
scp x86_64/vmlinux-btf-*.apk x86_64/honk-*.apk x86_64/luci-app-honk-*.apk \
    x86_64/luci-i18n-honk-zh-cn-*.apk root@192.168.1.1:/tmp/
ssh root@192.168.1.1
apk add --allow-untrusted /tmp/vmlinux-btf-*.apk /tmp/honk-*.apk \
    /tmp/luci-app-honk-*.apk /tmp/luci-i18n-honk-zh-cn-*.apk
/etc/init.d/honk enable && /etc/init.d/honk start
```

ipk（OpenWrt 24.10）：

```sh
opkg install vmlinux-btf_*.ipk honk_*.ipk luci-app-honk_*.ipk luci-i18n-honk-zh-cn_*.ipk
```

`honk` 依赖 `v2ray-geoip`、`v2ray-geosite` 和几个 kmod（`kmod-veth`、
`kmod-sched-core`、`kmod-sched-bpf`、`kmod-nft-*`），这些从 OpenWrt 官方仓库装。
服务默认不启动，装完在 LuCI **服务 → honk** 里启用，或者用上面两条 init 命令。
配置好之后客户端面板在 `http://<路由器 IP>:9527/`。

## 限制

* `honk` 需要 **6.12 或更新的内核**。OpenWrt 25.12 是 6.12，24.10 是 6.6，所以
  为 24.10 编出来的 ipk 只能用于测试或在更新的内核上跑。
* `vmlinux-btf` 只匹配编它的那个内核（点版本、target、vermagic 全都要对上），
  装错内核 apk/opkg 会直接拒绝，这是有意的：BTF 里是结构体布局。
* `honk` 和 `dae` 不能同时运行（都要 `dae0`/`daens`），页面里有互斥处理，
  但这里不提供 `dae`。
* LuCI 页面里的“软件更新”面板调用 `/usr/libexec/honk-pkg`，它用的是 `apk`，
  在 opkg 的 24.10 上这块不可用，其余功能不受影响。

## 鸣谢

* [daeuniverse/honk](https://github.com/daeuniverse/honk) —— honk 本体，`honk/`
  里的 Makefile、编译脚本、init 脚本和默认配置也取自它的发布方式。
* [daeuniverse/openwrt-packages](https://github.com/daeuniverse/openwrt-packages) ——
  这个仓库的打包结构、LuCI 页面（`service.js` / `nativeapi.js`）、中文翻译和
  `honk-pkg` 助手都来自这里；`scripts/build-btf.sh` 也沿用了它的 BTF 编译参数。
* [QiuSimons/vmlinux-btf](https://github.com/QiuSimons/vmlinux-btf) ——
  `vmlinux-btf/src/shadow_btf_*.c` 逐字复制自这个项目（GPL-3.0）。
* [Zakkaus/doona](https://github.com/Zakkaus/doona) —— honk 内嵌的 web 面板。
* OpenWrt 与 LuCI —— SDK、构建系统和 `luci.mk`。

本仓库按 GPL-3.0 发布，见 [`LICENSE`](LICENSE)。打包的软件本身：honk 是 GPL-3.0，
LuCI 页面是 GPL-3.0-or-later，内核 BTF 是 GPL-2.0-only；再分发时请保留上游的
许可证文本。
