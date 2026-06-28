---
name: rdk-model-zoo
description: Run a ready-made, officially pre-compiled BPU model from the RDK Model Zoo on a board — pick the right branch (branch = board), download the matching .bin/.hbm, run the sample, read the per-board benchmark (latency/FPS/accuracy). Use whenever the user wants a precompiled model instead of quantizing their own, asks "does RDK have a converted YOLO/classification/segmentation/OCR .bin/.hbm", "how do I run a Model Zoo sample", "which branch for my board", or "where do I download the precompiled model". 触发词:Model Zoo、现成模型、预编译模型、官方转好的、有没有现成的 bin/hbm、模型仓、跑示例 sample、哪个分支、archive.d-robotics 下载、benchmark 帧率精度、YOLO11 哪块板能跑、模型性能对比。Routing — quantizing your OWN .pt/.onnx through the toolchain → rdk-device; wrapping a model as a TROS/ROS2 node → rdk-ros; conversational LLM/VLM (InternVL/SmolVLM chat) → rdk-llm-deployment; "can my board run model X" / model selection → rdk-ecosystem; embodied ACT/VLA/Pi0 policies → rdk-embodied-lerobot.
---

# RDK Model Zoo — Ready-Made BPU Models

The Model Zoo is the official collection of **out-of-the-box, pre-compiled BPU models** plus full-link conversion tutorials. The single most important fact: **the branch you clone IS your board.** Cloning the wrong branch is the #1 failure — the model artifact or the runtime API will not match your hardware.

> Sources: official D-Robotics repos verified for this skill — [rdk_model_zoo](https://github.com/D-Robotics/rdk_model_zoo) (`rdk_x5` / `rdk_x3` / `rdk_s` branches), [rdk_model_zoo_s](https://github.com/D-Robotics/rdk_model_zoo_s) (`s100` archive), and [model_zoo_doc](https://github.com/D-Robotics/model_zoo_doc) appendix benchmarks. Facts carry provenance; nothing is invented.

## The one rule that matters most

**Branch = board.** Confirm the board first (`cat /sys/class/socinfo/board_id`, or `rdkos_info` for the full OS/board summary), then clone exactly that branch. A `.bin` (Bayes / Bernoulli2) and a `.hbm` (Nash) are **never** interchangeable, and the Python runtime import differs by branch. Do not recite directory or model names from memory — `ls samples/` on the actual checked-out branch is the source of truth.

## Branch → board cheat-sheet (the foundation)

| Board | Repo | Branch | Sample dir | Artifact | Python runtime |
|-------|------|--------|-----------|----------|----------------|
| RDK X5 | `rdk_model_zoo` | `rdk_x5` | `samples/vision/<model>/` | `.bin` | `hbm_runtime` |
| RDK X5 (legacy) | `rdk_model_zoo` | `rdk_x5_legacy` | (old demos) | `.bin` | `hobot_dnn` / `pyeasy_dnn` |
| RDK X3 | `rdk_model_zoo` | `rdk_x3` | `demos/<task>/` (note: `demos/`, not `samples/`) | `.bin` | `pyeasy_dnn` / `hobot_dnn` |
| RDK S100 / S100P / S600 | `rdk_model_zoo` | `rdk_s` | `samples/vision/<model>/` | `.hbm` | `hbm_runtime` |
| RDK S100 / S100P (archive) | `rdk_model_zoo_s` | `s100` | `samples/Vision/<Model>/` | `.hbm` | `hbm_runtime` |

Verified against the live `rdk_x5` and `rdk_s` branch READMEs. The `rdk_s` branch is now the **single current delivery branch for S100, S100P, AND S600** (its README: *"Current branch. Primary delivery branch for RDK S100, S100P, and S600"*). `rdk_model_zoo_s/s100` is the **historical archive** — still complete and runnable, but `rdk_s` is the one to use for new work. A deterministic branch lookup is in `scripts/branch_selector.py`.

> RDK Ultra is **not** a Model Zoo sample branch — there is no `rdk_ultra` branch and no Ultra appendix. Ultra users convert via the toolchain (`march bayes`, see rdk-device) rather than pulling Model Zoo precompiled artifacts.

## Model format & runtime (not portable across families)

- **X3 (Bernoulli2)** → `.bin`, classic `pyeasy_dnn` / `hobot_dnn` stack; lightweight models.
- **X5 (Bayes-e)** → `.bin`. On the `rdk_x5` branch the Python samples use **`hbm_runtime`** (the artifact is still `.bin`, NOT `.hbm`). Only the old `rdk_x5_legacy` branch uses `pyeasy_dnn`/`hobot_dnn`. C/C++ interfaces also ship.
- **S100 / S100P / S600 (Nash)** → **`.hbm`** (not `.bin`!), Python **`hbm_runtime`**. The `.hbm` artifact is the most common point of confusion versus X3/X5's `.bin`.
- Even a BPU-centric model usually keeps **CPU-side quantize/dequantize at the input/output**, and any op that cannot map to the BPU falls back to CPU. This is expected, not a bug.

## Workflows

### Workflow 1 — Pick the branch and run a precompiled model (the core)

**Use when:** "how do I run a Model Zoo sample", "which branch", "where's the precompiled model".

1. **Confirm the board** → `cat /sys/class/socinfo/board_id` (or `rdkos_info`), then read the cheat-sheet row.
2. **Clone the matching branch** (the whole point):
   ```bash
   git clone -b rdk_x5 https://github.com/D-Robotics/rdk_model_zoo.git   # X5
   git clone -b rdk_s  https://github.com/D-Robotics/rdk_model_zoo.git   # S100/S100P/S600
   git clone -b rdk_x3 https://github.com/D-Robotics/rdk_model_zoo.git   # X3
   ```
3. **Download the precompiled artifact** into the sample's `model/` dir. The download root is
   `https://archive.d-robotics.cc/downloads/rdk_model_zoo/<branch>/<MODEL_FAMILY>/<file>`.
   Filenames encode quantization + input layout, e.g. `yolo11x_detect_bayese_640x640_nv12.bin`
   (`bayese` = Bayes-e quantized, `nv12` = input layout).
4. **Run from the right CWD.** Sample dirs are layered `conversion/` + `evaluator/` + `model/` + `runtime/{cpp,python}/` + `test_data/`. The Python entry point is **`main.py`** — do NOT `python3 *.py` (the runtime dir holds `main.py` plus per-task scripts, so a glob hits the wrong file).
   ```bash
   cd samples/vision/ultralytics_yolo/runtime/python
   python3 main.py --task detect \
     --model-path ../../model/yolo11n_detect_bayese_640x640_nv12.bin \
     --test-img ../../../../../datasets/coco/assets/bus.jpg \
     --img-save-path ../../test_data/inference_yolo11.jpg
   ```
   `main.py` with no args runs the default (yolo11n + bus.jpg). Success = the output image is written.
5. **If slow / low FPS**, confirm you are actually running the BPU `.bin`/`.hbm` and not a raw `.pt`/`.onnx` (the latter runs CPU-only → 1–2 FPS; see rdk-device).

### Workflow 2 — Answer "which models does board X have + how fast" (benchmark lookup)

**Use when:** the user asks whether a specific model runs on their board, or wants latency/FPS/accuracy figures.

1. Map board → appendix chapter set (model_zoo_doc `docs/appendix/<board>/`):
   - **X5** (6 chapters): classification, detection, segmentation, pose, OCR, matting — with **Float vs Quant Top-1** and **PyTorch AP vs Python (on-board) AP** so you can judge quantization accuracy drop.
   - **S100/S100P** (7 chapters): classification, detection, segmentation, pose, OCR, depth estimation, LLM — latency + single/dual-thread FPS.
   - **X3** (4 chapters): classification, detection, segmentation, OCR — **no pose / matting / depth / LLM**.
   - **S600** (1 chapter): **LLM benchmark only** in the appendix. S600 vision/speech models exist as runnable samples on the `rdk_s` branch but have no per-model perf appendix yet.
2. For the per-board, per-model tables (verified figures, branch paths), read [per-board-model-catalog.md](references/per-board-model-catalog.md).
3. If the appendix has no entry, that means "no published number," **not** "cannot run" — check the `rdk_s`/`rdk_x5` sample README.

### Workflow 3 — Boundary: ready-made vs. convert-it-yourself

**Use when:** the user is unsure whether to pull a precompiled model or run the toolchain.

- The Model Zoo ships **both** precompiled artifacts (download and run) **and** full conversion tutorials (`conversion/` in each sample). Prefer the precompiled artifact when one exists.
- For a **private/custom** `.pt`/`.onnx` with no Model Zoo match, the general quantization flow (`hb_mapper` for X-series / `hb_compile` for S-series, calibration images, `march`) lives in **rdk-device**. Use the sample's `conversion/` dir as a worked template.

## Worked examples

**Example 1 — "我板子是 S600,Model Zoo 有现成的 YOLO11 吗?用哪个分支?"**
Yes. Clone the **`rdk_s`** branch of `rdk_model_zoo` (it is the current delivery branch for S100/S100P/S600), get the `.hbm` from `samples/vision/yolo11/model/`, and run with `hbm_runtime`. The README lists YOLO11 as S100/S600-supported. Note: the model_zoo_doc appendix only has an **LLM** benchmark for S600, so for vision perf numbers read the S100 tables as a proxy and confirm on-board.

**Example 2 — "我有一个在 X5 上转好的 .bin,能拷到 S100 上跑吗?"**
No. X5 `.bin` is Bayes-e; S100 is Nash and needs a `.hbm`. They are cross-architecture incompatible. Pull the S-series precompiled model from the `rdk_s` branch (or rebuild via `hb_compile --march nash-e`, see rdk-device).

**Example 3 — "Model Zoo 示例怎么跑?我下了一堆 .py 不知道跑哪个"**
Run **`main.py`**, never `python3 *.py`. From the sample, `cd runtime/python`, then `python3 main.py --task detect --model-path ../../model/<file>.bin`. The other `.py` files in that dir are per-task helpers; the glob would hit the wrong one. The default (`main.py` with no args) runs yolo11n on bus.jpg as a smoke test.

**Example 4 — "X5 上 yolo11n 量化后掉多少精度?帧率多少?"**
Read the X5 detection appendix (`per-board-model-catalog.md` → RDK X5 → detection): yolo11n is ~8.2 ms single-thread, ~122 FPS, PyTorch AP 0.323 → Python (on-board, post-quant) AP 0.308. X5's appendix is the one place that gives Float-vs-Quant and PyTorch-vs-Python AP so you can quantify the drop.

## Common pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| Clone `main` / `rdk_x5_legacy` / guess the branch | `git clone -b <board-branch>` — branch = board |
| Treat `rdk_model_zoo_s/s100` as the only S source | Use `rdk_s` branch of `rdk_model_zoo` for new S100/S100P/S600 work |
| Copy a `.bin` onto an S-board (or `.hbm` onto X) | Pull the artifact for the matching branch (`.bin` ≠ `.hbm`) |
| `python3 *.py` in the runtime dir | Run `main.py` with `--task`/`--model-path` |
| Assume "no appendix entry" = "can't run" | Check the sample README on the board's branch |
| Expect an `rdk_ultra` Model Zoo branch | Ultra has none — convert via toolchain (rdk-device) |
| Recite sample/model names from memory | `ls samples/` on the actual checked-out branch |

## Reference map

| Read this | When |
|-----------|------|
| [model-zoo-catalog.md](references/model-zoo-catalog.md) | Branch strategy, directory layout, format×runtime table, download path, run checklist — the "how the repo is organized" reference |
| [per-board-model-catalog.md](references/per-board-model-catalog.md) | Per-board, per-model verified benchmark tables (latency / FPS / accuracy) and exact branch/sample paths — including the S600 LLM numbers and the S100/S600 sample matrix |
| `scripts/branch_selector.py` | Deterministic board → repo / branch / sample-dir / artifact / runtime lookup |
