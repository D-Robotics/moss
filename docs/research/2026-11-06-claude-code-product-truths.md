# Claude Code 产品真值：README 首屏、首次运行、UX 手感（对 Moss 的可用结论）

- 调研时间：2026-11-06（本机时间）
- 被测对象：`@anthropic-ai/claude-code@2.1.317`（本机全局安装，Bun 单文件可执行体，BUILD_TIME `2026-11-02T22:15:13Z`，GIT_SHA `3d3e7cb16b5577dccaee9520c8dc1189d02d61b7`）
- 证据来源三类，逐条标注：
  - **【docs】** 官方文档在线抓取（2026-11-06 可达，HTTP 200），给出 URL；
  - **【pkg】** 本机 npm 包的 shipped 代码 REA（`docs/research/2026-11-04-cursor-claude-agent-design/claude-evidence.md` 的方法 + 本次新增抽取），给出 `bundle.js:行:列`；
  - **【npm】** `node_modules/@anthropic-ai/claude-code/README.md` 原文；
  - 少数只有先验知识、本次未能在线核实的，明确写“未在线核实”，不混入结论。
- 网络状态：**可用**。`https://code.claude.com/docs/llms.txt`、`/docs/en/{overview,quickstart,permission-modes,interactive-mode,headless}.md` 均 200。

---

## 0. 一页结论

1. **定位一句话，动词开头**：Claude Code = “an agentic coding tool that reads your codebase, edits files, runs commands, and integrates with your development tools. Available in your terminal, IDE, desktop app, and browser.”【docs: docs/en/overview.md】
2. **npm README 极薄**（约 2KB）：一句话是什么/在哪用 → 一行安装 → 两步开始 → 链接到文档主页 → bug/discord/data。它**不把排错写进首屏**，排错在 `troubleshoot-install` 页。【npm + docs IA】
3. **文档 IA 是“任务优先 + 分层参考”**：Getting started（Overview/Quickstart/Changelog）→ Core concepts（它怎么工作/扩展/.claude 目录/上下文窗口/prompt caching）→ Use（记忆/会话/常见工作流/提示词库/最佳实践）→ Platforms → Build（agents/MCP/skills/artifacts/automation/guides/troubleshooting）→ Reference（CLI/commands/env/tools/interactive/checkpointing/hooks）→ Agent SDK → What's New（周更）→ Glossary。每一页在索引里都有**一句“这页解决什么问题”**。【docs: llms.txt】
4. **Quickstart 是“7 步走到第一次成功”**：装 → 起 session（首次登录）→ 问第一个问题 → 改第一处代码 → 用 git → 修 bug/加功能 → 其它工作流；每步都只给可直接复制的命令，并把“选 Yes 批准”“Shift+Tab 切权限模式”这类**关键操作顺带教**。文末给两张「常用命令」表和 pro tips。【docs: docs/en/quickstart.md】
5. **安装已迁到 native installer**：`curl -fsSL https://claude.ai/install.sh | bash`（macOS/Linux/WSL）为主推，Homebrew/WinGet/apt 为替代；npm 安装不再是首选路径。验证方式固定为 `claude --version` 打印版本号 + `(Claude Code)`。【docs: quickstart.md】
6. **首次登录多身份**：Claude 订阅（Pro/Max/Ultra/Team/Enterprise）/ Console API / 云厂商（Bedrock、Google Cloud Agent Platform、Foundry）/ 自托管 gateway；已有 `ANTHROPIC_API_KEY` 且用户批准时跳过登录。【docs: quickstart.md】
7. **权限模式是产品核心概念，不是设置项**：`manual(default)` / `acceptEdits` / `plan` / `auto` / `dontAsk` / `bypassPermissions`；**v2.1.283 起交互终端默认 `auto`**（v2.1.302 起 `-p` 默认 `manual`）；Shift+Tab 循环切换，状态栏常驻标签 `⏸ manual mode on` / `⏵⏵ accept edits on` / `⏸ plan mode on` / `⏵⏵ auto mode on` / `⏵⏵ don't ask on` / `⏵⏵ bypass permissions on`。【docs: permission-modes.md】
8. **首次进目录有 workspace trust 对话**，并且它把“信任 = 这个目录的 hooks/MCP/权限规则/helper 会生效”讲清楚；按钮是 `Yes, I trust this folder` / `No, continue without these permissions` / `No, exit`。【pkg: bundle.js:112043 / 105191】
9. **手感来自“每个动作都有下一条出路”**：Esc 中断但保留已完成工作；Esc×2 打开 rewind 菜单；Ctrl+C 首次清输入、二次退出；Ctrl+D 二次退出；Ctrl+T 看 todo；Ctrl+O 看 transcript；`/rewind` 恢复 code / conversation / both，或“从这里总结”；失败文案给下一个命令（`Please run /login`、`run with --debug`）。【docs: interactive-mode.md + pkg】
10. **plan mode 是一等模式**：5 阶段工作流 + plan 文件（`~/.claude/plans/`），系统提示写死“只读、禁止编辑、此规则高于其它指令”，并要求回合结束只能调用 `AskUserQuestion` 或 `ExitPlanMode`。【pkg: bundle.js:93698 / 93780】
11. **headless 契约是产品级 API**：`-p` exit 0/非 0；`--output-format text|json|stream-json`；json 含 `result/session_id/total_cost_usd/permission_denials`；`--json-schema` 给 `structured_output`；`system/init`、`system/api_retry`、`permission_denied` 事件；SIGTERM=143；`--bare` 是推荐脚本模式（且将成为 `-p` 默认）。【docs: headless.md】
12. **错误语言统一为“发生了什么 + 下一步”**，且大量文案本身就在教模型/用户改法：`API Error: 400 orphaned tool_result in conversation history.`、`Your session has expired. Please run /login to sign in again.`、`Restored the code, but skipped ${N} files: … run with --debug for the paths.`【pkg: bundle.js:84067 / 84231 / 110288】
13. **Moss 现状对比**：Moss README 首屏是「环境（Node 版本）→ 安装排错（EEXIST/EACCES/npm warn 一堆）→ 快速开始」。排错信息密度远高于 Claude Code 首屏，但“它是什么、为什么是它、三条命令跑起来”的可读路径被压到后面。【Moss README.md 1–135 行】

---

## 1. 定位与 README / 文档首屏结构

### 1.1 官方一句话（【docs: overview.md】）

> Claude Code is an agentic coding tool that reads your codebase, edits files, runs commands, and integrates with your development tools. Available in your terminal, IDE, desktop app, and browser.

拆解：

- **是什么**：agentic coding tool（不是“AI 助手/聊天框”）；
- **干什么**：读代码库、改文件、跑命令、接开发工具；
- **在哪用**：terminal / IDE / 桌面 app / 浏览器。

### 1.2 npm 包 README 的结构（【npm】，全文约 2KB）

顺序（原文）：

1. 标题 + 两个 badge（Node 22+ / npm 版本）；
2. 一段话：`Claude Code is an agentic coding tool that lives in your terminal, understands your codebase, and helps you code faster by executing routine tasks, explaining complex code, and handling git workflows -- all through natural language commands. Use it in your terminal, IDE, or tag @claude on Github.`
3. `Learn more at Homepage | Documentation` + 一张 demo gif；
4. `## Get started`：两条命令（`npm install -g @anthropic-ai/claude-code`，然后 `cd` 到项目跑 `claude`）；
5. `## Reporting Bugs`（`/bug` 或 GitHub issue）；
6. `## Connect on Discord`；
7. `## Data collection, usage, and retention`（用法/隐私/合规链接）。

**观察**：首屏没有任何排错、没有平台矩阵、没有能力清单、没有截图之外的架构说明；所有“深水区”都推给 `code.claude.com/docs`。对比 Moss 的 470 行/43KB README（含 Node 版本矩阵、EEXIST、EACCES、npm 11 警告、代理、板端依赖、bench……），这是两种完全不同的 README 哲学。

### 1.3 文档 IA（【docs: llms.txt】）

```
Getting started:  Overview · Quickstart · Changelog
Core concepts:    How Claude Code works · Extend Claude Code · .claude directory ·
                  Context window · Prompt caching
Use:              Memory · Sessions · Common workflows · Prompt library · Best practices
Platforms:        CLI · Desktop · VS Code · JetBrains · web · mobile · Slack · Chrome ·
                  GitHub Actions · GitLab CI · cloud · Remote Control · Projects
Build:            Agents & parallel work(n) · MCP · Skills · Artifacts · Automation(
                  hooks/channels/scheduled/goal/headless/deep links) · Guides · Troubleshooting
Plugins:          overview/install/... · Mods(插件级 UI 扩展)
Administration / Configuration / Reference:
                  CLI · Commands · Env vars · Tools · Interactive mode · Checkpointing ·
                  Hooks · Channels · Glossary
Agent SDK:        overview/quickstart/agent-loop/sessions/streaming/tools/... ×6 组
What's New:       每周一条 digest（2026-w13 … w37）
```

可复用的 IA 规律：

1. **一个新用户只需要 3 个入口**：Overview（是什么）→ Quickstart（跑起来）→ Common workflows（拿它干活）；其余全部可后置。
2. **“概念页”与“参考页”分开**：`how-claude-code-works`（agentic loop / tools / context）是概念，`tools-reference`/`cli-reference` 是参考。同一件事不会既当教程又当手册。
3. **每个索引条目都带一句目的**（不是标题列表），例如 “Explore the context window: An interactive simulation of how the context window fills during a session.”。
4. **把排错做成独立章节**：`troubleshoot-install`（装不上）、`troubleshooting`（卡住/吃 CPU/自动压缩抖动）、`debug-your-config`（为什么 CLAUDE.md/hooks/MCP 没生效）、`errors`（错误对照表）。**首屏不承载排错**。
5. **What's New 按周更新 + Glossary**：让“新功能”与“术语”都有固定去处，不动主教程。

### 1.4 Quickstart 的 7 步（【docs: quickstart.md】）

| 步骤                   | 内容                                                                    | 可复用的写法                                             |
| ---------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| Before you begin       | 有终端 / 有项目 / 有账号                                                | 先把前提说清，并对“没用过终端的人”给 terminal-guide 链接 |
| Step 1 Install         | 按平台 tab：native installer（推荐）、Homebrew、WinGet、apt/dnf/apk     | 主推一条命令；其它平台折叠；装完用 `--version` 验证      |
| Step 2 Start           | `cd /path/to/project && claude`；首次登录；`/help`、`/resume`           | 说明“输入框上方会显示版本、模型、工作目录”               |
| Step 3 Ask             | `what does this project do?` 等 3–6 个建议问句                          | 给**可以照抄的问题**，不给抽象建议                       |
| Step 4 First change    | `add a hello world function to the main file`；提示“如果它问，就选 Yes” | 第一次“写”操作明确教批准动作 + 指向权限模式              |
| Step 5 Git             | 4 个 git 问句                                                           | “把 git 变成对话”是差异化卖点                            |
| Step 6 Bug/feature     | 自然语言描述                                                            | —                                                        |
| Step 7 Other workflows | refactor / tests / docs / review                                        | 展示能力宽度                                             |
| Essential commands     | Shell 命令表 + Session 命令表                                           | “在哪跑”决定命令属于哪张表                               |
| Pro tips               | 具体化请求 / 分步 / 先探索 / 快捷键（`/`、Tab、↑、Shift+Tab）           | 用 accordion 收纳，不打断主线                            |
| What's next            | 4 个下一站链接                                                          | —                                                        |

---

## 2. 首次运行（安装 → 登录 → 权限 → 信任 → `/init` → 第一个任务）

### 2.1 安装与验证（【docs: quickstart.md】）

- 主路径：`curl -fsSL https://claude.ai/install.sh | bash`（macOS/Linux/WSL）；Windows 分别给 PowerShell / CMD 两行，并解释 `&&` 与 `irm` 报错是“你在错的 shell 里”。
- 替代：`brew install --cask claude-code`（stable）/ `claude-code@latest`；`winget install Anthropic.ClaudeCode`；apt/dnf/apk。
- 验证：`claude --version` → “prints a version number followed by `(Claude Code)`”。
- 明确“native 安装后台自动更新；brew/winget 不自动更新，要手动 upgrade”。
- 失败指向：`troubleshoot-install#find-your-error`（错误 ↔ 修复对照）。

### 2.2 登录（【docs: quickstart.md】+【pkg】）

- 首次 `claude` 会提示登录，浏览器回调完成；账号类型：Claude 订阅 / Console / 云厂商 / 自托管 gateway。
- 已有 `ANTHROPIC_API_KEY` 且“批准使用该 key”时**跳过登录提示**。
- 凭证持久化：登录一次后续免登录；会话内 `/login` 可换账号。
- 【pkg】登录 UI 原文：标题 `Select login method:`，选项 `Claude account with subscription · Individual, Team, or Enterprise` / `Anthropic Console account · API usage billing` / `3rd-party platform · <providers>`；套餐名渲染为 `Claude Pro / Claude Max / Claude Team / Claude Enterprise`；欢迎屏 `Welcome to Claude Code` + `v2.1.317`（`bundle.js:107052:6737`、`84199:32504`、`105212:465`）。
- 【pkg】API key 校验文案：`Invalid API key format. API key must contain only alphanumeric characters, dashes, and underscores.`；keychain 写入失败时：`Failed to save API key to macOS Keychain (…). Run \`claude doctor\` to diagnose keychain access.`（`bundle.js:84198:25239`）——**错误 + 一条可执行诊断命令**。

### 2.3 权限模式（【docs: permission-modes.md】）

| 模式                          | 不需要问就能做什么                                            | 适用                 |
| ----------------------------- | ------------------------------------------------------------- | -------------------- |
| `default`（UI 名 **Manual**） | 只读                                                          | 逐动作审查、敏感工作 |
| `acceptEdits`                 | 读 + 文件编辑 + 常见文件系统命令（`mkdir`/`touch`/`mv`/`cp`） | 边看边迭代代码       |
| `plan`                        | 读；auto 可用时还允许分类器批准的只读命令                     | 先探索再改           |
| `auto`                        | 几乎全部，后台分类器复核                                      | 长任务、降低打断     |
| `dontAsk`                     | 工作目录内读 + 预批准工具；该问的一律拒绝                     | 锁死的 CI / 脚本     |
| `bypassPermissions`           | 全部                                                          | 仅隔离容器/VM        |

关键事实（都来自该页）：

- **默认值变更**：v2.1.283 起交互终端与 VS Code 内置默认 = `auto`；`-p` 与 Agent SDK 在 v2.1.302 起默认 = `manual(default)`。
- **保护路径**：`.git`、`.vscode`、`.claude`、`.bashrc`、`.mcp.json` 等**任何模式都不自动批准**（除 `bypassPermissions` 与特定 plan 场景）。
- **任何模式都不自动批准的清单**：显式 `ask` 规则、需要人回答的 `AskUserQuestion`、MCP `requiresUserInteraction`、`rm`/`rmdir` 关键路径删除、跨会话消息保护、开启 `blockReadsOutsideWorkingDirectories` 时的工作目录外读。
- **deny 规则在任何模式都赢**；allow 规则在 `bypassPermissions` 无效。
- **切换**：Shift+Tab 循环 `default → acceptEdits → plan`（+ 可选 `bypassPermissions`/`auto`）；状态栏标签常驻（见结论 7）。
- **首次进入 `bypassPermissions`** 有“接受责任”对话框，接受后写 `skipDangerousModePermissionPrompt: true`，拒绝则退出；`-p` 不弹；root/sudo 直接拒绝并给原因。

### 2.4 Workspace trust（【pkg】）

- 组件具名 `TrustDialog`，确认按钮 `Yes, I trust this folder`；取消按钮二选一：`No, continue without these permissions`（仅不启用目录权限）/`No, exit`；退出需二次确认（`Press <key> again to exit`）。
- 说明文案（ultrareview 复用同一信任流程）明确信任后果：
  `Trusting the folder also applies to Claude Code: sessions started here can read, edit, and execute files, and this folder's project settings (hooks, MCP servers, permission rules, helper commands) apply to them.`
- `-p` 不弹 trust 对话框，但也因此要小心未信任目录里的 hooks/MCP：docs 明确 `-p` 会运行项目 `.claude/settings.json` 的 hooks 与 `.mcp.json` 的 server，除非 `--bare`。【docs: headless.md】

### 2.5 `/init` 与第一个任务

- `/init` 在 docs 的 commands 参考里是内置命令（用于初始化 `CLAUDE.md`）。本次没有抓到 `/init` 的**提示原文**；【pkg】中 `/init` 共 76 处命中，多在命令注册/帮助文本里（`bundle.js:83099` 等）。**`/init` 首次运行的确切交互文案：未在线核实**。
- 第一个任务的引导在 quickstart 里体现为：给具体问句 → 让模型读文件 → 给一个小改动 → 教“选 Yes 批准” → 指向 Shift+Tab。
- 【pkg】`# Environment` 块会注入“Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app (claude.ai/code), and IDE extensions (VS Code, JetBrains).”+“Fast mode …”，说明**能力自述也进提示词**，用户问“你能做什么”时有稳定答案（`bundle.js:92268:13`）。

---

## 3. 核心 UX 机制与“手感”来源

### 3.1 plan mode（【docs: permission-modes.md / plan 段】+【pkg】）

- 【pkg】系统提示原文（`bundle.js:93698:145`）：
  > `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.`
- 【pkg】工作流约束（`bundle.js:93698` 与 `93780`）：
  - 有 **5 阶段**计划工作流（读 → 设计 → 写 plan 文件 → 澄清 → 提交）；
  - plan 文件路径随会话（`~/.claude/plans/` 或自定义 `plansDirectory`）；
  - 回合结束只有两个合法出口：`AskUserQuestion`（澄清）或 `ExitPlanMode`（请求批准）；原文：
    > `This is critical - your turn should only end with either using the AskUserQuestion tool OR calling ExitPlanMode. Do not stop unless it's for these 2 reasons`
  - “sparse” 变体用于长会话中途提醒（`Plan mode still active (see full instructions earlier in conversation). Read-only except plan file …`）。
- 手感点：**模式有明确“出口工具”**，不是靠模型自觉；用户看到的是“计划 → 批准 → 执行”，而不是“它直接改了”。

### 3.2 todo / task list（【docs: interactive-mode.md#task-list】）

- Ctrl+T 切换显示；显示区一次最多 5 条；未创建任务时无视觉变化。
- **任务跨 compaction 保留**（“Tasks persist across context compactions”）。
- 可用性随模型：`Opus 4.7 / Sonnet 4.6 / Haiku 4.5` 及更早模型默认提供 task 工具；其它模型要 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 打开。
- 跨会话共享任务列表：`CLAUDE_CODE_TASK_LIST_ID=my-project claude`（落在 `~/.claude/tasks/`）。
- 与后台任务视图分离：`/tasks` 看 running shells/subagents，Ctrl+T 看 checklist。

### 3.3 中断 / 恢复（【docs: interactive-mode.md】）

| 键          | 语义                                                                               | 手感设计              |
| ----------- | ---------------------------------------------------------------------------------- | --------------------- |
| `Esc`       | 中断当前回合/工具调用；**"Claude keeps the work done so far"**；有排队消息则接着发 | 中断不清空成果        |
| `Esc` `Esc` | 输入有内容 → 清空并存入历史（↑ 可取回）；输入为空 → **打开 rewind 菜单**           | 同一个键的“轻/重”两档 |
| `Ctrl+C`    | 运行中 → 中断；空闲 → 第一次清输入，第二次退出                                     | 防误退                |
| `Ctrl+D`    | 第一次给确认提示，800ms 内第二次退出；有文本时是“删光标后字符”                     | 防误退 + 不打断编辑   |
| `Ctrl+B`    | 把 Bash/agent 转后台（tmux 按两次）                                                | 长任务不阻塞对话      |
| `Ctrl+S`    | 暂存/恢复草稿（含光标、粘贴、输入模式）                                            | 输入不丢              |
| `Ctrl+O`    | transcript 视图（工具细节、时间戳、模型名）                                        | “想看细节”有独立层    |
| `Ctrl+R`    | 历史反向搜索                                                                       | readline 肌肉记忆     |
| `Ctrl+G`    | 用外部编辑器写 prompt                                                              | 长 prompt 场景        |

### 3.4 checkpoint / rewind（【docs: interactive-mode.md / checkpointing.md】+【pkg】）

- 入口：输入为空时 `Esc`×2；或 `/rewind`。
- 【pkg】菜单项原文：`code`（恢复文件）/ `conversation`（恢复对话）/ `both` / `Summarize from here` / `Summarize up to here` / `Never mind`（`bundle.js:110286:2583`）。
- 失败恢复语言（`bundle.js:110288:539`）：
  - `Restored the code, but skipped 3 files: … Skipped files were left untouched — run with --debug for the paths.`
  - `Failed to restore the code: …` / `Failed to restore the conversation and code: …`
- 手感点：**“恢复”是可能部分成功的操作**，文案明确“哪些没恢复、为什么、怎么看路径”，不谎报成功。

### 3.5 上下文 / compact（【docs: prompt-caching / context-window / model-config】+ 前序 REA）

- 有 `/compact` 手动、auto-compact 自动；`autoCompactEnabled`、`precomputeCompactionEnabled`、`idleCompaction` 三个开关对应三种行为（自动/预计算/空闲时）。
- 前序 REA 已证：`threshold = effective_window − summary buffer`，可被 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 下调，或转 reactive 模式等 API prompt-too-long。【pkg: claude-evidence.md §C3】
- docs 侧额外可复用概念：`/context` 看上下文占用、`prompt-caching` 页解释“为什么改 CLAUDE.md 不立即生效”“`/compact` 花多少钱”“cache hit rate 怎么看”。
- 手感点：**把“上下文”做成可观测对象**（`/context`、状态栏、compaction 提示），而不是黑盒。

### 3.6 hooks（【docs: hooks-guide.md / hooks.md】）

- 事件面（前序 REA + docs）：`PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `PostToolBatch` / `UserPromptSubmit` / `Stop` / `SubagentStop` / `SessionStart` / `SessionEnd` / `PermissionRequest` 等。
- 用途语言是“干活的自动化”：格式化、通知、校验命令、执行项目规则（`hooks-guide` 的一句话）。
- 手感点：hooks 输出**被当作 user feedback 交给模型**（前序 REA 的 `# Harness` 原文），所以“格式检查失败”不需要用户转述。

### 3.7 skills（【docs: skills.md】+ 前序 REA）

- `SKILL.md` 渐进披露：会话只注入“名字 + 描述”，模型按需 `Skill` 调用；会话中途发现新技能会**增量告知**（`dynamic_skill` 附件）。
- 斜杠命令与技能同源：`/` 菜单 = 内置命令 + 技能 + 插件/MCP 提供的命令；`/btw` 这类“侧问”是技能式的轻交互（不进历史）。
- 手感点：**能力可增长但不吃上下文**。

### 3.8 MCP（【docs: mcp.md / mcp-quickstart.md】+ 前序 REA）

- 用户侧：`claude mcp add` / `claude mcp login`（OAuth）/ `--mcp-config` / `-p` 下的 `mcp_server_errors`。
- 模型侧：工具名 `mcp__<server>__<tool>`；大工具集走 ToolSearch 懒加载；结果大小受 `MAX_MCP_OUTPUT_TOKENS` 与 per-tool `maxResultSizeChars` 控制。
- 手感点：**连接失败可诊断**——`system/init` 的 `mcp_servers[].status` 与 `mcp_server_errors[]`（含 `unknown_type`/`url_missing_type`/`invalid_config`/`reserved_name`）可直接做 CI 门禁。

### 3.9 headless `-p` 输出契约（【docs: headless.md】）

- 基础：`claude -p "<prompt>"`；**exit 0 成功 / 非 0 失败**；参数错误在运行前打到 stderr；运行期失败（如缺认证）作为 result 打到 stdout。
- 输出格式：
  - `--output-format text`（默认）；
  - `json`：`result`、`session_id`、成本（`total_cost_usd` 与 per-model 分解，客户端估算）、`permission_denials`、可选 `structured_output`；
  - `stream-json`：逐行事件，末行是 `result`；`system/init` 报 model/tools/MCP/plugins/capabilities；`system/api_retry` 报 `attempt/max_retries/retry_delay_ms/error_status/error`；`permission_denied`。
- 结构化输出：`--output-format json --json-schema '<schema>'`；非法 schema 直接 `Error: --json-schema is not a valid JSON Schema` + 诊断；**没有 structured_output 时字段缺失而不是 null**（调用方必须先检查存在性）。
- 运行控制：`--max-budget-usd` 封顶；SIGTERM → exit 143（不记录该回合结果），要“结束回合”用 SIGINT；`--bare` 跳过 hooks/skills/commands/subagents/plugins/MCP/auto memory/CLAUDE.md（推荐脚本模式，未来成为 `-p` 默认）；`--permission-prompts none` 让“该问的一律拒绝并告诉模型别重试”。
- stdin：管道上限 10MB，超限明确报错；后台任务退出等待默认 10 分钟天花板（`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 可调）。
- 手感点：**机器可读 + 人可读两套并列**，且每类失败都有专门字段/退出码，不靠解析散文。

### 3.10 错误与失败恢复的语言风格（【pkg】实例）

风格归纳：**短句 + 具体主语 + 一个可执行的下一步 + 不责难**。

| 场景                               | 原文                                                                                                                                                                                                                | 位置                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 会话过期                           | `Your session has expired. Please run /login to sign in again.`                                                                                                                                                     | `bundle.js:84231:29990`      |
| 工具历史损坏                       | `API Error: 400 orphaned tool_result in conversation history.` / `duplicate tool_use ID in conversation history.`                                                                                                   | `bundle.js:91017:6141`       |
| 上下文超限                         | `Prompt is too long`（固定前缀，可被识别后触发 compact 路径）                                                                                                                                                       | `bundle.js:84067:2233`       |
| 中断后被误读为“拒绝”时给模型的自纠 | `Correction to the text above: this call was stopped while running, not refused before it ran. It may have run in part or in full… check before starting the same work again.`                                      | `bundle.js:84030:10362`      |
| 用户打断后提醒模型存偏好           | `Note: The user's next message may contain a correction or preference. Pay close attention — if they explain what went wrong or how they'd prefer you to work, consider saving that to memory for future sessions.` | `bundle.js:84030:10362`(Mje) |
| 参数冲突                           | `Error: <flag> cannot be combined with --continue.` / `… both select a remote backend; pick one.`                                                                                                                   | `bundle.js:89900:197`        |
| 恢复部分失败                       | `Restored the code, but skipped N files: … run with --debug for the paths.`                                                                                                                                         | `bundle.js:110288:539`       |
| 等待/重试                          | `· will retry in <t> · check your network`；`· next try in <t> · attempt <n> · esc to interrupt`                                                                                                                    | `bundle.js:107015:15997`     |
| 权限被拒                           | `Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.`（系统提示）                                                                            | 前序证据 §A2                 |
| trust 对话框                       | `Yes, I trust this folder` / `No, continue without these permissions` / `No, exit`                                                                                                                                  | `bundle.js:112043:25696`     |

---

## 4. 给 Moss 的结论

### 4.1 README 建议（5 条，每条一行结论 + 证据）

1. **首屏只回答三件事：它是什么、为什么值得试、三条命令跑起来**；把现有 Node 版本矩阵/EEXIST/EACCES/npm warn 全部移到 `docs/troubleshooting-install.md` 的 `<details>` 或链接页。
   证据：Claude Code npm README 全文仅 2KB（一句话 + 1 条安装 + 2 步开始 + 文档链接）；排错在独立 `troubleshoot-install` 页。【npm + docs IA】
2. **首屏文案照“动词 + 宾语 + 在哪用”写**，并把差异化放在第一句之后立刻出现（Moss 的差异化 = 可机检验收 / 真机闭环 / 四交互面）。
   证据：官方 overview 一句话 = “reads your codebase, edits files, runs commands, and integrates with your development tools. Available in your terminal, IDE, desktop app, and browser.”【docs: overview.md】
3. **Quickstart 做成“7 步到第一次成功”**：装 → 起 → 问 → 改 → 验 → 长任务 → 下一步；每一步只用一条可复制命令 + 一句“你应该看到什么”。
   证据：quickstart 的 Step 1–7 与两张 Essential commands 表；验证动作固定为 `claude --version`。【docs: quickstart.md】
4. **把“首次运行会发生什么”写进 README**：要登录/要 key、会问哪些问题（trust、权限、provider）、`moss` 之后看到什么提示符；Moss 现在是“没有配置时在界面里设置”＋大段排错，但没给第一次成功的样子。
   证据：Claude Code 明确“prompt appears with the version, current model, and working directory shown above it”；trust 对话框按钮文案已在上文引用。【docs: quickstart.md + pkg】
5. **文档 IA 用“任务优先 + 参考后置 + 排错独立 + 每页一句目的 + 术语表 + 更新日志”**；Moss 现有 `docs/` 已有 20+ 顶层目录，缺的是面向用户的入口分层。
   证据：Claude Code docs 分组与“每个索引条目一句目的”的写法；`What's New` 周更 + `Glossary`。【docs: llms.txt】

### 4.2 UX / 手感建议（5 条，每条一行结论 + 证据）

1. **中断必须“保留已完成工作”，且同一个键分轻重两档**：一次中断保留成果，再按一次进 rewind/恢复菜单；退出类按键要二次确认。
   证据：`Esc` “Claude keeps the work done so far”；`Esc Esc` 打开 rewind；`Ctrl+C` 首次清输入/二次退出；`Ctrl+D` 800ms 内二次确认。【docs: interactive-mode.md】
2. **给“改坏了”一条一键回退路径，并诚实报告部分失败**：`/rewind` 或 checkpoint 至少覆盖 code / conversation / both 三种粒度，失败时写清“恢复了什么、跳过了什么、怎么看路径”。
   证据：rewind 菜单项原文 + `Restored the code, but skipped N files … run with --debug for the paths.`【pkg: bundle.js:110286 / 110288】
3. **权限模式要做成“状态栏常驻 + 单键循环 + 每档一句话解释”**，并把“默认档”当作产品决策写进 README（Moss 目前是 `manual/acceptEdits/plan/full`，Claude Code 已演进到含 classifier 的 `auto` 与 `dontAsk`）。
   证据：6 档模式表 + Shift+Tab 循环 + 状态栏标签 + v2.1.283 起 `auto` 为默认。【docs: permission-modes.md】
4. **错误文案统一成“发生了什么 + 下一步命令”**，禁止只报错因；对“被用户中断/被 hook 拦”要额外告诉模型“这不是拒绝，别重试也别假设没执行”。
   证据：`Please run /login…`、`… cannot be combined with --continue.`、`Correction to the text above: this call was stopped while running…`。【pkg: bundle.js:84231 / 89900 / 84030】
5. **headless 输出契约要把“人读的文本”和“机器读的 JSON”并列，且失败有独立退出码/字段**（Moss 已有 `--json` 与 exit code，但可对齐 `result/session_id/cost/permission_denials` 与 `system/init|api_retry` 事件命名）。
   证据：`--output-format text|json|stream-json`、`system/init`、`system/api_retry`、`permission_denials`、SIGTERM=143。【docs: headless.md】

---

## 附录

### A. 证据来源清单

| 编号 | 类型       | 位置                                                                                                      |
| ---- | ---------- | --------------------------------------------------------------------------------------------------------- |
| D1   | docs       | https://code.claude.com/docs/llms.txt（信息架构全量索引，2026-11-06 抓取）                                |
| D2   | docs       | https://code.claude.com/docs/en/overview.md（定位一句话）                                                 |
| D3   | docs       | https://code.claude.com/docs/en/quickstart.md（7 步、安装、登录、Essential commands、pro tips）           |
| D4   | docs       | https://code.claude.com/docs/en/permission-modes.md（6 档模式、默认值、保护路径、Shift+Tab、状态栏）      |
| D5   | docs       | https://code.claude.com/docs/en/interactive-mode.md（键位表、task list、session recap、/diff、/btw）      |
| D6   | docs       | https://code.claude.com/docs/en/headless.md（`-p` 契约、json/stream-json、`--bare`、SIGTERM、stdin 10MB） |
| N1   | npm README | `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/README.md`                                      |
| P1   | pkg        | `bundle.js:105212:465` 欢迎屏 `Welcome to Claude Code` + 版本/构建信息                                    |
| P2   | pkg        | `bundle.js:107052:6737` `Select login method:` 与账号类型                                                 |
| P3   | pkg        | `bundle.js:112043:25696` TrustDialog 按钮与说明                                                           |
| P4   | pkg        | `bundle.js:93698:145` / `93780:372` plan mode 系统提示与 5 阶段流程                                       |
| P5   | pkg        | `bundle.js:110286:2583` / `110288:539` rewind 菜单与失败文案                                              |
| P6   | pkg        | `bundle.js:84030:10362` / `84067:2233` / `91017:6141` / `84231:29990` / `89900:197` 错误语言样本          |
| P7   | pkg        | `bundle.js:107015:15997` 等待/重试 UI 文案                                                                |
| P8   | pkg        | `bundle.js:92268:13` 能力自述块（`# Environment`）                                                        |
| M1   | Moss 现状  | `/Users/d-robotics/Desktop/RDK_Studio/moss/README.md`（470 行、43KB，1–135 行为环境/安装/排错/快速开始）  |
| M2   | Moss 文档  | `docs/` 顶层 20+ 目录；`docs/research/2026-11-05-ux-handfeel.md` 为上一轮 UX 研究                         |

### B. 版本与构建信息（【pkg】内嵌常量，`bundle.js:105212`）

| 字段             | 值                                                 |
| ---------------- | -------------------------------------------------- |
| VERSION          | `2.1.317`                                          |
| BUILD_TIME       | `2026-11-02T22:15:13Z`                             |
| GIT_SHA          | `3d3e7cb16b5577dccaee9520c8dc1189d02d61b7`         |
| PACKAGE_URL      | `@anthropic-ai/claude-code`                        |
| README_URL       | `https://code.claude.com/docs/en/overview`         |
| FEEDBACK_CHANNEL | `https://github.com/anthropics/claude-code/issues` |

### C. 局限与未核实

1. **`/init` 的首次运行提示原文**：`/init` 在 pkg 中 76 处命中，但未定位到它的 UI 文案；本次**未在线核实**其交互细节（只确认它是内置命令、用于初始化 `CLAUDE.md`）。
2. **首次登录的浏览器 OAuth 细节**（回调页、token 存储路径、keychain 具体条目名）：pkg 中可见 OAuth 端点与 keychain 写入错误文案，但完整流程属运行时行为，未实跑确认。
3. **onboarding 是否有“选择主题/首次教程”等分步**：本次只证到欢迎屏与登录选择；完整首启分步**未在线核实**。
4. **自动压缩阈值百分比**：继承上一份 REA 报告的结论（`effective_window − summary buffer`），具体百分比未与常量绑定，仍为 unknown。
5. **docs 页面的插叙视频/动图**未纳入证据（文本证据已足够）；页面里 `<video>` 元素说明产品在文档中大量使用短视频演示手感，但本次未逐页统计。
6. 本报告未修改 Moss 任何源码/AGENTS/backlog，只新建本文件；未 commit / 未 push。
