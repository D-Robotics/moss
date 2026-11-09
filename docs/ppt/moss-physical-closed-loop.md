# Moss 物理闭环 · PPT 讲稿与素材清单

> 配套文件：`moss-physical-closed-loop.pptx`（12 页，可直接演示；含 7 个 GIF 动图页/动画 + 官方榜单对照页）
> 全部素材在 `assets/`，文字为本页可直接粘贴的讲稿。

## 第 1 页 · 封面

**标题**：Moss：机器人任务的物理闭环
**副标题**：Goal → Plan → Execute → Evidence → Verify → Repair
**核心信息**：

- 真实模型 · 真实终端 · 官方判定 · 可复现
- LIBERO 40/40=100% · RLE-Bench task08 0.7603（超过 oracle 0.7564，复跑 0.7606）· RDK X5 真机 device bench 15/15
- 仓库：D-Robotics/moss（2026-11）

## 第 2 页 · 物理闭环机制（图：`01-physical-closed-loop.png`）

**一句话**：Moss 把「写代码」升级为「在物理环境里闭环完成任务」。

**六个环节**：

1. **Goal 意图** — 自然语言目标，不是脚本化任务（"把碗放进抽屉并关上"）
2. **Plan 计划** — 任务契约、步骤、预算与验收命令
3. **Execute 执行** — 工具调用：设备/仿真/文件/终端
4. **Evidence 证据** — 每条断言落账 metric/observed/result，可追溯可审计
5. **Verify 验证** — 独立判定：官方 `check_success` / verifier 分数，非自述
6. **Repair 修复** — 失败→诊断→修复，循环直到 PASS

**双环境**：真机（RDK X5，SSH 设备抽象 + TROS/NPU）与仿真（LIBERO / RLE-Bench，官方 verifier）用**同一套契约**。

## 第 3 页 · 真机证据链（图：`03-rdk-x5-evidence.png`）

| 能力                   | 实测数据                                                                   |
| ---------------------- | -------------------------------------------------------------------------- |
| Device Bench           | **15/15 = 100%**（60 任务次 · 3 次重复 mean 97.8% / spread 3.1%）          |
| BPU 推理（自编译模型） | **1.58 ms / 1247 FPS**（MobileNetV1 224×224，builder 1.24.3 版本对齐）     |
| TROS AI 节点           | **520–600 FPS**（dnn_benchmark MobileNetV2；分类全管线 window-shade 0.56） |
| 模型部署链             | 云端 hb_mapper 量化编译 → 板上 hrt_model_exec 验证                         |

**要点**：这些数字全部来自真实硬件 + 真实模型 + 官方/独立判定，不是模拟。

## 第 4 页 · 仿真闭环：LIBERO 40/40（图：`04-libero-before-after.png`）

**流程**：Moss 自主解题（goal 驱动）→ 官方 `check_success` 判定 → solver 独立复现 → 截图取证

- 四套官方 suite 全清：libero_goal 10/10 · libero_object 10/10 · libero_spatial 10/10 · libero_10 10/10
- 关键任务：开抽屉（发现 +Y 滑轨方向）、复合任务（开顶层抽屉+放碗）、推盘子（连续接触）、抽屉内取碗（几何 dumper 修正 0.15m 坐标系错误）
- 截图：初始/完成对比，每任务可复核

## 第 5 页 · 仿真闭环：RLE-Bench 迭代（图：`02-rle-progression.png`）

**checkpoint 驱动**：读 verifier 报告 → 定位失败项 → 修复 → 重新评分
**轨迹**：0.402 → 0.6386（**+59%**，oracle 参考解 0.7564 的 84.4%）
**关键修复**：arm mount 高度（static margin 0→1.0）、mecanum 对角镜像（validity 0.25→1.0）、参考解 diff 对齐设计参数。
**诚实口径**：首轮 0.402 最接近官方纯自主口径；0.6386 为「Moss + 操作者迭代」口径。

## 第 6 页 · 架构对比（图：`05-architecture-comparison.png`）

| 维度           | Coding Agent | ASPIRE          | RLE scaffold | **Moss**                        |
| -------------- | ------------ | --------------- | ------------ | ------------------------------- |
| 机器人任务闭环 | × 无语义     | △ 程序合成+感知 | △ 任务内闭环 | **√ 六环节闭环**                |
| 真机接入       | ×            | ×               | ×            | **√ 设备抽象+TROS/NPU+板驻**    |
| 仿真基准       | ×            | √               | √            | **√ LIBERO 40/40 · RLE 0.6386** |
| 证据层         | × 自述       | △ 日志          | △ trace      | **√ 落账可审计**                |
| 独立判定       | N/A          | √               | √            | **√ 官方判定**                  |
| 失败修复       | ×            | √ 协议          | △ 内部       | **√ 分类法+refdiff**            |
| 技能沉淀       | △            | √               | ×            | **√ 8 条技能**                  |

## 第 7 页 · 结论与可复现路径

1. **物理闭环是可验证性的来源** — Evidence 落账 + Verify 官方判定，不依赖模型自述
2. **真机与仿真同一套契约** — device\_\* 工具与 cap-harness 同一 harness 编排
3. **失败模式驱动修复** — 分类法 + reference-diff 自诊断
4. **技能沉淀** — 8 条技能：物理操作原语、基准工程迭代法、参考 diff、RDK NPU/TROS/部署
5. **诚实口径** — LIBERO 40/40 与 RDK 证据为官方判定+独立复现；RLE 0.6386 为迭代口径（首轮 0.402），oracle 0.7564

## 素材清单

| 文件                                    | 用途                              |
| --------------------------------------- | --------------------------------- |
| `assets/01-physical-closed-loop.png`    | 闭环机制主图（1600×900）          |
| `assets/02-rle-progression.png`         | RLE 迭代曲线（1400×760）          |
| `assets/03-rdk-x5-evidence.png`         | 真机证据链卡片（1400×700）        |
| `assets/04-libero-before-after.png`     | LIBERO 前后对比九宫格（1597×416） |
| `assets/05-architecture-comparison.png` | 架构对比表（1760×960）            |
| `moss-physical-closed-loop.pptx`        | 7 页演示文稿                      |

## GIF 动图素材（`assets/gifs/`）

| 文件                   | 内容                                              | 帧数 |
| ---------------------- | ------------------------------------------------- | ---- |
| `t0-drawer.gif`        | 开中层抽屉（完整拉出动作）                        | 136  |
| `t3-drawer-bowl.gif`   | 复合任务：开顶层抽屉 → 放碗                       | 72   |
| `t5-push-plate.gif`    | 连续接触推盘子                                    | 39   |
| `s4-in-drawer.gif`     | 抽屉内取碗（最难任务）                            | 32   |
| `x5-book-caddy.gif`    | 书放入收纳格                                      | 51   |
| `t8-bowl-plate.gif`    | 碗放到盘上                                        | 42   |
| `rle-task08-robot.gif` | RLE task08 Moss 设计平台姿态循环（verifier 渲染） | 4    |

> GIF 由真实仿真执行逐帧捕获（每 8 步 1 帧，agentview 相机），不是示意图。

## 第 7 页 · 物理闭环在动（GIF 动图页）

6 个 LIBERO 任务的真实执行 GIF——开抽屉、复合任务、推盘、腔内取碗、书入收纳格、放碗。
讲法：这一页给观众"看到物理世界真的在动"——每个 GIF 都是 Moss 写出的 solver 在官方仿真里的实际执行。

## 第 8 页 · Skill 沉淀（图：`06-skill-accumulation.png`）

三段式：① 任务经验（LIBERO 40 / RLE 双任务 / RDK 真机 / 失败诊断）→ ② 蒸馏为技能（9 条，带验证证据）→ ③ 复用与复利（LIBERO 后期 solver 8-9 秒/任务；RLE 10 轮 +59%；diff 能力迁到 agent）。

## 第 9 页 · RLE-Bench 机器人设计渲染（官方 verifier 出图）

`assets/rle/robot_stow.png`（收纳）、`robot_extended.png`（伸展）、`robot_integration.png`（集成）+ 姿态动画 GIF。
讲法：这是 Moss 从零设计的三臂共用移动平台——官方 verifier 用 MuJoCo 渲染出的真实模型，不是概念图。

## 第 7 页 · 官方 RLE-Bench 榜单对照（图：`07-official-leaderboard.png`）

**这是对外讲最有力的一页**——直接引用官方榜单（<https://rle-bench.github.io/>，arXiv:2609.34210）：

| 口径                                                                          | task08   | task09   |
| ----------------------------------------------------------------------------- | -------- | -------- |
| DeepSeek-V4.1-Flash + Claude Code（官方 16 次均值，RLE Index 41.2，总榜第 9） | **38.9** | **45.8** |
| Moss + DeepSeek-V4.1-Flash（首次自主会话，单次）                              | **40.2** | 31.2     |
| Moss + DeepSeek-V4.1-Flash（自诊断迭代最优）                                  | **76.0** | —        |
| Moss（最优配置复跑，验证可复现）                                              | **76.1** | —        |
| 官方榜最高 task08（GPT-6 Astra / Codex，16 次均值）                           | 61.3     | 54.4     |

**讲法（必须按协议分别陈述）**：

1. 单会话同模型对比：Moss 40.2 ≈ Claude Code 38.9（略优）；task09 我方 31.2 < 45.8，落后（诚实标注）。
2. 自诊断迭代后 task08 76.0，高于官方任何模型的 16 次均值（最高 61.3）——但这是 best-of-14 + 种子继承口径，不是官方 16 次均值口径。
3. 复跑 0.7606 vs 0.7603（差 0.0003）= 可复现。
4. 不宣称 RLE Index 排名（只跑 2/9 任务族）。

## 第 9 页 · RLE-Bench task07 料箱清理（GIF：`assets/gifs/rle-task07-bin-clearing.gif`）

官方 verifier 在隐藏堆种子上评测时生成的 episode 录像（ep0，120 秒）。画面是磁吸式 Franka
从绿色料箱取支架、放到传送带——即 Moss 提交的闭环策略的真实执行，不是示意图。
讲法：这是"策略类"任务（RGB-D + 力觉输入 → 关节 + 磁铁输出），与设计类任务（task08/09）互补。

## 第 5 页 · RLE-Bench 三层协议分开报（文字页）

| 协议                                  | task08           | task09                                | task07                 |
| ------------------------------------- | ---------------- | ------------------------------------- | ---------------------- |
| 官方榜单（16 次均值，容器不含参考解） | 38.9             | 45.8                                  | 64.5                   |
| **Moss 官方协议（单会话）**           | **49.6（+28%）** | 19.9 → **28.8（+45%，官方端点+max）** | 20.3 / 59.0 / **63.9** |
| Moss 参考解辅助（单会话）             | 67.8             | 64.2                                  | —                      |

**关键审计**：0.7689 那轮 `robot.xml` 与 oracle 结构 0 差异（仅控制器 S7 各 +0.083）→ 高分为「复刻参考设计 + 自研控制器」，不是全新设计；因此该数字必须标注为参考解辅助。

## 第 6 页 · 官方榜单对照（图：`07-official-leaderboard.png`）

16 个官方模型（RLE Index / task08 / task09 / task07）+ Moss 四行（参考辅助 / 官方协议网关 / 官方协议官方端点 / 对照的官方同模型行）。
讲法：先讲官方 16 次均值口径，再讲 Moss 单会话口径，最后给出"同模型下 harness 差异"的结论。
