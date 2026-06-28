# D-Robotics Repo Family Map

> Sources: live `gh api orgs/D-Robotics/repos` metadata (name / description / language / branch / visibility), verified 2026-06 at **226 public / 327 total (101 private)**, clustered and cross-checked against representative READMEs. Per-family counts below are approximate groupings, not exact org figures — re-run `gh api` to confirm. The org evolves; treat the live org page as the source of truth.

## Naming-convention cheat table (pattern → meaning)

| Name pattern | Meaning | Layer |
| --- | --- | --- |
| `hobot-xxx` (hyphen) | BSP / system source component | System / BSP |
| `hobot_xxx` (underscore) | TROS / ROS2 application package | Application |
| *(no prefix:* `hobot-*` / `rdk-gen` / `manifest`) | **RDK X3** board | — |
| `x5-` prefix | RDK X5 board (public) | — |
| `s100-` prefix | RDK S100 / S100P board (**private** repos) | — |
| `j5-` prefix | Journey 5 (征程5, automotive SoC) board (**private** repos) | — |
| `tros_xxx` | TROS tooling / orchestration / release | Middleware |
| `nodehub_xxx` | NodeHub app packaging (deb for app center) | App distribution |
| `magicbox_xxx` | MagicBox hardware-product companion package | Product |
| `xxx_doc` / `xxx-doc` | Documentation source | Docs |
| `rcl` / `rclcpp` / `rmw_*` / `rosbag2` / `vision_opencv` / `isaac_*` | Upstream ROS2 port (NOT RDK-original) | Middleware |
| `mono*` / `stereo*` / `face_*` / `hand_*` / `*_cam` | Vision / perception application | Application |

## The 12 families

### 1. System / BSP
Kernel and board-support packages, assembled into the OS image via `repo` + `manifest` + `*-rdk-gen`.
- **Build entry**: `rdk-gen` (X3, public) / `x5-rdk-gen` (public) / `s100-rdk-gen` (private) / `j5-rdk-gen` (private). Manifests: `manifest` / `x5-manifest` (public); `j5-manifest` (private).
- **Low-level (public)**: `kernel`, `x5-kernel`, `x5-kernel-rt`, `uboot`, `x5-uboot`, `bootloader`, `x5-bootloader`. (`s100-bootloader`, `j5-uboot`, `j5-kernel-5.10` are private.)
- **BSP components, one set per board**: `hobot-boot` / `-camera` / `-multimedia` / `-multimedia-dev` / `-dnn` / `-bpu-drivers` / `-dtb` / `-wifi` / `-io` / `-utils` / `-display` / `-spdev` / `-miniboot` / `-kernel-headers` / `-configs` / `-audio-config`, plus the `x5-hobot-*` public set and the `s100-hobot-*` **private** set.
- **Camera low-level (X5, public)**: `x5-libcam-sensor`, `x5-libcam-inc`, `x5-drv-camsys`.
- **RDK S600 note**: no `s600-` prefixed BSP/build repos exist (public or private). S600 support appears only in application-layer repos (e.g. `rdk_model_zoo` has S600 feature branches; `hobot_*` ROS packages add S600/Jazzy adaptation). See SKILL.md board-prefix table.
- Detailed build flow: [os-image-build.md](os-image-build.md).

### 2. TROS / ROS2 core ports
RDK ports/mirrors of upstream ROS2 repos — **not RDK-original algorithms**: `rcl` / `rclcpp` / `rcl_interfaces` / `rmw_cyclonedds` / `ament_*` / `rosbag2` / `tinyxml_vendor` / `vision_opencv` / `livox_ros_driver2` / `isaac_*`. When one misbehaves, check upstream ROS2 first.

### 3. TROS tooling / orchestration
`tros_*` and the build entry: `robot_dev_config` (TROS compile entry, public) / `tros_doc` / `tros_vims_doc` / `tros_bridge_grpc` / `tros_perception_fusion` / `tros_perception_common` / `tros_runtime_stats` / `tros_websocket_interaction` / `tros_nav_docking` / `tros_gnss` / `tros_apriltag_det` / `tros_lowpass_filter` / `trosdep`. (`tros_release`, `tros_demos` are private.)

### 4. Perception / vision application packages (largest family)
`hobot_*` underscore + algorithm-named repos. Detection / segmentation / pose / stereo / SLAM / calibration / peripherals:
- Detect/segment: `hobot_yolo_world` / `hobot_dosod` / `hobot_bev` / `hobot_centerpoint` / `mono*` / `face_*` / `hand_*` repos.
- Stereo depth: `hobot_stereonet` (+ `_utils`) / `DStereo_X5` / `dstereo_occnet` / `elevation_net`.
- Cameras/peripherals: `hobot_usb_cam` / `hobot_mipi_cam` / `hobot_zed_cam` / `hobot_rgbd_cam` / `hobot_stereo_mipi_cam` / `hobot_stereo_usb_cam` / `hobot_codec` / `hobot_cv` / `hobot_websocket` / `hobot_imu_sensor`.
- Base: `hobot_dnn` (dnn_node) / `hobot_msgs` / `hobot_shm` / `hobot_sensors` / `hobot_vio`.

### 5. Model Zoo
`rdk_model_zoo` (X3/X5, branches `rdk_x3` / `rdk_x5` / `rdk_s` / S600 feature branches) / `rdk_model_zoo_s` (S-series, default branch `s100`) / `model_zoo` / `tros_application_model_zoo`. → skill `rdk-model-zoo`.

### 6. NodeHub packaging
`nodehub_*`: package a TROS app into a deb for the NodeHub app center; READMEs usually only reference TROS docs and the implementation repo. E.g. `nodehub_yolov8_object_detection` / `nodehub_yolo11_object_detection` / `nodehub_yolov10_object_detection` / `nodehub_yolov8_instance_segmentation` / `nodehub_hobot_clip` / `nodehub_hobot_yolo_world` / `nodehub_mono_mobilesam` / `nodehub-x5-rdkmodelzoo-samples`.

### 7. Embodied AI
`rdk_LeRobot_tools` / `RDK_LeRobot_Tools_4_THU_Discover_AirBotPlay` / `lerobot` / `openpi` / `openpi_runtime` / `RoboTwin` / `embodied_ai_robots` / `Alicia-D-SDK` / `object_graspnet` / `xr_robot`. → skill `rdk-embodied-lerobot`.

### 8. On-device LLM / speech
`hobot_llamacpp` / `hobot_llm` / `hobot_xlm` / `hobot_chatbot` / `hobot_clip` / `hobot_tts` / `hobot_audio` / `chat_robot`. → skill `rdk-llm-deployment`.

### 9. MagicBox product
`magicbox_lighting_control` / `magicbox_audio_io` / `magicbox_servo_control` / `magicbox_mipi_cam` / `magicbox_gesture_interaction` / `magicbox_qwen_llm` / `magicbox_doc` — companion packages for the MagicBox hardware product.

### 10. Documentation
`rdk_doc` (main doc source, 16★, JavaScript/docs framework) / `rdk_s_doc` / `rdk_x_doc` / `tros_doc` / `tros_vims_doc` / `model_zoo_doc` / `rdk_studio_doc` / `rdk_doc_center` / `case_doc` / `accessories_doc` / `magicbox_doc` / `DRobotics_SoC_Technology`. → skill `rdk-doc-finder`.

### 11. Image / toolchain helpers
`system_download` (image download manifest) / `sysroot_docker` / `sysroot_docker_noble` / `cross_compile` / `x5-tuning-json`. (`ai_toolchain_models`, `x5-factorytest` are private.)

### 12. Other / courses / internal
`device-knowledge` (this repo) / `moss` (agent architecture layer) / `benchmark` / `d-robotics-recruit` / sample and internal tooling repos.

## Cross-platform / standalone repo reminders

- `lerobot` / `openpi` are D-Robotics **forks of upstream projects** (READMEs note BPU adaptation), not from-scratch originals.
- Family-2 ROS2 core ports: when one breaks, verify upstream ROS2 behavior before assuming an RDK-introduced change.
- A single capability may exist as **both** a BSP library (hyphen) and a ROS package (underscore). Decide whether you want the low-level library or the ROS node **before** picking a repo.
- **Public vs private**: many `s100-*` / `j5-*` BSP/build repos and some `tros_*` repos are private. The prefix → board mapping is still valid for *classifying* a name you encounter, but you cannot clone a private one anonymously.

## Journey 5 (征程5)

`j5-` = Journey 5 (征程 Journey 5), Horizon's automotive/autonomous-driving SoC. The prefix → board mapping holds, but the `j5-rdk-gen` / `j5-manifest` / `j5-kernel-5.10` repos are private; product attribution is documented on the official developer site (Journey 5 OpenExplorer docs at developer.d-robotics.cc).
