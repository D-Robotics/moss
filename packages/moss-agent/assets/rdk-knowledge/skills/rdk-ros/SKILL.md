---
name: rdk-ros
description: TROS (TogetheROS.Bot) / ROS2 development on RDK boards — pick the right perception node for a capability (detection, segmentation, body/face/hand, stereo depth, 3D/lidar, VLM/LLM, audio), launch it with the correct platform and topics, debug "ros2 command not found" / package / launch problems, and follow the official end-to-end robot app cases (AMR, line-follower). Use whenever the user is on an RDK board and mentions TROS, ROS2, a perception node, a topic/launch/package, stereo depth, lidar, or a TROS app. 触发词:TROS、ros2 命令找不到、source /opt/tros、jazzy、humble、双目深度、stereonet、激光雷达、livox、点云、SLAM、nav2、人体检测、手势识别、人脸、YOLO 节点、dnn_node_example、hobot_dnn、ai_msgs、hbmem_img、巡线小车、AMR、感知节点用哪个。Routing — camera format/driver bringup (v4l2, MIPI sensor, no image) → rdk-device; GPIO/peripheral wiring → rdk-peripheral-cookbook; converting your own model to .bin/.hbm → rdk-device; ready-made model picking → rdk-model-zoo.
---

# RDK TROS / ROS2 Development

TROS (TogetheROS.Bot) is D-Robotics' ROS2 distribution for RDK boards. The single most common situation is **"I want capability X, which node do I run?"** — answer that from the node catalog, with the right **支持平台 (support platform)** and **topics** for the user's board. The second most common is **"ros2: command not found"** — that is almost always a missing `source`, not a broken install.

> Sources: facts verified against the official **[D-Robotics/tros_doc](https://github.com/D-Robotics/tros_doc)** (`docs/03_boxs/**`, `docs/04_apps/**`, `docs/05_tros_dev/**`) and per-node README support tables, plus **rdk_x_doc** `docs/06_Application_case/{amr,line_follower}.md`. Per-node platform/topic claims are taken from each node's own README, re-checked 2026-06.

## The one rule that matters most

`ros2` not found, or a TROS package "missing", almost always means the **environment was never sourced** — not a broken install. Source first, then diagnose:

- **X3 / X5 / Ultra / S100 / S100P** → `source /opt/tros/humble/setup.bash` (ROS2 **Humble**, Ubuntu 22.04, apt packages `tros-humble-*`).
- **RDK S600** → `source /opt/tros/jazzy/setup.bash` (ROS2 **Jazzy**, Ubuntu 24.04, apt packages `tros-jazzy-*`). **Never look for `/opt/tros/humble` on an S600**, and never look for `jazzy` on the others.
- Some S100/S600 images only configured TROS in the **`sunrise`** user's `~/.bashrc`. If `root` can't find `ros2`, `su - sunrise` and retry (the board also ships `root/root` and `sunrise/sunrise`).

## Board → TROS distro cheat-sheet

| Board(s) | Ubuntu | ROS2 distro | Setup path | apt prefix | On-board model artifact |
|----------|--------|-------------|------------|------------|-------------------------|
| RDK X3 / X3 Module | 20.04 (Foxy) or 22.04 | Foxy / **Humble** | `/opt/tros/humble/` | `tros-humble-*` | `.bin` |
| RDK X5 / X5 Module | 22.04 | **Humble** | `/opt/tros/humble/` | `tros-humble-*` | `.bin` |
| RDK Ultra | 22.04 | **Humble** | `/opt/tros/humble/` | `tros-humble-*` | `.bin` |
| RDK S100 / S100P | 22.04 | **Humble** | `/opt/tros/humble/` | `tros-humble-*` | `.hbm` |
| RDK S600 | **24.04** | **Jazzy** | `/opt/tros/jazzy/` | `tros-jazzy-*` | `.hbm` |

The same algorithm ships a **different model file per board** (`.bin` for X-series, `.hbm` for S-series; and within S-series the BPU march differs — **S100 = `nash-e` (`nashe`), S100P = `nash-m` (`nashm`), S600 = `nash-p` (`nashp`)**). Always swap the model filename in `launch` to match the board — see [tros-node-catalog.md](references/tros-node-catalog.md).

## Topic conventions (learn these once, the whole catalog reads easily)

TROS vision nodes name topics very consistently:

- **Image input** — `ros_img_sub_topic_name` (default `/image`, plain ROS2 image) **or** `sharedmem_img_topic_name` (default `/hbmem_img`, zero-copy shared memory; preferred for large frames / low latency). A sensor package (`mipi_cam` / `usb_cam` / `hobot_image_publisher` for file replay) publishes it.
- **AI result output** — set by each node's `ai_msg_pub_topic_name`, message type usually `ai_msgs::msg::PerceptionTargets`.
- **Cascaded subscribe** — downstream nodes (hand keypoints, face, reid, SAM) subscribe an upstream detection box via `ai_msg_sub_topic_name`, typically `/hobot_mono2d_body_detection`.
- **Web visualization** — the `websocket` package subscribes `image_topic` + `smart_topic`; open `http://<board-ip>:8000` in a browser.

## Workflows

### Workflow 1 — Environment confirm & package location

**Use when:** `ros2: command not found`, TROS env, can't find a launch/config, `ros2 pkg`, `colcon`.

1. **Source TROS** — `/opt/tros/humble/setup.bash` (or `/opt/tros/jazzy/setup.bash` on S600). If `ros2` still fails, try `su - sunrise` first.
2. **Verify** — `ros2 pkg list | head` returns ROS2/TROS package names.
3. **Locate the package, don't guess** — `ros2 pkg prefix <pkg>` gives the install path; if it errors, the package name or install is wrong.
4. **Find launch/config/model files** — `find /opt/tros -name "*launch.py"`. D-Robotics packages mostly use `*_launch.py` (a few use `*.launch.py`). Preinstalled nodes live in `/opt/tros/humble/lib/<pkg>/` and `share/<pkg>/`; model files sit in the package's `config/` (`*.bin` on X-series, `*.hbm` on S-series).
5. **Inspect a launch before running** — `ros2 launch <pkg> <launch.py> --show-args`. For a failing node, `ros2 run <pkg> <node> --ros-args --log-level debug`.

Never copy a relative config path between working directories — resolve absolute paths via `ros2 pkg prefix` / `find` on the actual board. Full command table: [ros-commands.md](references/ros-commands.md).

### Workflow 2 — Pick a perception node for a capability

**Use when:** "I want detection / segmentation / body / face / hand / gesture / stereo depth / 3D / lidar / VLM / audio but don't know which node."

1. Open [tros-node-catalog.md](references/tros-node-catalog.md) and find the capability's category (audio / body / classification / detection / segmentation / spatial / driver / function / generate, plus `apps`).
2. **Check the 支持平台 column against the user's board first** — many nodes are X5-only or S100-only. Suggesting an S100-only node to an X3 user is the most common mistake.
3. Read the subscribe/publish topics so you know how data flows in and out.
4. Copy the minimal `launch`, swapping the **model filename** for the board's artifact (`.bin` on X-series vs `.hbm` on S-series; within S-series `nashe` for S100, `nashm` for S100P, `nashp` for S600).
5. For detection/classification/segmentation, most share **`dnn_node_example`** (repo [hobot_dnn](https://github.com/D-Robotics/hobot_dnn)) — switch models via `dnn_example_config_file` rather than a different package.

### Workflow 3 — Stereo depth & lidar bringup

**Use when:** hobot_stereonet, double camera, Livox / Mid-360 / HAP lidar, point cloud sparse, packet loss.

- **Stereo depth (`hobot_stereonet`, X5 / S100 / S100P)** — calibrate the stereo pair first (checkerboard → `left.yaml`/`right.yaml`/`extrinsics.yaml`, path given in launch). Left/right timestamp skew **> 30 ms** badly degrades disparity — use a hardware trigger or PTP sync. Input is a left/right spliced combined image on `/image_combine_raw`; outputs are `/StereoNetNode/stereonet_depth` (mm), `/StereoNetNode/stereonet_pointcloud2` (m), `/StereoNetNode/stereonet_visual` (older docs write these as `~/stereonet_*`).
- **Livox lidar (`livox_ros_driver2`)** — must be **wired** (Wi-Fi bandwidth is insufficient). Keep NIC `MTU = 1500` (`sudo ip link set dev eth0 mtu 1500`) or the whole cloud goes sparse. Default subnet `192.168.1.x`; pick the launch by model (`ros2 launch livox_ros_driver2 msg_HAP_launch.py`). Details: [hardware-notes.md](references/hardware-notes.md).

### Workflow 4 — Full robot app cases (AMR / line-follower)

**Use when:** "build a working robot following the official guide" — autonomous navigation (AMR) or a CNN line-follower car, end to end.

Send the user to [app-cases.md](references/app-cases.md). These are complete TROS projects (sensor self-check → calibration → mapping/nav, or collect → label → train → quantize → on-board BPU inference). For a single node, stay in the catalog; the per-step deep dives route to rdk-device (model conversion) and rdk-model-zoo (ready-made models).

## Worked examples

**Example 1 — "在 S600 上 source /opt/tros/humble 报路径不存在"**
S600 is Ubuntu 24.04 with ROS2 **Jazzy**, so the path is `/opt/tros/jazzy/setup.bash`, not humble. Tell them to source jazzy; apt packages are `tros-jazzy-*`. If `ros2` still isn't found, the image may only have TROS configured for the `sunrise` user → `su - sunrise` and retry. (This board behaves differently from X5/S100 — those are Humble.)

**Example 2 — "我想做手势控制,该用哪个节点?"**
It's a cascade, not one node: `mono2d_body_detection` (body box) → `hand_lmk_detection` (hand keypoints) → `hand_gesture_detection` (gesture). All three support **X3 / X5 / X5 Module** (not S-series). For a ready-made full robot demo, point them at the `gesture_control` app (X3/X5). Give the launch lines from the catalog and note the cascade topics (`/hobot_mono2d_body_detection` → `/hobot_hand_lmk_detection`).

**Example 3 — "X5 上跑 YOLO 检测节点,直接用什么命令?"**
`dnn_node_example` with a YOLO config: `ros2 launch dnn_node_example dnn_node_example.launch.py dnn_example_config_file:=config/yolov5workconfig.json dnn_example_image_width:=1920 dnn_example_image_height:=1080`. Switch versions via `dnn_example_config_file` (X5 supports v2/v3/v5/v8/v10/v11/v12/yolo26; **S600 only v2/v3/v5**). Input `/hbmem_img`, output `hobot_dnn_detection`. Don't assume every YOLO version works on every board — check the board column.

**Example 4 — "双目深度图全是噪点,跑 hobot_stereonet 出来很差"**
Two usual causes: (1) the stereo pair was never calibrated → generate `left/right/extrinsics.yaml` and point the launch at them; (2) left/right timestamp skew > 30 ms → use a hardware trigger or PTP. Confirm the input is the combined image on `/image_combine_raw` and check `/StereoNetNode/stereonet_depth` is actually publishing. hobot_stereonet runs on X5 / S100 / S100P only.

## Common pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| Tell an S600 user to `source /opt/tros/humble` | S600 is Jazzy → `/opt/tros/jazzy/setup.bash` |
| Assume `ros2 not found` = broken install | Source the env first; try `su - sunrise` on S100/S600 |
| Recommend an S100-only node to an X3 user | Check the 支持平台 column before suggesting a node |
| Reuse the same model filename across boards | Swap `.bin`/`.hbm`, and the S-march infix (`nashe` S100 / `nashm` S100P / `nashp` S600) per board in launch |
| Guess the launch file path | `ros2 pkg prefix <pkg>` + `find /opt/tros -name "*launch.py"` |
| Run a Livox lidar over Wi-Fi | Wire it; keep MTU 1500 or the cloud goes sparse |
| Assume every YOLO version runs on every board | X5 = v2…v12/yolo26; S600 = v2/v3/v5 only |

## Reference map

| Read this | When |
|-----------|------|
| [tros-node-catalog.md](references/tros-node-catalog.md) | Picking a perception node — per-node package, role, key subscribe/publish topics, **support platform**, minimal launch, official doc, by category |
| [ros-commands.md](references/ros-commands.md) | ROS2/TROS command reference (launch, run, topic, node, pkg, colcon) with risk and supported boards |
| [app-cases.md](references/app-cases.md) | Building the full official AMR or line-follower robot end to end (hardware list → calibration → mapping/nav, or collect → train → quantize → on-board inference) |
| [hardware-notes.md](references/hardware-notes.md) | Deep dives: TROS env layout, hobot_stereonet calibration, Livox lidar networking |
| `scripts/tros_env.py` | Quick board → ROS2 distro / setup path / apt prefix / model artifact lookup |
