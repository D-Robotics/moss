# Building RDK OS Images and TROS from Source

> Sources: READMEs of [D-Robotics/rdk-gen](https://github.com/D-Robotics/rdk-gen), [x5-rdk-gen](https://github.com/D-Robotics/x5-rdk-gen), [manifest](https://github.com/D-Robotics/manifest), and [robot_dev_config](https://github.com/D-Robotics/robot_dev_config), verified 2026-06. Commands follow each repo's current default branch. **This is an advanced/customization path** — to just install the system or run apps you do NOT build from source; flash the official image (see skill `rdk-ecosystem` / `rdk-doc-finder` for the flashing docs).

## When you actually need a source build

- Customizing the **OS image** (root filesystem, preinstalled packages, partitions).
- Modifying the **kernel / device tree / driver**, adding a new camera sensor, or adding BSP capability.
- Cross-compiling **all of TROS from source** (instead of `apt install tros-*`).

Otherwise, don't: normal development = flash the official image + `apt` for TROS.

## A. OS image build (BSP layer: `repo` + `manifest` + `*-rdk-gen`)

### A.1 Host environment (X3 / rdk-gen shown; X5/S100 are structurally the same)

- Recommended: Ubuntu 22.04 (matching the target board's system version reduces dependency drift).
- Install build dependencies (includes `repo`, `qemu-user-static`, `debootstrap`, etc.):

```bash
sudo apt-get install -y build-essential make cmake libpcre3 libpcre3-dev bc bison \
  flex python3-numpy mtd-utils zlib1g-dev debootstrap libdata-hexdumper-perl \
  libncurses5-dev zip qemu-user-static curl repo git liblz4-tool apt-cacher-ng \
  libssl-dev checkpolicy autoconf android-sdk-libsparse-utils mtools parted \
  dosfstools udev rsync
# X5/S100 additionally need device-tree-compiler, u-boot-tools, ccache, etc. (see the matching *-rdk-gen README)
```

- Cross-compile toolchain (official file server):

```bash
curl -fO http://archive.d-robotics.cc/toolchain/gcc-arm-11.2-2022.02-x86_64-aarch64-none-linux-gnu.tar.xz
sudo tar -xvf gcc-arm-11.2-2022.02-x86_64-aarch64-none-linux-gnu.tar.xz -C /opt
```

### A.2 Pull all source with `repo` (the manifest is the repo list)

```bash
# (optional) point repo itself at a China mirror to speed up bootstrap
export REPO_URL='https://mirrors.tuna.tsinghua.edu.cn/git/git-repo/'
# init the manifest: main = corresponds to the latest released image;
# develop = development branch (more new features, slightly less stable)
repo init -u git@github.com:D-Robotics/manifest.git -b main
repo sync
```

The `manifest` repo pulls the kernel, bootloader, and all `hobot-*` (hyphen) BSP source into `source/`.
**Board mapping**: X3 uses `manifest`; X5 uses `x5-rdk-gen` + `x5-manifest`; S100 uses `s100-rdk-gen` (**private**); Journey 5 uses `j5-rdk-gen` + `j5-manifest` (**private**). Same `repo init`/`sync` flow, swap the manifest. **Only the X3 and X5 manifests are public.**

### A.3 Build the image

```bash
cd rdk-gen
sudo ./pack_image.sh      # on success, *.img lands in deploy/
```

### A.4 rdk-gen key scripts and directories

| Script / dir | Purpose |
| --- | --- |
| `pack_image.sh` | Top-level image build entry |
| `download_samplefs.sh` | Download the prebuilt base Ubuntu filesystem |
| `download_deb_pkgs.sh` | Download D-Robotics debs to preinstall (kernel, multimedia libs, samples, tros.bot, etc.) |
| `hobot_customize_rootfs.sh` | Customize the rootfs |
| `source_sync.sh` | Download bootloader/uboot/kernel/sample source |
| `mk_kernel.sh` | Build kernel, device tree, driver modules |
| `mk_debs.sh` | Produce deb packages |
| `samplefs/make_ubuntu_samplefs.sh` | Build the Ubuntu samplefs (lives under `samplefs/`; edit to customize) |
| `config/` | Goes into the image at `/hobot/config` (vfat partition; on SD boot you can edit it from Windows) |

`pack_image.sh` flow: download samplefs + preinstall debs → unpack samplefs and run `hobot_customize_rootfs.sh` → install debs into the rootfs → produce the image.
The `source/` directory holds `bootloader` / `hobot-boot` / `hobot-bpu-drivers` / … — i.e. the Family-1 hyphen BSP repos.

## B. TROS from source (application layer: `vcstool` + `robot_dev_config`)

`robot_dev_config` is the **compile entry** for [TogetheROS.Bot](https://developer.d-robotics.cc/en/rdk_doc/Quick_start) (ROS2-compatible). It uses `vcstool` to pull all `hobot_*` (underscore) ROS packages plus the ROS2 core ports, per `ros2.repos`.

```bash
# Fetch config and import all package sources
mkdir -p /mnt/data/test/cc_ws/tros_ws/src
cd /mnt/data/test/cc_ws/tros_ws
git clone https://github.com/D-Robotics/robot_dev_config.git -b develop
sudo pip install -U vcstool
vcs-import src < ./robot_dev_config/ros2.repos   # pull all ROS package source
# then compile via build.sh / all_build.sh (X3) / rdkultra_build.sh / x5_build.sh / s100_build.sh / x86_build.sh / minimal_build.sh
```

The README's cross-compile section is headed "ubuntu20.04 docker," but the official image it loads is `pc_tros_ubuntu22.04_v1.0.0` (Ubuntu 22.04). During `vcs-import`, a printed `.` = a repo pulled OK, `E` = a failed pull (the failing repo is named in the log).

`robot_dev_config` key scripts (verified against the repo's current file listing):

| Script | Purpose |
| --- | --- |
| `build.sh` | Compile script |
| `all_build.sh` / `rdkultra_build.sh` / `x86_build.sh` | X3 / RDK Ultra / x86 full-build configs |
| `x5_build.sh` / `s100_build.sh` | X5 / S100 build configs |
| `minimal_build.sh` / `minimal_deploy.sh` | Minimal build / trimmed deployment |
| `bloom_script/` | App deb packaging (the README also names `build_deb.sh`; the repo uses the `bloom_script/` directory — defer to the repo's actual layout) |
| `aarch64_toolchainfile.cmake` | Cross-compile toolchain file |
| `ros2.repos` / `ros2_alpha.repos` / `ros2_release.repos` | vcstool manifests (release / alpha variants) |

## The two build systems side by side (don't mix them)

| | OS image (A) | TROS app (B) |
| --- | --- | --- |
| Multi-repo tool | Google `repo` | `vcstool` |
| Manifest | `manifest` (XML) | `robot_dev_config/ros2.repos` |
| Entry | `*-rdk-gen` | `robot_dev_config` |
| Pulls | kernel/uboot/bootloader/`hobot-*` (hyphen) | `hobot_*` (underscore) + rcl/rclcpp/rmw… |
| Output | flashable `*.img` | `/opt/tros` workspace + debs |
| Board coupling | strong (split by prefix) | cross-board (relies on BSP for capability) |

## Related links

- [X3 image build (rdk-gen)](https://github.com/D-Robotics/rdk-gen) · [X5 (x5-rdk-gen)](https://github.com/D-Robotics/x5-rdk-gen)
- [TROS compile entry (robot_dev_config)](https://github.com/D-Robotics/robot_dev_config)
- [System image flashing (official, NOT a source build)](https://developer.d-robotics.cc/rdk_doc/Quick_start/install_os/rdk_x5)
- [System image download manifest](https://github.com/D-Robotics/system_download)
