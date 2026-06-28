# RDK Model Zoo — Directory & Runtime Reference

> Sources: official D-Robotics repos verified for this skill — [rdk_model_zoo](https://github.com/D-Robotics/rdk_model_zoo) (`rdk_x5`, `rdk_x3`, `rdk_s` branch READMEs and `samples/` listings) and [rdk_model_zoo_s](https://github.com/D-Robotics/rdk_model_zoo_s) (`s100`). Listings evolve with the repo — `ls samples/` on the actual checked-out branch is the final source of truth.

## Branch strategy (single source of truth)

| Board | Repo | Branch | Status |
|-------|------|--------|--------|
| RDK X5 | `rdk_model_zoo` | `rdk_x5` | **Primary delivery branch.** RDK OS ≥ 3.5.0 / Ubuntu 22.04 aarch64 / TROS-Humble. |
| RDK X5 (legacy) | `rdk_model_zoo` | `rdk_x5_legacy` | Former `main`, kept only as historical archive. Don't use for new work. |
| RDK X3 | `rdk_model_zoo` | `rdk_x3` | X3 devices. Uses `demos/<task>/` (not `samples/`). |
| RDK S100 / S100P / S600 | `rdk_model_zoo` | `rdk_s` | **Current delivery branch for all three S-boards.** README: *"Primary delivery branch for RDK S100, S100P, and S600."* |
| RDK S100 / S100P | `rdk_model_zoo_s` | `s100` | Historical archive. Complete and runnable, but superseded by `rdk_s`. |

Key correction over older guidance: `rdk_s` is now the unified, maintained S-series branch (S100 **and** S600), and `rdk_model_zoo_s` is explicitly the **archive**. The `feat/add-samples-s600-support` work has been merged into `rdk_s`, so there is no need to chase a `feat/*` dev branch for S600 samples.

There is **no `rdk_ultra` Model Zoo branch** and no Ultra benchmark appendix. RDK Ultra (Bayes, `march bayes`) is served by the toolchain conversion flow in rdk-device, not by Model Zoo precompiled artifacts.

## Directory layout (rdk_x5 / rdk_s `samples/`)

```text
rdk_model_zoo/
└── samples/
    ├── vision/
    │   ├── classification: convnext / edgenext / efficientformer(v2) / efficientnet /
    │   │        efficientvit / fasternet / fastvit / googlenet / mobilenetv1~v4 /
    │   │        mobileone / repghost / repvgg / repvit / resnet / resnext / vargconvnet / vit
    │   ├── detection: fcos / yolov5 / ultralytics_yolo / ultralytics_yolo26 /
    │   │              yoloworld (open-vocabulary) / yolov13_imoonlab
    │   ├── segmentation / matting: yoloe (instance) / yoloe11_seg / unetmobilenet (semantic) /
    │   │              modnet (matting) / ultralytics_yolo (seg task)
    │   ├── pose: ultralytics_yolo (pose task)
    │   ├── OCR: PaddleOCR / lprnet (license plate) / paddle_ocr
    │   ├── depth / 3D / tracking: depth_anything_v2 / pointnet / 3dresnet / bytetrack
    │   └── multimodal: clip (image-text) / siglip (VLM/VLA vision encoder)
    ├── speech/   (rdk_s: asr (Wav2Vec2) / kws)
    └── vla/      (rdk_s: act — Embodied AI / robot policy)
```

`ultralytics_yolo` / `ultralytics_yolo26` are single dirs that cover **detection / segmentation / pose / classification** as separate tasks — the first entry point for any YOLO need.

> The exact set differs per branch. X5 (`rdk_x5`) does not ship `speech/` or `vla/`; X3 (`rdk_x3`) uses a different `demos/` layout. Always `ls` the branch you checked out.

## Format × runtime table

| Board | BPU arch | Artifact | Python runtime | Notes |
|-------|----------|----------|----------------|-------|
| RDK X3 | Bernoulli2 | `.bin` | `pyeasy_dnn` / `hobot_dnn` | Classic stack, lightweight models |
| RDK X5 | Bayes-e | `.bin` | `hbm_runtime` (legacy branch: `hobot_dnn`/`pyeasy_dnn`) | Artifact is `.bin`, NOT `.hbm`; C/C++ also ships |
| RDK S100 / S100P / S600 | Nash | **`.hbm`** | **`hbm_runtime`** | Distinct from X3/X5 `.bin` — the usual point of confusion |

C/C++ and Python interfaces coexist; each sample dir provides both scripts and a README.

## Precompiled model download

- Download root: `https://archive.d-robotics.cc/downloads/rdk_model_zoo/<branch>/<MODEL_FAMILY>/<file>`
- Filenames encode quantization marker + input size/layout, e.g.
  `yolo11x_detect_bayese_640x640_nv12.bin` (`bayese` = Bayes-e quant, `nv12` = input layout).
- Most samples take `--model-path <.bin|.hbm>` and run; the input image comes from the sample's bundled test image or a camera.
- Each sample's `model/` dir also has a `download_model.sh` / `fulldownload.sh` helper.

## Run checklist

1. `cat /sys/class/socinfo/board_id` → confirm board → clone the matching branch.
2. Enter `samples/vision/<model>/`, download the precompiled artifact for your board into `model/` (or follow `conversion/` to build it yourself).
3. Install the runtime the sample needs (`hbm_runtime`; legacy branches use `hobot_dnn`/`pyeasy_dnn`).
4. From `runtime/python/`, run **`main.py`** (never `python3 *.py`) — validate single-image inference + visualization first, then attach a camera/video stream.
5. If slow / low FPS, confirm you're running the BPU `.bin`/`.hbm`, not a raw `.pt`/`.onnx` (CPU-only → 1–2 FPS; see rdk-device).

## Common mistakes

- **Wrong branch**: running `rdk_x3` / `rdk_x5_legacy` demos on an X5 → model or API mismatch. Pick the branch first.
- **`.bin` onto an S-board**: S-boards are Nash → `.hbm`. Cross-architecture artifacts are not interchangeable; pull from `rdk_s` or rebuild with `hb_compile`.
- **Chasing a `feat/*` branch for S600**: no longer needed — S600 samples are on `rdk_s`.
- **Assuming BPU = zero CPU**: input/output quantize-dequantize and unsupported ops fall back to CPU. Expected.

## Per-board, per-model benchmarks

This file covers **organization and runtime**. For **which exact models each board has officially measured, latency/FPS, and quantization accuracy drop**, see [per-board-model-catalog.md](per-board-model-catalog.md). It also pins the **S600 path** (appendix currently has LLM benchmark only; vision/speech/vla samples live on `rdk_s`).

## Related official resources

- [Per-board model catalog (this repo)](per-board-model-catalog.md)
- [Model Zoo (X3/X5)](https://github.com/D-Robotics/rdk_model_zoo)
- [Model Zoo S archive (S100/S100P)](https://github.com/D-Robotics/rdk_model_zoo_s)
- [Model Zoo benchmark appendix (model_zoo_doc)](https://github.com/D-Robotics/model_zoo_doc/tree/main/docs/appendix)
- [BPU toolchain overview](https://developer.d-robotics.cc/rdk_doc/Advanced_development/toolchain_development/overview)
- [NodeHub application center](https://developer.d-robotics.cc/en/nodehub)
