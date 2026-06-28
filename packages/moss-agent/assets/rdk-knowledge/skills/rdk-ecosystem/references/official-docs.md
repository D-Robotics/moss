# RDK Official Resource Index

> Sources: D-Robotics official docs and GitHub. Index of official docs/resources grouped by topic; pair with WebFetch to confirm the latest version.

> **Doc site split (2026):** the merged `rdk_doc` repo was split into independent sites — X-series → `rdk_x_doc`, S-series → `rdk_s_doc`, TROS → `tros_doc`, Model Zoo → `model_zoo_doc`, RDK Studio → `rdk_studio_doc`, accessories → `accessories_doc`. Legacy `developer.d-robotics.cc/rdk_doc/...` links still resolve (with a "migrated" banner). **To pin a question to the exact chapter/URL on the new sites, use the `rdk-doc-finder` skill** (full topic→URL index + URL derivation rules).

## Ecosystem entry points (the selection layer)

- [NodeHub application center](https://developer.d-robotics.cc/en/nodehub) — RDK app store
- [Developer community forum](https://developer.d-robotics.cc/forum)
- [GitHub: D-Robotics org](https://github.com/D-Robotics)
- [Model Zoo (X3 · Bernoulli2 / X5 · Ultra · Bayes)](https://github.com/D-Robotics/rdk_model_zoo)
- [Model Zoo (S100/S100P · Nash)](https://github.com/D-Robotics/rdk_model_zoo_s)
- [System image download list](https://github.com/D-Robotics/system_download)
- [Model Zoo docs (benchmarks)](https://github.com/D-Robotics/model_zoo_doc)

## Getting started

- [RDK X5 quick start](https://developer.d-robotics.cc/rdk_doc/Quick_start/hardware_introduction/rdk_x5)
- [RDK X3 quick start](https://developer.d-robotics.cc/rdk_doc/Quick_start/hardware_introduction/rdk_x3)
- [RDK Ultra quick start](https://developer.d-robotics.cc/rdk_doc/Quick_start/hardware_introduction/rdk_ultra)
- [S100 quick start](https://developer.d-robotics.cc/rdk_doc/rdk_s/Quick_start/hardware_introduction/rdk_s100)
- [Network config (wired/WiFi/Bluetooth)](https://developer.d-robotics.cc/rdk_doc/System_configuration/network_blueteeth)
- [Remote login (SSH/serial)](https://developer.d-robotics.cc/rdk_doc/Quick_start/remote_login)

## RDK Studio

- [Studio device management](https://developer.d-robotics.cc/rdk_doc/Quick_start/RDK_Studio/Device_management/hardware_resource)
- [Studio flashing](https://developer.d-robotics.cc/rdk_doc/Quick_start/RDK_Studio/flashing)
- [Studio integration tools](https://developer.d-robotics.cc/rdk_doc/Quick_start/RDK_Studio/Device_management/integration_tools)
- [Studio NodeHub](https://developer.d-robotics.cc/rdk_doc/Quick_start/RDK_Studio/nodehub)

## Vision

- [USB camera (hobot_usb_cam)](https://developer.d-robotics.cc/rdk_doc/Basic_Application/vision/usb_camera)
- [MIPI camera](https://developer.d-robotics.cc/rdk_doc/Basic_Application/vision/mipi_camera)
- [YOLO detection](https://developer.d-robotics.cc/rdk_doc/Basic_Application/pydev_demo_sample/yolov5_sample)
- [DOSOD open-vocabulary detection](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/detection/hobot_dosod)
- [Web visualization streaming](https://developer.d-robotics.cc/rdk_doc/Basic_Application/pydev_demo_sample/web_display_camera_sample)

## ROS / TROS

- [TROS install & env](https://developer.d-robotics.cc/rdk_doc/Robot_development/quick_start/install_tros)
- [TROS Hello World](https://developer.d-robotics.cc/rdk_doc/Robot_development/quick_start/hello_world)
- [Nav2 deployment](https://developer.d-robotics.cc/rdk_doc/Robot_development/apps/navigation2)

## Toolchain

- [BPU toolchain overview](https://developer.d-robotics.cc/rdk_doc/Advanced_development/toolchain_development/overview)
- [Toolchain quick start](https://developer.d-robotics.cc/rdk_doc/Advanced_development/toolchain_development/expert/quick_start)
- [Toolchain FAQ](https://developer.d-robotics.cc/rdk_doc/FAQ/toolchain)

## LLM / VLM

- [On-device LLM (hobot_llm)](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/generate/hobot_llm)
- [hobot_llamacpp — LLM + VLM (GGUF + BPU), X5 / S100](https://github.com/D-Robotics/tros_doc/blob/main/docs/03_boxs/generate/hobot_llamacpp.md)
- [S100 LLM benchmark (measured on S100P)](https://github.com/D-Robotics/model_zoo_doc/blob/main/docs/appendix/rdk_s100/07_llm.md)
- [S600 LLM benchmark](https://github.com/D-Robotics/model_zoo_doc/blob/main/docs/appendix/rdk_s600/01_llm.md)
- [TTS/ASR voice (hobot_audio)](https://developer.d-robotics.cc/rdk_doc/Robot_development/boxs/audio/hobot_audio)

## Hardware

- [40-pin definition](https://developer.d-robotics.cc/rdk_doc/Basic_Application/01_40pin_user_sample/40pin_define)
- [RDK S100 hardware introduction](https://github.com/D-Robotics/rdk_s_doc/blob/main/docs/01_Quick_start/01_hardware_introduction/01_rdk_s100/01_rdk_s100.md)
- [RDK S600 hardware introduction](https://github.com/D-Robotics/rdk_s_doc/blob/main/docs/01_Quick_start/01_hardware_introduction/02_rdk_s600/01_rdk_s600.md)

## Competitor official docs (for cross-platform comparison)

- [Jetson Orin Nano Super (NVIDIA developer blog)](https://developer.nvidia.com/blog/nvidia-jetson-orin-nano-developer-kit-gets-a-super-boost/) — 67 TOPS INT8 sparse, 6× A78AE, 1024 CUDA
- [Raspberry Pi AI HAT+](https://www.raspberrypi.com/products/) — Hailo-8L 13 TOPS / Hailo-8 26 TOPS
- For deep single-platform specs, use the `jetson-knowledge` / `rpi-knowledge` / `rk-knowledge` skills
