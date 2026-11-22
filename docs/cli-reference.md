# 命令与配置参考

完整子命令、常用 flag、界面语言与调优环境变量。README 只教最常用的四条命令；
需要精确参数时以本页和 `moss <command> --help` 为准。

## 命令参考

| 子命令                                                                                                                | 用途                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moss`（或 `moss "prompt"`）                                                                                          | 交互界面 / 一次性模式；`-p/--print` 强制 headless，`--json` 给机器可读输出                                                                                                                                                |
| `moss setup` · `moss auth status[--json]\|logout`                                                                     | 配置向导 · 查看 API-key 状态（`--json` → `moss_auth_status.v1`）/ 删除已存 key                                                                                                                                            |
| `moss doctor[--json]`（别名 `moss status`）· `moss uninstall[--json]`                                                 | 体检配置/凭证/工作区/运行时（`--json` → `moss_doctor.v1`）· 打印卸载路径（不自动删除；`--json` → `moss_uninstall.v1`，只读）                                                                                              |
| `moss init [--dry-run] [--json]`                                                                                      | 首次上手（确定性、无需模型）：检测 test/build/lint 入口与验收命令，写最小 AGENTS.md（不覆盖已有），打印下一条验证式运行                                                                                                   |
| `moss goal "<intent>" [--accept "<cmd>"]`                                                                             | `moss task run` 的快捷方式：意图进，验收过的结果出。`--resume [<id>]` 续跑；`--until <cmd>` 进 loop；`--workflow <plan.json>` 进 workflow；`moss run` 是兼容别名                                                          |
| `moss task run\|resume\|status\|timeline`                                                                             | 统一任务运行时；`status/timeline [<id>\|latest] [--json]` 是离线读路径（`--json` 给单个对象；timeline 带 `moss_task_timeline.v1`）                                                                                        |
| `moss loop --until "<cmd>" [--max N] [--every 5m] [--watch <path>] [--max-duration 30m] "<prompt>"`                   | 本地闭环：每轮跑一次全新 headless 会话再用你的命令验收；失败把输出喂回下一轮。`list/show/follow/prune` 是离线读路径                                                                                                       |
| `moss workflow run\|resume\|status\|list [--json]`                                                                    | 声明式 JSON 计划：步骤可依赖、并发、失败只阻塞下游；state 在 `.moss/workflows/<id>/state.json`，`status/resume` 接受 `latest`                                                                                             |
| `moss superagent init\|submit\|work\|status`                                                                          | 可选 Super-agent 工单协调（隔离 worker；本版本无代码托管/消息连接器）                                                                                                                                                     |
| `moss runs [list\|show\|prune\|follow] [--json]`                                                                      | 统一运行账本（`.moss/runs/<run_id>/run.json`）：状态/原因/下一步/工件。`list --kind task/loop/workflow/superagent/chat`、`--since 90s/30m/24h/7d`；`show [<id>\|latest]`；`follow` 实时跟随                               |
| `moss runs summary [--since] [--kind] [--by day\|week\|model] [--json]`                                               | 按日/ISO 周/模型汇总次数、通过率、token 与可算费用                                                                                                                                                                        |
| `moss runs export [<id>\|latest] [--since] [--kind] [--limit] [--format md\|json] [--out <file\|->]`                  | 导出单条或合并报告给 PR/CI；`--out=-` 写 stdout，路径被限制在工作区内                                                                                                                                                     |
| `moss artifacts [contracts\|tasks\|snapshots\|history\|evidence\|deployments\|acceptance\|device\|failures] [--json]` | 只读巡检闭环工件（不需要模型配置；`--json` → `moss_artifacts.v1`，含 kind/items）；`moss tasks …` 是等价旧别名                                                                                                            |
| `moss review list [--limit N] [--json]` · `moss review check [--json]`                                                | 独立评审记录 / CI 门禁：check 的退出码 0 通过、1 有未解决问题、2 无评审或 verdict 未知；`--json` 为 `moss_review_list.v1` / `moss_review_check.v1`                                                                        |
| `moss remember "<fact>" [--dry-run]`                                                                                  | 显式记忆：预览后把一条事实追加到 `AGENTS.md`（不自动记忆；重复幂等）                                                                                                                                                      |
| `moss rules list [--json]`                                                                                            | 作用域规则（`.moss/rules/*.md`）：激活方式 always / globs / manual（`@rule:<name>`）                                                                                                                                      |
| `moss capabilities [--json] [--kind <section>]`                                                                       | 一屏总览能力面：工具/斜杠命令/技能/自定义命令/子代理/钩子/MCP/设备（只读；`--json` → `moss_capabilities.v1`）                                                                                                             |
| `moss mcp add\|list\|remove\|test` · `moss device add\|list\|remove\|test`                                            | MCP 服务器管理 · 设备清单与多机只读巡检；两者 `list --json` 分别输出 `moss_mcp_list.v1` / `moss_devices_list.v1`                                                                                                          |
| `moss skill create\|list\|validate\|install\|update\|lock`                                                            | 技能管理 / 规范校验 / 带 hash 锁的安装与升级；`list --json` → `moss_skill_list.v1`（rows + 目录预算 summary），`validate --json` → `moss_skill_validate.v1`                                                               |
| `moss plugins validate\|install\|list\|remove`                                                                        | 本地能力包（skills + commands + agents + hooks + MCP）的安装/信任/版本；不做托管市场                                                                                                                                      |
| `moss sessions list\|delete\|search\|export [<key>\|--last] [--out <file\|->] [--json]`                               | 会话管理；`list/search --json` 给脚本（`moss_sessions_list.v1` / `moss_sessions_search.v1`），`export --last` 导出最新非空会话（`--json` → `moss_sessions_export.v1`，含 thinking、去 harness 前缀），`--out=-` 写 stdout |
| `moss resume\|fork [--last]`                                                                                          | 恢复 / 分叉会话                                                                                                                                                                                                           |
| `moss config show\|env\|init\|set\|unset\|validate` · `moss trust list[--json]\|remove`                               | 配置读写与文件夹信任（`trust list --json` → `moss_trust_list.v1`；`config show --json` 含 `pricing` 块）；`moss config --help` 是键的完整参考，`moss config env` 是环境变量权威清单                                       |
| `moss update [--json]`                                                                                                | 打印升级命令（npm 全局或 git 克隆）；不执行；`--json` → `moss_update.v1`                                                                                                                                                  |

> `migrate` / `web` / `agent` 属于已移除的子系统，本构建里会**明确报错**，不会悄悄 fallback；`plugins` 现在是本地能力包（`moss plugins validate/install/list/remove`）。`moss <command> --help` 仍给出该子命令自己的用法。

日常斜杠命令：`/model` `/compact` `/goal` `/plan` `/review` `/runs` `/capabilities` `/doctor` `/diff` `/resume` `/paste` `/rules` `/remember` `/skills` `/agents` `/todos` `/permissions` `/language` `/style` `/clear` `/help`。
会话与工件类：`/status`（当前模型/工作区/模式；`--verbose` 给全量诊断）、`/usage`（token 与 api 用时）、`/context`（上下文占用与预算）、`/export [path]`（把会话导出为 markdown，`-` 写 stdout）、`/rewind [seq]`（回退文件与对话到检查点，`/undo` 是最近一个）、`/mcp`（服务器状态与 prompt 模板）、`/hooks`（当前生效的钩子）。`Shift+Tab` 循环模式；`/plan` 进入 plan 模式；`/goal <条件>` 持续工作直到条件满足，`/goal clear` 取消。`/resume` 恢复已保存会话；`/tasks` 列出后台 shell 与子代理（`/jobs` `/bg` `/subs` 为旧别名）。`Esc` 中断当前回复；运行中直接发消息会先 steer，无法 steer 时排在输入区上方（`↑` 取回编辑）。`/mode` `/steer` `/queue` `/loop` 保留为隐藏别名一版（`/loop` 已改为 `/goal`）。`/goal` 没带 `--accept` 时，从工作区已有测试入口（`package.json` test、Makefile、pytest、`go.mod`）给出验收候选，找不到就直说。`/stop`（别名 `/abort`）只停本会话启动的后台进程。隐藏的 `/task` 是 Task OS 入口（status / timeline / resume / view / verify），`/task verify` 不调模型，只取一次裁决。PASS 只能来自 verdict provider。

常用 flag：

| Flag                                                               | 作用                                                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `-m/--model` · `--provider` · `--base-url` · `--lang`              | 仅本次运行覆盖                                                                           |
| `-C/--cd <dir>` · `-c/--config k=v`                                | 换工作区 · 覆盖 profile/model/policy                                                     |
| `--session <key>` · `--last`                                       | 指定 / 最近一个会话                                                                      |
| `--add-dir <dir>`                                                  | 本次运行额外可读写的目录（可重复；不从该目录加载 AGENTS.md/skills）                      |
| `--read-only` · `--workspace-write` · `--full-access`              | 本次运行的模式覆盖。`workspace-write` 只约束 Moss 自己的文件工具，shell 没有操作系统沙箱 |
| `--accept-edits` · `--plan` · `--ask-for-approval <never\|prompt>` | 其他模式覆盖（互斥）；accept-edits 只自动批准文件编辑，shell 仍会询问                    |
| `--allowed-tools <rules>` · `--disallowed-tools <rules>`           | 本次运行的工具规则（逗号分隔，语法同 permissions.\*；deny 始终优先）                     |
| `--trust-device` · `--trust-workspace`                             | 本进程允许毁灭性设备操作 · 信任此文件夹（hooks/MCP/routing）                             |
| `-p/--print` · `--json` · `--output-format <f>` · `--mock`         | 一次性 / 机器可读输出 / 离线 mock                                                        |
| `--quiet` · `--verbose` · `--debug` · `--no-color`                 | 输出与颜色控制                                                                           |

常用环境变量（完整见 `moss config env`）：`MOSS_PROFILE` · `MOSS_WORKSPACE` · `MOSS_SAFETY_MODE` · `MOSS_APPROVAL_POLICY` · `MOSS_MAX_AGENT_TURNS` · `MOSS_CONTEXT_TOKENS` · `MOSS_BUDGET_MAX_*` · `MOSS_DEVICE_*` · `MOSS_NO_RDK_DOCS`。

> **头号坑**：模型相关设置**只认配置文件**。`MOSS_MODEL` / `MOSS_PROVIDER` / `MOSS_BASE_URL` / `MOSS_API_KEY` 即使设了也会被忽略——请用 `moss setup` 或 `moss config set`。

未指定配置文件时，Moss 读取用户配置，并把工作区 `.moss/config.json` 当作项目默认值合并进去（用户配置优先）。`--config-file` 或 `MOSS_CONFIG_FILE` 只加载那个文件，项目 `.moss/config.json` 这一层不会进入本次配置。

## 界面语言

**英文是默认界面语言。** 中文是完整的可选界面语言，只影响界面文案、帮助、错误和配置向导。助手回复仍跟随用户消息的语言，不跟这个设置走。

```bash
moss --lang zh                         # 仅本次运行
MOSS_LANG=zh moss                      # 进程环境变量（项目 .env 不能设置）
moss config set language zh            # 记在用户配置 ~/.config/moss/config.json
moss config set language auto          # 默认：仅当系统区域以 zh 开头时用中文
```

优先级：`--lang` > `MOSS_LANG` > 用户配置 `language` > 系统区域。`C`、`POSIX`、`C.UTF-8` 不是语言，会落到下一个变量（`LC_ALL`、`LC_MESSAGES`、`LANG`）；都不是语言时界面保持英文。项目 `.moss/config.json` 和项目 `.env` 不能设置界面语言。

交互界面里 `/language`（别名 `/lang`）切换本会话；`/language zh save` 写入用户配置。系统区域为中文且还没选过时，首次 `moss setup` 用一行提示：按 `e` 切换为英语。

## Jev 意图识别（实验）

选择服务商并显式开启 shadow 模式。TypeSafe 和 OpenRouter 需要对应的 API Key。

| `MOSS_JEV_PROVIDER` | 密钥环境变量               | 模型                                                                                               |
| ------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| `typesafe`（默认）  | `TYPESAFE_API_KEY`         | `jev-latest`                                                                                       |
| `openrouter`        | `OPENROUTER_API_KEY`       | `jev-latest`，由 [OpenRouter](https://openrouter.ai/docs/guides/community/typesafe-sdk) 按用量计费 |
| `opencode`          | `OPENCODE_API_KEY`（可选） | `jev-1.13-free`，[OpenCode Console](https://opencode.ai/docs/console/models/#jev) 限时免费         |

```bash
MOSS_JEV_PROVIDER=opencode MOSS_JEV_INTENT=shadow MOSS_LOG_LEVEL=info \
  moss -p '先帮我读一下 README，整理启动步骤'
```

诊断日志里的 `Jev intent decision` 包含服务商、输入来源、分类、概率和耗时。分类包括新任务、任务纠正、插问、继续、停止和不明确。分类结果仅用于观察，Agent 仍按原有流程处理输入。识别请求与模型执行并行发出，收尾最多等待请求的两秒超时。

这个开关适用于 CLI 参数、交互式自然语言输入和实时 steering。开启后，Moss 会向所选服务商的 System One API 发送经过凭据脱敏和长度限制的用户文本。判断实时补充时，如果本轮有原始用户请求，会一起提供。诊断日志只记分类元数据。开关和密钥均从启动进程环境读取。

SDK 宿主也可通过 `MossAgentConfig.observeUserIntent` 注入观察器，或通过 `MossAgentConfig.decideSteeringIntent` 注入参与执行的判定器。用 `ChatOptions.userIntentText` 标记原始用户输入。

把 `MOSS_JEV_INTENT` 改成 `active`，即可在交互运行中使用 Jev 判定。运行中发送「改一下，只解释，别改代码」后，Moss 会在下一次工具启动前检查新消息。确认纠正后，本轮尚未启动的工具会收到跳过结果，模型按最新用户消息继续。已经启动的工具保留实际结果。对明确的只读要求，当前运行的后续轮次也只允许使用声明为只读的工具，直到收到明确允许编辑的新指令。

判定失败、超时或概率低于 `0.8` 时，Moss 会按最新用户消息重新规划，并保守地继续只读。被纠正的 `/goal` 会停在 `BLOCKED`，后续验收使用按新要求创建的目标。

### 单条任务中的 Jev 判定

以下开关均从启动环境读取。默认 `off`。`shadow` 记录判定，`active` 将判定用于当前 run。

| 环境变量              | 触发场景                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `MOSS_JEV_APPROVAL`   | 普通交互审批；仅当 Jev 认定完整调用是当前任务所需且概率达到 0.8 时放行一次，否则询问用户 |
| `MOSS_JEV_CONSTRAINT` | 操作可能违反用户给出的硬约束                                                             |
| `MOSS_JEV_OUTPUT`     | 测试或命令产生长文本，筛选给主模型的片段并保留完整日志路径                               |
| `MOSS_JEV_PROGRESS`   | 同一操作重复失败且没有新证据                                                             |
| `MOSS_JEV_COMPLETION` | 主模型拟结束，但用户要求的验证或改动证据仍需核对                                         |

使用 `MOSS_JEV_APPROVAL=active moss` 启用交互审批。Jev 有 2 秒判断当前任务是否需要这次完整操作，放行只对这一笔调用有效。用户或策略的显式 ask 规则、工具钩子要求的确认、受保护路径和敏感设备操作仍走人工审批。无交互终端时继续遵循原有拒绝策略。

通过自有 System One 网关时，将完整 HTTPS 接口地址放在 `MOSS_JEV_SYSTEMONE_URL`，将专用密钥放在 `MOSS_JEV_RELAY_KEY`。可用 `MOSS_JEV_MODEL` 覆盖网关模型名，默认 `jev-latest`。例如，在已经配置主模型和 Jev 凭据的环境中使用以下命令。

```bash
MOSS_JEV_OUTPUT=active MOSS_JEV_COMPLETION=active \
  moss -p '修复登录超时，并运行 tests/login-timeout.test.mjs 验证。'
```

长日志筛选和收尾补验可以在同一条用户输入内触发。使用 `MOSS_LOG_LEVEL=info` 查看各判定点的结果及耗时。SDK 通过 `MossAgentConfig.runtimeJudge` 提供判定客户端，并使用 `ChatOptions.userIntentText` 标记要作为目标的原始请求。 [运行规范与端到端记录](specs/moss-jev-runtime.md)

## 调优开关（环境变量）

这些开关默认都不需要；只有遇到明确症状时才设。每一条都能用一次真实运行验证。

| 变量                      | 作用                                                                                                                                                                | 什么时候用                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `MOSS_LEAN_TOOLS`         | 工具描述换用精简档（`ToolMetadata.leanDescription`）：`=1` 强制精简、`=0` 强制完整；不设时 **上下文窗口 ≤ 64,000 tokens 自动精简**                                  | 小窗口模型（32k/64k）每轮省约 200–700 tokens 的工具声明；或想强制对比两种工具面 |
| `MOSS_STARTUP_TIMING`     | 启动时向 stderr 打一行分阶段耗时：`entry/proxy/config/env/prompt/agent/mcp/probe/skills/total`（TUI 另有 `commands/tui-import/composer`；TUI 不等待 `env`/`probe`） | 启动变慢时先定位是哪一段，而不是猜                                              |
| `MOSS_VERIFY_CONCURRENCY` | `npm run verify` 的并发度（默认 4，`1` = 串行基线）；`startup-timing` 等耗时敏感项独占                                                                              | 排查验证门抖动，或核对并发带来的加速                                            |
| `MOSS_NO_TUI`             | 强制 readline REPL（不进全屏 TUI）                                                                                                                                  | 终端不兼容、要复制纯文本，或调试 TUI 之外的行为                                 |

验证方式举例（都在本机可跑）：

```bash
MOSS_STARTUP_TIMING=1 node dist/cli.js -p "hi" 2>&1 | grep "startup] timing"
MOSS_LEAN_TOOLS=1 node scripts/measure-tool-surface.mjs   # 声明字符数与默认档对比
VERIFY_CONCURRENCY=1 npm run verify                      # 与默认并发对照
```
