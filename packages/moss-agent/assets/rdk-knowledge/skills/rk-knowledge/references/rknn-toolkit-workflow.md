# RKNN Toolchain Workflow (RK3588 / RK3576)

Full reference for converting a model to `.rknn` on a PC and running it on a Rockchip RK35xx board. Every command and API name is taken from `airockchip/rknn-toolkit2` (README, `rknn-toolkit-lite2/examples`, `rknpu2/runtime` headers, `doc/`) and `airockchip/rknn_model_zoo`. Verify against the live repo for the exact version you use.

## Table of contents

- [1. The version-matching rule (read first)](#1-the-version-matching-rule-read-first)
- [2. Install](#2-install)
- [3. PC-side conversion (RKNN-Toolkit2)](#3-pc-side-conversion-rknn-toolkit2)
- [4. Exporting ONNX for YOLO and friends](#4-exporting-onnx-for-yolo-and-friends)
- [5. Board-side inference — Python (Lite2)](#5-board-side-inference--python-lite2)
- [6. Board-side inference — C/C++ (librknnrt)](#6-board-side-inference--cc-librknnrt)
- [7. Multi-core NPU scheduling (core_mask)](#7-multi-core-npu-scheduling-core_mask)
- [8. Diagnosing failures, in order](#8-diagnosing-failures-in-order)
- [9. LLMs are a different SDK (RKNN-LLM)](#9-llms-are-a-different-sdk-rknn-llm)

## 1. The version-matching rule (read first)

The RKNN stack is two halves and they must be the **same version**:

- PC side: `rknn-toolkit2` builds the `.rknn`.
- Board side: `librknnrt.so` (C runtime) and/or `rknn_toolkit_lite2` (Python) load and run it.

A version gap between them is the **single most common RKNN failure**: `rknn_init` fails, the runtime prints a version-difference warning, or inference returns wrong results. Always reconcile versions before blaming the model.

Check the versions:

```bash
# PC side
pip show rknn-toolkit2
python3 -c "from rknn.api import RKNN; print(RKNN().get_sdk_version())"

# Board side (Python)
python3 -c "from rknnlite.api import RKNNLite; r=RKNNLite(); print(r.get_sdk_version())"
# Board side (C): rknn_query(ctx, RKNN_QUERY_SDK_VERSION, &ver, sizeof(ver))
# Board side (driver): dmesg | grep -i rknpu
```

Fix: either re-convert the `.rknn` with the toolkit2 version that matches the board's `librknnrt`, or upgrade the board's `librknnrt.so` + RKNPU kernel driver to the version you converted with. PyPI publishes `2.2.0, 2.2.1, 2.3.0, 2.3.2` (latest `2.3.2`); to match an older board, take the matching wheel from the repo `packages/` or the RKNPU2 SDK instead of PyPI's latest.

## 2. Install

| Package | Where | Command | Notes |
|---------|-------|---------|-------|
| `rknn-toolkit2` | x86_64 / aarch64 Linux PC | `pip install rknn-toolkit2` | conversion + simulation; Python 3.6–3.12 |
| `rknn-toolkit-lite2` | board (aarch64) | `pip install rknn-toolkit-lite2` | board-side Python inference; aarch64 wheels only |
| `librknnrt.so` | board | from the board image / RKNPU2 SDK | C runtime |

- `rknn-toolkit2` and the old `rknn-toolkit` are **not compatible**. RK35xx uses Toolkit2.
- The PyPI wheels are `manylinux2014` for both x86_64 and aarch64 (toolkit2) and aarch64 only (lite2). For Windows, use WSL (see the repo's `doc/Using RKNN-ToolKit2 in WSL.md`).

## 3. PC-side conversion (RKNN-Toolkit2)

The Python API, in order:

```python
from rknn.api import RKNN

rknn = RKNN(verbose=True)

# 1. Pre-processing config + target platform (MUST match the board SoC)
rknn.config(
    mean_values=[[0, 0, 0]],
    std_values=[[255, 255, 255]],
    target_platform='rk3588',          # or 'rk3576', 'rk3566', ...
    quantized_dtype='asymmetric_quantized-8',
)

# 2. Load the source model
rknn.load_onnx(model='yolov8n.onnx')   # also load_pytorch / load_tensorflow / load_tflite

# 3. Build (quantize). dataset.txt lists calibration image paths, one per line.
rknn.build(do_quantization=True, dataset='dataset.txt')

# 4. (optional) accuracy + performance checks
rknn.accuracy_analysis(inputs=['test.jpg'])   # quantization drift
rknn.eval_perf()                               # on-NPU latency (needs a connected board)

# 5. Export
rknn.export_rknn('yolov8n.rknn')
rknn.release()
```

Key facts:
- **`target_platform` is load-bearing.** A `.rknn` built for `rk3588` will not run on `rk3576` and vice-versa. Convert once per SoC.
- **Quantization** is INT8 by default (`do_quantization=True`) and needs a calibration `dataset.txt` of ~a few hundred representative images. Skipping quantization (`False`) gives an FP16 model — larger and slower on the NPU but no calibration needed.
- For INT8 accuracy loss, options in/around `config`: per-channel quantization, hybrid quantization (`hybrid_quantization_step1/2`), or leaving sensitive layers in FP16 (mixed precision — improved in v2.3.x).
- The supported-operator list ships in the repo `doc/` (`05_RKNN_Compiler_Support_Operator_List` and `RKNNToolKit2_OP_Support-*.md`). Check it when `build` fails on an op.

For the common detectors, `rknn_model_zoo` provides a ready `convert.py`:
```bash
# rknn_model_zoo/examples/yolov8/python/
python convert.py yolov8n.onnx rk3588 i8 yolov8n.rknn
```

## 4. Exporting ONNX for YOLO and friends

Export from the **airockchip fork**, not vanilla upstream — the forks move post-processing out of the graph into an RKNN-friendly multi-branch head that quantizes well and runs faster:

| Model | Fork to export from |
|-------|---------------------|
| YOLOv5 / YOLOv5-seg | `airockchip/yolov5` |
| YOLOv6 | `airockchip/yolov6` |
| YOLOv7 | `airockchip/yolov7` |
| YOLOv8 / -seg / -pose / -obb | `airockchip/ultralytics_yolov8` |
| YOLO11 | `airockchip/ultralytics_yolo11` |
| YOLOX | `airockchip/YOLOX` |

A vanilla ultralytics export still converts, but the in-graph NMS/decode hurts quantization and speed. `rknn_model_zoo` documents the exact export flag per model.

## 5. Board-side inference — Python (Lite2)

```python
from rknnlite.api import RKNNLite

rknn = RKNNLite()
rknn.load_rknn('yolov8n.rknn')

# init_runtime: core_mask only applies on RK3576 / RK3588 (multi-core)
ret = rknn.init_runtime(core_mask=RKNNLite.NPU_CORE_0)   # or NPU_CORE_AUTO / NPU_CORE_0_1_2
# ... preprocess img to the model's input layout (usually NHWC, RGB) ...
outputs = rknn.inference(inputs=[img])
rknn.release()
```

`RKNNLite` core_mask constants mirror the C enum: `NPU_CORE_AUTO`, `NPU_CORE_0`, `NPU_CORE_1`, `NPU_CORE_2`, `NPU_CORE_0_1`, `NPU_CORE_0_1_2`, `NPU_CORE_ALL`.

## 6. Board-side inference — C/C++ (librknnrt)

Header: `rknpu2/runtime/Linux/librknn_api/include/rknn_api.h`. Typical flow:

```c
rknn_context ctx;
rknn_init(&ctx, model_buf, model_len, 0, NULL);
rknn_set_core_mask(ctx, RKNN_NPU_CORE_0_1_2);   // RK3588: all 3 cores
rknn_query(ctx, RKNN_QUERY_SDK_VERSION, &ver, sizeof(ver));   // version check
rknn_inputs_set(ctx, n_input, inputs);
rknn_run(ctx, NULL);
rknn_outputs_get(ctx, n_output, outputs, NULL);
rknn_destroy(ctx);
```

## 7. Multi-core NPU scheduling (core_mask)

From the official `rknn_api.h` enum:

```c
RKNN_NPU_CORE_AUTO    = 0       // default: runtime picks a core
RKNN_NPU_CORE_0       = 1
RKNN_NPU_CORE_1       = 2
RKNN_NPU_CORE_2       = 4
RKNN_NPU_CORE_0_1     = 3       // CORE_0 | CORE_1  (2 cores)
RKNN_NPU_CORE_0_1_2   = 7       // CORE_0 | CORE_1 | CORE_2  (3 cores, RK3588 only)
RKNN_NPU_CORE_ALL     = 0xffff  // auto multi-core, platform-dependent
```

- **RK3588 has 3 NPU cores; RK3576 has 2.** `NPU_CORE_2` / `NPU_CORE_0_1_2` only exist meaningfully on RK3588.
- **6 TOPS is the whole NPU, not per core.** Default `AUTO` runs a model on one core (~1/3 of RK3588). To use the full NPU:
  - run **2–3 independent model instances**, each pinned to a different core (`NPU_CORE_0`, `_1`, `_2`) — best for throughput; or
  - set **`NPU_CORE_0_1_2`** for a single large model that supports multi-core splitting — best for one model's latency.
- This is a real deployment decision, not a toggle: pinning instances to cores is how you get the advertised 6 TOPS.

## 8. Diagnosing failures, in order

1. **Versions** — toolkit2 (PC) vs `librknnrt` (board). Reconcile before anything else (section 1).
2. **NPU driver** — `dmesg | grep -i rknpu` shows the RKNPU kernel driver probing. If absent, the image/kernel lacks NPU support.
3. **Platform** — was the `.rknn` built with `target_platform` equal to this SoC?
4. **Operator support** — if `build` failed on the PC, check the supported-op list in `doc/`.
5. **Preprocessing** — input layout (NHWC vs NCHW), `mean_values`/`std_values` matching training, RGB vs BGR. Wrong preprocessing gives plausible-looking but wrong outputs even when everything loads.

## 9. LLMs are a different SDK (RKNN-LLM)

Large language models on RK35xx do **not** go through rknn-toolkit2. Rockchip ships a separate SDK, **RKNN-LLM** (`airockchip/rknn-llm`):

- `rkllm-toolkit` (PC) converts a Hugging Face model → `.rkllm`.
- `librkllmrt` (board) runs it.

If a user asks to run Qwen / Llama / DeepSeek / a chat model on RK3588, route them to RKNN-LLM and stop trying to use rknn-toolkit2 — it is the wrong toolchain for that task.
