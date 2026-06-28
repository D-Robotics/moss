# BPU Toolchain: X-series `hb_mapper` → `.bin` vs S-series `hb_compile` → `.hbm`

> Sources: every fact below is taken item-by-item from official docs and is traceable.
> - X-series (Bernoulli2 / Bayes / Bayes-e): rdk_doc `docs/07_Advanced_development/04_toolchain_development/overview.md`, `.../intermediate/ptq_process.md`, `.../intermediate/runtime_sample.md`, `.../intermediate/supported_op_list.md`
> - S-series (Nash): rdk_s_doc `docs/07_Advanced_development/04_toolchain_development/01_algorithm_toolchain/01_overview.md`, `docs/04_Algorithm_Application/02_Python_API.md`, `docs/04_Algorithm_Application/04_C++_Sample/02_ResNet18.md`; rdk_model_zoo (`rdk_s` branch) `samples/vision/mobilenetv2/conversion/`, `samples/vision/3dresnet/conversion/`, `samples/vision/resnet152/conversion/`
> - OE online manual: <https://toolchain.d-robotics.cc/>; OE resource portal: <https://developer.d-robotics.cc/rdk_doc/rdk_s/Advanced_development/toolchain_development/overview>
>
> Note: model conversion always runs **inside Docker on an x86 Linux host**; **the board only has the runtime**. The `march` values, command names, and artifact suffixes below follow the latest official toolchain docs; for uncertain `march` variants (e.g. `nash-m` / `nash-p`) see the end of this file.

## Table of contents

- [0. One-glance comparison](#0-one-glance-comparison)
- [1. Shared prerequisites: floating-point model constraints (both paths)](#1-shared-prerequisites-floating-point-model-constraints-both-paths)
- [2. X-series path: hb_mapper → .bin](#2-x-series-path-hb_mapper--bin)
- [3. S-series path: OpenExplorer + hb_compile → .hbm](#3-s-series-path-openexplorer--hb_compile--hbm)
- [4. Key differences and traps](#4-key-differences-and-traps)

---

## 0. One-glance comparison

| Dimension | X3 / X5 / RDK Ultra | S100 / S100P / S600 |
|---|---|---|
| BPU architecture | Bernoulli2 (X3) / Bayes (Ultra) / Bayes-e (X5) | Nash |
| Host toolchain | Algorithm toolchain / OpenExplorer (`hb_mapper` family) | OpenExplorer / 天工开物 OE (`hb_compile` family) |
| Validation command | `hb_mapper checker` | `hb_compile --model x.onnx --march <nash-*>` |
| Compile command | `hb_mapper makertbin --config x.yaml` | `hb_compile --config x.yaml` |
| `march` value | X3 = `bernoulli2`, Ultra = `bayes`, X5 = `bayes-e` | **S100 = `nash-e`, S100P = `nash-m`** (official FAQ); S600 = `nash-p` |
| Artifact suffix | `.bin` | `.hbm` |
| Intermediate / debug artifact | `hb_perf` html, `hb_mapper_*.log` | `*_quantized_model.bc` (HBIR, can be run on x86 for comparison) |
| Host performance eval | `hb_perf x.bin` | x86 inference script (ONNX / HBIR / HBM three-way comparison) |
| Board low-level library | `libdnn.so` + `hbDNN*` C API | `libdnn` + `libhbucp` / `libucp` |
| Board high-level loader | `hobot_dnn` / TROS `dnn_node` | `hbm_runtime` (`HB_HBMRuntime`, pybind11) |
| LLM path | — | Separate SDK, not the CNN path in this table: `D-Robotics_LLM_S100` (S100/S100P) / `D-Robotics_LLM_S600` (S600), see §4.5 |

**Cross-architecture artifacts are not interchangeable:** `.bin` and `.hbm` are mutually incompatible, and artifacts compiled for different `march` values are mutually incompatible.

---

## 1. Shared prerequisites: floating-point model constraints (both paths)

> Source: rdk_doc `.../overview.md`; Nash op evidence in §4.4

- Frameworks: supports Caffe 1.0 float models, plus ONNX float models with `ir_version ≤ 7` and `opset10` / `opset11`; other frameworks must first be exported to a conforming ONNX.
- Input: only **fixed 4-D** NCHW or NHWC is supported, and the **N dimension must be 1** (e.g. `1x3x224x224` or `1x224x224x3`); dynamic dimensions and non-4-D inputs are not supported.
- Post-processing: **do not include post-processing ops such as NMS** in the float model — compute them in the deployment-side post-processing instead.
- Ops not on the official support list are temporarily unsupported because of BPU hardware limits; **check the official op-support list before converting**: [supported_op_list](https://developer.d-robotics.cc/rdk_x_doc/Advanced_development/toolchain_development/intermediate/supported_op_list) (source `rdk_x_doc:docs/07_Advanced_development/04_toolchain_development/intermediate/supported_op_list.md`). For the S-series Nash op constraints, follow the S toolchain chapter on the official site.

---

## 2. X-series path: `hb_mapper` → `.bin`

> Source: rdk_doc `.../intermediate/ptq_process.md`

### 2.1 Validate the model (checker)
```bash
hb_mapper checker \
  --model-type ${model_type} \   # caffe or onnx
  --march ${march} \             # X3=bernoulli2 / Ultra=bayes / X5=bayes-e
  --model ${model.onnx} \
  --input-shape ${input_name} ${NxCxHxW}   # optional; pass once per input for multi-input models
```
- The log defaults to `hb_mapper_checker.log` (`--output` is deprecated).
- A CPU op splits the model into multiple Subgraphs; ideally there is only 1 subgraph. Moving CPU ops like `pow`/`reshape` into post-processing reduces subgraphs.

### 2.2 Prepare yaml + calibration data + compile (makertbin)
```bash
# without fast-perf (the formal conversion)
hb_mapper makertbin --config ${config_file} --model-type ${model_type}

# with fast-perf (only for quickly measuring peak performance of the bin)
hb_mapper makertbin --fast-perf --model ${model} --model-type ${type} --march ${march}
```

Key yaml structure (excerpt):
```yaml
model_parameters:
  onnx_model: '****.onnx'        # or prototxt + caffe_model (pick one)
  march: 'bernoulli2'           # Ultra=bayes / X5=bayes-e
  output_model_file_prefix: 'mobilenetv1'
  working_dir: './model_output_dir'
input_parameters: { ... }       # input type / layout / normalization
calibration_parameters: { ... } # calibration data directory and method
compiler_parameters:
  optimize_level: 'O3'          # at O3, bayes/bayes-e enable a compile cache by default
```
- On failure, check `hb_mapper_makertbin.log`; on success the console tail gives a clear notice plus the per-output cosine similarity.

### 2.3 Host performance evaluation
```bash
hb_perf ***.bin          # for a packed model, add -p: hb_perf -p ***.bin
```
Produces `hb_perf_result/` (subgraph structure + BPU static analysis; **does not include the CPU portion** — CPU performance must be measured on the board).

### 2.4 Board-side loading
- Low level: `libdnn.so` + the `hbDNN*` C API (`hbDNNGetModelHandle`, `hbDNNInfer`, `hbDNNResize`, `hbDNNRoiInfer`, etc.).
- High level: load the `.bin` with `hobot_dnn` / the TROS `dnn_node` (e.g. `dnn_node_example`); models commonly live in `/userdata/models/`.

---

## 3. S-series path: OpenExplorer / 天工开物 OE + `hb_compile` → `.hbm`

### 3.1 Install the toolchain (OE package + Docker)
> Source: rdk_s_doc `.../01_algorithm_toolchain/01_overview.md` (V3.7.0, mapping to S100 system software 4.0.5 / S600 5.1.0; confirm on the board with `cat /etc/version`)

```bash
# OE development package (includes the OE user manual; online version at https://toolchain.d-robotics.cc/)
wget https://d-robotics-aitoolchain.oss-cn-beijing.aliyuncs.com/oe/3.7.0/oe-package-3.7.0-s100-s600.tgz

# CPU Docker (online pull)
docker login -u "ccr\$deliver-ronly" registry.d-robotics.cc -p '<password is in the official overview doc>'
docker pull registry.d-robotics.cc/deliver/ai_toolchain_ubuntu_22_s100_s600_cpu:v3.7.0
# or offline tar: .../oe/3.7.0/ai_toolchain_ubuntu_22_s100_s600_cpu_v3.7.0.tar (GPU variant is analogous)
```

Start the container (mount the project + enlarge shared memory):
```bash
sudo docker load -i ai_toolchain_ubuntu_22_s100_xxx.tar   # offline package
sudo docker run -it --rm \
  --network host --shm-size=15g \
  -v "$(pwd)":/workspace --workdir /workspace \
  <docker-image-name> /bin/bash
```
> Source: rdk_model_zoo `rdk_s` branch `samples/vision/3dresnet/conversion/README_cn.md`

### 3.2 Validate the model (quick check with hb_compile)
> Source: rdk_model_zoo `rdk_s` branch `samples/vision/mobilenetv2/conversion/README.md`
```bash
hb_compile --model mobilenetv2_100.onnx --march nash-e
```

### 3.3 Prepare calibration data
> Source: rdk_model_zoo `rdk_s` branch `samples/vision/resnet152/conversion/get_calibration_data.py`

Pre-process with the `horizon_tc_ui` transformer (must match the inference pre-processing exactly: mean subtraction, normalization), and save the result as `.npy` (float32):
```python
from horizon_tc_ui.data.transformer import (
    PaddedCenterCropTransformer, ResizeTransformer, HWC2CHWTransformer,
    MeanTransformer, ScaleTransformer, RGB2BGRTransformer)
transformers = [
    PaddedCenterCropTransformer(224),
    ResizeTransformer(target_size=(224,224), mode='skimage', method=3),
    HWC2CHWTransformer(),
    ScaleTransformer(scale_value=255.0),
    MeanTransformer(means=np.array([123.675,116.28,103.53])),
    ScaleTransformer(scale_value=0.017),
]
```
Calibration image count: the sample uses about **100 images** (covering the real input distribution).

### 3.4 Write config.yaml + compile (hb_compile → `.hbm`)
> Source: rdk_model_zoo `rdk_s` branch `samples/vision/mobilenetv2/conversion/mobilenetv2_config.yaml`

```yaml
model_parameters:
  onnx_model: '../mobilenetv2_100.onnx'
  march: "nash-e"
  layer_out_dump: False
  working_dir: '../model_output'
  output_model_file_prefix: 'mobilenetv2_224x224_nv12'
input_parameters:
  input_type_rt: 'nv12'
  input_type_train: 'bgr'
  input_layout_train: 'NCHW'
  norm_type: 'data_mean_and_scale'
  mean_value: 103.53 116.28 123.675
  scale_value: 0.017429 0.017507 0.017124
calibration_parameters:
  cal_data_dir: '../calibration_data_bgr'
  cal_data_type: 'float32'
  calibration_type: 'default'
compiler_parameters:
  optimize_level: 'O2'
```
```bash
hb_compile --config conversion/mobilenetv2_config.yaml
# Artifacts: model_output/mobilenetv2_224x224_nv12.hbm
#            + model_output/mobilenetv2_224x224_nv12_quantized_model.bc (HBIR intermediate)
```
Note the yaml structure is **isomorphic** with the X-series §2.2 — the only differences are the `march` value, the command name (`hb_compile` vs `hb_mapper makertbin`), and the artifact suffix (`.hbm` vs `.bin`).

### 3.5 Host-side accuracy comparison (.bc HBIR)
> Source: rdk_model_zoo `rdk_s` branch `mobilenetv2/runtime/python/x86_inference.py`

The x86 inference script can directly consume **ONNX / HBIR (.bc) / HBM**, which makes before/after-quantization comparison easy:
```bash
python3 runtime/python/x86_inference.py -m model_output/mobilenetv2_224x224_nv12_quantized_model.bc -i test.jpg
# example post-quantization cosine similarity: output Calibrated 0.993383 / Quantized 0.988877
```

### 3.6 Board-side loading: `hbm_runtime`
> Source: rdk_s_doc `docs/04_Algorithm_Application/02_Python_API.md`, `docs/04_Algorithm_Application/04_C++_Sample/02_ResNet18.md`

**Install** (a pybind11 wrapper over `libdnn` / `libhbucp` / `libucp`; requires Python ≥ 3.10):
```bash
sudo apt-get install hobot-dnn          # or dpkg -i hobot-dnn_*.deb
# installation builds the hbm_runtime wheel, dropped into the board's /tmp:
#   hbm_runtime-x.x.x-cp310-cp310-manylinux_2_34_aarch64.whl
pip install /tmp/hbm_runtime-*.whl       # or pip install hbm_runtime
```

**Python inference (minimal):**
```python
import numpy as np
from hbm_runtime import HB_HBMRuntime
model = HB_HBMRuntime("/opt/hobot/model/s600/basic/resnet18_224x224_nv12.hbm")
name = model.model_names[0]
inp = model.input_names[name][0]
x = np.ones(model.input_shapes[name][inp], dtype=np.float32)
out = model.run(x)            # returns a nested {model_name: {...}} structure
print(out[name])
```
- Supports single-model multi-input (`Dict[str, np.ndarray]`) and multi-model (`Dict[str, Dict[...]]`, several `.hbm` files or a single `.hbm` containing multiple models). During inference the C++ side releases the GIL → Python threads can run concurrently.
- Optional scheduling: `set_scheduling_params(...)` to set defaults, or override priority / BPU-core binding / device id per call inside `run()`.

**C++ inference:** the sample project is on the board at `/app/cdev_demo/bpu/.../resnet18/`; after `cmake .. && make`:
```bash
./resnet_18 --model_path /opt/hobot/model/s600/basic/resnet18_224x224_nv12.hbm --top_k 5
```
The default model directory is `/opt/hobot/model/s100|s600/basic/`.

---

## 4. Key differences and traps

### 4.1 Don't confuse the command names
- The S-series uses `hb_compile`, **not** `hb_mapper`; only the X-series uses `hb_mapper checker` / `hb_mapper makertbin`. Typing `hb_mapper` on an S-series board or container will not find it.

### 4.2 `march` values
- X3 = `bernoulli2`, RDK Ultra = `bayes`, X5 = `bayes-e` (all have official doc provenance).
- **The official FAQ distinguishes `march` by SKU: Super100 (S100) = `nash-e`, Super100P (S100P) = `nash-m`** (the BPU architecture name *is* the `march`). The sample `mobilenetv2_config.yaml` uses `nash-e`, which is S100's; for S100P switch to `nash-m`. **S600 = `nash-p`** (confirmed: the LLM SDK's `resolve_model_nash-p.md` is for S600). The `type` field in `bpu_export_config.yaml` may be `nash-e` (S100) / `nash-m` (S100P) / `nash-p` (S600), each mapping to a different SKU.

### 4.3 Artifacts and intermediates
- X: `.bin` + `hb_perf` html; S: `.hbm` + `*_quantized_model.bc` (HBIR, runnable on x86 for comparison).
- On neither side should you copy a `.pt` / raw `.onnx` onto the board and run it directly — that runs on CPU only.

### 4.4 Op constraints (Nash, evidenced)
> Source: rdk_model_zoo `rdk_s` branch `samples/vision/3dresnet/conversion/README_cn.md` (OpenExplorer 3.5.0)
- The toolchain supports `Conv3D` but **does not support** 3D `GlobalAveragePooling`; replace that 3D pooling path with an equivalent 2D `ReduceMean` before compiling.
- After conversion most ops of this model have similarity > 0.99, and the final quantization similarity is about 0.99.
- For the general constraints, see §1.

### 4.5 LLM is a separate path
> Source: rdk_s_doc `.../02_LLM_Toolchain/01_s100_LLM_Toolchain.md`
- S100/S100P large models (DeepSeek-R1-Distill-Qwen, InternLM2, Qwen2.5, Qwen2.5-Omni) go through the separate `D-Robotics_LLM_S100` SDK (q4/q8 quantization, PPL evaluation, board-side `oellm_runtime`) — **not** the general `hb_compile` CNN path of this document. (Note: the S600 LLM stack is different again — it uses the `D-Robotics_LLM_S600` SDK with `oellm_runtime` / `libxlm.so`.)
```bash
wget https://d-robotics-aitoolchain.oss-cn-beijing.aliyuncs.com/llm_s100/1.0.0/D-Robotics_LLM_S100_1.0.0_SDK.tar.gz
```
