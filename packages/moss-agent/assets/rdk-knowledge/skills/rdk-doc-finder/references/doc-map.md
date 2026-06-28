# RDK Official Docs — Full Topic → Location Index

> Sources: the six D-Robotics Docusaurus repos (`rdk_x_doc` / `rdk_s_doc` / `tros_doc` / `model_zoo_doc` / `rdk_studio_doc` / `accessories_doc`, default branch `main`) checked via `git/trees` + `docusaurus.config.js`, plus the archived `rdk_doc`. Representative URLs were curl-tested 200/404. URL-derivation rules and exceptions are in [SKILL.md](../SKILL.md). Docs evolve with releases — when in doubt, re-fetch. Rows marked `✅` were curl-verified 200; rows marked `⚠️` were derived by rule and not individually curl-tested — `web_fetch` before quoting.

## Table of contents

1. [Site roots](#site-roots)
2. [Quick Start](#1-quick-start)
3. [System Configuration](#2-system-configuration)
4. [40pin peripherals (GPIO/I2C/SPI/UART/PWM)](#3-40pin-peripherals)
5. [Vision / Camera](#4-vision--camera)
6. [Audio](#5-audio)
7. [Multimedia (VPU/codec/ISP/VIO)](#6-multimedia)
8. [Algorithm / Model Zoo](#7-algorithm--model-zoo)
9. [Robotics — TROS / ROS2](#8-robotics--tros--ros2)
10. [Toolchain (BPU quantize/compile)](#9-toolchain)
11. [Linux advanced dev & MCU (S-only)](#10-linux-advanced-dev--mcu)
12. [Application cases](#11-application-cases)
13. [FAQ](#12-faq)
14. [Appendix: command manual & release notes](#13-appendix-command-manual--release-notes)
15. [RDK Studio desktop client](#14-rdk-studio-desktop-client)
16. [Official accessories](#15-official-accessories)

---

## Site roots

- X-series `https://developer.d-robotics.cc/rdk_x_doc/`
- S-series `https://developer.d-robotics.cc/rdk_s_doc/`
- TROS `https://developer.d-robotics.cc/tros_doc/`
- Model Zoo `https://developer.d-robotics.cc/model_zoo_doc/`
- RDK Studio `https://developer.d-robotics.cc/rdk_studio_doc/`
- Accessories `https://developer.d-robotics.cc/accessories_doc/` (live ✅)
- Archive `https://developer.d-robotics.cc/rdk_doc/` (migrated, banner-flagged; X under `docs/`, S routed at `rdk_s`)

X-series → `rdk_x_doc`, S-series → `rdk_s_doc`, TROS → `tros_doc`, Studio → `rdk_studio_doc`. Every row below tags the board coverage and owning site.

---

## 1. Quick Start

| Topic | Location | Boards |
|---|---|---|
| [RDK X5 hardware intro](https://developer.d-robotics.cc/rdk_x_doc/Quick_start/hardware_introduction/rdk_x5) | rdk_x_doc | X5 ✅ |
| [RDK X3 hardware intro](https://developer.d-robotics.cc/rdk_x_doc/Quick_start/hardware_introduction/rdk_x3) | rdk_x_doc | X3 ✅ |
| **RDK Ultra hardware intro — archive only** [`rdk_doc/Quick_start/hardware_introduction/rdk_ultra`](https://developer.d-robotics.cc/rdk_doc/Quick_start/hardware_introduction/rdk_ultra) — **no Ultra page exists under rdk_x_doc** (only x3/x5) | rdk_doc (archive) ✅ | Ultra |
| [RDK S100 dev-kit intro](https://developer.d-robotics.cc/rdk_s_doc/01_Quick_start/01_hardware_introduction/01_rdk_s100/01_rdk_s100_kit) (custom slug, keeps `NN_`) | rdk_s_doc | S100/S100P ✅ |
| [RDK S600 dev-kit intro](https://developer.d-robotics.cc/rdk_s_doc/01_Quick_start/01_hardware_introduction/02_rdk_s600/01_rdk_s600_kit) (custom slug, keeps `NN_`) | rdk_s_doc | S600 ✅ |
| X3/X5 system flashing — src `rdk_x_doc:docs/01_Quick_start/install_os/rdk_x3|rdk_x5/01_system_burn.md` → `Quick_start/install_os/rdk_x5/system_burn` | rdk_x_doc | X3/X5 ⚠️ |
| S100/S600 system flashing (xburn, Win/Linux/Mac) — src `rdk_s_doc:docs/01_Quick_start/02_install_os/rdk_s100|rdk_s600/03_xburn/*.md` | rdk_s_doc | S100/S600 ⚠️ |
| Remote login (SSH/serial) — `Quick_start/remote_login` (one per X / S) | rdk_x_doc / rdk_s_doc | X / S ⚠️ |
| Boot config wizard — X `Quick_start/configuration_wizard`; S `rdk_s_doc:docs/01_Quick_start/03_configuration_wizard/configuration_wizard_s100|s600.md` | rdk_x_doc / rdk_s_doc | X / S ⚠️ |
| Image download list — `Quick_start/download` (X / S) | rdk_x_doc / rdk_s_doc | X / S ⚠️ |

## 2. System Configuration

| Topic | Location | Boards |
|---|---|---|
| Network/Bluetooth — X `System_configuration/network_blueteeth`; S `System_configuration/network_bluetooth` (note spelling differs) | rdk_x_doc / rdk_s_doc | X / S ⚠️ |
| `srpi-config` tool — `System_configuration/srpi-config` (X / S) | rdk_x_doc / rdk_s_doc | X / S ⚠️ |
| `config.txt` boot config — `System_configuration/config_txt` | rdk_x_doc / rdk_s_doc | X / S ⚠️ |
| Frequency / thermal mgmt — `System_configuration/frequency_management` | rdk_x_doc / rdk_s_doc | X / S ⚠️ |
| Boot self-start — `System_configuration/self_start` | rdk_x_doc / rdk_s_doc | X / S ⚠️ |
| GUI network config (S-only) — `rdk_s_doc:.../06_gui_network_config.md` → `System_configuration/gui_network_config` | rdk_s_doc | S ⚠️ |
| File-share tool (S-only) — `rdk_s_doc:.../07_share_file_tool.md` → `System_configuration/share_file_tool` | rdk_s_doc | S ⚠️ |

## 3. 40pin peripherals

| Topic | Location | Boards |
|---|---|---|
| [40pin pin definition (X)](https://developer.d-robotics.cc/rdk_x_doc/Basic_Application/01_40pin_user_sample/40pin_define) | rdk_x_doc | X ✅ |
| [GPIO (X)](https://developer.d-robotics.cc/rdk_x_doc/Basic_Application/01_40pin_user_sample/gpio) | rdk_x_doc | X ✅ |
| [I2C](https://developer.d-robotics.cc/rdk_x_doc/Basic_Application/01_40pin_user_sample/i2c) ✅ / SPI / UART / PWM — same dir, swap leaf name (`01_40pin_user_sample` prefix is **kept**) | rdk_x_doc | X |
| S100 40pin (define/gpio/pwm/uart/i2c/spi) — src `rdk_s_doc:docs/03_Basic_Application/03_40pin_user_guide/01_s100/*.md` (nested `01_s100`; verify slug, give src path + S root) | rdk_s_doc | S100 ⚠️ |
| S600 40pin (ext_io/gpio/uart/spi) — src `rdk_s_doc:docs/03_Basic_Application/03_40pin_user_guide/02_s600/*.md` | rdk_s_doc | S600 ⚠️ |

> ⚠️ Reminder: the `01_40pin_user_sample/` segment **keeps** its `01_` prefix. Stripping it → 404.

## 4. Vision / Camera

| Topic | Location | Boards |
|---|---|---|
| MIPI camera (X) — `rdk_x_doc:docs/03_Basic_Application/04_vision/RDK_X3|RDK_X5/mipi_camera.md` → `Basic_Application/vision/RDK_X5/mipi_camera` | rdk_x_doc | X3/X5 ⚠️ |
| USB camera (X) — same dir, `usb_camera` | rdk_x_doc | X3/X5 ⚠️ |
| [MIPI camera (S)](https://developer.d-robotics.cc/rdk_s_doc/Basic_Application/Image/mipi_camera) | rdk_s_doc | S100/S600 ✅ |
| [USB camera (S)](https://developer.d-robotics.cc/rdk_s_doc/Basic_Application/Image/usb_camera) | rdk_s_doc | S100/S600 ✅ |
| Python vision samples (classify/detect/seg/pose/USB/MIPI/web-stream) — `rdk_x_doc:docs/03_Basic_Application/03_pydev_demo_sample/RDK_X5/*` → `Basic_Application/pydev_demo_sample/RDK_X5/...` | rdk_x_doc | X3/X5 ⚠️ |
| C vision samples (vio2display / rtsp2display / vio_capture …) — `rdk_x_doc:docs/03_Basic_Application/02_cdev_demo_sample/*` → `Basic_Application/cdev_demo_sample/...` | rdk_x_doc | X ⚠️ |

## 5. Audio

| Topic | Location | Boards |
|---|---|---|
| X5 on-board ES8326 / WM8960 HAT / Hiwonder audio — `rdk_x_doc:docs/03_Basic_Application/05_audio/rdk_x5/*.md` → `Basic_Application/audio/rdk_x5/in_board_es8326` etc. | rdk_x_doc | X5 ⚠️ |
| X3 audio (WM8960 / audio_driver_hat2) — `rdk_x_doc:.../05_audio/rdk_x3_and_rdk_x3_module/*.md` | rdk_x_doc | X3 ⚠️ |
| S audio expansion board — `rdk_s_doc:docs/03_Basic_Application/02_audio/01_audio_board_super.md` → `Basic_Application/audio/audio_board_super` | rdk_s_doc | S100/S600 ⚠️ |

## 6. Multimedia

| Topic | Location | Boards |
|---|---|---|
| X multimedia `sp` API (BPU/encode/decode/display/VIO, Python+C) — `rdk_x_doc:docs/03_Basic_Application/06_multi_media_sp_dev_api/RDK_X5/...` → `Basic_Application/multi_media_sp_dev_api/RDK_X5/...` | rdk_x_doc | X3/X5 ⚠️ |
| S multimedia API (cdev/pydev: decoder/display/encoder/sys/vio) — `rdk_s_doc:docs/03_Basic_Application/04_multi_media/multi_media_api/...` → `Basic_Application/multi_media/multi_media_api/...` | rdk_s_doc | S100/S600 ⚠️ |
| X advanced multimedia dev (video_input/encode/decode/ISP/region/system_control) — `rdk_x_doc:docs/07_Advanced_development/03_multimedia_development/*` → `Advanced_development/multimedia_development/...` | rdk_x_doc | X ⚠️ |
| S advanced multimedia (camsys/camera_bringup/codec/display/camerasync + vin/isp/pym/gdc/codec samples) — `rdk_s_doc:docs/07_Advanced_development/03_multimedia_development/...` | rdk_s_doc | S100/S600 ⚠️ |

## 7. Algorithm / Model Zoo

| Topic | Location | Boards |
|---|---|---|
| [Model Zoo intro](https://developer.d-robotics.cc/model_zoo_doc/model_zoo_intro) | model_zoo_doc | all ✅ |
| [RDK X5 Model Zoo guide](https://developer.d-robotics.cc/model_zoo_doc/rdk_x5_guide) | model_zoo_doc | X5 ✅ |
| [RDK X3 guide](https://developer.d-robotics.cc/model_zoo_doc/rdk_x3_guide) ✅ / [RDK S guide](https://developer.d-robotics.cc/model_zoo_doc/rdk_s_guide) ✅ | model_zoo_doc | X3 / S |
| [Infer API reference](https://developer.d-robotics.cc/model_zoo_doc/infer_api_ref) | model_zoo_doc | all ✅ |
| Per-board model lists (classify/detect/instance-seg/pose/OCR/depth/matting/LLM) — `model_zoo_doc:docs/appendix/rdk_x5|rdk_x3|rdk_s100|rdk_s600/*.md` → `appendix/rdk_x5/02_object_detection` etc. | model_zoo_doc | X3/X5/S100/S600 ⚠️ |
| On-board Python/C++ algorithm samples (ResNet18/MobileNetV2/YOLOv5x/YOLO11/seg/pose/LaneNet/ASR/PaddleOCR) — `rdk_s_doc:docs/04_Algorithm_Application/03_Python_Sample|04_C++_Sample/*` → `Algorithm_Application/Python_Sample/...` | rdk_s_doc | S100/S600 ⚠️ |

## 8. Robotics — TROS / ROS2

> All TROS topics live in `tros_doc`, cross-board.

| Topic | Location | Boards |
|---|---|---|
| Install / env prep / Hello World / ros_pkg / cross-compile — `tros_doc:docs/01_quick_start/*` → [`quick_start/install_tros`](https://developer.d-robotics.cc/tros_doc/quick_start/install_tros) ✅ | tros_doc | cross |
| Quick demos (sensor/comm/CV/render/tools/codec/tts) — `tros_doc:docs/02_quick_demo/*` → `quick_demo/demo_sensor` etc. | tros_doc | cross ⚠️ |
| [YOLO detection (boxs)](https://developer.d-robotics.cc/tros_doc/boxs/detection/yolo) | tros_doc | cross ✅ |
| DOSOD open-vocab / YOLO-World — `tros_doc:docs/03_boxs/detection/hobot_dosod|hobot_yolo_world.md` → `boxs/detection/hobot_dosod` | tros_doc | cross ⚠️ |
| Body/gesture/face/ReID (body) — `tros_doc:docs/03_boxs/body/*` → `boxs/body/mono2d_body_detection` etc. | tros_doc | cross ⚠️ |
| Stereo/VIO/3D (spatial: hobot_stereonet/hobot_vio/elevation_net/mono3d) — `tros_doc:docs/03_boxs/spatial/*` → `boxs/spatial/hobot_stereonet` | tros_doc | cross ⚠️ |
| On-device generative ([hobot_llamacpp](https://developer.d-robotics.cc/tros_doc/boxs/generate/hobot_llamacpp) ✅ / hobot_llm / hobot_xlm) — `tros_doc:docs/03_boxs/generate/*` | tros_doc | cross |
| Audio (hobot_audio / sensevoice_ros2) — `tros_doc:docs/03_boxs/audio/*` → `boxs/audio/hobot_audio` | tros_doc | cross ⚠️ |
| Apps: [Nav2](https://developer.d-robotics.cc/tros_doc/apps/navigation2) ✅ / SLAM / car-following / fall-detection — `tros_doc:docs/04_apps/*` | tros_doc | cross |
| TROS dev advanced (zero_copy / flame_graph / breakpad / ai_predict) — `tros_doc:docs/05_tros_dev/*` → `tros_dev/zero_copy` | tros_doc | cross ⚠️ |

> Same boxs/apps content also exists as an archived copy in old `rdk_doc` chapter 5 (`docs/05_Robot_development/...`); always cite **tros_doc** for the canonical link.

## 9. Toolchain

| Topic | Location | Boards |
|---|---|---|
| [X toolchain overview](https://developer.d-robotics.cc/rdk_x_doc/Advanced_development/toolchain_development/overview) — `rdk_x_doc:docs/07_Advanced_development/04_toolchain_development/overview.md` | rdk_x_doc | X ✅ |
| X toolchain expert (quick_start/user_guide/api_reference/environment_config) — `.../04_toolchain_development/expert/*` → `Advanced_development/toolchain_development/expert/quick_start` | rdk_x_doc | X ⚠️ |
| X toolchain intermediate (PTQ/runtime_sample/supported_op_list) — `.../04_toolchain_development/intermediate/*` | rdk_x_doc | X ⚠️ |
| S toolchain overview / LLM toolchain — `rdk_s_doc:docs/07_Advanced_development/04_toolchain_development/01_algorithm_toolchain/01_overview.md` (extra nested `01_algorithm_toolchain/` layer) and `02_LLM_Toolchain/` → `Advanced_development/toolchain_development/algorithm_toolchain/overview` etc. | rdk_s_doc | S100/S600 ⚠️ |

## 10. Linux advanced dev & MCU

| Topic | Location | Boards |
|---|---|---|
| X driver dev (GPIO/I2C/SPI/UART/PWM/pinctrl/thermal/RTC/watchdog …) — `rdk_x_doc:docs/07_Advanced_development/02_linux_development/driver_development[_x5]/*` → `Advanced_development/linux_development/driver_development/driver_gpio_dev` | rdk_x_doc | X3/X5 ⚠️ |
| X realtime kernel / kernel headers / env build / hardware unit test — `.../02_linux_development/{realtime_kernel,kernel_headers,environment_build,hardware_unit_test/*}` | rdk_x_doc | X ⚠️ |
| X hardware dev (schematic/interfaces/camera/display/CAN/POE/V4l2) — `rdk_x_doc:docs/07_Advanced_development/01_hardware_development/rdk_x5/*` → `Advanced_development/hardware_development/rdk_x5/hardware` | rdk_x_doc | X3/X5/Ultra ⚠️ |
| S driver dev (uart/i2c/gpio/pinctrl/ipc/spi/pwm/thermal/lowpower/audio/timesync/wifi/rtc) — `rdk_s_doc:docs/07_Advanced_development/02_linux_development/04_driver_development_super/*` → `Advanced_development/linux_development/driver_development_super/driver_gpio_dev` | rdk_s_doc | S100/S600 ⚠️ |
| **S PCIe** (hw_guide/sw_arch/sw_setup/libhbpciehal) — `.../04_driver_development_super/13_driver_pcie/*` → `.../driver_development_super/driver_pcie/s100x_pcie_hw_guide` | rdk_s_doc | S100/S600 ⚠️ |
| **S hbmem** (introduce/hardware/software/debug/FAQ) — `.../04_driver_development_super/15_driver_hbmem/*` → `.../driver_development_super/driver_hbmem/s100_hbmem_introduce` | rdk_s_doc | S100/S600 ⚠️ |
| **S EtherCAT / ethernet driver** — `.../04_driver_development_super/16_driver_ethernet/02_ethercat.md` → `.../driver_development_super/driver_ethernet/ethercat` | rdk_s_doc | S100/S600 ⚠️ |
| **S OTA** (system/miniboot) — `.../06_OTA/*` → `Advanced_development/linux_development/OTA/ota_system` | rdk_s_doc | S100/S600 ⚠️ |
| **S VDSP dev** — `rdk_s_doc:docs/07_Advanced_development/07_vdsp_development.md` → `Advanced_development/vdsp_development` | rdk_s_doc | S100/S600 ⚠️ |
| **S MCU dev** (build_system/FreeRTOS/uart/pwm/spi/adc/can/i2c/eth/ramdump/ICU/mcu_port + IPC below) — `rdk_s_doc:docs/07_Advanced_development/05_mcu_development/*` | rdk_s_doc | S100/S600 |
| [S MCU IPC guide](https://developer.d-robotics.cc/rdk_s_doc/Advanced_development/mcu_development/mcu_ipc) | rdk_s_doc | S100/S600 ✅ |
| S board bringup (S100/S600) — `rdk_s_doc:docs/07_Advanced_development/01_hardware_development/03_rdk_s100_board_bringup.md` → `Advanced_development/hardware_development/rdk_s100_board_bringup` | rdk_s_doc | S100/S600 ⚠️ |

## 11. Application cases

| Topic | Location | Boards |
|---|---|---|
| AMR / line-follower — `rdk_x_doc:docs/06_Application_case/{amr,line_follower}.md` → `Application_case/amr` | rdk_x_doc | X ⚠️ |
| S application-case index — `rdk_s_doc:docs/06_Application_case/01_intro.md` → `Application_case/intro` | rdk_s_doc | S ⚠️ |

## 12. FAQ

| Topic | Location | Boards |
|---|---|---|
| X FAQ (hardware/interfaces/app-samples/multimedia/toolchain/TROS/desktop) — `rdk_x_doc:docs/08_FAQ/*.md` → `FAQ/hardware_and_system` etc. (src `01_hardware_and_system.md`) | rdk_x_doc | X ⚠️ |
| S quick-start FAQ — `rdk_s_doc:docs/01_Quick_start/03_FAQ.md` and `install_os/.../05_FAQ.md` | rdk_s_doc | S ⚠️ |
| Toolchain FAQ — within the toolchain pages (section 9) | rdk_x_doc / rdk_s_doc | X / S |
| RDK Studio client FAQ — section 14 | rdk_studio_doc | Studio |

## 13. Appendix: command manual & release notes

| Topic | Location | Boards |
|---|---|---|
| Linux command manual (apt/dmesg/ssh/scp/top/ps/tar …) — `rdk_x_doc:docs/09_Appendix/linux-command-manual/cmd_*.md` → `Appendix/linux-command-manual/cmd_ssh` | rdk_x_doc | X ⚠️ |
| RDK proprietary commands (hrut_somstatus / hrut_boardid / rdkos_info / devmem / rdk-miniboot-update / rdk-backup) — X `rdk_x_doc:docs/09_Appendix/rdk-command-manual/*`; S `rdk_s_doc:docs/09_Appendix/rdk-command-manual/*` → `Appendix/rdk-command-manual/cmd_hrut_somstatus` | rdk_x_doc / rdk_s_doc | X / S ⚠️ |
| X release notes — `rdk_x_doc:docs/10_Release_Note/...` → `Release_Note/release_note` | rdk_x_doc | X ⚠️ |
| S release notes / roadmap — `rdk_s_doc:docs/10_Release_Note/*.md` → `Release_Note/roadmap` etc. | rdk_s_doc | S100/S600 ⚠️ |

## 14. RDK Studio desktop client

> Studio uses hyphenated `NN-xxx` ordering prefixes; strip them the same way (`2-quick-start/1-install-and-login.md` → `quick-start/install-and-login`).

| Topic | Location |
|---|---|
| Product intro / architecture / feature matrix / supported hardware / changelog — `docs/1-product-intro/*` → `product-intro/overview` etc. ⚠️ |
| [Install & login](https://developer.d-robotics.cc/rdk_studio_doc/quick-start/install-and-login) ✅ |
| Quick start: flash / connect device (TypeC/SSH/serial) / network / configure AI model / first chat — `docs/2-quick-start/*` ⚠️ |
| Workbench / AI chat / remote terminal / file mgr / remote IDE / remote desktop / system flash / network config / device mgmt — `docs/3-user-guide/*` ⚠️ |
| [**OpenClaw**](https://developer.d-robotics.cc/rdk_studio_doc/user-guide/openclaw/overview) (overview/deploy-uninstall/main-panel/collab-with-dmoss/task-delegation/pairing-security) — `docs/3-user-guide/10-openclaw/*` ✅ |
| [**Skill**](https://developer.d-robotics.cc/rdk_studio_doc/user-guide/skill/skill-md-structure) (skill-md-structure/builtin/clawhub-community/create-and-import/trigger-matching/sync-to-board) — `docs/3-user-guide/11-skill/*` ✅ |
| Local model / Feishu·WeChat channels / config center / monitoring / CLI (rdkstudio·moss-agent) — `docs/3-user-guide/{12,13,14,15}-*` ⚠️ |
| Resources: [get skills](https://developer.d-robotics.cc/rdk_studio_doc/resources/get-skills) ✅ / share skills / NodeHub cases — `docs/4-resources/*` |
| FAQ (AI no-response/SSH fail/TypeC flash fail/camera no-image/OpenClaw install fail/network fail/IDE fail/multi-device/token error/model quality/VNC/local LLM/empty serial) — `docs/5-faq/*.md` → `faq/ssh-failed` etc. ⚠️ |

## 15. Official accessories

> `accessories_doc` is **live** (`url: developer.d-robotics.cc`, `baseUrl: /accessories_doc/`). Earlier this site was not yet migrated and returned 404; it now resolves. Prefix-strip rule applies as usual.

| Topic | Location |
|---|---|
| Accessories overview — `docs/01_accessories.md` (slug `/accessories`) → [`accessories_doc/accessories`](https://developer.d-robotics.cc/accessories_doc/accessories) ✅ |
| Stereo camera GS130W (overview/install/quick-start/hardware/software/downloads) — `docs/01_stereo_camera_gs130w/*.md` → [`accessories_doc/stereo_camera_gs130w/product_overview`](https://developer.d-robotics.cc/accessories_doc/stereo_camera_gs130w/product_overview) ✅ |
| Stereo camera GS130WI — `docs/02_stereo_camera_gs130wi/*.md` → `accessories_doc/stereo_camera_gs130wi/product_overview` ⚠️ |
| IMU module (overview/install/quick-start/hardware/software: C API·Python API·ROS2·IIO/downloads) — `docs/03_imu_module/*.md`, software pages under `03_imu_module/05_software/*.md` → [`accessories_doc/imu_module/software/ros2`](https://developer.d-robotics.cc/accessories_doc/imu_module/software/ros2) ✅ |

> X5 also ships a board-side IMU module page in `rdk_x_doc:docs/03_Basic_Application/07_accessory_instructions/rdk_x5/imu/{icm42688,rdk_imu_module}.md` (→ `Basic_Application/accessory_instructions/rdk_x5/imu/icm42688` ⚠️).
