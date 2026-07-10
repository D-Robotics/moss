---
name: rdk-model-zoo
description: Run a ready-made, officially pre-compiled BPU model from the RDK Model Zoo on a board — pick the right branch (branch = board), download the matching .bin/.hbm, run the sample, read the per-board benchmark (latency/FPS/accuracy). Use whenever the user wants a precompiled model instead of quantizing their own, asks "does RDK have a converted YOLO/classification/segmentation/OCR .bin/.hbm", "how do I run a Model Zoo sample", "which branch for my board", or "where do I download the precompiled model". 触发词:Model Zoo、现成模型、预编译模型、官方转好的、有没有现成的 bin/hbm、模型仓、跑示例 sample、哪个分支、archive.d-robotics 下载、benchmark 帧率精度、YOLO11 哪块板能跑、模型性能对比。Routing — quantizing your OWN .pt/.onnx through the toolchain → rdk-device; wrapping a model as a TROS/ROS2 node → rdk-ros; conversational LLM/VLM (InternVL/SmolVLM chat) → rdk-llm-deployment; "can my board run model X" / model selection → rdk-ecosystem; embodied ACT/VLA/Pi0 policies → rdk-embodied-lerobot.
---

# RDK Model Zoo — Ready-Made BPU Models

The Model Zoo is the official collection of **out-of-the-box, pre-compiled BPU models** plus full-link conversion tutorials. The single most important fact: **the branch you clone IS your board.** Cloning the wrong branch is the #1 failure — the model artifact or the runtime API will not match your hardware.

## ⚠️ 关键：先搜索，再回答

**分支映射、板卡支持列表、benchmark 数据都是时效性信息，会随时间变化。回答前必须先调用 `knowledge_search` 搜索最新信息。**

### 分支查询（必须用 knowledge_search）

当用户问"XX板卡用哪个分支"时，**必须**调用：

```
knowledge_search(query="rdk_model_zoo github D-Robotics branches <板卡型号>")
```

搜索后，用 `web_fetch` 打开 `https://github.com/D-Robotics/rdk_model_zoo` 的分支页面确认实际分支列表。

### 模型支持/benchmark 查询（必须用 knowledge_search）

当用户问"XX板卡能不能跑模型Y"或"帧率多少"时，**必须**调用：

```
knowledge_search(query="rdk_model_zoo <板卡型号> <模型名> benchmark support")
```

或直接 fetch `https://github.com/D-Robotics/model_zoo_doc` 的 appendix 页面。

### 分支 = 板卡（核心原则，不会变）

**Branch = board.** 确认板卡型号后，clone 对应分支。`.bin`（Bayes / Bernoulli2）和 `.hbm`（Nash）**绝不**互通，Python runtime 也因分支而异。

> 来源：官方 D-Robotics 仓库 — [rdk_model_zoo](https://github.com/D-Robotics/rdk_model_zoo)、[rdk_model_zoo_s](https://github.com/D-Robotics/rdk_model_zoo_s)（S100 归档）、[model_zoo_doc](https://github.com/D-Robotics/model_zoo_doc) appendix benchmark。

## Model format & runtime（not portable across families）

- **X3 (Bernoulli2)** → `.bin`，`pyeasy_dnn` / `hobot_dnn` 栈
- **X5 (Bayes-e)** → `.bin`，Python 示例用 **`hbm_runtime`**（artifact 仍是 `.bin`，不是 `.hbm`）
- **S100 / S100P / S600 (Nash)** → **`.hbm`**（不是 `.bin`！），Python **`hbm_runtime`**
- 即使 BPU 模型，CPU 侧量化/反量化通常在输入/输出层，无法映射到 BPU 的算子会 fallback 到 CPU——这是预期行为，不是 bug

## Workflows

### Workflow 1 — Pick the branch and run a precompiled model

**Use when:** "how do I run a Model Zoo sample", "which branch", "where's the precompiled model".

1. **先用 `knowledge_search` 查分支**：
   ```
   knowledge_search(query="rdk_model_zoo github branches <板卡型号>")
   ```
2. **确认板卡** → `cat /sys/class/socinfo/board_id`（或 `rdkos_info`），对照搜索结果中的分支
3. **Clone 匹配的分支**：
   ```bash
   git clone -b <branch> https://github.com/D-Robotics/rdk_model_zoo.git
   ```
4. **下载预编译 artifact** 到 sample 的 `model/` 目录。下载根路径：
   `https://archive.d-robotics.cc/downloads/rdk_model_zoo/<branch>/<MODEL_FAMILY>/<file>`
   文件名编码了量化方式 + 输入布局，如 `yolo11x_detect_bayese_640x640_nv12.bin`
5. **Run from the right CWD.** Sample 目录结构为 `conversion/` + `evaluator/` + `model/` + `runtime/{cpp,python}/` + `test_data/`。Python 入口是 **`main.py`**——不要 `python3 *.py`：
   ```bash
   cd samples/vision/ultralytics_yolo/runtime/python
   python3 main.py --task detect \
     --model-path ../../model/yolo11n_detect_bayese_640x640_nv12.bin \
     --test-img ../../../../../datasets/coco/assets/bus.jpg \
     --img-save-path ../../test_data/inference_yolo11.jpg
   ```
   `main.py` 无参数运行默认配置（yolo11n + bus.jpg）。成功 = 输出图片已写入。
6. **如果慢/帧率低**，确认你确实在跑 BPU 的 `.bin`/`.hbm`，而不是原始 `.pt`/`.onnx`（后者 CPU-only → 1-2 FPS；参见 rdk-device）。

### Workflow 2 — Answer "which models does board X have + how fast" (benchmark lookup)

**Use when:** the user asks whether a specific model runs on their board, or wants latency/FPS/accuracy figures.

1. **先用 `knowledge_search` 查 benchmark**：
   ```
   knowledge_search(query="model_zoo_doc appendix <板卡型号> <模型名> benchmark")
   ```
2. 或直接 `web_fetch` 打开 `https://github.com/D-Robotics/model_zoo_doc` 的 appendix 目录
3. 如果 appendix 没有对应条目，说明"没有已发布的数据"，**不是**"不能跑"——查 sample README 确认

### Workflow 3 — Boundary: ready-made vs. convert-it-yourself

**Use when:** the user is unsure whether to pull a precompiled model or run the toolchain.

- Model Zoo 同时提供**预编译 artifact**（下载即用）和**完整转换教程**（每个 sample 的 `conversion/` 目录）。有预编译 artifact 时优先使用。
- 对于**私有/自定义**的 `.pt`/`.onnx`（Model Zoo 没有对应模型），通用量化流程（`hb_mapper` X 系列 / `hb_compile` S 系列，校准图片，`march`）在 **rdk-device** 中。用 sample 的 `conversion/` 目录作为参考模板。

## Worked examples

**Example 1 — "我板子是 S600,Model Zoo 有现成的 YOLO11 吗?用哪个分支?"**
1. 调用 `knowledge_search(query="rdk_model_zoo github rdk_s branch S600 YOLO11")`
2. 用 `web_fetch` 打开 `https://github.com/D-Robotics/rdk_model_zoo/tree/rdk_s` 的 README 确认 YOLO11 支持情况
3. 根据搜索结果回答分支和模型支持情况，附上来源链接

**Example 2 — "我有一个在 X5 上转好的 .bin,能拷到 S100 上跑吗?"**
No. X5 `.bin` 是 Bayes-e；S100 是 Nash 需要 `.hbm`。跨架构不互通。从对应分支拉取 S 系列预编译模型（或用 `hb_compile --march nash-e` 重建，参见 rdk-device）。

**Example 3 — "Model Zoo 示例怎么跑?我下了一堆 .py 不知道跑哪个"**
Run **`main.py`**，never `python3 *.py`。从 sample 目录 `cd runtime/python`，然后 `python3 main.py --task detect --model-path ../../model/<file>.bin`。该目录下的其他 `.py` 是各 task 的 helper，glob 会跑到错误的文件。默认（`main.py` 无参数）跑 yolo11n + bus.jpg 作为冒烟测试。

**Example 4 — "X5 上 yolo11n 量化后掉多少精度?帧率多少?"**
1. 调用 `knowledge_search(query="model_zoo_doc rdk_x5 appendix yolo11n detection benchmark")`
2. 用 `web_fetch` 打开 `https://github.com/D-Robotics/model_zoo_doc` 的 X5 appendix 章节
3. 根据搜索结果回答，X5 的 appendix 是唯一同时给出 Float-vs-Quant 和 PyTorch-vs-Python AP 的来源

## Common pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| 凭记忆或内置知识直接回答分支/benchmark | 先调用 `knowledge_search` 搜索最新信息 |
| Clone `main` / 猜分支 | 搜索确认后 `git clone -b <board-branch>` |
| 把 `.bin` 拷到 S 板（或 `.hbm` 拷到 X 板） | 从匹配分支拉取 artifact（`.bin` ≠ `.hbm`） |
| `python3 *.py` in the runtime dir | Run `main.py` with `--task`/`--model-path` |
| Assume "no appendix entry" = "can't run" | Check the sample README on the board's branch |
| Recite sample/model names from memory | `ls samples/` on the actual checked-out branch |

## Reference map

| Read this | When |
|-----------|------|
| GitHub `rdk_model_zoo` branches page | 查板卡对应哪个分支（用 `web_fetch` 打开） |
| GitHub `model_zoo_doc` appendix | 查 benchmark 数据（用 `knowledge_search` 或 `web_fetch`） |
| `rdk_s` branch README | S100/S100P/S600 的模型支持矩阵 |