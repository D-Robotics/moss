# RDK Board Baseline — Hardware & System Notes

> Source: D-Robotics RDK official docs + toolchain + reproduced practice. Each item keeps its provenance; technical facts are not rewritten.

Deep-dive material for this skill: common development traps and the full misconception→correction catalog.

## Common development traps

1. **USB camera crash** — 99% is the YUYV format → switch to MJPEG.
2. **Model path not found** — launch depends on the working directory → use `find` for the absolute path.
3. **pip install fails on the board** — no network or arch mismatch → download the aarch64 whl on a connected machine, then copy it over.
4. **`ros2` command not found** — TROS not sourced → `source /opt/tros/humble/setup.bash` (S600: `/opt/tros/jazzy/setup.bash`).
5. **`/app` is read-only** — write to `/tmp`, `/userdata`, or `$HOME`.
6. **Wrong GPIO numbering** — don't use Raspberry Pi numbers → check the current board's pinout.
7. **Wrong Docker image arch** — must use arm64/aarch64 images.
8. **hobot_dnn not found in venv** — must use system Python; virtual environments are unsupported.

## High-frequency user misconceptions → one-line correction

> When asked with these wrong premises, **correct first, then continue** — don't go along with the false premise.

| Misconception | Fact & correction |
|---------------|-------------------|
| "My X3-compiled `.bin` runs directly on X5" | No — different BPU march (X3 `bernoulli2` vs X5 `bayes-e`); recompile with the matching toolchain. |
| "Ultra is an overclocked X5" | No. Both are the "Bayes" family but the **marches differ — Ultra is `bayes`, X5 is `bayes-e`, and `.bin` artifacts do NOT interchange between them** (recompile per board). Ultra also has **~9.6× compute** (96 TOPS), 8 GB RAM, active cooling — a dedicated industrial/research board. |
| "I can't `apt install hb_mapper` on the board" | Correct — the toolchain runs in **host Docker**, not on the board; the board only has the runtime (`hobot-dnn`, `bpu_infer_lib_*`). |
| "S100 = domestic Jetson Orin" | Positioning is close but the architecture differs — Jetson is GPU + CUDA, S100 is **BPU + ONNX toolchain**; code can't port directly, you must reconvert the model. |
| "Only X3 has root/sunrise; X5/S-series differ" | No. Official RDK images generally ship **both `sunrise/sunrise` (normal) and `root/root` (super)** — X5, S100, S600 all do (FAQ Q on default accounts). `sunrise` is not X3-only; X3 logs in mainly as `sunrise`, while RDK Studio's SSH channel usually uses `root`. |
| "Models go in `/opt/hobot/model/rdkx5/`" | The real path is **`/opt/hobot/model/x5/`** (no `rdk` prefix); X3 is `/opt/hobot/model/rdkx3/` (which **does** have the `rdk` prefix — asymmetric for historical reasons). |
| "X5 can use `hrut_smi` / `bputop`" | **No.** RDK OS 3.x X5 images only ship `hrut_bpuprofile` + `hrut_somstatus`; `hrut_smi` is mainly on X3, `bputop` on X3/Ultra. Universal fallback: `cat /sys/devices/system/bpu/bpu0/ratio`. |
| "`apt upgrade` RDK OS 1.x → 3.x" | **No.** 1.x → 2.x/3.x requires **reflashing**; same-major upgrades must follow the official flow with backup. Studio never auto-runs a full `apt upgrade`. |
| "Put hobot_dnn in a venv" | No. The `hobot_dnn` Python bindings only work with **system Python** (`/usr/bin/python3`); conda/venv can't find them. |
| "`rosdepc` is a pip package" | No. `rosdepc` is D-Robotics' China-mirror-accelerated wrapper of `rosdep`, shipped with the TROS apt packages. |
| "RDK Studio = RDK hardware" | **RDK Studio is a desktop IDE workbench** (this very repo), running on a PC connected to an RDK board; it is not the board and isn't preinstalled on it (though it can cooperate with on-board OpenClaw). |
| "NodeHub and Model Zoo are the same" | Two repos: **NodeHub** is ROS2 node-level apps (developer.d-robotics.cc/en/nodehub, also surfaced in Studio); **Model Zoo** (`rdk_model_zoo` / `rdk_model_zoo_s`) is models + inference samples. |
| "RDK is Horizon's" | Brand: the current official name is **D-Robotics**; historically linked to Horizon — legacy "Horizon / 地平线" refers to the same line, normalize to D-Robotics. |
| "RDK S100 is the RoboSense lidar, right?" | **Completely different.** RDK S100 is D-Robotics' **compute dev board** (SoC + BPU); RoboSense's RS series are lidar sensors. Some articles confuse the two — just correct it. |
| "S600 has a Pi-style 40PIN" | **No** — S600 has no standard 40PIN; its CAN/UART/PCM use 1.8V self-locking connectors. S100/S100P **do** have a 40-Pin GPIO header (J24). |
| "CAN on S100/S600 is SocketCAN like X5 (`ip link set can0`)" | **No.** Only **X5** exposes CAN as **SocketCAN** (`can0` netdev, `cansend`/`candump`). **S100/S100P/S600 route CAN through the MCU domain (CANHAL)** — no `can0` netdev; the CAN lines sit on MCU-domain self-lock connectors (S600 also has a separate main-domain CAN connector, J17) and are driven via the MCU CAN HAL, not `ip link`. |
| "Run an LLM on S600 with `hobot_llamacpp`" | S600's on-board LLM stack is **`D-Robotics_LLM_S600` / `oellm_runtime`**, not the `hobot_llamacpp` node used elsewhere — use the S600 LLM runtime path. |

---
