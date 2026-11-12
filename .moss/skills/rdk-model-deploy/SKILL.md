---
name: rdk-model-deploy
description: Quantize and compile a model for the RDK X5 BPU with the OE toolchain (hb_mapper), deploy the .bin to the board, and benchmark it on the NPU
when: deploying, converting, quantizing, or porting a model to RDK X5 / the BPU
---

# RDK X5 model deployment (OE toolchain)

## Prerequisites

The OE toolchain (hb_mapper) must be installed on an x86 machine — never on the board itself.
OE v1.2.8 wheels: hbdk, horizon-nn, horizon-tc-ui, horizon-plugin-pytorch (torch 1.13+cu116).
On Ubuntu 22.04, install wheels directly (the installer script hard-checks 20.04).

## Workflow

1. **Prepare the model** — Caffe (.caffemodel + .prototxt) or ONNX, with a YAML config mirroring
   OE samples under `horizon_model_convert_sample/`.
2. **Validate**: `hb_mapper checker --model-type onnx --model-path <model>`
3. **Calibration data**: preprocess representative images to .bgr (the sample's `02_preprocess.sh`).
4. **Quantize + compile**: `hb_mapper makertbin --config <yaml>` → `model_output/<name>.bin`
5. **Deploy**: scp the .bin to the board (relay through the workstation if cloud/board are on
   different networks).
6. **Verify on the board**: `hrt_model_exec model_info` then `hrt_model_exec perf --thread_num 2`.

## Verified example (2026-11)

Caffe MobileNetV1 → calibration → `hb_mapper makertbin` → 4.3 MB `mobilenetv1_224x224_nv12.bin` →
board deploy → `model builder version = 1.24.3` (matches toolchain) → **1.58 ms / 1247 FPS**.

## Rules

- Calibration data quality decides quantization accuracy; use domain-representative images.
- `compile_mode: latency` for inference speed, `bandwidth` for memory-bound cases.
- A model that fails to load is a toolchain/board version mismatch, not a runtime failure.
- The board and cloud dev machine may be on different networks — relay through the workstation.

## Known dependency traps (Ubuntu 22.04)

`pycocotools` needs cython+numpy pre-installed and `--no-build-isolation`; `libglib2.0-0` for
libgthread; `paramiko` for hb_mapper's SSH deploy path.
