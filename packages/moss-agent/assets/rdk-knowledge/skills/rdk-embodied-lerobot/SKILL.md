---
name: rdk-embodied-lerobot
description: Deploy a trained embodied-AI policy onto an RDK board — LeRobot ACT imitation policies and Pi0 VLA (openpi) — by exporting to ONNX, compiling to a BPU `.hbm`, and running the on-board control loop that drives a robot arm. Use whenever the user has an ACT checkpoint or a Pi0 model and wants it on RDK S100/S100P/S600, mentions export_bpu_actpolicy.py / bpu_control_robot.py / build_all.sh / hbm-runtime / openpi_runtime / piper_node, or asks "怎么把 ACT 部署到板上 / Pi0 怎么跑". 触发词:具身智能、ACT 部署、模仿学习策略上板、LeRobot 上 RDK、Pi0、openpi、VLA、视觉语言动作、机械臂策略、bpu_control_robot、export_bpu_actpolicy、SO-101 跑到 S100、双臂 mango。Routing — generic .onnx→.bin/.hbm quantization (non-policy models) → rdk-device; ros2 commands/env → rdk-ros; on-board LLM/VLM chat & voice → rdk-llm-deployment; S100 CPU/BPU/MCU heterogeneous split, firmware burn, board-agent handoff → rdk-board-delegate; raw error-code lookup → rdk-board-knowledge.
---

# RDK Embodied AI: LeRobot ACT & Pi0 VLA Deployment

Take a trained robot-control **policy** and run it on an RDK board's BPU: a LeRobot **ACT** imitation policy, or a **Pi0 / openpi VLA** model. This skill owns the **software deployment** half only — exporting a checkpoint to ONNX, compiling it to `.hbm` in the OpenExplorer (OE) Docker toolchain, and running the on-board control loop.

**The single most important thing:** a board can only run an **OE-compiled `.hbm`**. It cannot run a raw `.pt`/ONNX policy, and the on-board control script (`bpu_control_robot.py`) loads `.hbm` + `.npy` normalization files, never the PyTorch checkpoint. If the user copied a checkpoint to the board expecting it to drive the arm, stop and route them through the export→compile loop first.

> Sources: official D-Robotics repos [rdk_LeRobot_tools](https://github.com/D-Robotics/rdk_LeRobot_tools) (`stable` / `s100` / `s600` branches), [openpi_runtime](https://github.com/D-Robotics/openpi_runtime) (`develop`), [huggingface.co/D-Robotics/openpi](https://huggingface.co/D-Robotics/openpi). Every non-trivial claim below is verified against those READMEs/scripts.

## Scope boundary — read this before answering

This skill covers **trained policy → BPU → on-board control loop ONLY.**

- ✅ In scope: export ACT to ONNX, compile to `.hbm`, board-side `hbm-runtime` / C++ BPU runtime, `bpu_control_robot.py`, Pi0 client-server runtime.
- ❌ Out of scope (it's **upstream LeRobot**, not this repo): SO-101/SO-100 arm assembly, motor ID setup, zero-point **calibration** (`lerobot-calibrate`), teleoperation data collection (`lerobot-record`), ACT training (`lerobot-train`), serial ports/baud. Point the user to [huggingface/lerobot](https://github.com/huggingface/lerobot) and the [SO-101 docs](https://huggingface.co/docs/lerobot/so101) for that front half.

## Which path / which branch (decision cheat-sheet)

Pick the path first, then the branch — they pin different LeRobot versions and toolchain settings.

| Goal | Path | Repo + branch | Board | `march` | LeRobot |
|------|------|---------------|-------|---------|---------|
| ACT on S100, current | ACT | `rdk_LeRobot_tools` **`s100`** | S100 (Nash-e) | `nash-e` | upstream HF **v0.5.2** |
| ACT on S600, current | ACT | `rdk_LeRobot_tools` **`s600`** | S600 (Nash) | `nash-p` | upstream HF **v0.5.2** |
| ACT, legacy v2.1 datasets | ACT | `rdk_LeRobot_tools` **`stable`** | S100 | `nash-e` | **D-Robotics fork** |
| Pi0 VLA dual-arm | VLA | `openpi_runtime` **`develop`** | S600 (Nash) | (pre-quantized HBM) | n/a |

**Critical, recently-changed facts** (the old guidance was the reverse — fix it):

- The **active `s100`/`s600` branches use UPSTREAM `huggingface/lerobot` v0.5.2** and explicitly say *"Do not use the outdated `D-Robotics/lerobot` fork."* The fork is **only** for the legacy `stable` branch (locked `datasets`, v2.1 datasets).
- ACT is now **verified on both S100 (`nash-e`) and S600 (`nash-p`)** via their dedicated branches. The `stable` branch README only claims S100; S100P shares the S100/Nash-e path. Other boards (X5/`bayes*`) are NOT verified — the export script has a bayes branch, but compiling a `.bin` ≠ a verified end-to-end arm deployment. State that boundary honestly.
- Both S100 and S600 ACT branches require the **OE 3.7.0 S100/S600 toolchain** for compilation.

## Workflow A — LeRobot ACT deployment (three stages)

> Full commands, `bpu_export_config.yaml` fields, and the C++ runtime build are in [lerobot-workflow.md](references/lerobot-workflow.md).

**Stage 1 — Dev machine: export ONNX + compile configs**

1. Set up the env. For the **current** path use upstream LeRobot, NOT the fork:
   ```bash
   git clone https://github.com/huggingface/lerobot.git && cd lerobot
   git clone https://github.com/D-Robotics/rdk_LeRobot_tools.git
   cd rdk_LeRobot_tools && git checkout s100   # or s600
   cd .. && pip install -e ".[feetech]"
   pip install onnx onnxsim termcolor tqdm safetensors
   ```
2. Edit the export YAML — `dataset.root`, `act_path` (ACT checkpoint dir with `config.json` + `model.safetensors`), and `type` = the `march` (`nash-e` for S100, `nash-p` for S600). On the s600 branch use the dedicated `bpu_export_config_s600_calfix.yaml`.
3. `python export_bpu_actpolicy.py --config <yaml>` → produces `export_path/` with **two** ONNX submodels (`BPU_ACTPolicy_VisionEncoder`, `BPU_ACTPolicy_TransformerLayers`), per-model OE configs, calibration data, `bpu_output/` normalization `.npy`, and `build_all.sh`. (ACT is split: VisionEncoder `images → [1,512,15,20]`; TransformerLayers `states + features → Actions [1,100,6]`.)

**Stage 2 — Dev machine: compile ONNX → `.hbm`**

4. Inside the **OE 3.7.0 Docker** (x86 host, NOT the board) run `cd export_path && bash build_all.sh`. The OE toolchain (`hb_compile`) only accepts ONNX. Output: `bpu_output/*.hbm` plus the `.npy` files and `new_actions.npy` (pre-conversion PyTorch output, for accuracy checking).
5. `scp` the whole **`bpu_output/`** folder to the board.

**Stage 3 — Board: load `.hbm` and drive the arm**

6. On the board, set up the runtime (branch-specific — see the pitfalls table for the Python-3.12 trap):
   - **s600 branch:** clone upstream lerobot + tools (`git checkout s600`), `pip install -e ".[feetech]"`, `pip install hbm-runtime`.
   - **s100 branch:** Python **3.12** venv, then **build the bundled `bpu_runtime/` C++ pybind11 extension** — the PyPI `hbm-runtime` wheel is Python-3.10-only and won't import. It builds `bpu_act_runtime.*.so` exposing `BPUACTRuntime`, a drop-in for `hbm_runtime.HB_HBMRuntime`.
7. Run the control loop:
   ```bash
   python bpu_control_robot.py --bpu-act-path ./bpu_output
   ```
   Key flags: `--bpu-act-path` (dir with `.hbm` + `.npy`), `--fps` (default 30), `--inference-time` (run seconds), `--robot-port` (default `/dev/ttyACM0`), `--camera-index/--camera-name` (default `front`). Default robot is **`so101`** (change `make_robot("so101")` in code for another arm).
8. **Verify correctness:** compare board BPU output against `new_actions.npy` from the export step before trusting the arm.

## Workflow B — Pi0 / openpi VLA (client-server, S600)

> Minimal run sheet and data spec in [lerobot-workflow.md](references/lerobot-workflow.md) section B.

Pi0 is a **Vision-Language-Action** runtime on **RDK S600 (Ubuntu 24.04 / ROS2 Jazzy)** driving a **dual-arm** setup. It is **client-server**, not a single board process:

- **Client = the S600 inference node** (`s600_inference_node`): time-synchronizes multi-camera ROS2 topics (`TopicTimeSynchronizer`, 100 ms window), preprocesses, calls the server, then smooths and executes actions.
- **Server = Pi0 inference (OE-LLM)**: predicts the action sequence; `piper_node` drives the arm over CAN (`can0`).
- **Input:** 3× images `[3,224,224] uint8` (head, left wrist; right wrist is a black placeholder) + state `[14] float32` + a text prompt (e.g. `"put the yellow mango on the blue plate"`).
- **Output:** action sequence `[50,14] float32` (50 steps × [6 joints + gripper] per arm).
- **Latency (reference):** collect 0.1 ms / preprocess 3.2 ms / **inference 192.5 ms (server)** / postprocess 0.1 ms / execution ~700.5 ms. Action smoothing = 10-step interpolation in, first-order low-pass (`alpha=0.15`) in the middle, 10-step interpolation out; gripper bypasses filtering.
- **Models:** pre-quantized HBM + `norm_stats.json` from [huggingface.co/D-Robotics/openpi](https://huggingface.co/D-Robotics/openpi); the `norm_stats.json` lives under `<task>/torch/assets/trossen/` and must match the model.

Steps: download HBM + `norm_stats.json` → `conda create -n s600_pi0 python=3.12` + `pip install -r resource/requirements.txt` → `colcon build --packages-select openpi_runtime` → launch the two D457 cameras, then `piper_node`, then `s600_inference_node` (all with the same `ROS_DOMAIN_ID`). Inference connects to the Pi0 server on **port 8888**.

## Worked examples

**Example 1 — "我训练好了一个 SO-101 的 ACT 策略,怎么部署到 RDK S100 上?"**
Walk Workflow A. Stage 1: clone **upstream** `huggingface/lerobot` (not the fork) + `rdk_LeRobot_tools` `s100` branch, set `type: nash-e` and `act_path` in the export YAML, run `export_bpu_actpolicy.py` → two ONNX submodels. Stage 2: in OE 3.7.0 Docker run `build_all.sh` → `bpu_output/*.hbm`. Stage 3: on the board build the `bpu_runtime/` C++ extension (Python 3.12, PyPI hbm-runtime won't import), then `python bpu_control_robot.py --bpu-act-path ./bpu_output`. Note that arm assembly/calibration/data collection are upstream LeRobot, not this repo.

**Example 2 — "S600 上跑 ACT,march 填什么?跟 S100 一样吗?"**
No — S600 uses **`nash-p`** (S100 uses `nash-e`), via the `rdk_LeRobot_tools` **`s600`** branch and `bpu_export_config_s600_calfix.yaml`. Both need OE 3.7.0. S600 board-side install uses `pip install hbm-runtime` directly (the Python-3.12 C++ extension build is the s100-branch path). Artifact is `.hbm` either way.

**Example 3 — "Pi0 / openpi 是不是直接在板子上跑就行?"**
No — it's **client-server**. The S600 board runs the *client* (`s600_inference_node`: camera sync + preprocess + execute) and `piper_node` (arm control over CAN); the **Pi0 model runs on the server (OE-LLM)** and is reached on port 8888. Inputs are 3 images + a `[14]` state + a text prompt; output is `[50,14]` actions. Get the HBM model + matching `norm_stats.json` from huggingface.co/D-Robotics/openpi.

**Example 4 — "我直接用 huggingface 最新的 lerobot 装,加载老数据集报错了"**
Two cases. If you're on the **current** `s100`/`s600` branches, they target upstream **v0.5.2** with new-format datasets — re-collect or convert, and don't use the D-Robotics fork. If you must load **legacy v2.1 datasets**, switch to the **`stable`** branch and use the **D-Robotics/lerobot fork** (locked `datasets`), or pin `datasets==2.19.0` on upstream. Mixing a current branch with v2.1 data (or vice-versa) is the usual cause of the load error.

## Common pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| Use the `D-Robotics/lerobot` fork for current work | Use **upstream `huggingface/lerobot` v0.5.2** on the `s100`/`s600` branches; fork is only for legacy `stable` + v2.1 data |
| `pip install hbm-runtime` on S100 under Python 3.12 | Build the bundled **`bpu_runtime/` C++ extension** (`BPUACTRuntime`); the PyPI wheel is Python-3.10-only |
| Assume S100 and S600 share a `march` | S100 = `nash-e`, S600 = `nash-p`; pick the matching branch + export YAML |
| Run `build_all.sh` / `hb_compile` on the board | Compile in the **OE 3.7.0 Docker on an x86 host**; board only runs `.hbm` |
| `scp` a `.pt`/ONNX checkpoint and expect the arm to move | `bpu_control_robot.py` loads `bpu_output/` (`.hbm` + `.npy`) only |
| Treat Pi0/openpi as a single on-board process | It's **client-server**; Pi0 inference is on the OE-LLM server (port 8888) |
| Expect this skill to cover arm assembly / calibration / data collection | Those are **upstream LeRobot** (`lerobot-calibrate` / `lerobot-record` / SO-101 docs) |
| Claim ACT works on X5 because the script has a bayes branch | Only S100 (`nash-e`) and S600 (`nash-p`) are verified end-to-end |

## Reference map

| Read this | When |
|-----------|------|
| [lerobot-workflow.md](references/lerobot-workflow.md) | Doing the work — full ACT commands, `bpu_export_config.yaml` fields, the two-config OE flow, C++ `bpu_runtime` build, Pi0 minimal run sheet & data spec, related-repo list |
