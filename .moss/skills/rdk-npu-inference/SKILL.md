---
name: rdk-npu-inference
description: Run and benchmark BPU/NPU inference on an RDK board (X5/S100) over SSH — load a .bin model, verify it loads, measure latency and FPS with hrt_model_exec
when: working with RDK board NPU/BPU, running hbm models, benchmarking NPU inference, or diagnosing model load failures
---

# RDK NPU inference via device tools

## Load and verify a model

```
device_exec: hrt_model_exec model_info --model_file /path/to/model.bin
```
Success shows `Load model to DDR cost Xms` plus per-model info. The `model builder version` in the output
identifies the toolchain that compiled it — a mismatch with the running runtime means a version-skew, not
a runtime failure.

## Benchmark latency and FPS

```
device_exec: hrt_model_exec perf --model_file /path/to/model.bin --thread_num 2
```
Runs 200 frames, then prints `Average latency is: X ms` and `Frame rate is: Y FPS`. Record both as evidence.

## Run inference on an input

```
device_exec: hrt_model_exec infer --model_file /path/to/model.bin --input_bin_path /path/to/input.bin
```

## Board-shipped test models

| Board path | What it is |
| --- | --- |
| `/app/multimedia_samples/chip_base_test/.../HBDK3_MODEL_2K/x5/*.hbm` | BPU self-test (2K resolution) |
| `/app/multimedia_samples/sunrise_camera/.../model_zoom/mobilenetv2_224x224_nv12.bin` | MobileNetV2 classification |
| `/app/multimedia_samples/sunrise_camera/.../model_zoom/yolov5s_672x672_nv12.bin` | YOLOv5s detection |
| `/opt/hobot/model/x5/basic/*.bin` | TROS node models |

## Real baselines (RDK X5, 2026-11)

| Model | Latency | FPS | Source |
| --- | --- | --- | --- |
| MobileNetV1 224x224 (OE-compiled) | 1.58 ms | 1247 | cloud→board deploy |
| MobileNetV2 224x224 (preinstalled) | 1.6-1.8 ms | 520-600 | sunrise_camera |
| HBDK3 2K test model | 44 ms | 45 | chip_base_test |

## Rules

- A `golden result ERROR` after `bpu0 test sucess` in the chip_base_test means a missing reference file,
  not a BPU failure.
- One heavy NPU process at a time; GPU/NPU contention yields intermittent depth/conversion failures.
- Background a long NPU run safely: `nohup CMD > log 2>&1 < /dev/null & echo $! > pid`.
