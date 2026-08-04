---
name: rdk-device
description: End-to-end deployment of a user's OWN model on RDK boards — quantize .pt/.onnx into .bin (X3/X5/Ultra) or .hbm (S100/S100P/S600) through the BPU toolchain — plus first-boot/network setup, camera bringup, and on-board inference debugging. Use whenever the user is deploying a self-trained model, reports slow inference (1-2 FPS, "pt 拷上去很慢"), is doing first boot / 开箱 / 入门, or debugging a camera or 推理 pipeline. 触发词:部署模型、YOLO 转换、hb_mapper、hb_compile、量化、.bin/.hbm、pt 直接跑很慢、BPU 推理、首次开箱、新手上手、摄像头无画面、v4l2。Routing — ready-made precompiled models → rdk-model-zoo; inference as a ROS node / stereo depth / lidar → rdk-ros; embodied ACT/VLA/Pi0 BPU compile → rdk-embodied-lerobot; pure error-code lookup → rdk-board-knowledge.
trigger: deploy model, model deployment, onnx, quantize, hb_mapper, hb_compile, v4l2, mipi camera, 部署模型, 量化, 摄像头无画面
trigger: deploy model, model deployment, connect rdk board, on-board inference, camera bringup, onnx, quantize, hb_mapper, hb_compile, v4l2, mipi camera, 连接开发板, 部署模型, 模型量化, 板端推理, 摄像头调试
stable_id: rdk-device
summary: Connect, prepare, deploy, and verify models or camera pipelines on an identified RDK board.
inputs: board-profile, model-artifact
outputs: connected-board-workspace, deployed-model
after: rdk-board-knowledge
before: rdk-ros
requires_board: true
---

# RDK Device Deployment

Take a user's trained model from `.pt`/`.onnx` to a working on-board BPU deployment, and get a fresh board booted, networked, and running a camera. The single most common failure is copying a `.pt`/`.onnx` straight onto the board — it runs on CPU only and the user blames the hardware. **Catch that first, then run the toolchain loop.**

> Sources: official D-Robotics docs (rdk_doc / rdk_x_doc / rdk_s_doc), the OpenExplorer/天工开物 toolchains, and reproduced community cases. Facts are carried over verbatim with provenance; nothing is invented.

## The one rule that matters most

**A `.pt` or raw `.onnx` does NOT use the BPU.** PyTorch / ONNX Runtime on an RDK board run on CPU, so the 40+ TOPS NPU sits idle and the user sees **1–2 FPS**. When someone says *"I deployed YOLOv5 and it's super slow / video is laggy / FPS won't go up / I copied my pt over"* — **interrupt before tuning anything** and explain they must run the BPU toolchain (`.pt → .onnx → .bin`/`.hbm`). Tuning a CPU-path model is wasted effort.

## Board → toolchain cheat-sheet (the foundation)

Confirm the board first (`cat /sys/class/socinfo/board_id`), then everything downstream follows from this table. Cross-architecture artifacts are **never** interchangeable — a `.bin` will not load on Nash, and different `march` values are mutually incompatible.

| Board | BPU arch | `march` | Host tool | Artifact | On-board runtime |
|-------|----------|---------|-----------|----------|------------------|
| RDK X3 | Bernoulli2 | `bernoulli2` | `hb_mapper` | `.bin` | `hobot_dnn` (`pyeasy_dnn`) |
| RDK X5 | Bayes-e | `bayes-e` | `hb_mapper` | `.bin` | `hbm_runtime` (3.5.0+) / `pyeasy_dnn` (older) |
| RDK Ultra | Bayes | `bayes` | `hb_mapper` | `.bin` | `hobot_dnn` |
| RDK S100 | Nash-e | `nash-e` | `hb_compile` | `.hbm` | `hbm_runtime` |
| RDK S100P | Nash-m | `nash-m` | `hb_compile` | `.hbm` | `hbm_runtime` |
| RDK S600 | Nash | `nash-p` | `hb_compile` | `.hbm` | `hbm_runtime` |

`march` values come from the official FAQ (Super100=Nash-e, Super100P=Nash-m); S600=`nash-p` confirmed via the LLM SDK's `resolve_model_nash-p.md`. A quick selector script is in `scripts/toolchain_selector.py`.

**Two iron rules:**
- ✅ The toolchain (`hb_mapper`/`hb_compile`) runs on an **x86 host inside Docker**. The board only has the runtime.
- ❌ Never tell the user to `apt install hb_mapper` **on the board** — it doesn't belong there.

## Workflows

### Workflow 1 — First boot, network, and Studio (0-to-1 onboarding)

**Use when:** "how do I start", 新手, 刚拿到板, 开箱, 入门, first boot, can't connect after flashing.
**Do NOT** open with BPU architecture or toolchains. Walk the board up first:

1. **Flash** — RDK Studio flasher / Rufus / balenaEtcher; image from `developer.d-robotics.cc` or GitHub `D-Robotics/system_download`. (S-series boards flash via `xburn`, not SD — see rdk-board-knowledge.)
2. **Power** — **official supply required**: X5 needs 5V/5A, Ultra 12V/5A DC, S600 12–28V DC. A laptop USB port causes repeated reboots.
3. **Indicator light** — green = power OK; **orange status light blinking = system healthy** (orange exists on 3.1.0+ firmware only; earlier boards just blink the green ACT LED).
4. **First config** — `sudo srpi-config` for Wi-Fi / SSH / VNC / locale (not available on Ultra). First boot does ~45s of default setup.
5. **Get IP** — `nmcli dev wifi connect "SSID" password "PWD"` (S-series also has `wifi_connect "SSID" "PWD"`), then `ip addr`.
6. **SSH** — every board ships with **both** `root/root` and `sunrise/sunrise` (desktop autologin uses `sunrise`). **S100/S600 management port `eth1` is fixed at `192.168.127.10`.**
7. **Run a preinstalled demo** — `ls /app/pydev_demo/` first, then run a detection sample (see Workflow 3 for the directory layout). Push `09_web_display_camera_sample/` (browser at `http://<ip>:8000`) — it's the best 2-minute "it works" demo.

If flashing fails or the orange light never blinks → suspect **image checksum** and **SD card quality** (≥8GB Class 10) before blaming the flasher.

### Workflow 2 — Model conversion & deployment loop (the core)

**Use when:** 部署模型, YOLO 转换, hb_mapper, pt 直接跑很慢, BPU 推理.

1. **Confirm the board** → read the cheat-sheet row. `cat /sys/class/socinfo/board_id` (X3 fallback: `som_name`).
2. **Export ONNX correctly (host)** — clone the **official `ultralytics/yolov5`** repo and modify the **Detect output head** per the [model_zoo YOLOv5 doc](https://github.com/D-Robotics/rdk_model_zoo/blob/rdk_x3/demos/detect/YOLOv5/README_cn.md) (strip post-processing, emit 4-D NHWC). Both `v2.0` (LeakyReLU) and `v7.0` (Sigmoid) work — it is **not** "v2.0 only", and you do **not** need a D-Robotics fork.
3. **Quantize (host Docker)** — the command differs by family, don't mix them:
   - **X3/X5/Ultra:** `hb_mapper checker` (op support) → ~50–100 calibration images → `hb_mapper makertbin --config x.yaml` → `.bin`
   - **S100/S100P/S600:** the tool is **`hb_compile`**, not hb_mapper → `hb_compile --model x.onnx --march nash-e` (validate) → ~100 calibration images (`horizon_tc_ui` transformer → `.npy`) → `hb_compile --config x.yaml` → `.hbm` (+ `*_quantized_model.bc` HBIR for x86 accuracy comparison)
   - Config templates: `assets/templates/x_series_hb_mapper_config.yaml` and `assets/templates/s_series_hb_compile_config.yaml`. Full command reference: [toolchain-workflow.md](references/toolchain-workflow.md).
4. **Deploy** — `scp <model>.bin|.hbm root@<ip>:/userdata/models/`. Load with `hobot_dnn`/TROS `dnn_node_example` (X3/X5/Ultra) or `hbm_runtime` (S-series).
5. **Verify the BPU is actually working** — `hb_eval_perf` for latency/FPS, and `hrut_bpuprofile -b 0` on-board: if BPU utilization doesn't move during inference, you're still on the CPU path.

If conversion fails on an op → check the [official supported-op list](https://developer.d-robotics.cc/rdk_x_doc/Advanced_development/toolchain_development/intermediate/supported_op_list) (Transformer ops are only partially supported, Nash only). To write the actual load+inference code on-board, see [board-inference-api.md](references/board-inference-api.md).

### Workflow 3 — Preinstalled demos & camera bringup

**Preinstalled demos** live in `/app/pydev_demo/`. **Always `ls` it first — don't recite directory numbers from memory:**
- **X5 3.5.0+:** 9 task-named dirs (`01_classification_sample` … `09_web_display_camera_sample`), loaded via `hbm_runtime`.
- **Older X5 / X3:** numbered list (`01_basic_sample`, `07_yolov5_sample`, …), via `pyeasy_dnn`.
- **S-series:** also under `/app/pydev_demo/` (S100 like `01_classification_sample/01_resnet18`, S600 like `classification_sample/resnet18`), via `hbm_runtime`, models in `/opt/hobot/model/{s100|s600}/basic/`.

**Camera bringup — follow this order, don't skip:**
1. Enumerate: `ls /dev/video*` + `lsusb` (USB) or `dmesg | grep -i mipi` (MIPI).
2. List real formats: `v4l2-ctl -d /dev/video0 --list-formats-ext` → find MJPEG resolution+fps.
3. Configure launch to **MJPEG + an exactly-matching resolution**; validate at 640×480 first.
4. Confirm the image topic is healthy (`ros2 topic list`) **before** attaching any inference node.

If the same error repeats twice, stop retrying the same parameter — check rdk_doc and the board log instead. Camera command details: [camera-commands.md](references/camera-commands.md).

## Worked examples

**Example 1 — "I deployed YOLOv5 on my X5 but it's only 2 FPS"**
Don't suggest threading/resolution tweaks. Respond: *"2 FPS means it's running on CPU — a raw `.pt`/`.onnx` never touches the BPU. You need to convert it: export ONNX from official ultralytics/yolov5 with a modified Detect head, then `hb_mapper makertbin --march bayes-e` on an x86 Docker host to get a `.bin`, scp it to `/userdata/models/`, and load with hobot_dnn. Confirm with `hrut_bpuprofile -b 0` that BPU utilization moves."* Then point to Workflow 2.

**Example 2 — "What march do I use to convert a model for S600?"**
*"`nash-p`, and the tool is `hb_compile` (not hb_mapper) since S600 is Nash → produces `.hbm`, loaded on-board with hbm_runtime. S100=nash-e, S100P=nash-m for comparison."* (You can run `scripts/toolchain_selector.py s600`.)

**Example 3 — "Just got my board, how do I start?"**
Do not mention BPU. Walk Workflow 1: flash → official power → check the light → `srpi-config` → get IP → SSH (`root/root` or `sunrise/sunrise`) → run `09_web_display_camera_sample`. Confirm the board is healthy before any model talk.

**Example 4 — "My USB camera shows no image"**
Walk Workflow 3's camera order: `ls /dev/video*` + `lsusb` → `v4l2-ctl --list-formats-ext` → set launch to MJPEG at a listed resolution → test 640×480 → check `ros2 topic list`. Don't tweak launch params before confirming the device node and format.

## Common pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| Tune FPS on a `.pt`/`.onnx` running on-board | Convert through the BPU toolchain first |
| `apt install hb_mapper` on the board | Run the toolchain on an x86 Docker host |
| Use the same `march`/artifact across families | Match the cheat-sheet row exactly (`.bin` ≠ `.hbm`) |
| Power from a laptop USB port | Use the official supply (5V/5A, 12V/5A, etc.) |
| Recite `/app/pydev_demo/` dir names from memory | `ls /app/pydev_demo/` on the actual board |
| `import hobot_dnn` inside conda/venv | Use system `/usr/bin/python3` (bindings are system-only) |

## Reference map

| Read this | When |
|-----------|------|
| [toolchain-workflow.md](references/toolchain-workflow.md) | Converting a model — full `hb_mapper`/`hb_compile` commands, Docker setup, config.yaml structure, Nash op constraints |
| [board-inference-api.md](references/board-inference-api.md) | Model is converted, now writing on-board inference code — `pyeasy_dnn` vs `HB_HBMRuntime` vs C++ `libdnn`, run() forms, scheduling params, sample matrix |
| [camera-commands.md](references/camera-commands.md) | Camera command details (v4l2, MIPI sensors) |
| [hardware-notes.md](references/hardware-notes.md) | Deep dives: the 0-to-1 standard path and the full deployment-pitfalls catalog |
| `scripts/toolchain_selector.py` | Quick board → march/tool/format/runtime lookup |
| `assets/templates/*.yaml` | Starting-point config files for conversion |
