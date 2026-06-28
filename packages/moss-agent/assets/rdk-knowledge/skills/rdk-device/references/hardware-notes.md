# RDK Device Control & Model Deployment · Hardware and System Reference

> Source: compiled from official D-Robotics RDK documentation, the toolchain, and reproduced community practice; provenance preserved per item. Faithfully derived from the device-knowledge base — no technical facts altered.

This page gathers the RDK hardware/system topics this skill touches, organized section by section from official docs and field practice, for when you need the details.

## Section 19. The newcomer "0-to-1" standard path (X5-centric, covers ~90% of community questions)

> When a user picks up a board for the first time and says "how do I start", "run a demo", "getting started", or "out of the box", walk this checklist. Do **not** open with the BPU toolchain.

**Shortest path from an X5 out of the box to a first detection:**

```
[ 1 ] Flash the SD card        → RDK Studio flasher / Rufus; get the image from the developer.d-robotics.cc resource portal or the GitHub `D-Robotics/system_download` manifest. 3.x images default to Humble.
[ 2 ] Power + boot             → an official 5V/5A Type-C supply is REQUIRED; powering from a PC USB port ≈ repeated reboots.
[ 3 ] Read the indicator LEDs  → green power LED on = power OK; an orange status LED BLINKING = system healthy (the orange LED exists only on 3.1.0+ firmware; earlier boards only blink the green ACT LED).
[ 4 ] First-boot setup wizard  → first boot runs ~45 s of default environment setup; afterward use `sudo srpi-config` to set Wi-Fi / SSH / VNC / locale.
[ 5 ] Network + get the IP      → `nmcli dev wifi connect "SSID" password "pwd"` (S-series also has `wifi_connect "SSID" "PWD"`) → `ip addr`.
[ 6 ] SSH login                → every board ships with BOTH `root/root` and `sunrise/sunrise` (the desktop autologin uses `sunrise`); `ssh root@<ip>` or `ssh sunrise@<ip>`. **S100/S600 management port eth1 is factory-fixed at `192.168.127.10`.**
[ 7 ] First detection demo (preinstalled) → `cd /app/pydev_demo/02_detection_sample/ && sudo python3 ...` (follow the README inside the directory; X5 3.5.0+ layout is below).
[ 8 ] Live web detection       → `cd /app/pydev_demo/09_web_display_camera_sample/`, then open `http://<ip>:8000` in a browser.
```

**X5 `/app/pydev_demo/` preinstalled sample list** (**software 3.5.0+**, named by task, loaded via `hbm_runtime`; no model conversion needed):

| Directory | Function |
|-----------|----------|
| `01_classification_sample/` | Image classification |
| `02_detection_sample/` | Object detection (contains `01_ultralytics_yolov5x` / `02_yolo11` / `03_yolov8` / `04_yolov10`) |
| `03_instance_segment_sample/` | Instance segmentation |
| `04_pose_sample/` | Pose estimation |
| `05_open_instance_segment_sample/` | Open-vocabulary instance segmentation |
| `06_segment_sample/` | Semantic segmentation |
| `07_usb_camera_sample/` | USB camera capture |
| `08_mipi_camera_sample/` | MIPI camera capture |
| `09_web_display_camera_sample/` | Web-browser inference display (port 8000, best for demos) |

> **Version / board differences:** (1) Older X5 (<3.5.0) and X3 use a different, numbered list (`01_basic_sample` / `07_yolov5_sample` / `09_yolov5x_sample`, etc., via `pyeasy_dnn`); always go by the actual `ls /app/pydev_demo/` on the board. (2) **S-series (S100/S600)** preinstalled samples also live under `/app/pydev_demo/` (S100 as `01_classification_sample/01_resnet18`, S600 as `classification_sample/resnet18` with no numeric prefix), all loaded via `hbm_runtime` (`HB_HBMRuntime`) reading `.hbm`, with default models in `/opt/hobot/model/{s100|s600}/basic/` and Python ≥ 3.10.

**Three "milestone achievements" for newcomers** (increasing difficulty):
1. **Run the preinstalled YOLOv5** → 5 minutes → "board is fine + BPU works".
2. **Watch live detection via the web sample** → 10 minutes → camera + BPU + network working together.
3. **Run a model you trained yourself** → half a day to several days → enters the "full model-deployment pipeline" (next section).

## Section 20. Full model-deployment pipeline and high-frequency pitfalls (**the core user pain point**)

> Community data: ~60%+ of newcomers get stuck at this step. The moment a user says ".pt copied over and run" / "inference is super slow" / "YOLO conversion failed" or any similar keyword → **warn first, then continue**; do not just follow along with what they are doing.

**Iron rule #1 — a `.pt` / raw `.onnx` cannot be accelerated on the BPU:**
- Native PyTorch / ONNX Runtime on an RDK board run on **CPU only**; the BPU does not participate at all → typically just **1–2 FPS**.
- When a user says "my model only gets X FPS on the board" / "I deployed the .pt directly" → **immediately** tell them to go through the full `.pt → .onnx → .bin` pipeline, otherwise it is pointless.
- Plenty of community blog posts confirm this (CSDN: "deploying the .pt directly is slow, the video stream is very laggy").

**Full pipeline (host + board):**

```
[Host x86 / Docker]                      [Board aarch64]
─────────────────                        ──────────────
[1] Train in PyTorch/TF
[2] Export ONNX (use the vendor fork) ──▶
[3] hb_mapper checker validates ops
[4] Prepare calibration set (~100 imgs)
[5] hb_mapper makertbin quantize+convert
[6] Get .bin (X3/X5/Ultra) / .hbm (S100/S100P/S600) ──▶ [7] scp to the board /userdata/models/
                                         [8] Load & infer: X3/X5/Ultra use hobot_dnn / ROS2 node; S-series use hbm_runtime
                                         [9] hb_eval_perf to measure fps/latency
```

> Note: `hb_mapper → .bin` is the X3/X5/Ultra (Bernoulli2/Bayes) path. **S100/S100P/S600 (Nash) go through the D-Robotics OpenExplorer (天工开物) toolchain, the artifact is `.hbm`, and the board loads it with `hbm_runtime`.** The S-series host tool is `hb_compile` (not `hb_mapper`).

**Step-by-step pitfalls (all are real, repeatedly seen in the community):**

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Exporting ONNX with the default ultralytics export script | `hb_mapper checker` reports unsupported ops / conversion succeeds but the on-board boxes are all wrong | Use the **official `ultralytics/yolov5` repo** (not a D-Robotics fork), but modify the Detect output head per the [model_zoo YOLOv5 doc](https://github.com/D-Robotics/rdk_model_zoo/blob/rdk_x3/demos/detect/YOLOv5/README_cn.md) (strip post-processing, emit 4-D NHWC). Both `tag v2.0` (LeakyReLU) and **`tag v7.0` (Sigmoid)** are supported (modify the output head per the doc for each); it is **not** "v2.0 only". |
| Docker won't pull / won't start | User installed WSL2 + Docker on Windows, config errors keep it from launching | Prefer the **official D-Robotics Docker image** (OpenExplorer / 天工开物); for WSL2 run `wsl --update`; allocate ≥ 8 GB RAM; the image is large, so inside China pull the CPU version first. |
| Wrong ONNX opset | `hb_mapper checker` reports unsupported ops | Pin the export to `opset10`/`opset11` (`ir_version ≤ 7`) per the toolchain docs; X3 Bernoulli2 is stricter, S-series Nash is the most permissive. |
| Missing calibration set / accuracy collapses 30%+ | Conversion succeeds but on-board mAP drops sharply | You must prepare **~50–100 images** matching the training-set distribution for PTQ; the calibration set determines accuracy when quantization is enabled. |
| OOM during conversion | The large-model `hb_mapper makertbin` process gets killed | Host RAM ≥ 16 GB, or use ZRAM; try YOLOv5s first rather than going straight to YOLOv5x. |
| Wrong `march` value | e.g. `hb_mapper checker --march bayes-e` — `bayes-e` cannot be used for X3 | X3 → `bernoulli2` / X5 → `bayes-e` / Ultra → `bayes` / **S100 → `nash-e`, S100P → `nash-m`** (official FAQ) / S600 → `nash-p`; the S-series uses the OpenExplorer (天工开物) toolchain with `hb_compile`, artifact `.hbm`, board runtime `hbm_runtime`. |
| Board runtime version mismatched with the `.bin` | `libdnn` / `hobot_dnn` fails to initialize | `dpkg -l \| grep hobot-dnn` to check the on-board version; upgrade `hobot-dnn` / the BPU runtime per the official release notes if needed. |
| `import hobot_dnn` inside a virtualenv | `ModuleNotFoundError` | The `hobot_dnn` Python bindings only work with the system Python `/usr/bin/python3`; conda/venv all fail — a repeated community trap. |

**Moss response script (when facing a model-deployment problem):**
1. First confirm the **model's current state** (`.pt` / `.onnx` / `.bin`? on the host or on the board?).
2. **If a `.pt` / `.onnx` is being run directly on the board:** interrupt immediately and explain the three-step pipeline.
3. Pin down the **board → matching toolchain** (X3 uses OE v1, X5/Ultra use OE v2, S-series uses the OpenExplorer/天工开物 OE with `hb_compile`).
4. On a conversion error, **don't guess** — ask the user to paste the first 30 lines of the `hb_mapper`/`hb_compile` error log.
5. Only discuss the deployment path (`/userdata/models/` or a TROS package `config/`) after a successful conversion.
