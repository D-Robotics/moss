# Official End-to-End Robot App Cases (X-series: AMR / line-follower)

> Sources: rdk_x_doc (default branch `main`) `docs/06_Application_case/amr.md` (marked RDK-X5) and `docs/06_Application_case/line_follower.md`. Only facts the docs state; GitHub repos and commands are taken from the original text. Both are **complete ROS2/TROS projects** — they live here because their skeleton is TROS nodes + colcon + launch + BPU inference, the same shape as this skill's TROS workflow and node catalog. The S-series showcase solutions (no build steps) live in rdk-ecosystem, not here.

## When to open this page

The user wants to "build a working robot following the official guide" — an autonomous mobile robot (AMR) or a CNN line-follower car — and needs the **full chain**: hardware list, sensor self-check, calibration, mapping/navigation, model training, on-board inference. For a single capability (only stereo depth, only one Nav2 param), stay in SKILL.md and [tros-node-catalog.md](tros-node-catalog.md).

## Case 1 — AMR autonomous mobile robot (RDK X5)

**What it is** — the official AMR full-machine solution: X5 as the controller, multi-sensor fusion + Nav2 autonomous navigation. The doc stresses AMR differs from an AGV that relies on tracks/predefined routes.

**Hardware (key parts)** — RDK X5 ×1, steering-wheel AMR chassis (Yuhesen / 煜禾森), single-line lidar (Kjian / 氪见), ToF camera (Guangjian / 光鉴), stereo camera **230ai** (D-Robotics accessory), IMU **BMI088** (D-Robotics accessory), USB-to-Ethernet adapter, 12V→5V power, plus 3D-printed brackets/covers. The chassis talks over **CAN**, the stereo camera over a 22-pin ribbon, the lidar over Ethernet (subnet/mask must match the board).

**Software chain (TROS Humble):**
1. **Sensor self-check** — stereo via `i2c`; lidar `ping` reachable and on the same subnet; chassis `ip link` brings up CAN (`can1` shows `<NOARP,UP,LOWER_UP>`) and receives CAN data; IMU via `i2c`, read three-axis data.
2. **Install functions** — `sudo apt -y tros-hobot-nav2 ros-foxy-navigation2 ros-foxy-nav-msgs`; build from source: `hobot_stereonet` (stereo depth, D-Robotics), `Tofslam_ros2`, `voxel_filter` (cloud filtering), `pose_setter` (go-to-pose navigation).
3. **Build** — `source /opt/tros/humble/setup.bash && colcon build`.
4. **Calibration (kalibr, official Docker provided)** — checkerboard or aprilgrid; in order: stereo intrinsics, monocular intrinsics, IMU params, IMU↔RGB extrinsics. Capture uses `ros1_bridge` to convert topics into a ROS1 bag (needs Ubuntu 20.04 with both ROS1 + ROS2).
5. **Mapping** — tofSLAM (`Localization_mode: False` = mapping); output `final-voxel.pcd`; `pcd2pgm` converts it to a PGM grid map. During mapping the camera must see the complete AprilTag; after startup, stay still 3–4 s for IMU init.
6. **Go-to-pose navigation** — start Nav2 + the go-to-pose function; `pose_setter` uses an AprilTag to compute the robot→map transform and publish the initial pose, then requests goal points in turn. Nav2's obstacle layer overlays the point cloud to avoid obstacles lower than the lidar's height.

**Key nodes/repos used (cross-check in tros-node-catalog)** — `hobot_stereonet` (github.com/D-Robotics/hobot_stereonet), `mipi_cam` (stereo `device_mode:=dual` / `out_format:=nv12`), community repos `Tofslam_ros2` / `voxel_filter` / `pose_setter` / `pcd2pgm_package`. The AMR also uses the official `yolov8-seg` (deployed via hobot_dnn).

## Case 2 — CNN line-follower car (line_follower, X3 / X5)

**What it is** — a **CNN replaces the traditional threshold method** for sensing the guide line; a complete "collect → label → train → quantize → on-board inference → UART control loop" toolchain teaching case. Code repo **github.com/D-Robotics/line_follower** (the doc links the `develop` branch; the on-board perception sub-package is pulled per device: **`feature-x3` for X3, `feature-x5` for X5**).

**End-to-end pipeline:**
1. **Collect + label** — capture with tros.b `hobot_sensor` MIPI + cross-device comms, send images to a PC to label; `ros2 run line_follower_model annotation`, right-click the guide-line center to mark the target, Enter to save as `xy_[x]_[y]_[uuid].jpg`. Recommend **≥100 images**; re-collect when the environment/site changes.
2. **Train** — backbone **ResNet18**, framework **PyTorch** (CPU or GPU build); code `line_follower_model/training_member_function.py`; `ros2 run line_follower_model training`.
3. **Export ONNX** — `ros2 run line_follower_model generate_onnx` → `best_line_follower_model_xy.onnx`.
4. **Float→fixed (algorithm toolchain)** — code `line_follower/10_model_convert`; generate ~**100** calibration images, compile to **`resnet18_224x224_nv12.bin`** (uses the X3 5 TOPS BPU).
5. **On-board inference + control loop** — `line_follower_perception` (C++, `line_follower_perception.cpp`): copy the sub-package and fixed-point model to the board, `colcon build --packages-select line_follower_perception`, then `ros2 run line_follower_perception line_follower_perception --ros-args -p model_path:=./resnet18_224x224_nv12.bin -p model_name:=resnet18_224x224_nv12`. The camera grabs the forward image → CNN infers the guide-line coordinates → control policy → **UART issues motion commands**, closing the loop.

**Why it lives here** — the quantized artifact is the X-series `.bin` (`resnet18_224x224_nv12.bin`), running on the hobot_dnn / BPU runtime; conversion goes through the OpenExplorer (天工开物) toolchain (details in rdk-device's toolchain-workflow). This page only strings together "how the whole project flows"; for a single step, go to: model conversion → rdk-device, ready-made models → rdk-model-zoo, TROS nodes → this skill's [tros-node-catalog.md](tros-node-catalog.md).

## Cross-references

- Doc-site entry points and routing for these two cases: see rdk-doc-finder's doc-map "Application case" section.
- Locating the case repos (line_follower etc.): rdk-source-map.
- **S-series** official solutions (quadruped / humanoid / dual-arm) are community showcases rather than build tutorials — see rdk-ecosystem's "official solution showcase".
