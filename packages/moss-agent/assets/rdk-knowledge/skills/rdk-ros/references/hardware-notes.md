# RDK TROS/ROS2 — Hardware & System Reference

> Sources: D-Robotics official docs and repos — [tros_doc](https://github.com/D-Robotics/tros_doc) (TROS env, zero-copy), [hobot_stereonet](https://github.com/D-Robotics/hobot_stereonet), [livox_ros_driver2](https://github.com/D-Robotics/livox_ros_driver2). Facts re-checked 2026-06; only what the docs/repos state.

## TROS (TogetheROS.Bot)

- Based on **ROS2 Humble**, path `/opt/tros/humble/` (X3 / X5 / Ultra / S100 / S100P). **RDK S600 is ROS2 Jazzy**, path `/opt/tros/jazzy/` (Ubuntu 24.04, apt packages `tros-jazzy-*`).
- Preinstalled nodes live under `/opt/tros/humble/lib/<pkg>/` and `/opt/tros/humble/share/<pkg>/` (S600: `/opt/tros/jazzy/...`).
- Model files are usually in the package's `config/` directory: `*.bin` for X3/X5/Ultra, `*.hbm` for S100/S100P/S600 (matches the board's BPU architecture).
- Activate the env: `source /opt/tros/humble/setup.bash` (or `.../jazzy/...` on S600).
- **S100/S600 caveat:** some images only configured the TROS source in the `sunrise` user's `~/.bashrc`; `root` must run it manually, or `su - sunrise`.

**Common diagnostics**
- `ros2 pkg list | grep <name>` — is the package installed
- `ros2 pkg prefix <name>` — package install path
- `ros2 launch <pkg> <launch.py> --show-args` — tunable launch args
- `ros2 node list` / `ros2 topic list` — node and topic state

### Zero-copy (`/hbmem_img`)

Native ROS2 large-data transport has high latency/load, so TROS offers zero-copy via the RDK `hbmem` library. **tros.b Foxy** is a private implementation; **Humble and later (including Jazzy) use ROS2-native loaned messages** (`talker_loaned_message`). This is why many vision nodes subscribe `/hbmem_img` instead of `/image`.

## Stereo depth (`hobot_stereonet`)

- **Repo:** <https://github.com/D-Robotics/hobot_stereonet>
- **Board support:** per the README, RDK **X5 / X5 Module (Humble)** and **S100 / S100P**. Cross-architecture artifacts are not interchangeable (X5 = `.bin`, S-series = `.hbm`). Defer to the repo's current support table.
- **Calibration:** calibrate the stereo intrinsics/extrinsics first with a checkerboard, producing `left.yaml` / `right.yaml` / `extrinsics.yaml`; the path is given in the launch.
- **Topics:** input is the left/right spliced combined image on `/image_combine_raw` (optional `/image_combine_raw/right/camera_info`); the node runs as `StereoNetNode`, so outputs are `/StereoNetNode/stereonet_depth` (mm), `/StereoNetNode/stereonet_pointcloud2` (m), `/StereoNetNode/stereonet_visual` (older docs write these as `~/stereonet_*`). Depth is aligned to the left image.
- **Common pitfalls:**
  - Left/right timestamp skew **> 30 ms** badly degrades disparity accuracy — use a hardware trigger line or PTP time sync.
  - Model input size is per-eye (e.g. `640×352×3×2` or `544×448×3×2`, per the repo model); the depth map aligns to the left image.
  - Inference FPS varies by board/model — measure on the actual board.

## Livox lidar (`livox_ros_driver2`)

- **Repo:** <https://github.com/D-Robotics/livox_ros_driver2>
- **Supported models:** Mid-360 (automotive-grade compact), HAP (mass-production), Avia (development), etc.
- **Networking (defer to the repo `config/*.json`):** lidar over Ethernet + UDP; default subnet `192.168.1.x`.
  - **Mid-360:** factory IP `192.168.1.1XX` (XX = last two digits of the lidar SN, e.g. SN ending 02 → `192.168.1.102`); board host IP `192.168.1.50/24`; host-side port `561xx`.
  - **HAP:** device IP `192.168.1.100`, board host IP `192.168.1.5`; ports cmd 56000 / point 57000 / imu 58000 / log 59000.
  - Open the firewall for roughly UDP 56000-59000 (HAP) / 561xx (Mid-360).
- **Launch:** `ros2 launch livox_ros_driver2 msg_HAP_launch.py` (pick the launch by model).
- **Data types:** `livox_ros_driver2/msg/CustomMsg` (intensity + timestamp) or standard `sensor_msgs/PointCloud2`.
- **Common pitfalls:**
  - NIC `MTU < 1500` drops packets and makes the whole cloud sparse → `sudo ip link set dev eth0 mtu 1500`.
  - Wi-Fi bridging has insufficient bandwidth for lidar data — **must** be wired.
  - Recording point clouds to a rosbag is huge (HAP ~50 MB/s) — toggle recording as needed.
