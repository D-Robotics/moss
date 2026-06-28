# RDK Embodied Deployment Workflow Reference

> Sources: [D-Robotics/rdk_LeRobot_tools](https://github.com/D-Robotics/rdk_LeRobot_tools) (`stable` / `s100` / `s600` branch READMEs + `doc/WORKFLOW_GUIDE_EN.md` + scripts), [D-Robotics/openpi_runtime](https://github.com/D-Robotics/openpi_runtime) (`develop` README), [huggingface.co/D-Robotics/openpi](https://huggingface.co/D-Robotics/openpi). Facts are taken verbatim from those sources; commands match the current repo state. Where branches differ, the difference is called out explicitly.

## Contents

- [A. LeRobot ACT — full flow](#a-lerobot-act--full-flow)
  - [A.1 Pick the branch](#a1-pick-the-branch)
  - [A.2 Dev-machine environment](#a2-dev-machine-environment)
  - [A.3 Export ONNX + configs](#a3-export-onnx--configs)
  - [A.4 Compile ONNX → .hbm](#a4-compile-onnx--hbm)
  - [A.5 Board-side runtime (the Python-3.12 split)](#a5-board-side-runtime-the-python-312-split)
  - [A.6 Run the control loop](#a6-run-the-control-loop)
  - [A.7 Key files](#a7-key-files)
- [B. Pi0 / openpi VLA (S600)](#b-pi0--openpi-vla-s600)
  - [B.1 Data spec](#b1-data-spec)
  - [B.2 Architecture, latency, smoothing](#b2-architecture-latency-smoothing)
  - [B.3 Minimal run sheet](#b3-minimal-run-sheet)
- [C. Related embodied repos](#c-related-embodied-repos)

---

## A. LeRobot ACT — full flow

### A.1 Pick the branch

`rdk_LeRobot_tools` has diverged into branch-specific deployments. Choose by board and dataset vintage:

| Branch | Target | LeRobot | `march` | Toolchain | Board runtime |
| --- | --- | --- | --- | --- | --- |
| `s100` | RDK S100, current | upstream HF **v0.5.2** | `nash-e` | OE **3.7.0** | C++ `bpu_runtime` ext (Py 3.12) |
| `s600` | RDK S600, current | upstream HF **v0.5.2** | `nash-p` | OE **3.7.0** | `pip install hbm-runtime` |
| `stable` | legacy, v2.1 datasets | **D-Robotics/lerobot fork** (locked `datasets`) | `nash-e` (S100) | OE Docker | `pip install hbm-runtime` |

**The fork-vs-upstream rule reversed recently.** The current `s100`/`s600` branches state: *"Use the official Hugging Face LeRobot repository … Do not use the outdated `D-Robotics/lerobot` fork."* The fork is now **only** the legacy `stable` path. Do not carry the old "always use the fork" rule into current work.

S100P shares the S100 Nash-e path. Only S100 (`nash-e`) and S600 (`nash-p`) are verified end-to-end; the export script contains a `bayes`/`bayes-e` (X5) branch, but a compilable `.bin` is not a verified arm deployment.

### A.2 Dev-machine environment

Current path (`s100` shown; swap `s100`→`s600` for S600):

```bash
conda activate lerobot
git clone https://github.com/huggingface/lerobot.git
cd lerobot
git clone https://github.com/D-Robotics/rdk_LeRobot_tools.git
cd rdk_LeRobot_tools && git checkout s100 && cd ..
pip install -e ".[feetech]"
pip install onnx onnxsim termcolor tqdm safetensors
```

Verified env for the v0.5.2 branches: `datasets 4.8.5`, `torch 2.7.1+cu126`, `onnxruntime 1.26.0`, `onnx 1.21.0`, `numpy 2.2.6`.

Legacy `stable` path (only if you must load v2.1 datasets):

```bash
git clone https://github.com/D-Robotics/lerobot.git   # fork, locked datasets
cd lerobot
git clone https://github.com/D-Robotics/rdk_LeRobot_tools.git
pip install -e ".[feetech]"
pip install onnx onnxsim termcolor tqdm
# Upstream alternative: git checkout 8cfab3882480bdde38e42d93a9752de5ed42cae2  (v2.1 commit),
# and if compatibility errors appear: pip install datasets==2.19.0
```

> Arm assembly, motor setup, `lerobot-calibrate` calibration, and `lerobot-record` data collection are **upstream LeRobot** — see [huggingface/lerobot](https://github.com/huggingface/lerobot) and the [SO-101 docs](https://huggingface.co/docs/lerobot/so101). This repo starts from a trained ACT checkpoint.

### A.3 Export ONNX + configs

There are **two distinct config files** in this workflow — do not confuse them:

| Config file | Used by | Purpose |
| --- | --- | --- |
| `bpu_export_config.yaml` (s600: `bpu_export_config_s600_calfix.yaml`) | `export_bpu_actpolicy.py` | checkpoint, dataset, export path, `type` (`march`), `cal_num` |
| `config_BPU_ACTPolicy_*.yaml` | OE `hb_compile` | ONNX path, calibration data, quantization/compile settings — **auto-generated**, you do not hand-edit it |

Export-stage YAML key fields:

| Field | Meaning |
| --- | --- |
| `dataset.root` | Root dir of the dataset used during training (used to fetch calibration batches and auto-detect cameras) |
| `act_path` | Trained ACT checkpoint dir (`config.json` + `model.safetensors`) |
| `type` | BPU chip = the `march`: `nash-e` (S100) / `nash-p` (S600) / `nash-m` (S100P); `bayes`/`bayes-e` (X5, unverified). The script picks compile params from this. **Not** the same as `policy.type: "act"` |

```bash
python export_bpu_actpolicy.py --config bpu_export_config.yaml   # s600: ..._s600_calfix.yaml
```

What the script does (6 steps): ① load checkpoint + dataset, auto-detect cameras; ② export normalization `.npy` (`{cam}_mean/std`, `action_mean/std`, `action_mean/std_unnormalize`) used for manual norm/denorm outside the BPU; ③ export **VisionEncoder** ONNX (backbone + `encoder_img_feat_input_proj`; output feature map `[1,512,15,20]`); ④ export **TransformerLayers** ONNX (encoder + decoder + action_head; output `Actions [1,100,6]`; also writes `new_actions.npy` for accuracy checking); ⑤ generate `config_BPU_ACTPolicy_*.yaml`, `build_*.sh`, and `build_all.sh` (`march: nash-*`, `norm_type: no_preprocess`); ⑥ assemble `export_path/`.

ACT is split into two submodels because the BPU deploys them separately:
`image → VisionEncoder → front_features`, then `state + front_features → TransformerLayers → Actions`. `bpu_control_robot.py` chains them on the board.

Output tree:

```text
export_path/
├── BPU_ACTPolicy_VisionEncoder/
│   ├── BPU_ACTPolicy_VisionEncoder.onnx
│   ├── config_BPU_ACTPolicy_VisionEncoder.yaml
│   └── calibration_data_BPU_ACTPolicy_VisionEncoder/
├── BPU_ACTPolicy_TransformerLayers/
│   ├── BPU_ACTPolicy_TransformerLayers.onnx
│   ├── config_BPU_ACTPolicy_TransformerLayers.yaml
│   └── calibration_data_BPU_ACTPolicy_TransformerLayers/
├── bpu_output/          # normalization .npy (final .hbm land here after compile)
└── build_all.sh
```

> For v2.1-era exports on the legacy path, uncomment the `policy` and `dataset` sections in the export YAML to avoid missing-key errors (e.g. `policy.type`).

### A.4 Compile ONNX → .hbm

The OE toolchain only accepts ONNX (it does not read PyTorch checkpoints). Run **inside the OE 3.7.0 Docker on an x86 host — never on the board**:

```bash
cd export_path
bash build_all.sh        # invokes hb_compile per submodel
```

Result: `bpu_output/` gains the compiled models and runtime params:

```text
bpu_output/
├── BPU_ACTPolicy_TransformerLayers.hbm
├── BPU_ACTPolicy_VisionEncoder.hbm
├── action_mean.npy / action_std.npy
├── action_mean_unnormalize.npy / action_std_unnormalize.npy
├── camera1_mean.npy / camera1_std.npy   # camera names auto-detected (e.g. front)
└── new_actions.npy                       # pre-conversion PyTorch output (accuracy check)
```

`scp` the whole `bpu_output/` folder to the board.

### A.5 Board-side runtime (the Python-3.12 split)

**s600 branch** — straightforward:

```bash
git clone https://github.com/huggingface/lerobot.git && cd lerobot
git clone https://github.com/D-Robotics/rdk_LeRobot_tools.git
cd rdk_LeRobot_tools && git checkout s600 && cd ..
pip install -e ".[feetech]"
pip install hbm-runtime
```

**s100 branch** — Python **3.12** + LeRobot v0.5.2, where the PyPI `hbm-runtime` wheel (built for Python 3.10) **cannot be imported**. The repo ships a `bpu_runtime/` pybind11 C++ module that wraps `hbDNN`/`hbUCP` and exposes `BPUACTRuntime` (a drop-in for `hbm_runtime.HB_HBMRuntime`):

```bash
# uv-based Python 3.12 venv
curl -LsSf https://astral.sh/uv/install.sh | sh && export PATH="$HOME/.local/bin:$PATH"
cd ~ && git clone https://github.com/huggingface/lerobot.git && cd lerobot
uv venv --python 3.12 .venv && source .venv/bin/activate
git clone https://github.com/D-Robotics/rdk_LeRobot_tools.git
cd rdk_LeRobot_tools && git checkout s100 && cd ..
uv pip install -e ".[feetech]"
uv pip install onnx onnxsim termcolor tqdm safetensors numpy
# build the C++ BPU extension
cd rdk_LeRobot_tools/bpu_runtime && uv pip install pybind11
mkdir build && cd build
cmake -DPython3_EXECUTABLE=$(which python) \
      -Dpybind11_DIR=$(python -c "import pybind11; print(pybind11.get_cmake_dir())") ..
make -j$(nproc)
# produces bpu_act_runtime.cpython-312-aarch64-linux-gnu.so
```

`bpu_control_robot.py` auto-imports the built `.so`: it tries `hbm_runtime` first, falls back to the C++ extension if unavailable — no manual `PYTHONPATH`.

### A.6 Run the control loop

```bash
python bpu_control_robot.py --bpu-act-path ./bpu_output
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--bpu-act-path` | (required) | BPU model dir; must contain `.hbm` + `.npy` |
| `--fps` | `30` | control-loop frequency (Hz) |
| `--inference-time` | `1000` | auto-run duration (seconds) |
| `--robot-port` | `/dev/ttyACM0` | arm serial port |
| `--camera-index` | `0` | camera device index |
| `--camera-name` | `front` | must match a camera name baked into the model |
| `--camera-width` / `--camera-height` | `640` / `480` | capture resolution |

Default robot is `so101` (`make_robot("so101")` — edit the code to use another arm). **Verify correctness** by comparing the board's BPU output against `new_actions.npy` from the export step before trusting the arm.

### A.7 Key files

| File | Runs on | Role |
| --- | --- | --- |
| `export_bpu_actpolicy.py` | dev machine / training server | PyTorch weights → ONNX (2 submodels) + OE configs + `build_all.sh` |
| `bpu_export_config.yaml` (s600: `bpu_export_config_s600_calfix.yaml`) | dev machine | export-stage config |
| `config_BPU_ACTPolicy_*.yaml` | OE Docker | auto-generated `hb_compile` configs |
| `bpu_runtime/` | RDK S100 board | C++ pybind11 BPU runtime (`BPUACTRuntime`) for Python 3.12 |
| `bpu_control_robot.py` | RDK board | load `.hbm`, run control loop, drive the arm |
| `damo/replace.py` | dev machine | DAMO Developer Matrix · LeYun dataset key remap (edit `folder_path`, then run; back up data first — it edits in place) |

---

## B. Pi0 / openpi VLA (S600)

A Vision-Language-Action runtime based on quantized [Pi0](https://github.com/Physical-Intelligence/openpi), running on **RDK S600 (Ubuntu 24.04 / ROS2 Jazzy)** to drive a **dual-arm** setup. **Client-server architecture** (the S600 is the development board, not the arm itself).

### B.1 Data spec

| Item | Shape | Type | Notes |
| --- | --- | --- | --- |
| Images ×3 | `[3,224,224]` | uint8 | head / left wrist / right wrist (right wrist = black placeholder) |
| State | `[14]` | float32 | both arms: joints + gripper |
| Prompt | — | string | e.g. `"put the yellow mango on the blue plate"` |
| Action output | `[50,14]` | float32 | 50 steps; each = [6 joints + gripper] per arm |

### B.2 Architecture, latency, smoothing

- **Client (S600 inference node, `s600_inference_node`):** time-synchronizes multi-camera ROS2 topics via `TopicTimeSynchronizer` (default `sync_time_window` = 0.1 s) → collect → preprocess → call server → smooth → execute.
- **Server (Pi0 inference, OE-LLM):** predicts the action sequence; reached on **port 8888**.
- **`piper_node`:** drives the arm over CAN (`can0`).

| Stage | Avg latency |
| --- | --- |
| Data collection | 0.1 ms |
| Preprocessing | 3.2 ms |
| Inference (server) | 192.5 ms |
| Postprocessing | 0.1 ms |
| Action execution | ~700.5 ms (~68 ticks, ~1.36 s at 20 ms/step) |

Action smoothing (three stages): 10-step linear interpolation from current state to `action[0]`; first-order low-pass on `action[1..48]` (`alpha=0.15`, `filtered = alpha*action + (1-alpha)*prev`); 10-step interpolation `action[48]→action[49]`. The gripper dimension bypasses filtering/interpolation and uses the inference output directly.

### B.3 Minimal run sheet

> Full `colcon build`, every node parameter, and exact camera topic names: see the [openpi_runtime](https://github.com/D-Robotics/openpi_runtime) `develop` README. This is the minimal skeleton.

```bash
# 1. Model: from huggingface.co/D-Robotics/openpi grab the task's HBM model + norm_stats.json
#    (norm_stats.json is under <task>/torch/assets/trossen/ and must match the model)
# 2. Env (Python 3.12)
conda create -n s600_pi0 python=3.12 && conda activate s600_pi0
pip install -r resource/requirements.txt
colcon build --packages-select openpi_runtime
# 3. Launch order (same ROS_DOMAIN_ID across all, e.g. 40):
#    a) two D457 cameras (head + left wrist) via realsense2_camera rs_launch.py
#    b) piper_node  (--subscribe_topic /aliciaD/action --publish_topic /piper/qpos --can_name can0)
#    c) s600_inference_node
python3 install/lib/openpi_runtime/s600_inference_node --ros-args \
  -p norm_stats_path:=norm_stats.json \
  -p action_topic:=/aliciaD/action \
  -p qpos_topic:=/piper/qpos \
  -p num_steps:=1250          # max control steps, default 1250
```

Published HBM models (Hugging Face): `put_the_box` (v0.1.0) and `pi0_put_the_yellow_mango_on_the_blue_plate` (v0.2.0), both `pi0_base` quantized to HBM; v0.2.1 adds a 10 fps mango variant (`10fps_pi0_put_the_yellow_mango_on_the_blue_plate`). Each task's `.hbm` lives under `<task>/s600_hbm/`; the matching `norm_stats.json` under `<task>/torch/assets/trossen/`.

Common failures: no observation data → check camera nodes + matching `ROS_DOMAIN_ID` + topic names; inference connect fail → Pi0 server not up / port 8888 busy / wrong `norm_stats.json` path; jerky execution → network latency, CAN health, tune `sync_time_window`.

---

## C. Related embodied repos

| Repo | Use |
| --- | --- |
| [rdk_LeRobot_tools](https://github.com/D-Robotics/rdk_LeRobot_tools) | ACT → BPU export/deploy (branches: `stable`/`s100`/`s600`) |
| [lerobot](https://github.com/D-Robotics/lerobot) | D-Robotics fork (locked `datasets`) — legacy `stable` path only |
| [huggingface/lerobot](https://github.com/huggingface/lerobot) | Upstream LeRobot v0.5.2 — current path; also arm assembly/calibration/data collection |
| [openpi_runtime](https://github.com/D-Robotics/openpi_runtime) | Pi0 VLA runtime (S600, `develop`) |
| [openpi](https://github.com/D-Robotics/openpi) | openpi + x86 server / training config |
| [Physical-Intelligence/openpi](https://github.com/Physical-Intelligence/openpi) | Upstream Pi0 |
| [RoboTwin](https://github.com/D-Robotics/RoboTwin) | dual-arm simulation / data |
| [embodied_ai_robots](https://github.com/D-Robotics/embodied_ai_robots) | embodied robot examples |
| [Alicia-D-SDK](https://github.com/D-Robotics/Alicia-D-SDK) | robot arm SDK |

> S100's CPU (6×A78AE) / BPU (Nash) / MCU (4×R52+ real-time control) heterogeneous split, firmware burn, and board-agent task handoff: see `rdk-board-delegate`.
