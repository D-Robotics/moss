# Board-side Inference Programming API (X3/X5/Ultra vs S100/S100P/S600)

> Sources: official D-Robotics docs — rdk_x_doc `docs/03_Basic_Application/02_cdev_demo_sample/{00_overview,bpu}.md`, `docs/03_Basic_Application/03_pydev_demo_sample/RDK_X5/{00_overview,01_classification_sample,02_detection_sample}.md`, `docs/03_Basic_Application/03_pydev_demo_sample/RDK_X3/{01_basic_sample,07_yolov5_sample}.md`; rdk_s_doc `docs/04_Algorithm_Application/{02_Python_API.md,03_Python_Sample/01_Summary.md,03_Python_Sample/02_ResNet18.md,04_C++_Sample/01_Summary.md,04_C++_Sample/02_ResNet18.md}`. Only documented facts are recorded; the raw C++ libdnn interface details live in the OE docs — see "Not covered / uncertain" at the end.

This page covers the half that [toolchain-workflow.md](toolchain-workflow.md) does not: the toolchain only covers the **host side** turning a model into `.bin`/`.hbm`; this page covers how to write **board-side** code to load the model, feed inputs, run inference, and read outputs.

## Table of contents

- [One-line selection](#one-line-selection)
- [1. Python · X3 / older X5 — hobot_dnn.pyeasy_dnn](#1-python--x3--older-x5--hobot_dnnpyeasy_dnn)
- [2. Python · X5 (3.5.0+) / S100 / S100P / S600 — hbm_runtime.HB_HBMRuntime](#2-python--x5-350--s100--s100p--s600--hbm_runtimehb_hbmruntime)
- [3. C / C++ board-side inference](#3-c--c-board-side-inference)
- [4. Per-sample matrix](#4-per-sample-matrix)
- [5. Boundary with rdk-multimedia](#5-boundary-with-rdk-multimedia-no-duplicate-copying)
- [6. Not covered / uncertain](#6-not-covered--uncertain)

## One-line selection

| Board | Python inference library | Model format | C/C++ inference base |
|---|---|---|---|
| X3 (all images) | `hobot_dnn.pyeasy_dnn` | `.bin` | `/app/cdev_demo/bpu`, the **spcdev (`libspcdev.so`)** wrapper (`libsp`/sp_dev is for the multimedia capture/encode/decode demos — see §5) |
| X5 / Ultra (older image) | `hobot_dnn.pyeasy_dnn` | `.bin` | same as above |
| **X5 software 3.5.0+** | **`hbm_runtime.HB_HBMRuntime`** | **still `.bin`** | same as above |
| S100 / S100P / S600 | `hbm_runtime.HB_HBMRuntime` | `.hbm` | `/app/cdev_demo/bpu`, libdnn (`hbDNN*`) + libhbucp |

> ⚠️ **Important change:** starting with X5 software **3.5.0**, the official pydev samples migrated from `pyeasy_dnn` to `hbm_runtime` (the model is still `.bin`, not `.hbm`). So "X5 uses pyeasy_dnn" only holds for **older X5/Ultra images**; for a 3.5.0+ X5, go by `ls /app/pydev_demo/` (task-named directories such as `01_classification_sample/`, `02_detection_sample/`) and the actual `import` in the samples. Source: rdk_x_doc X5 `00_overview.md` (marked "software version 3.5.0"), `01_classification_sample.md`, `02_detection_sample.md`.

On-board preinstalled code locations:
- X-series: Python = `/app/pydev_demo/`, C = `/app/cdev_demo/`
- S-series: Python = `/app/pydev_demo/`, C++ = `/app/cdev_demo/bpu/`
- Basic models: `/opt/hobot/model/{x5|s100|s600}/basic/*.{bin|hbm}`

---

## 1. Python · X3 / older X5 — `hobot_dnn.pyeasy_dnn`

The most classic board-side inference API. Source: X3 `01_basic_sample.md`, `07_yolov5_sample.md`.

**Key call flow:**
```python
from hobot_dnn import pyeasy_dnn as dnn
import numpy as np

# 1. Load the model (.bin); returns a list of models
models = dnn.load('../models/yolov5s_672x672_nv12.bin')

# 2. Inspect input/output tensor properties
#    models[0].inputs[i].properties / outputs[i].properties
#    include tensor_type (e.g. NV12), dtype, layout (NCHW), shape (e.g. (1,3,224,224)), name
#    e.g. inputs[0]  tensor type=NV12, shape=(1,3,224,224), name='data'
#         outputs[0] tensor type=float32, shape=(1,1000,1,1), name='prob'

# 3. Pre-process: image → model input size → NV12 format
#    (resize BGR to the target size, then convert to NV12)

# 4. Inference: forward pass on model index 0
outputs = models[0].forward(nv12_data)

# 5. Post-process: take tensors from outputs[i].buffer; classification/detection parse separately
#    the classification sample parses via the libpostprocess library; detection adds decode + NMS
```

Key points:
- Input is **NV12** (the classification sample's input tensor type is NV12); resize the BGR image, then convert to NV12 before feeding it.
- A model may contain multiple sub-models (`dnn.load` returns a list); for a single model use `models[0]`.
- Post-processing: the X-series Python samples rely on the `libpostprocess` library to parse output tensors (classification reads the probabilities directly, detection does decode + NMS).
- `No module named 'hobot_dnn'` → the RDK-specific inference library is not installed; check the board's Python environment.

---

## 2. Python · X5 (3.5.0+) / S100 / S100P / S600 — `hbm_runtime.HB_HBMRuntime`

`hbm_runtime` is a pybind11-based Python binding wrapping the **libhbucp / libdnn** C++ libraries underneath. Source: rdk_s_doc `02_Python_API.md`, X5 `01/02_*_sample.md`, S Python sample `01_Summary` / `02_ResNet18`.

> X5 3.5.0+ uses the same class name to load `.bin`; the S-series loads `.hbm`. The API shape is identical.

**Minimal inference flow (single model, single input):**
```python
import numpy as np
from hbm_runtime import HB_HBMRuntime

# 1. Load (single model → str; multiple models → List[str], or one .hbm containing several models)
model = HB_HBMRuntime("/opt/hobot/model/s600/basic/resnet18_224x224_nv12.hbm")

# 2. Inspect metadata (all read-only Dicts; outer key = model name)
model_name = model.model_names[0]
input_name = model.input_names[model_name][0]
input_shape = model.input_shapes[model_name][input_name]

# 3. Build the input (use model.input_dtypes to decide dtype; shown here for illustration)
input_tensor = np.ones(input_shape, dtype=np.float32)

# 4. Inference
outputs = model.run(input_tensor)

# 5. Read the result: always a nested structure {model_name: {output_name: np.ndarray}} (single model too)
output_array = outputs[model_name]
```

**Three input forms for run()** (signatures in `02_Python_API.md`):

| Form | Input type | Notes |
|---|---|---|
| Single model, single input | `np.ndarray` | exactly 1 input tensor; `model_name` can be omitted when the model is unique |
| Single model, multiple inputs | `Dict[str, np.ndarray]` | key = **input tensor name** (must really exist); e.g. NV12 two planes `{'data_y':…, 'data_uv':…}` |
| Multiple models, multiple inputs | `Dict[str, Dict[str, np.ndarray]]` | outer key = **model name**, inner = input name → tensor |

- The return is uniformly `Dict[str, Dict[str, np.ndarray]]` (outer model name / inner output name).
- Inputs are automatically checked and converted to **C-contiguous** (a non-contiguous input incurs an extra copy); a dtype or shape mismatch raises `ValueError`; a model dimension of `-1` is dynamically filled from the actual input.

**Metadata properties quick reference** (read-only; outer key = model name):

| Property | Meaning |
|---|---|
| `model_names` / `model_count` | model name list / count |
| `input_names` / `output_names` | per-model input/output tensor name lists |
| `input_shapes` / `output_shapes` | tensor shapes `Dict[model_name][tensor_name] = List[int]` |
| `input_dtypes` / `output_dtypes` | data types (`hbDNNDataType` enum: U8/S8/F16/F32/S16/U16/S32/…) |
| `input_quants` / `output_quants` | quantization params `QuantParams` (`scale`/`zero_point`/`quant_type`/`axis`) for de-quantizing in pre/post-processing |
| `input_strides` / `output_strides` | strides (meaning in the OE libdnn docs) |
| `input_counts` / `output_counts` | number of tensors |
| `compile_bpu_core_num` | the BPU core count fixed at compile time (can be consistency-checked against the runtime core binding) |
| `sched_params` | current scheduling params (`SchedParam`: priority/customId/bpu_cores/deviceId) |

**Scheduling params (priority / BPU-core binding):**
```python
# model-level defaults (persisted on the runtime instance)
model.set_scheduling_params(
    priority={model_name: 5},      # 0~255, higher = higher priority
    bpu_cores={model_name: [0]},   # list of core indices; [-1] means the scheduler auto-assigns
)
# per-call override: pass the same-named params to run(); applies only this call, defaults unchanged
outputs = model.run(input_tensor, priority={model_name: 50})
```
- Priority precedence: `run() argument > set_scheduling_params() default > built-in default`.
- `custom_id` (e.g. frame id / timestamp; smaller = higher priority, with priority `priority > customId`) and `device_id` (multi-device) are settable too.
- **Core-count constraint:** `bpu_cores` — S100 may take only 1, S600 takes 0~3; `[-1]` = ANY auto-selects.

**Multi-thread throughput:** the inference stage releases the GIL on the C++ side, so Python threads can call `run()` concurrently; for multiple models, `run()` launches one C++ thread per model to execute in parallel. Each call may carry independent scheduling params without interfering.

**Pre/post-processing (the X5 detection sample matches the S-series pattern):**
1. Pre-process: BGR → resize to the model input size → `bgr_to_nv12_planes` yields the y/uv planes (NV12). Example: the S-series yolov5x hbm has two input tensors `data_y [1,672,672,1]` + `data_uv [1,336,336,2]` (U8).
2. Inference: `model.run(...)`.
3. Post-process (detection): `dequantize_outputs` (de-quantize using each `output_quants` scale/zero_point) → `decode_outputs` (decode with strides/anchors/num-classes) → `filter_predictions` (confidence filter) → `NMS` → `scale_coords_back` (restore to the original image size) → `draw_boxes`. Source: the API flow in X5 `02_detection_sample.md`.
4. The S-series samples uniformly call `utils/` helpers: `preprocess_utils` / `postprocess_utils` / `draw_utils` / `common_utils`.

Common command-line arguments (shared by the classification/detection samples): `--model-path`, `--test-img`, `--label-file`, `--priority` (0~255), `--bpu-cores` (e.g. `0 1`); detection also has `--nms-thres` (default 0.45), `--score-thres` (default 0.25), `--img-save-path`.

> ⚠️ Running the S-series samples needs `numpy` / `opencv-python` / `scipy`; on S600 `pip install` may require `--break-system-packages`. For grabbing camera frames use Hobot VIO (`hobot_vio`, e.g. `libsrcampy`) — see rdk-multimedia.

---

## 3. C / C++ board-side inference

### 3.1 X3 / X5 — libsp / spcdev wrapper (`/app/cdev_demo/bpu`)

Source: X cdev `00_overview.md`, `bpu.md`. This is a **C-language** sample, **not** raw libdnn — it is built on the **spcdev interface (`libspcdev.so`)**: parse command-line args → query the display resolution via the spcdev API → initialize the model module, display module, and video-input module → scale via VPS as needed → pre/post-processing threads turn inference results into coordinates → display.

```bash
cd /app/cdev_demo/bpu/src && make        # output at src/bin/sample
cd /app/cdev_demo/bpu/src/bin
# camera + yolov5
./sample -f /app/model/basic/yolov5s_672x672_nv12.bin -m 0
# h264 playback + fcos
./sample -f /app/model/basic/fcos_512x512_nv12.bin -m 1 -i 1080p_.h264 -w 1920 -h 1080
```
Arguments: `-f` model path, `-m` model select (0 = yolov5 / 1 = fcos), `-i` input video (when there is no camera), `-w/-h` output width/height, `-d` debug. `include/` holds the model headers, `src/` holds the entry point and each model's pre-process/inference/post-process implementation. The log prints model info (input/output tensorLayout/tensorType/validShape/alignedShape).

> Before running a sample that drives the display, `systemctl stop lightdm` to stop the graphical desktop.

### 3.2 S100 / S100P / S600 — libdnn (`hbDNN*`) + libhbucp (`/app/cdev_demo/bpu`)

Source: S `04_C++_Sample/01_Summary.md`, `02_ResNet18.md`. The C++ sample's base is **libdnn / libhbucp** (the same C++ libraries as the `hbm_runtime` Python binding). The official sample wraps inference in a **per-model class** (e.g. `inc/resnet18.hpp` + `src/resnet18.cc`, called from `main.cc`), and inference is performed via the class's **`.infer()`** method.

```bash
cd classification_sample/resnet18   # on S100 this is 01_classification_sample/01_resnet18
mkdir build && cd build && cmake .. && make -j$(nproc)
./resnet_18 \
  --model_path /opt/hobot/model/s600/basic/resnet18_224x224_nv12.hbm \
  --test_img   /app/res/assets/zebra_cls.jpg \
  --label_file /app/res/labels/imagenet1000_clsidx_to_labels.txt \
  --top_k 5
```
- Verified build environment: CMake 3.22.1 / GCC·G++ 11.4.0; S100 = Ubuntu 22.04, S600 = Ubuntu 24.04.
- Four functional stages: load (parse input/output name/shape) → pre-process (BGR resize to 224x224, convert to NV12, split Y/UV) → `.infer()` forward → post-process (read output tensors, parse Top-K).
- Common dependency `libgflags-dev`; ASR also needs `libsndfile1-dev` / `libsamplerate0-dev`; S100 OCR needs `libpolyclipping-dev`.
- Shared helpers in `utils/inc`: `common_utils.hpp` (de-quantize / draw), `preprocess_utils.hpp`, `postprocess_utils.hpp` (NMS / decode / mask), `multimedia_utils.hpp` (video-frame decode / pixel-format conversion).

> **The raw libdnn (`hbDNN*`) C++ interface** (per-function details: `hbDNNTensorProperties`, tensor alloc/copy, `hbDNNInfer`, etc.) is **not** in the rdk_s_doc tree; it is in the OE / 天工开物 docs (`j6.doc.oe.hobot.cc .../ucp/runtime/bpu_sdk_api/`). If this repo needs it, write a separate page sourced from the OE docs — do not invent signatures from memory.

---

## 4. Per-sample matrix

### X5 pydev (software 3.5.0+, `hbm_runtime`, `.bin`)
| Directory | Task | Model |
|---|---|---|
| `01_classification_sample/` | Image classification | ResNet18 / MobileNetV2 |
| `02_detection_sample/` | Object detection | YOLOv5x / YOLO11 / YOLOv8 / YOLO10 |
| `03_instance_segment_sample/` | Instance segmentation | — |
| `04_pose_sample/` | Pose estimation | — |
| `05_open_instance_segment_sample/` | Open-vocabulary instance segmentation | — |
| `06_segment_sample/` | Semantic segmentation | — |
| `07_usb_camera_sample/` `08_mipi_camera_sample/` `09_web_display_camera_sample/` | Camera + inference + (web) display | capture/display detailed in rdk-multimedia |

### X3 pydev (`pyeasy_dnn`, `.bin`)
Numbered list (go by `ls` on the board): `01_basic_sample` (classification: ResNet18/GoogleNet/MobileNetV1/…), `04_segment`, `06/07/09 yolov3/v5/v5x`, `11_centernet`, `12_yolov5s_v6_v7`, `02_usb_camera`, `03_mipi_camera`, `05_web_display_camera`, `08_decode_rtsp_stream`.

### S-series Python / C++ samples (`hbm_runtime` / libdnn, `.hbm`)
S100 directories are numbered (`01_classification_sample` … `11_web_display_camera_sample`); S600 directories are not (`classification_sample` … `rtsp_yolov5x_display_sample`). Coverage: classification, detection, instance segmentation, pose, (S100 extra) open-vocabulary segmentation / lane detection / OCR, speech (ASR), USB/MIPI cameras, web display, decode/RTSP display.

---

## 5. Boundary with rdk-multimedia (no duplicate copying)

The X cdev multimedia capture/encode/decode C demos — `vio_capture`, `vio2encoder`, `vio2display`, `decode2display`, `rtsp2display` — are **libsp/sp_dev** camera→encode/decode→display pipelines (e.g. `./vio2encoder -w 1920 -h 1080 -o stream.h264` produces h264), overlapping with **rdk-multimedia**'s sp_dev coverage.

This page only reminds you, when "inference needs to be fed camera/video frames", that: **capture, encode/decode, and display via the sp_dev / libsrcampy API are detailed in rdk-multimedia**; board-side inference itself (load model / `forward`·`run`·`infer` / input-output tensors / post-processing) is on this page.

---

## 6. Not covered / uncertain

- **X5 version divide:** pyeasy_dnn vs hbm_runtime depends on the X5 software version (3.5.0 is the known migration point). Which path Ultra's pydev uses, and whether old scripts still work with pyeasy_dnn after an older X5 is upgraded to 3.5.0+, are not stated in the docs — go by the actual `import` and `ls /app/pydev_demo/` on the board.
- **Raw libdnn C++ API (`hbDNN*`):** per-function signatures are not in this batch of docs — they are in the OE docs; the S-series C++ samples only demonstrate a per-model class + `.infer()`, without exposing the underlying call sequence.
- **X-series spcdev C API header list:** `bpu.md` only says "built on the spcdev interface / `libspcdev.so`" without listing the individual spcdev function signatures.
- **The full pyeasy_dnn API surface:** this batch of docs gives `dnn.load` / `models[i].forward` / `inputs[i].properties` / `outputs[i].properties` / `outputs[i].buffer`, but no complete method/property manual; for a deeper dig, consult the X-series multimedia API or a dedicated hobot_dnn page.
