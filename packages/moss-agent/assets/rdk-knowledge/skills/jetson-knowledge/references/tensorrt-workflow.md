# TensorRT Inference Workflow on Jetson

> Source: NVIDIA official — [TensorRT documentation](https://docs.nvidia.com/deeplearning/tensorrt/), the `trtexec` tool shipped in `/usr/src/tensorrt/`, [jetson-inference](https://github.com/dusty-nv/jetson-inference), and [DeepStream](https://developer.nvidia.com/deepstream-sdk). Flags reflect TensorRT 8.5+ / 10.x as shipped in JetPack 5.1.x / 6.2.

## The model path on Jetson

On Jetson you deploy a **TensorRT engine** (`.engine` / `.plan`), not a raw `.pt` or `.onnx`. TensorRT builds an optimized, hardware-specific engine that uses the GPU's Tensor Cores (and DLA on Orin/Xavier). A raw PyTorch/ONNX-Runtime model runs unoptimized and far slower.

```
train (host) → export ONNX → [on the target Jetson] trtexec build → .engine → deploy
```

**Engines are not portable.** A TensorRT engine is specialized to the exact GPU architecture **and** TensorRT version it was built against. An engine built on JetPack 5 will not load on JetPack 6, and an AGX Orin engine should be rebuilt for an Orin Nano. **Always build the engine on the target module.**

## 1. Export ONNX (host)

From PyTorch:
```python
torch.onnx.export(model, dummy_input, "model.onnx",
                  opset_version=17, input_names=["input"], output_names=["output"])
```
Match the ONNX opset to your TensorRT version's supported range. Prefer a static or explicitly-bounded dynamic shape; fully dynamic shapes need an optimization profile at build time.

## 2. Build the engine with trtexec (on the Jetson)

`trtexec` ships at `/usr/src/tensorrt/bin/trtexec`:

```
/usr/src/tensorrt/bin/trtexec \
  --onnx=model.onnx \
  --saveEngine=model.engine \
  --fp16
```

Useful flags:

| Flag | Purpose |
|------|---------|
| `--fp16` | Build an FP16 engine — the default fast path on Jetson; large speedup, minimal accuracy loss |
| `--int8` | INT8 engine — fastest on Orin's INT8 path; needs a calibration cache (`--calib=`) or QAT model for accuracy |
| `--best` | Let TensorRT pick the fastest precision per layer (FP32/FP16/INT8 mix) |
| `--useDLACore=0 --allowGPUFallback` | Offload supported layers to **DLA** accelerator (Orin/Xavier), freeing the GPU; fall back to GPU for unsupported layers |
| `--saveEngine=` / `--loadEngine=` | Serialize / load a prebuilt engine |
| `--shapes=input:1x3x640x640` | Set input shape for dynamic-shape models |
| `--workspace=N` (8.x) / `--memPoolSize=workspace:NM` (10.x) | Builder scratch memory |

## 3. Set the performance mode BEFORE benchmarking

Benchmarking before configuring power gives misleadingly low FPS. First:

```
sudo nvpmodel -m 0        # NX Super  (Nano Super: -m 2) — check `nvpmodel -q` for indices
sudo jetson_clocks        # pin GPU/CPU/EMC to max
```

Then measure. `jetson_clocks` does not raise the `nvpmodel` ceiling — set the power mode first.

## 4. Profile

```
/usr/src/tensorrt/bin/trtexec --loadEngine=model.engine   # latency / throughput report
tegrastats                                                 # confirm GPU% actually moves during inference
```
If `tegrastats` shows the GPU idle during inference, the model is not running on the TensorRT/GPU path.

## Higher-level entry points (prefer these over hand-rolling)

- **jetson-inference (Hello AI World)** — `github.com/dusty-nv/jetson-inference`: ready-made image classification, detection (SSD/YOLO), and segmentation with prebuilt models and Python/C++ APIs; good first deployment.
- **DeepStream SDK** — production multi-stream video analytics pipelines (decode → TensorRT inference → tracking → output) built on GStreamer; the right tool for camera/RTSP inference at scale.
- **Torch-TensorRT / `torch2trt`** — compile PyTorch modules to TensorRT directly when you want to stay in Python.

## Common mistakes

- Copying a `.engine` between boards or JetPack versions → rebuild on the target.
- Forgetting `nvpmodel`/`jetson_clocks` before measuring → low FPS that looks like a model problem.
- Building INT8 without calibration → large accuracy drop; supply a calibration cache or use a QAT model.
- Expecting DLA to run every layer → DLA supports a subset; always pair `--useDLACore` with `--allowGPUFallback`.
