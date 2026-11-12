# RoboProbe 提交材料（草稿，待 cell 完成后定稿）

> 本文件按 RoboProbe 的 _Required disclosure_ 清单逐项填写（见
> [minimal_harness.md](https://github.com/RoboProbe/RoboProbe/blob/main/docs/minimal_harness.md)）。
> 状态：**草稿**——最终数值与逐任务表在 `general_pickup` 官方 cell（50 episodes）跑完后补全。

## 1. 模型与 provider

| 项        | 值                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 模型      | **deepseek-flash**（DeepSeek-V4.1-Flash 别名，provider `/models` 返回 `id=deepseek-flash`, name `DeepSeek-V4.1-Flash`）        |
| provider  | DeepSeek 官方 API，`https://api.deepseek.com/v1`（OpenAI 兼容 chat/completions）                                               |
| 思考强度  | `reasoning_effort=max`（请求体参数；该 provider 的合法档位见其错误信息 `none\|minimal\|low\|medium\|high\|xhigh\|ultra\|max`） |
| 温度/采样 | 未显式设置（provider 默认）                                                                                                    |
| 凭据      | 仅运行时环境变量，不随代码分发                                                                                                 |

## 2. harness 与 prompt 来源

- 基座：**RoboProbe 官方 L3 Inspect EEF**（`policy/RoboDojo_Agent_L3_Inspect_EEF`，commit 见仓库根 README 记录）。
- system prompt：该 adapter 的 `docs.py`（ARX X5 EEF 操作说明书）+ task recipe（`inspect/recipes/<task>.md`，官方自带）。
- **与参考实现的差异**：
  1. 新增 `deepseek` planner 预设与 `openai_chat` 传输（OpenAI 兼容 base_url）；
  2. 客户端依赖放宽：`pillow>=11.3`（原 pin `==12.3.0`），原因见 §6；
  3. `L3_INSPECT_MAX_LLM_CALLS=60`（官方默认 170；同模型的论文口径用 10 eps/task），其余预算默认。
- prompt/harness 源码：随 PR 提供（`docs/bench/roboprobe/` + adapter 目录）。

## 3. 工具面（tool surface）

官方三个工具，未增删：

- `move_eef(targets, note)`：命名绝对世界坐标 EEF 目标（每臂 7 维：x/y/z/pitch/roll/yaw/gripper），
  未命名维度保持当前值；
- `give_up(reason, hindsight)`；
- 无"任务完成"工具（RoboDojo 自己按奖励终止）。

## 4. motion stack

本地非学习 Cartesian planner（RoboDojo/CuRobo），无学习型策略；LLM 只输出 EEF 目标。

## 5. memory 与图像历史

| 项                           | 值                                     |
| ---------------------------- | -------------------------------------- |
| 相机                         | head + left_wrist + right_wrist（RGB） |
| `L3_INSPECT_KEEP_ALL_IMAGES` | 0（默认；仅保留最近图像）              |
| `L3_INSPECT_IMAGE_HORIZON`   | 2（默认）                              |
| depth                        | 关闭（L3 仅 RGB）                      |

## 6. 预算与已知限制

- 每 episode：`L3_INSPECT_MAX_LLM_CALLS=60`；hard timeout/次调用 420 s；env steps 由任务配置（200）。
- cell：`general_pickup` × 50 episodes，单进程、`ROBODOJO_NUM_ENVS=1` 串行。
- 环境限制（如实披露）：本机为容器化 GPU（RTX 5090），无 `cap_sys_boot`；Isaac 首帧渲染会间歇性死锁，
  跑批时用"150 s 无步进即杀进程重试"的看护脚本处理，**不修改任何评分/环境逻辑**。
- `pillow` 版本差异原因：Isaac Sim 5.1 硬性要求 `Pillow==11.3.0`，官方 adapter 的 `install.sh` 要求
  `12.3.0`，两者冲突；以 Isaac 为准并放宽客户端断言（图像读写 API 无差异）。

## 7. 结果（待填）

| 项             | 值                                                                       |
| -------------- | ------------------------------------------------------------------------ |
| 任务 / cell    | `general_pickup` / 50 episodes                                           |
| SR (%)         | 待定稿                                                                   |
| Score          | 待定稿                                                                   |
| 逐 layout 结果 | 见 `docs/research/roboprobe-rsi-ledger.tsv` 与 run 目录 `_result.json`   |
| 复现命令       | `bash /tmp/cell50.sh`（等价命令见 `docs/bench/roboprobe/rsi_runner.sh`） |
