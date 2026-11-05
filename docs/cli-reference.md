# 命令与配置参考

完整子命令、常用 flag、界面语言与调优环境变量。README 只教最常用的四条命令；
需要精确参数时以本页和 `moss <command> --help` 为准。

## 命令参考

| 子命令                                                                     | 用途                                                                                |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `moss`（或 `moss "prompt"`）                                               | 交互界面 / 一次性模式                                                               |
| `moss run "<intent>" [--accept "<cmd>"]`                                   | `moss task run` 的快捷方式：意图进，验收过的结果出                                  |
| `moss runs [list\|show\|prune] [--json]`                                   | 统一运行账本（`.moss/runs/<run_id>/run.json`）：状态 / 原因 / 下一步 / 工件路径     |
| `moss setup` · `moss auth status\|logout`                                  | 配置向导 · 查看登录态 / 删除已存 key                                                |
| `moss doctor`（别名 `moss status`）                                        | 体检配置 / 凭证 / 工作区 / 运行时                                                   |
| `moss config show\|env\|init\|set\|unset\|validate`                        | 配置读写；`moss config --help` 是键的完整参考，`moss config env` 是环境变量权威清单 |
| `moss resume` · `moss fork` · `moss sessions list\|delete\|search\|export` | 会话恢复 / 分叉 / 管理                                                              |
| `moss task run\|resume\|status\|timeline`                                  | 统一任务运行时（目标进 → 已验证结果出）                                             |
| `moss tasks list\|evidence\|deployments\|acceptance\|device`               | 只读巡检机器人闭环产物                                                              |
| `moss device add\|list\|remove\|test\|fleet`                               | 设备清单与多机只读巡检                                                              |
| `moss mcp add\|list\|remove\|test`                                         | MCP 服务器管理                                                                      |
| `moss skill create\|list\|validate\|install\|update\|lock`                 | 技能管理 / 规范校验 / 带 hash 锁的安装与升级                                        |
| `moss update`                                                              | 打印升级命令（npm 全局或 git 克隆）；不执行                                         |

> `plugins` / `migrate` / `web` / `agent` 属于已移除的子系统，本构建里会**明确报错**，不会悄悄 fallback。`moss <command> --help` 仍给出该子命令自己的用法。

日常斜杠命令：`/model` `/compact` `/goal` `/plan` `/review` `/doctor` `/diff` `/permissions` `/clear` `/help`。`Shift+Tab` 循环模式；`/plan` 进入 plan 模式；`/goal <条件>` 持续工作直到条件满足，`/goal clear` 取消。`/resume` 恢复已保存的会话；`/tasks` 列出后台 shell 与子代理。`Esc` 中断当前回复；运行中直接发消息会先 steer，无法 steer 时排在输入区上方（`↑` 取回编辑）。`/mode` `/steer` `/queue` `/loop` 保留为隐藏别名一版（`/loop` 已改为 `/goal`）。`/goal` 没带 `--accept` 时，从工作区已有的测试入口（`package.json` test、Makefile、pytest、`go.mod`）给出验收命令候选，找不到就直说，不编造。`/stop`（别名 `/abort`）只停本会话启动的后台进程。隐藏的 `/task` 是 Task OS 入口（status / timeline / resume / view / verify），`/task verify` 不调模型，只取一次裁决。PASS 只能来自 verdict provider。

常用 flag：

| Flag                                                  | 作用                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `-m/--model` · `--provider` · `--base-url`            | 仅本次运行覆盖                                                                           |
| `-C/--cd <dir>` · `-c/--config k=v`                   | 换工作区 · 覆盖 profile/model/policy                                                     |
| `--read-only` · `--workspace-write` · `--full-access` | 本次运行的模式覆盖。`workspace-write` 只约束 Moss 自己的文件工具，shell 没有操作系统沙箱 |
| `--trust-device`                                      | 本进程允许毁灭性设备操作                                                                 |
| `--accept-edits` · `--ask-for-approval <p>`           | 审批行为                                                                                 |
| `-p/--print` · `--json` · `--output-format <f>`       | 一次性 / 机器可读输出                                                                    |

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
