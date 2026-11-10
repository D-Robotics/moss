# 选定榜单：RoboProbe（RoboDojo LLM-as-Policy 榜）

> 目标（用户）：找一个**仿真机器人官方榜单**，其中 **DeepSeek-V4-Flash 已有公开成绩**，且
> **harness 可替换**——这样同模型换我们的 harness，就能测出"harness 的能力"。

## 为什么是 RoboProbe

[RoboProbe](https://github.com/RoboProbe/RoboProbe) 是 RoboDojo 官方的 **LLM-as-Policy** 代码库与榜单
（论文 [arXiv:2609.24170](https://arxiv.org/abs/2609.24170)，报告页
[robodojo-benchmark.com/report/gpt-6-astra-eval](https://robodojo-benchmark.com/report/gpt-6-astra-eval)）：

| 条件                           | RoboProbe 是否满足                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方仿真机器人榜单             | ✅ RoboDojo-Sim：42 tasks × 5 能力维度（generalization / precision / long-horizon / memory / open）                                                                                             |
| DeepSeek-V4-Flash 已跑过且公开 | ✅ **DeepSeek-Flash 2.99 Score / 1.92% SR**（10 eps/task、420 trials、medium effort；论文 Table 1 rank 28）                                                                                     |
| harness 可替换                 | ✅ 榜单比的是 **LLM + harness 整体**；harness 可改 model/provider client、system/task prompt、tool 词表与校验、memory/图像历史策略、call/token/step 预算、非学习运动规划、retry/repair/停止行为 |
| 提交门槛可行                   | ✅ **单个 RoboDojo task 的官方 cell = 50 episodes（25 + 25 random）**，单 cell 改善即可上榜（不必跑满 2100）                                                                                    |
| 可复现披露                     | ✅ 需公开源码、完整 prompt、模型版本、tool surface、motion stack、预算、与参考 harness 差异                                                                                                     |

## 同 harness 的公开参照（Score / SR%）

| 系统                                               |    Score |         SR | 备注                                                                        |
| -------------------------------------------------- | -------: | ---------: | --------------------------------------------------------------------------- |
| GPT-6 Astra（L3 Inspect EEF，official 2100）       |    28.72 | **22.48%** | 2100 trials；论文 rank 4 区间                                               |
| GPT-5.5（同 harness）                              |     1.13 |      0.88% | rank 33                                                                     |
| **DeepSeek-Flash（同 harness 家族，10 eps/task）** | **2.99** |  **1.92%** | 论文 rank 28；per-dim 2.42/1.67、1.75/0.00、2.12/0.00、2.17/1.67、6.50/6.25 |
| Claude Fable 5.2（Anthropic 内部自测，非官方榜）   |        — |  **64.9%** | 微信文章；max effort                                                        |
| Claude Opus 5.5（同上）                            |        — |      39.4% | 微信文章                                                                    |
| Claude Fable 5.1（同上）                           |        — |      27.6% | 微信文章                                                                    |

→ 我们的目标数字：**用 Moss harness + deepseek-flash 在同一个 cell 上超过 DeepSeek-Flash 的 1.92% SR / 2.99 Score**。

## 备选：DexJoCo（RAX）

[DexJoCo](https://dexjoco.github.io/) 是 MuJoCo 灵巧手基准；[RAX](https://github.com/robot-agent-exploration/rax)
在它上面有 DeepSeek 基线：**RAX + DeepSeek-v4.1-flash 66.0%**（11 tasks）vs **RAX + Claude Opus 5.5 96.7%**、
ME-Dex 65.3%、π0.5 54.1%、Fast-WAM 52.9%。同样是"harness 决定上限"，但 RoboProbe 更贴合：
官方榜、单 cell 可提交、harness 契约文档化。

## 落地计划

1. **工作区**（机器 `120.48.90.140`）：`/root/rp-ws/{RoboDojo-eval,XPolicyLab}`（分别指向 `/root/RoboDojo`、`/root/RoboProbe`）。
2. **基线**：`policy/RoboDojo_Agent_L3_Inspect_EEF` + deepseek-flash，先在 1 个 task 上小样本复现 ~0–2% 量级。
3. **Moss harness**：fork 参考 adapter → `RoboProbe_Moss`，把"每 turn 一次 provider 调用"换成
   "每 turn 一次 Moss headless 会话"（`moss_planner.py`：图像落盘 → `moss -p` 用 `read_image` 看图 →
   输出单 tool_call JSON）。按契约披露 prompt/tool/motion/预算差异。
4. **正式 cell**：选定 task 跑 50 episodes（25+25），对比基线；有改善即准备 PR 到 RoboProbe。

## 已解决的阻塞

| 阻塞                                                                     | 处理                                       |
| ------------------------------------------------------------------------ | ------------------------------------------ | --- | ----- |
| 客户端依赖 `openai==3.8.0` / `pillow==12.3.0`                            | 按 adapter `install.sh` 装入 RoboDojo 环境 |
| `policy_uv_env_path` 指向未安装的 Pi_05                                  | 改为已装好的 `../Pi_0/openpi`              |
| `robodojo_sim_env.sh` 在 `set -euo pipefail` 下 libcuda 探测失败直接退出 | 探测管道加 `2>/dev/null                    |     | true` |
| 机器缺少 `zenity` 导致 crash dialog                                      | 安装 `sudo`；提供 `zenity` no-op stub      |

## 未打通

- 参考 harness 启动仍缺 RoboProbe 自己的脚本资产（`robodojo_untiled_capture_manager.py` 等），
  必须从 `/root/rp-ws` 工作区按 RoboProbe 的方式运行，而不是直接用 RoboDojo 自带 XPolicyLab。
