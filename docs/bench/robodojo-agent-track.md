# RoboDojo agent 轨：让 Moss 本人当策略（进行中）

> 背景：WeChat 文章（Anthropic 内部自测）用 **Claude Fable 5.2 / GPT-6 Astra** 在
> **RoboDojo Sim 的 agent 轨**取得 64.9% / 29.8% 平均分。那是"通用大模型 + 同一 harness
> 直接输出 EEF 动作"，不是 VLA 策略轨。我们要的同口径对比，是让 **Moss（agent loop +
> deepseek-flash + read_image）** 坐在 harness 的策略位，而不是让 provider API 裸答。

## harness 结构（官方自带）

`XPolicyLab/policy/GPT_6_Astra_Direct_EEF/` 就是文章用的 agent 轨适配器：

| 文件                             | 作用                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `inspect/policy.py`              | L4 inspect agent loop：system 文档 + 相机图像 + 历史 tool 结果 → **恰好一个 tool_call** |
| `inspect/planner_http_worker.py` | 每个 turn 在子进程里发一次 provider 请求（Responses / Azure chat）                      |
| `inspect/recipes/*.md`           | 每任务的操作提示（默认启用）                                                            |
| `docs.py`                        | 给模型的操作说明书（双腕相机、毫米级修正、双臂归位判据 0.15 m / 20°）                   |
| `run_fixed_layout.sh`            | 选 layout 跑单任务的入口（`XPL_CONDITION=L4-inspect-eef`）                              |

环境变量即接口：`L4_INSPECT_{PLANNER,BASE_URL,API_KEY_ENV,MODEL,API_STYLE,REASONING_EFFORT,TIMEOUT_S,MAX_LLM_CALLS,...}`。

## 我们的改法（Moss 当策略）

1. 复制适配器为 `DeepSeek_Direct_EEF`，加两条：
   - `PLANNERS["deepseek"] = Planner("deepseek-flash","openai_chat","")`；
     `PLANNERS["moss"] = Planner("moss+deepseek-flash","moss_cli","")`，默认 `moss`。
   - `planner_http_worker._execute` 增加 `openai_chat`（`OpenAI(base_url=…)`）与
     `moss_cli`（交给下面的桥）两个分支。
2. 新增 `inspect/moss_planner.py`：**把每个 turn 交给一个 headless Moss 会话**
   - 把该 turn 的相机图像（data URL）落盘；
   - 把 system 文档 + 对话 + 工具 schema 拼成 prompt；
   - 调 `moss -p <prompt> --max-turns 6`（cwd=/root/RoboDojo，deepseek-flash，reasoning max）；
   - Moss 用 `read_image` 看图、推理，把选定的单个工具调用写成 `action.json`；
   - 桥把它包装成 chat completion + tool_call 返回给 harness。
   - 每个 turn 的 prompt / stdout / stderr / action 都留在 `/tmp/l4_moss/step_*/` 作为证据。

这样分数记在"**Moss + deepseek-flash**"名下，且 harness 与文章完全一致（同 docs、同 recipes、
同 planner、同评分）。

## 已打通 / 未打通

| 项                                                         | 状态                                                                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Moss 升级到 0.32.0（机器上 `moss v0.32.0 (497c5d4)`）      | ✅                                                                                                                                 |
| `moss -p` 一次性模式 + `--max-turns`（0.32 无 `--no-tty`） | ✅                                                                                                                                 |
| deepseek-flash 视觉输入（实测识别图片内容）                | ✅                                                                                                                                 |
| 适配器 provider 分支 + Moss planner 桥                     | ✅ 代码就绪                                                                                                                        |
| 客户端依赖（`openai==3.8.0`、`pillow==12.3.0`）            | ✅ 已按 install.sh 装进 RoboDojo 环境                                                                                              |
| `policy_uv_env_path` 指向已装好的 `../Pi_0/openpi`         | ✅                                                                                                                                 |
| **harness 启动**                                           | ⛔ 阻塞：`XPolicyLab/scripts/robodojo_sim_env.sh` 的 libcuda 探测在本机（无 `libcuda.so.<driver>` 直链）`set -u` 下 rc=1，sim 未起 |

## 下一步

1. 修 `robodojo_sim_env.sh` 的 libcuda 探测（或直接复用 `scripts/robodojo.sh` 路径并显式
   `XPL_CONDITION=L4-inspect-eef`），让 L4 客户端起得来。
2. 单任务 smoke（`general_pickup` layout 0，`L4_INSPECT_MAX_LLM_CALLS` 小）验证 Moss 动作被接受。
3. 跑若干任务/layout，得"平均分/SR"，与 Fable 5.2 的 64.9% 同口径并列。
