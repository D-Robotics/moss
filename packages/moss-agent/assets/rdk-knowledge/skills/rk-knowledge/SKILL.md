---
name: rk-knowledge
description: Rockchip RK35xx single-platform reference — RK3588 / RK3576 NPU specs, the RKNN-Toolkit2 conversion workflow (.onnx → .rknn on an x86 PC), board-side inference with RKNN-Toolkit-Lite2 / librknnrt, multi-core NPU scheduling via core_mask, and the version-mismatch failures that dominate RKNN support. Use whenever someone asks about a Rockchip RK3588/RK3576 SBC (Radxa ROCK 5B/5 ITX, Orange Pi 5, Firefly), its NPU, RKNN model conversion, .rknn deployment, or "RKNN version mismatch / init runtime failed". 触发词:RK3588、RK3576、Rockchip、瑞芯微、ROCK 5B、Orange Pi 5、Firefly RK3588、RKNN、rknn-toolkit2、rknn_toolkit_lite2、librknnrt、.rknn 转换、NPU 几 TOPS、core_mask、三核 NPU、版本不匹配、init runtime failed。Routing — this skill covers the RK35xx platform itself only; RDK-vs-RK3588 / Jetson / Raspberry Pi selection and "买哪个" comparison → rdk-ecosystem (RDK-anchored); Jetson → jetson-knowledge; Raspberry Pi → rpi-knowledge; RKNN-LLM (LLMs on RK35xx) is a separate Rockchip SDK, out of scope here.
---

# Rockchip RK35xx Knowledge

A clean single-platform reference for Rockchip RK35xx AI SBCs (RK3588 and RK3576). What the NPU delivers, how to turn a trained model into a `.rknn`, how to run it on-board, and how to read the version-mismatch errors that cause most RKNN support tickets. **The single most important thing to get right: the PC-side toolkit version and the board-side `librknnrt` version must match, or inference fails or returns garbage — this is the #1 RKNN failure.**

> Sources: official Rockchip / airockchip repos — [`airockchip/rknn-toolkit2`](https://github.com/airockchip/rknn-toolkit2) (README, `rknpu2/runtime` C API headers, `rknn-toolkit-lite2` examples, `doc/`), [`airockchip/rknn_model_zoo`](https://github.com/airockchip/rknn_model_zoo), [`airockchip/rknn-llm`](https://github.com/airockchip/rknn-llm), PyPI (`rknn-toolkit2`, `rknn-toolkit-lite2`), and Radxa / Orange Pi / Firefly product docs. Every version, API, and spec below is grounded in those; provenance is noted inline. Specs and "latest version" change — defer to the live repo / PyPI when in doubt.

## The one rule that matters most: versions must match

The RKNN stack has **two halves that must be the same version**:

- **PC side** — `rknn-toolkit2` (x86_64 or aarch64 Linux): converts `.onnx`/`.pt` → `.rknn`, runs simulation and accuracy analysis.
- **Board side** — `librknnrt.so` (C runtime) and/or `rknn_toolkit_lite2` (Python): loads and runs the `.rknn`.

If you convert a model with toolkit2 **v2.3.x** but the board ships an older `librknnrt` (e.g. v1.6 / v2.1), the model either fails to load (`rknn_init` error), warns about a version difference, or silently produces wrong outputs. When someone reports *"RKNN init runtime failed / load model failed / version mismatch / 推理结果全是乱的"* — **check the two versions first**, before suspecting the model. Fix by upgrading `librknnrt.so` + the NPU kernel driver on the board to match the toolkit2 version you converted with (or re-convert with the toolkit2 version that matches the board).

Confirm the board runtime version: the C API exposes it via `rknn_query(..., RKNN_QUERY_SDK_VERSION, ...)`; the SDK version is also printed when a sample runs. Confirm the PC version with `python3 -c "from rknn.api import RKNN; print(RKNN().get_sdk_version())"` or `pip show rknn-toolkit2`.

## Platform cheat-sheet (the foundation)

Confirm the SoC first (`cat /proc/device-tree/compatible` or `cat /proc/device-tree/model`), then read the row. The NPU core count is what gates `core_mask` scheduling.

| SoC | NPU | NPU cores | `core_mask` ceiling | CPU | Process |
|-----|-----|-----------|---------------------|-----|---------|
| **RK3588 / RK3588S** | 6 TOPS INT8 | **3 cores** | `NPU_CORE_0_1_2` (all 3) | 4× A76 + 4× A55 | 8nm |
| **RK3576** | 6 TOPS INT8 (INT4/8/16/FP16/BF16/TF32) | **2 cores** | `NPU_CORE_0_1` (both) | 4× A72 + 4× A53 | 8nm |

**The 6 TOPS is the whole NPU, not per core.** On RK3588 that is 3 cores at ~2 TOPS each; a single model runs on one core by default (`NPU_CORE_AUTO`) and only uses the full 6 TOPS if you either split work across cores or run 2–3 model instances pinned to different cores. This per-core-vs-total distinction is the most common spec mistake.

RK3588 vs RK3588S: same NPU/CPU; "S" is the cost-reduced package (fewer PCIe/USB lanes, no second display pipeline). For AI/NPU purposes they are identical.

## RKNN software stack (who does what)

| Component | Runs on | Role | Install |
|-----------|---------|------|---------|
| **RKNN-Toolkit2** | x86_64 / aarch64 Linux PC | convert → `.rknn`, simulate, accuracy analysis, perf eval | `pip install rknn-toolkit2` (PyPI, v2.3.x) |
| **RKNN-Toolkit-Lite2** | the board (aarch64) | Python inference of a `.rknn` | `pip install rknn-toolkit-lite2` (PyPI, aarch64 wheels) |
| **RKNN Runtime (`librknnrt.so`)** | the board | C/C++ inference (`rknn_api.h`) | ships in the board image / RKNPU2 SDK |
| **RKNPU kernel driver** | the board | talks to NPU hardware | in the Rockchip kernel; check `dmesg \| grep -i rknpu` |

- **RKNN-Toolkit2 is NOT compatible with the old RKNN-Toolkit** (for RK1808/RV1109/RV1126/RK3399Pro). Do not mix them.
- Toolkit2 supports **Python 3.6–3.12**. Wheels are published on PyPI **2.2.0, 2.2.1, 2.3.0, 2.3.2** (latest **2.3.2**); the full set (matching the exact board runtime) also lives in the repo's `packages/` and the RKNPU2 SDK.
- **Supported NPU platforms** (toolkit2 v2.3.2): RK3588, RK3576, RK3566/RK3568, RK3562, RV1103/RV1106, RV1103B/RV1106B, RV1126B, RK2118. This skill focuses on the RK35xx AI SBCs (RK3588/RK3576).

## Workflows

### Workflow 1 — Identify the board and its NPU

1. **SoC:** `cat /proc/device-tree/compatible` (e.g. `rockchip,rk3588`) or `cat /proc/device-tree/model` (e.g. "Radxa ROCK 5B").
2. **OS / kernel:** `cat /etc/os-release`, `uname -a` — image generation gates which `librknnrt` and driver you have.
3. **NPU driver present:** `dmesg | grep -i rknpu` (should show the RKNPU kernel driver probing). `lscpu` / `lsusb` for the rest.
4. Read the cheat-sheet row → know the core count (3 for RK3588, 2 for RK3576) before deciding any `core_mask` strategy.

### Workflow 2 — Convert a model to `.rknn` (PC side, the core loop)

Conversion runs on an **x86_64 (or aarch64) Linux PC**, never as the deployment step on the board. Full command reference: [rknn-toolkit-workflow.md](references/rknn-toolkit-workflow.md).

1. **Install the matching toolkit2** — `pip install rknn-toolkit2`. If the board runtime is older than PyPI's latest, install the wheel that matches the board's `librknnrt` from the repo `packages/` instead, so the two halves line up (see "the one rule").
2. **Export ONNX correctly** — for YOLO and similar detectors, export from the **airockchip fork** (`airockchip/yolov5`, `airockchip/ultralytics_yolov8`, `airockchip/ultralytics_yolo11`, etc.), which strips post-processing into an RKNN-friendly head. A vanilla ultralytics export converts but is slower / harder to quantize well.
3. **Convert with the Python API** — `RKNN()` → `config(target_platform='rk3588', ...)` → `load_onnx(...)` → `build(do_quantization=True, dataset='dataset.txt')` (≈ a few hundred calibration images) → `export_rknn('model.rknn')`. `target_platform` must match the board (`rk3588`, `rk3576`, …); a `.rknn` built for one platform will not run on another.
4. **Verify before deploying** — `rknn.accuracy_analysis(...)` to catch quantization drift, and `rknn.eval_perf()` for on-NPU latency (needs a connected board). For INT8 accuracy loss, try hybrid/mixed quantization or per-channel quant in `config`.
5. **`rknn_model_zoo`** has a ready convert script per model (`convert.py <onnx> <platform> <dtype> <out.rknn>`) — prefer it over hand-writing the API for the common detectors.

### Workflow 3 — Run the `.rknn` on the board

**Python (RKNN-Toolkit-Lite2):**
```python
from rknnlite.api import RKNNLite
rknn = RKNNLite()
rknn.load_rknn('model.rknn')
rknn.init_runtime(core_mask=RKNNLite.NPU_CORE_0)   # or NPU_CORE_AUTO / NPU_CORE_0_1_2
outputs = rknn.inference(inputs=[img])
```
- `core_mask` only matters on RK3576/RK3588 (multi-core). Default `NPU_CORE_AUTO` (=0) lets the runtime pick. To use the full 6 TOPS of an RK3588, run separate model instances pinned to `NPU_CORE_0` / `_1` / `_2`, or use `NPU_CORE_0_1_2` for one large model.
- C/C++ side mirrors this: `rknn_init` → `rknn_set_core_mask(ctx, RKNN_NPU_CORE_0_1_2)` → `rknn_run`. Header: `rknpu2/runtime/.../rknn_api.h`.

**Diagnose a failing run, in order:**
1. Versions match? (toolkit2 vs board `librknnrt` — Workflow 0 of debugging; see "the one rule").
2. NPU driver loaded? `dmesg | grep -i rknpu`.
3. `target_platform` at convert time == this SoC?
4. Only then suspect the model / preprocessing (input layout NHWC vs NCHW, mean/std, color order).

### Workflow 4 — Out of scope: LLMs on RK35xx

For large language models on RK35xx, Rockchip ships a **separate SDK, RKNN-LLM** (`airockchip/rknn-llm`, with `rkllm-toolkit` to convert to `.rkllm` and `librkllmrt` to run). It is **not** part of rknn-toolkit2. If the user asks "run Qwen/Llama/DeepSeek on RK3588", point them to RKNN-LLM and note this skill covers the vision/CNN RKNN path. Do not try to push an LLM through rknn-toolkit2.

## Worked examples

**Example 1 — "RKNN init runtime failed / load model 报版本不匹配怎么办?"**
Lead with the version rule: *"This is almost always a PC-toolkit-vs-board-runtime version gap. Check both: on the PC `pip show rknn-toolkit2`; on the board the `librknnrt.so` version (printed when a sample runs, or via `rknn_query` RKNN_QUERY_SDK_VERSION). Make them match — either re-convert the `.rknn` with the toolkit2 version that matches the board's `librknnrt`, or upgrade `librknnrt.so` + the RKNPU kernel driver on the board to the version you converted with. Only after they match should you suspect the model."* Then point to Workflow 3's diagnosis order.

**Example 2 — "RK3588 不是 6 TOPS 吗,为什么我跑一个模型只用了 1/3?"**
*"6 TOPS is the whole NPU, which is **3 cores** (~2 TOPS each). One model with the default `NPU_CORE_AUTO` runs on a single core, so you see roughly 1/3. To use all of it: either run 2–3 model instances pinned to `NPU_CORE_0` / `_1` / `_2`, or set `core_mask=NPU_CORE_0_1_2` for a single model that supports multi-core. RK3576 is the same idea but 2 cores."*

**Example 3 — "怎么把我的 YOLOv8 .pt 部署到 Orange Pi 5 (RK3588)?"**
*"Two stages. PC side: export ONNX from the **airockchip/ultralytics_yolov8** fork (RKNN-friendly head), then `pip install rknn-toolkit2` and convert with `target_platform='rk3588'` and a calibration dataset → `model.rknn`. Board side: `pip install rknn-toolkit-lite2`, then `RKNNLite().load_rknn` + `init_runtime` + `inference`. Make sure the toolkit2 version matches the board's `librknnrt`. The `rknn_model_zoo` has a ready yolov8 convert script."* Route to Workflow 2 then 3.

**Example 4 — "我想在 RK3588 上跑 Qwen 大模型,用 rknn-toolkit2 转吗?"**
*"No — rknn-toolkit2 is for CNN/vision models. LLMs use Rockchip's separate **RKNN-LLM** SDK (`airockchip/rknn-llm`): `rkllm-toolkit` converts the HF model to `.rkllm`, and `librkllmrt` runs it on the board. That's a different toolchain from everything above."* (Out of scope here; just route.)

## Common pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| Quote 6 TOPS as if one model gets it all | 6 TOPS = 3 cores (RK3588) / 2 cores (RK3576); one model on AUTO uses one core |
| Assume "load model failed" means the model is broken | Check toolkit2 vs board `librknnrt` versions first |
| Mix RKNN-Toolkit2 with the old RKNN-Toolkit | They are incompatible; RK35xx uses Toolkit2 only |
| Convert with `target_platform='rk3588'` and run on RK3576 (or vice-versa) | `.rknn` is platform-specific; convert per SoC |
| Export YOLO from vanilla ultralytics and wonder why it's slow | Export from the airockchip fork (RKNN-optimized head) |
| Push an LLM through rknn-toolkit2 | Use the separate RKNN-LLM SDK (`.rkllm` / `librkllmrt`) |
| `pip install rknn-toolkit-lite2` on the x86 PC for conversion | Lite2 is board-side (aarch64) inference; conversion is `rknn-toolkit2` on the PC |

## Reference map

| Read this | When |
|-----------|------|
| [rknn-toolkit-workflow.md](references/rknn-toolkit-workflow.md) | Converting / deploying a model — full toolkit2 Python API call sequence, `config`/`build` params, quantization, board-side Lite2 + C API, `core_mask`, version-matching, and the RKNN-LLM out-of-scope note |
| `scripts/rk_npu_selector.py` | Quick SoC → NPU TOPS / core count / `core_mask` ceiling lookup, so the per-core-vs-total fact never drifts |
