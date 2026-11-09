# RLE-Bench 官方榜单口径与 Moss 实测对照

来源：<https://rle-bench.github.io/>（榜单数据 `assets/data/leaderboard.json`，2026-11 抓取）
论文：RLE-Bench: A Qualifying Exam for Coding Agents as Robot Learning Engineers，
Ma, Gao, Qiang, Li, Dai · arXiv:2609.34210

## 官方口径（必须按此对照，否则不可比）

- **16 次运行取均值**（`tasks.task08.n_runs = 16`），每个模型固定 harness（Claude Code / Codex / Antigravity CLI / Grok Build）。
- **task08 分数 = 五个阶段加权**：validity 0.15、design 0.35、static 0.15、dynamic 0.2、integration 0.15；
  **三臂取最小值**（minimum over Panda / UR5e / xArm7）；任一 gate 失败封顶 0.15。
- **task09 分数 = 三臂 reward 的均值**（franka/ur5e/xarm7 各权重 1）。
- 统一 0–1 分数，榜单展示 ×100；RLE Index = 先各 workflow 内均值、再跨 workflow 均值。

## 官方 task08 / task09 排行（节选，全部 16 个模型）

| #     | 模型                    | harness         | RLE Index | task08   | task09   |
| ----- | ----------------------- | --------------- | --------- | -------- | -------- |
| 1     | GPT-6 Astra             | Codex           | 71.8      | 61.3     | 54.4     |
| 2     | Gemini 4 Argon          | Antigravity CLI | 70.7      | 54.3     | 50.9     |
| 3     | Claude Opus 5.5         | Claude Code     | 68.3      | 56.6     | 56.1     |
| 4     | GPT-6.1 Sol             | Codex           | 66.0      | 55.1     | 49.0     |
| 5     | Claude Fable 5.1        | Claude Code     | 64.9      | 56.3     | 49.0     |
| 6     | Claude Opus 5           | Claude Code     | 56.3      | 52.4     | 56.0     |
| 7     | Kimi K3.1 Pro           | Claude Code     | 55.1      | 59.3     | 47.9     |
| 8     | GPT-5.6 Sol             | Codex           | 49.6      | 54.7     | 46.7     |
| **9** | **DeepSeek-V4.1-Flash** | **Claude Code** | **41.2**  | **38.9** | **45.8** |
| 10    | Grok 4.6                | Grok Build      | 33.4      | 40.2     | 28.8     |
| 11    | Claude Opus 4.8         | Claude Code     | 31.3      | 42.2     | 52.0     |
| 12    | GLM-5.3 Flash           | Claude Code     | 31.0      | 36.5     | 32.5     |
| 13    | Gemini 3.7 Flash        | Antigravity CLI | 29.3      | 37.6     | 42.9     |
| 14    | GPT-5.6 Luna            | Codex           | 23.7      | 44.0     | 16.3     |
| 15    | GPT-5.6 Terra           | Codex           | 22.1      | 41.2     | 48.2     |
| 16    | GPT-6 Luna              | Codex           | 21.8      | 37.7     | 21.2     |

## Moss 实测（同一官方 task + 官方 verifier，本地运行）

| 协议                                                     | task08   | task09   | 说明                                                             |
| -------------------------------------------------------- | -------- | -------- | ---------------------------------------------------------------- |
| **DeepSeek-V4.1-Flash + Claude Code（官方，16 次均值）** | **38.9** | **45.8** | 官方榜单第 9 名（RLE Index 41.2）                                |
| Moss + DeepSeek-V4.1-Flash，**通用自主单会话**           | **56.7** | **61.3** | 无种子、无任务提示；agent 自主 refdiff 诊断后提交（+46% / +34%） |
| Moss + DeepSeek-V4.1-Flash，**自诊断迭代最优**           | **76.0** | —        | 14 轮迭代，iter13 达成                                           |
| Moss + DeepSeek-V4.1-Flash，**最优配置复跑**             | **76.1** | —        | 验证可复现（0.7603 → 0.7606）                                    |
| 官方 task08 最高（GPT-6 Astra / Codex，16 次均值）       | 61.3     | 54.4     | Moss 迭代最优 76.0 高于此值（协议不同，已标注）                  |

## 结论（按协议分别陈述，不混用）

1. **单会话同模型对比（通用自主模式，无操作者干预）**：Moss 56.7 vs Claude Code 38.9（task08，+46%）；
   task09 Moss 61.3 vs 45.8（+34%）。
2. **迭代/自诊断协议的增量**：Moss 通过自诊断把 task08 从 40.2 提到 76.0（+89%），
   数值高于官方任何模型的 16 次均值（最高 GPT-6 Astra 61.3，Codex）。
   **但必须标注**：这是 best-of-14 + 种子继承的迭代口径，不是官方 16 次均值口径。
3. **可复现性**：同种子同指导复跑 0.7606 vs 0.7603，差 0.0003 —— 迭代结果稳定。
4. **可运行范围**：9 个任务族中只有 task07/08/09 是 CPU 可跑（其余 6 个 manifest 声明
   `gpu = true`：robocasa 仿真、感知模型等）；本机无 GPU，故只报这三个。task07 运行中。
5. **不主张**：不宣称 RLE Index 排名（未跑完整 9 任务族）。

## 复现方式

- 官方任务与 verifier 来自 <https://github.com/RLE-Bench/RLE-Bench> 的 rlebench 2.0.0；
- 我们的 harness 适配器在服务器 `/root/RLE-Bench/rlebench/agents/moss.py`；
- 每次运行产物：`jobs/task08/moss/*/task08__*/{agent/moss.txt, artifacts/logs/artifacts/robot.xml, controller.py, verifier/report.json}`；
- 最优工件备份：`best-task08-robot.iter13-0.7603.xml` / `best-task08-controller.iter13-0.7603.py`。
