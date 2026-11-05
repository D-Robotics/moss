# Cursor 产品真值调研 — 服务 Moss README 重写与交互手感升级

- 调研日期：2026-11-06（Asia/Shanghai）
- 目标产品：Cursor（Anysphere），本机 shipped app `/Applications/Cursor.app` **3.27.14**（commit `69b724eb…`，2026-10-23 构建）
- 服务对象：Moss `@rdk-moss/agent` **0.31.0**（`moss` bin，TS/ESM coding agent harness + 机器人 Agent Task OS）
- 证据分级（全文统一）：
  - **[线上核实]** = 2026-11-06 实际抓取 `cursor.com` 页面，附 URL 与原文。
  - **[本机 REA]** = 从 `/Applications/Cursor.app` 的 shipped JS bundle 静态读出的实现事实；详细证据见本仓库 `docs/research/2026-11-04-cursor-claude-agent-design/cursor-evidence.md`（上次逆向产出，含逐条 `文件:行`）。
  - **[先验·未在线核实]** = 我的既有认知，本次未取到一手页面，**不可当作引用源**，只用来提示"值得去验"。

> 阅读提示：本报告只做"产品真值 + 对 Moss 的可执行结论"。所有"Cursor 怎么做"的断言都能落到一个 URL 或一个本机文件；落到不上的，一律标 **[先验·未在线核实]**。

---

## 0. 一页结论（给赶时间的 Lead）

**Cursor 的产品叙事只有一句话，且这句话出现在所有入口的第一行。**

- 官网 h1：**"Cursor is your coding agent for building ambitious software."**（[cursor.com](https://cursor.com/)）**[线上核实]**
- 文档首句：**"Cursor is a coding agent for building ambitious software. Use it to understand your codebase, plan and build features, fix bugs, review changes, and work with the tools you already use."**（[docs](https://cursor.com/docs)）**[线上核实]**
- 产品页标题：**"Turn ideas into code"** + **"Everywhere you work — One agent across every surface."**（[product](https://cursor.com/product)）**[线上核实]**

同一句话 = 定位 + 动词清单（understand / plan / build / fix / review）+ 覆盖面（every surface）。**没有一个字在讲"我们用了什么技术"。**

**它 30 秒内让人想装的机制，是 4 件事的固定顺序：**

1. **首屏只有一个动作**：`Download for macOS`（主 CTA）+ `Get started` + `Request a demo`，没有第二个概念。**[线上核实]**
2. **首屏紧接着就是"看得见的动作"**：一个交互式 demo（"showing multiple Cursor interfaces: Cursor Desktop interface, Cursor CLI interface"）——不是截图，是可点的产品。**[线上核实]**
3. **Quickstart 是 4 步，每步一句人话 + 一段可复制的 prompt + 一个 `Try in Cursor` deeplink**，且第 2 步就是"让它解释这个 codebase"——**第一次运行的价值在 60 秒内兑现，不需要先学会任何东西。**[线上核实]
4. **能力不是列表，是"你会得到什么结果"**：Understand your code / Plan and build / Find and fix bugs / Review changes / Customize / Connect your workflow（docs 六卡）。**[线上核实]**

**而 Moss 的 README 现在把顺序完全反了**（`README.md`，470 行）：

- L1–L23 是标题 + 一句话 slogan + 三个 badge；**L24 就进 `## 环境`**（Node / macOS / Windows / 代理，31 行），**到 L55 才 `## 快速开始`**。
- **"为什么是 Moss" 在 L200**——读者要先读完安装、升级、卸载、代理、约 200 行，才知道这东西为什么存在。
- **全文 0 张图 / 0 个 GIF / 0 段终端录像**（`grep '!\[' README.md` 只命中 3 个 badge）。
- 没有"和谁比"的一段；`## 能力`（L220）是一段段加粗散文，不是可扫的能力矩阵。

**手感（feel）的真值：Cursor 的手感不来自"快"，来自四件可验证的事**（详见 §3）：

1. **每一步都可撤销**：checkpoint 在"significant changes"前自动创建，时间线可点、可预览、可 restore；且**只回滚文件、不删消息**（[agent overview](https://cursor.com/docs/agent/overview)）**[线上核实]**。
2. **等待时它不装作在等你**：Ask 提问后 "While waiting for your response, the agent continues reading files, making edits, or running commands"（同上）**[线上核实]**。
3. **失败信息是写给模型看的，不是抛给人看的**：本机 bundle 里 bash 失败统一映射成 `An exception occurred while executing the command: …`，而"没执行"单独返回 `"action was not executed"`（**与真失败区分**）；模型版/用户版错误文案是两条独立字段。**[本机 REA]**
4. **截断永远给"怎么继续"**：grep 截断后回填 `Results truncated. Showing X-Y of Z … Use offset=N to see more`；Read 超 100000 字符直接报错并教模型改用 offset/limit 或 grep。**[本机 REA]**

**对 Moss 的 10 条结论（正文 §4 / §5 各 5 条，每条一行）已经写成可直接照做的形态，这里只给最强的 3 条：**

- **README 前 60 行必须重排成：一句话定位 → 一段 30 秒可复制的"首个闭环" → 一张 TUI 真录屏 → 才轮到环境前提。** 现在 `## 环境` 挡在 `## 快速开始` 前面，是把最容易流失的人先劝退。
- **Moss 最独有的东西（"没有证据就不算完成" + 真机 SSH 闭环）现在埋在第 200 行**，应该提到首屏第二段——这是 Cursor 讲不出来的差异点。
- **手感优先做"可撤销 + 失败可读"两件事**：Moss 已有 `/rewind` 检查点、`/diff`、审批预览；缺的是 Cursor 那种"每次大改前自动 checkpoint + 时间线可点回"的**可见性**，以及统一把失败翻译成"下一步做什么"。

---

## 1. Cursor 的定位与 README / 落地页结构

### 1.1 [线上核实] 三个入口的第一行，是同一句话的三个变体

| 入口     | 第一行原文                                                                                                                                                                                  | 作用                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 官网首页 | "Cursor is your coding agent for building ambitious software."                                                                                                                              | 定位 + 野心                        |
| 文档首页 | "Cursor is a coding agent for building ambitious software. Use it to understand your codebase, plan and build features, fix bugs, review changes, and work with the tools you already use." | 定位 + **5 个动词** + 覆盖面       |
| 产品页   | "Turn ideas into code" / "Delegate implementation to focus on higher-level direction."                                                                                                      | 价值主张（从"写代码"升到"做决策"） |

来源：[cursor.com](https://cursor.com/)、[cursor.com/docs](https://cursor.com/docs)、[cursor.com/product](https://cursor.com/product)。

**可迁移的结构**：`[名词] is your [类别] for [你想要的终局]` + `Use it to A, B, C, D, and E`。第二句才是能力清单，而且用**动词**不用名词。

Moss 现在的 slogan 是 `**One Intent → One Task → One Agent Loop → One Verified Result.**`——**这是内部架构，不是用户终局**。它准确，但需要读者先懂 4 个名词。这是 §4 建议 1 的直接依据。

### 1.2 [线上核实] 首页首屏的精确顺序（从抓取到的 DOM 文本还原）

```
[H1]  Cursor is your coding agent for building ambitious software.
[CTA] Download for macOS   [CTA] Get started   [CTA] Request a demo
[DEMO] 交互式 demo：Cursor Desktop interface + Cursor CLI interface
        （页面原文标注："This element contains an interactive demo for sighted users…"）
[H2]  Trusted every day by teams that build world-class software
[H3]  Agents turn ideas into code
       Accelerate development by handing off tasks to Cursor, while you focus on making decisions.
```

关键观察（三条，都能照做）：

1. **首屏只有一个转换目标**：装/登录，没有"看文档""看定价"抢注意力（它们在 nav 里，不在 hero 里）。
2. **demo 是"多界面同时展示"**：Desktop + CLI 并置。它想说的是"同一套 agent，无处不在"，而不是"我们有个漂亮的编辑器"。
3. **社会证明在 demo 之后、功能之前**："Trusted every day by teams that build world-class software"。

### 1.3 [线上核实] 产品页用"面"组织，不用"功能"组织

`/product` 的结构：

```
Turn ideas into code
Everywhere you work — One agent across every surface
  ├ Desktop   "Manual to agentic coding, in one familiar editor."   [Download]
  ├ CLI       "Run agents in any terminal, script, or editor."      [Install]
  ├ Other     "Start agents from GitHub, Slack, Linear, JetBrains IDEs…"
  └ Web&Mobile "Run cloud agents from your browser or phone."
Understands your codebase, no matter the size
Multiple models — Subagents run in parallel …
```

**这是"能力矩阵"的正确形态**：行 = 交互面，列 = 入口（Download / Install / Open）。每个格子里先一句"你在这能做什么"，再一个动作链接。

Moss 有**四个交互面**（全屏 TUI / readline REPL / headless CLI / SDK），但 README 只用一行字说"四种交互面：全屏 TUI · readline REPL · headless CLI · 可嵌入 SDK"（L21），**没有矩阵、没有各自的入口、没有各自的截图**。这是 §4 建议 3。

### 1.4 [线上核实] Quickstart 的四步：每步都有一个"立刻能跑的东西"

[Quickstart](https://cursor.com/docs/get-started/quickstart) 的四步是：

| 步  | 标题                                  | 提供的可执行物                                                                                    |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Install Cursor and sign in            | 三平台安装矩阵（macOS 12+ `.dmg` / Windows 10+ `.exe` / Linux apt+yum+AppImage 完整命令）         |
| 2   | Ask Cursor to explain your codebase   | 一句可复制 prompt + `Try in Cursor` deeplink：`cursor://anysphere.cursor-deeplink/prompt?text=…`  |
| 3   | Make one small change                 | 一句可复制 prompt（"Suggest three small, safe improvements…wait for me to choose one"）+ deeplink |
| 4   | Review the diff and verify the result | "review the diff and ask Cursor to run the checks your project already uses"                      |

三个可迁移的设计：

1. **第 2 步不是"hello world"，是"理解我的代码"**——第一次运行就产出**对我有用**的信息，而不是验证安装成功。
2. **deeplink 把"复制粘贴"这一步也消掉了**：点一下就带着 prompt 打开产品。这是 onboarding 摩擦的最后一公里。
3. **第 4 步把"验证"写进首次体验**："run the checks your project already uses（tests / type checker / linting / local build）"。这和 Moss 的 verdict 哲学同源，但 Cursor 用**一句话**表达，Moss 用一整套状态机文档。

### 1.5 [线上核实] 文档首页的"六卡"结构 = 能力矩阵的 prose 版

`/docs` 的 `## What you can do with Cursor`：

| 卡片                    | 一句话                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------- |
| Understand your code    | "Trace how a repo fits together and find the right places to start"                     |
| Plan and build features | "Scope changes, use Plan Mode, and ship bigger work with confidence"                    |
| Find and fix bugs       | "Reproduce issues, narrow the root cause, and verify the fix"                           |
| Review changes          | "Inspect diffs, run checks, and catch problems before you merge"                        |
| Customize Cursor        | "Add plugins, skills, MCPs, and rules from one place"                                   |
| Connect your workflow   | "Work with GitHub, GitLab, Azure DevOps, Bitbucket, JetBrains, Slack, Linear, and more" |

**每一行都是 `动词短语 : 你得到的结果`**，不是 `功能名 : 技术描述`。六行覆盖了完整工作流（理解 → 规划 → 实现 → 修 bug → 审查 → 集成）。

### 1.6 [线上核实] 视觉/录屏的位置与作用

从三个页面的抓取结果看，Cursor 的视觉资源有**三种明确分工**：

| 类型              | 位置                                                                                           | 作用                                    | 证据                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **交互式 demo**   | 首页首屏、每个 surface 卡片内                                                                  | 让人"摸到"产品；覆盖 Desktop + CLI 双语 | 页面原文 "This element contains an interactive demo for sighted users showing multiple Cursor interfaces" |
| **静态产品图**    | docs 首页 hero（`homepage-hero.png`）、changelog 每条一张                                      | 证明"这个功能真的存在"                  | changelog 每条都带 `![…]` 截图                                                                            |
| **动画/演示视频** | Marketplace 提交要求里明确要 "demo video…show install, uninstall, and your core product flows" | 生态侧的规范                            | [origin marketplace changelog](https://cursor.com/changelog)                                              |

**Moss 是一张都没有。** 对一个 TUI 产品，这是最大的一块丢分——终端手感**只能靠看**，而 README 里没有任何一处能让人看到终端长什么样。

### 1.7 [线上核实] Changelog 是产品页的一部分，不是附属品

`/changelog` 在 nav 的 Resources 第一位，条目按时间倒序，**每条都是"标题 + 2-4 句人话 + 一张图 + Get started 链接"**。2026-10 的条目：Agent SDK（Oct 20）、Cloud Agent Canvases（Oct 16）、Origin App Marketplace（Oct 13）、Remote control for local agents（Oct 6）、Rollouts and Security Review（Sep 23）。

其中 Oct 20 那条把"agents as code"的目录约定写得很清楚，**对 Moss 的能力包设计有直接参考价值**：

> "`instructions.md` is the prompt. Each file in `tools/` is one typed action the model can call. `skills/` holds procedures the model loads on demand, `mcp-connections/` adds tools from MCP servers, and `channels/` defines where the bot receives and answers messages."

以及 **"evals" 是发布流程的一等公民**："An eval sends a fixed message to the bot and asserts on what it did: which tools ran, with what input, and the shape of the reply."

**[先验·未在线核实]**：Cursor 早期（2023–2024）的 README 与官网以 "The AI Code Editor" 为主张，卖点是 Tab 补全 + Cmd-K；2025 之后整体切到 "coding agent"。我没拿到历史页面，这条只作背景，不作引用。

---

## 2. 首次运行与 onboarding：每一步消掉了什么摩擦

### 2.1 [线上核实] 官方定义的六步

Quickstart + CLI 文档拼起来，Cursor 的首次路径是：

```
1. 下载安装（.dmg / .exe / apt|yum|AppImage）· 或 CLI: curl https://cursor.com/install -fsS | bash
2. 打开 app → sign in
3. "pick a folder"（选工作区）
4. 打开 Agent（Cmd+I / Ctrl+I）· CLI 里直接 `agent`
5. 提问 → agent 搜索 repo、读文件、总结结构
6. 看 diff → 让 agent 跑项目已有的 checks
```

**注意：官方 quickstart 里没有"选模型"这一步。** 模型选择是可用但非必答的（`/docs` 有独立 Models & Pricing 页；CLI 用 `--model`）。这是一个刻意的产品决策：**不让新用户在第一次运行前做决策**。

### 2.2 逐步拆"摩擦被消在哪"

| 步骤       | 潜在摩擦           | Cursor 的处理（[线上核实]）                                                                                                                                                             | 对 Moss 的映射                                                                                                                  |
| ---------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 安装       | 三平台命令各不相同 | 同一页给全 macOS/Windows/Linux 三套，Linux 还分 apt / yum / AppImage 并**注明"apt and yum are preferred over AppImage. They provide desktop icons, automatic updates, and CLI tools."** | Moss README 的 `### macOS` / `### Windows` 已经有雏形，但**没有 Linux 一节**，且缺少"推荐哪个"的判断                            |
| 登录       | 需要账号           | 装完就登录，无第二个账号体系                                                                                                                                                            | Moss **无账号**（这是优势，应该显式写成卖点，现在写在 L21 一行"无账号、无云服务、无遥测"）                                      |
| 选模型     | 决策瘫痪           | **在新用户路径里不出现**；`--model` 是进阶选项                                                                                                                                          | Moss 首次运行**必须**选 provider + key（README L95–L110 描述"按数字选服务商"）——这是首次体验的主要摩擦点，见 §5 建议 1          |
| 选文件夹   | 不知道选哪个       | "pick a folder and start with a small task"                                                                                                                                             | Moss `moss` 在 cwd 直接起，无摩擦 ✅                                                                                            |
| 第一次提问 | 不知道问什么       | 给一句**可直接复制**的 prompt，并且是"解释这个 codebase"这种必然有产出的事                                                                                                              | Moss README 给的是 `看一下这个目录里有什么`（L110 附近）——**同样好**，但它埋在第 110 行的一段散文里，不在 quickstart 的代码块里 |
| 第一次编辑 | 怕它乱改           | Plan mode + Ask mode + checkpoint 三保险                                                                                                                                                | Moss 有审批 + `/rewind` + `--mode` 类能力，但 README 没有把它们表述成"所以你不会被它坑"                                         |
| 验证       | 不知道该跑什么     | 第 4 步明确"run the checks your project already uses"                                                                                                                                   | Moss 的 `--until "<cmd>"` / `post-condition` 是同源能力，**且更强**（这是差异点）                                               |

### 2.3 [线上核实] 三个"零教学"设计

1. **`Try in Cursor` deeplink**：quickstart 每个 prompt 后跟 `cursor://anysphere.cursor-deeplink/prompt?text=<urlencoded>`。用户不需要"复制 → 切窗口 → 粘贴"。**摩擦从 3 步降到 1 步。**
2. **Shift+Tab 轮换模式**：CLI 与编辑器统一用同一个键在 Agent / Plan / Ask 之间转（[CLI using](https://cursor.com/docs/cli/using)、[plan mode](https://cursor.com/docs/agent/plan-mode)）。不需要记三个命令。
3. **`/summarize` 与自动压缩并存**：手动有 `/summarize`（`/compress` 是别名），自动压缩则在长对话里静默发生。**用户不需要理解 context window 也能一直用下去。**

### 2.4 [先验·未在线核实] 本次未取到的环节

- **信任工作区 / workspace trust**：Cursor 作为 VS Code fork 保留了 workspace trust 机制；我**没有**在 quickstart 或 docs 首页取到相关段落，所以不把它当作"Cursor 的 onboarding 设计"来引用。
- **隐私模式 / Privacy Mode（数据不落库）**：本次未抓取 `/docs/account/privacy`，不作为断言。
- **首启的模型默认值**：未取到文档化的默认模型策略。

> 建议：这三条若要写进 Moss 的对标材料，需要再抓一轮 docs；不要用我的先验直接下结论。

---

## 3. 核心 UX 机制：哪些是"手感"的真正来源

先把"手感"拆成 5 个可观测维度，再逐机制定位。

### 3.0 手感 = 5 个维度的乘积（不是"响应速度"单项）

```
手感 = 响应速度 × 可预期性 × 可撤销性 × 失败可读性 × 快捷键一致性
```

任何一项接近 0，整体就是"难用"——**即使它很快**。Cursor 在这五项上都有可验证的具体设计，下面逐条给证据。

### 3.1 可撤销性：checkpoint 是手感的第一来源 [线上核实]

[agent overview](https://cursor.com/docs/agent/overview) 的 Checkpoints 段，四条原文：

1. "Checkpoints save snapshots of your codebase during an Agent session. **Agent automatically creates them before making significant changes**, capturing the state of all modified files."
2. "If Agent takes a wrong turn, **click any checkpoint in the chat timeline to preview your files at that point, then restore** to revert all files to that state."
3. "**Restoring a checkpoint reverts files only; it does not remove messages from the conversation.**"
4. "Checkpoints are stored locally and separate from Git. Only use them for undoing Agent changes; use Git for permanent version control."

为什么这是"手感"：**用户敢让它跑，是因为知道能退回来。** 四件事缺一不可：

- **自动**（不需要用户先想着建 checkpoint）→ 消除"忘了备份"的焦虑；
- **在时间线上可点**（不是隐藏菜单）→ 恢复的路径 = 0 次搜索；
- **只回滚文件、保留对话** → 恢复后**上下文还在**，可以"从这一步换个做法"，而不是从零重说；
- **与 Git 分离**（本地、不入版本库）→ 不污染工作流。

**Moss 对照**：README 只在 L220–L222 一行里提到 `/rewind`（"从检查点撤销文件编辑"）、`/diff`、`/review`。Moss 的 checkpoint 能力存在，但**没有"自动在危险操作前建点"与"时间线可点"的产品叙事**。这是 §5 建议 1。

### 3.2 可预期性：模式用同一个键轮换，且系统会"建议"模式 [线上核实]

- CLI：`Shift+Tab` 在 Agent / Plan / Ask 之间 rotate；`/plan`、`/ask`、`--mode=plan` 是等价别名（[CLI using](https://cursor.com/docs/cli/using)）。
- 编辑器：`Shift+Tab from the chat input to rotate to Plan Mode`（[plan mode](https://cursor.com/docs/agent/plan-mode)）。
- **系统主动建议**："Cursor also suggests it automatically when you type keywords that indicate complex tasks."（同上）

为什么这是手感：**用户不需要先判断"我该用哪个模式"再去找入口。** 一个键、一个方向、系统还会主动提示。三个操作（轮换/命令/flag）指向同一个状态机，减少"我到底在哪个模式"的不确定性。

**[本机 REA] 实现侧证据**：Cursor 的模式不是不同 system prompt，而是同一 prompt + 每轮追加的 `<system_reminder>` 块（Ask / Plan / Triage 各有全文模板；Ask 的模板里明确写 "This supersedes any other instructions you have received"）。系统提示词另有一处统一交代这类注入的正确反应：**"Heed them, but do not mention them directly in your response as the user cannot see them."**——**模式的"可预期感"来自每轮都在重述当前模式约束**，而不是第一次进入时说一次。

### 3.3 等待质感：它不装作在等你 [线上核实]

[agent overview](https://cursor.com/docs/agent/overview) 的 "Ask questions" 工具：

> "Ask clarifying questions during a task. **While waiting for your response, the agent continues reading files, making edits, or running commands.** Your answer is incorporated as soon as it arrives."

为什么这是手感：**提问不再是一个"双方互锁"的停顿。** 大多数 agent 在问问题时会完全停下，用户体验是"卡住了"。Cursor 的设计是"问归问，活照干，答案到了再吸收"。

Moss 现状：AGENTS.md 记录了一个修复（B122）——运行期间 `ask_user_question` 走 run-scoped asker 直接读 stdin，**非 TTY 自动 decline 让 agent 继续**。这已经是同源思路；README 没有把它讲成"不会卡住"。

### 3.4 失败可读性：错误信息是"下一步"而不是"堆栈" [本机 REA]

这是最容易被忽略、但对"手感"贡献最大的一块。从 `/Applications/Cursor.app` 3.27.14 的 bundle 读到的具体设计：

**（a）"没执行" ≠ "失败" —— 单独一个返回值**

```js
case void 0: return "action was not executed";
```

工具被拒绝或被跳过时，模型收到的是 `"action was not executed"`，而不是一个 error。**避免模型把"用户没批准"当成"命令失败"然后重试。**（证据：`cursor-local-agent-runtime/dist/main.js`，参见 `docs/research/2026-11-04-cursor-claude-agent-design/cursor-evidence.md` §E.4）

**（b）错误文案双通道：给模型的和给人的不是同一份**

bundle 里的错误对象同时带 `clientVisibleErrorMessage` 与 `modelVisibleErrorMessage` 两个字段（`j0` 类）。同一次失败，**人读的是"发生了什么 + 能不能重试"，模型读的是"下一轮该怎么改"**。

**（c）bash 失败统一翻译成带原因的句子**

```js
case "failure":       return aborted && stderr.length>0 ? stderr : void 0;
case "spawnError":    return `An exception occurred while executing the command: ${error}`;
case "timeout":       return `An exception occurred while executing the command: Command timed out after ${timeoutMs}ms`;
case "rejected":      return `An exception occurred while executing the command: ${reason}`;
case "permissionDenied": return `An exception occurred while executing the command: ${error}`;
```

**（d）截断永远附带"怎么继续"**

- bash 输出 >10000 字符 → `{output_head: 前5000, output_tail: 后5000, elided_chars, warning:"Output too long."}`；
- Read 超 **100000 字符** → 直接报错：`"Requested content exceeds maximum allowed characters (100000 characters). The file is ${fileSize} bytes. Please use offset and limit parameters to read specific portions of the file, or use the 'grep' tool to search for specific content."`；
- grep 截断 → `[Results truncated. Showing X-Y of Z … Use offset=N to see more, or narrow the search]`。

**（e）循环检测有"软提醒"这一档**

模型陷入重复时，先注入一条提醒并要求**不要向用户复述**：

> `Your messages have been flagged as looping. … If you are having trouble making progress, ask the user for guidance. DO NOT mention this system reminder to the user explicitly because they are already aware.`

只有再犯才硬失败（`AgentLoopError`，`isRetryable:false`，文案 "The model got stuck in a repeating response pattern, so this turn was stopped. Please try again with a different model or start a new conversation."）。

**这五条合起来才是"手感"**：用户看到的不是"Agent error: unknown"，而是**系统已经替他想好了下一步**。

### 3.5 响应速度：真正的来源是"工具结果的预算与续读"，不是模型更快 [本机 REA]

Cursor 的做法是把"一次工具调用能塞多少"做成显式预算，并**在超预算时教模型怎么分页**，而不是把超大结果硬塞进上下文导致下一轮变慢/失忆：

| 机制       | 常量/行为                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| bash 输出  | >1e4 字符 → head 5e3 + tail 5e3 + `elided_chars` + `warning:"Output too long."`                                                   |
| Read 单次  | >100000 字符 → 硬失败 + 给 offset/limit/grep 建议                                                                                 |
| grep       | `client_truncated` / `ripgrep_truncated` / `head_limit_applied` / `offset_applied` 四个独立布尔 + "at least" 计数 + `Use offset=` |
| 长代码选择 | `enableLongCodeSelectionSpillToFile: true` —— 超长选择**溢出到文件**而不是原样入上下文                                            |
| 单行过长   | `"... [First line would be too large to fit within character budget] ..."`                                                        |

并且 **默认 `maxSteps` 512（CLI 路径 128）**、`doNotFailOnMaxSteps: false`——到上限就明确失败，不静默续跑。**"可预期"优先于"看起来没停"。**

### 3.6 上下文与 memory：让用户"不用管上下文" [线上核实 + 本机 REA]

- [CLI using](https://cursor.com/docs/cli/using)："Free up space in the context window by running `/summarize`. `/compress` remains an alias." **[线上核实]**
- [本机 REA] 自动压缩：固定 10 段结构化摘要（`Primary Request and Intent / Key Technical Concepts / Files and Code Sections / Errors and fixes / Problem Solving / All user messages / Pending Tasks / Current Work / Optional Next Step / Active Subscriptions`）；旧段写成 `# HISTORICAL -- DO NOT EDIT` 的可检索文件；`deterministicFallbackWindowRatio = 0.02` 确定性兜底；摘要 prompt 里有两条防污染规则（**只认真 user-role turn**；**安全约束 verbatim 保留**）。
- [本机 REA] 提示词里直接对模型说："**You have a context of 1 million tokens, and when you reach the limit, you will automatically be provided with a fresh context window, as many times as you need.** … You don't need to wrap up early or hand off mid-task."

**手感结论**：用户从不被要求"清理上下文"。手动 `/summarize` 是给想主动控制的人的逃生口，**不是必需品**。而"不要提前收尾"是**写进提示词**的——这解释了为什么 Cursor 的长任务不会莫名其妙地说"我先总结一下，你可以开个新会话"。

### 3.7 Tab / Cmd-K：本次未作为证据采用 [未在线核实]

产品页与 docs 首页**没有**把 Tab / Cmd-K 作为 2026 年的主张（主张已经是 agent）。我没有抓到 `/docs/tab` 或 `/docs/cmd-k` 一类页面来引用具体行为，因此**不把 Tab 补全与 Cmd-K 内联编辑的任何细节写成本次结论**。

> 对 Moss 的意义：这是一条**负面证据**——连 Cursor 都把"编辑器级补全"从主叙事里降权了。Moss 是 CLI/TUI 产品，更不应该把 README 的注意力花在"逐行补全"这种编辑器能力上。

### 3.8 快捷键一致性：一张表就能看出成熟度 [线上核实]

[CLI using](https://cursor.com/docs/cli/using) 的快捷键是**成体系**的，且有明确的"为什么"：

| 键            | 行为                    | 备注（原文）                                                            |
| ------------- | ----------------------- | ----------------------------------------------------------------------- |
| `Shift+Tab`   | 轮换 Agent / Plan / Ask | 与编辑器同一个键                                                        |
| `Shift+Enter` | 换行而非提交            | "works in iTerm2, Ghostty, Kitty, Warp, and Zed"                        |
| `Ctrl+J`      | 换行（通用备选）        | "For tmux users, use Ctrl+J instead"                                    |
| `Ctrl+D`      | 退出                    | "Follows standard shell behavior, **requiring a double-press to exit**" |
| `Ctrl+R`      | 审查改动                | 按 `i` 加后续指令，方向键滚动/切文件                                    |
| `@`           | 选文件/文件夹入上下文   | —                                                                       |
| `↑`           | 历史消息                | —                                                                       |

**两个细节值得抄：**

1. **`Ctrl+D` 要按两次**——防误触退出。这是"手感"的典型形态：一个 10 行代码的决定，消掉一整类事故。
2. **`Shift+Enter` 有 tmux 备选 `Ctrl+J`**——**承认终端差异并给出退路**，而不是"我们支持 Shift+Enter，你的终端不支持是你的事"。

---

## 4. 给 Moss README 的 5 条建议

> 每条：一行结论 + 证据。全部基于本次线上核实 + 本仓库现有 `README.md` 的实际行号。

### 建议 1：把「一句话定位」从架构语言改成用户终局语言，并补齐"为什么不是 Cursor/Claude Code"

**结论**：首屏 slogan 换成 `[Moss] 是 [给机器人/设备开发者的 coding agent]，[让"完成"由真机证据判定而不是模型自称]`，并在首屏 60 行内放一张 3 行对比表（Cursor / Claude Code / Moss）说清差异。

**证据**：

- Cursor 三处入口第一行都是同一句用户语言（[cursor.com](https://cursor.com/)、[docs](https://cursor.com/docs)、[product](https://cursor.com/product)）**[线上核实]**；Moss 现 slogan 是 `One Intent → One Task → One Agent Loop → One Verified Result.`（`README.md:5`）——4 个内部名词，读者无法在 5 秒内解码。
- Moss 真正的差异点（"PASS 只能来自 verdict provider"、"缺证据 = 未完成"、SSH 真机）写在 `README.md:200`–`README.md:218`，**在第 200 行**。
- 全文无任何对比段落（`grep -c '^| '` 无对比表）。

### 建议 2：把「## 环境」下沉到 quickstart 之后，前 60 行改成"30 秒首个闭环"

**结论**：现在 `## 环境`（`README.md:24`）在 `## 快速开始`（`README.md:55`）之前，31 行 Node/git/PowerShell 前置条件挡在门口。改成：首屏 → 一行安装 → 一个可复制的首个 prompt → 一张终端录屏 → 然后才是环境前提与平台细节。

**证据**：

- Cursor quickstart 的四步里，**第 1 步就是"安装 + 登录"，第 2 步就产出价值**；平台差异被折进第 1 步的子块（[quickstart](https://cursor.com/docs/get-started/quickstart)）**[线上核实]**。
- Cursor 甚至不再要求选模型（quickstart 四步里没有"选模型"），把决策推到需要时 **[线上核实]**。Moss 的首次运行必须在 TUI 里选 provider + 输 key（`README.md:95`–`README.md:110`）——**这已经是一个摩擦，不该再用 31 行环境说明把它推得更远。**
- Moss 已有极好的"首个 prompt"（`看一下这个目录里有什么`，`README.md:110` 附近），但它埋在散文里，不在 quickstart 的代码块里。

### 建议 3：加"交互面矩阵"（TUI / REPL / headless / SDK），每格一个入口 + 一张真图

**结论**：照 Cursor 产品页的 `Everywhere you work` 做一张 4 行表：交互面 → 一句话用途 → 启动命令 → 一张该界面的真实终端截图。TUI 那张必须是**真录屏的静帧**（含 `❯` composer、`⏺` 工具调用、`⎿` 结果）。

**证据**：

- Cursor `Everywhere you work — One agent across every surface`，Desktop/CLI/Other/Web&Mobile 四格，每格一句人话 + 一个动作链接 + 一个交互 demo（[product](https://cursor.com/product)）**[线上核实]**。
- Moss 有四个交互面，README 只用一行字带过（`README.md:21`），**0 张图**（`grep '!\[' README.md` 仅命中 3 个 badge，`README.md:8-10`）。
- Moss 自己已有真实终端渲染规范（`docs/tui-ux-audit-2026-10-01.md` §0：`❯` 用户 / `⏺` 回答与工具调用 / `⎿` 工具结果 / `·` 思考 / `✢…✻` 运行中）——**素材已经在了，只是没进 README。**

### 建议 4：把「命令参考」从 470 行里的大表改成"三段式"，长尾移到 docs

**结论**：`## 命令参考`（`README.md:316`）现在是一张横跨 36 行、单元格极宽的表格（AGENTS.md 里同一张表已膨胀到单行上千字符）。README 只留：① 三个最高频命令（`moss` / `moss loop --until` / `moss task run`）② 一张"其余命令去哪"的索引表 ③ 链接到 `docs/`。完整表留在 docs。

**证据**：

- Cursor 的 `/docs` 首页只放 **3 张"Start here"卡 + 6 张"你能做什么"卡**，"全部能力"要进二级页 **[线上核实]**。CLI 文档也把「模式」「键盘」「MCP」「ACP」「Rules」拆成独立小节，每节 3–8 行 **[线上核实]**。
- Moss README 470 行里，`## 命令参考` 到 `## 界面语言` 之间（`README.md:316`–`README.md:353`）是单张巨表，与 AGENTS.md 的"常用命令"表重复维护。**漂移已经发生，而且是同一个文件内部先漂**（本次实测）：
  - examples 数量：`README.md:258` 写"三个可运行集成"、`README.md:408` 写"3 个 examples"、`README.md:410` 写"四个离线嵌入示例"；`AGENTS.md:55` 写"四个"、`AGENTS.md:58` 写"3 个"。**实际 `examples/` 有 5 个文件**（`custom-tool-approval` / `headless-run` / `repl-host` / `rsi-sdk` / `skill-catalog`）。
  - 失效引用：`README.md:258` 仍指向 `test/sdk-contract.spec.mjs`，而 AGENTS.md 已声明该 spec 套件于 **2026-11-04 全部删除**（`AGENTS.md` "验证约定"节）。

### 建议 5：把「验证/证据」做成首屏的**可看产物**，而不是第 200 行的哲学

**结论**：在首屏放一段真实的 `.moss/` 产物片段（`acceptance.jsonl` 或 `task timeline` 的 5 行输出），让人**看到** "PASS 来自 verdict provider" 是什么样子。用一轮 `moss loop --until "npm run verify"` 的真实输出更好。

**证据**：

- Cursor 的 quickstart 第 4 步就是"review the diff and ask Cursor to run the checks your project already uses"，把验证放进**首次体验**而不是原理章节 **[线上核实]**。
- Moss 的验证哲学强得多（verdict provider / latest-wins / 完成门），但表达是 `docs` 级：`README.md:200`–`218` 是状态机与文件清单的**名词列表**，没有一个"跑出来的样子"。
- 仓库已有可复制的证据形态：`moss task status --json` 输出（AGENTS.md 描述为 `taskId/goal/phase/status/attempt/repairs/failures/evidence/resumable/acceptanceCommand/lastFailure/...`）——**这就是最好的截图素材，一行命令就能生成。**

---

## 5. 给 Moss UX / 手感的 5 条建议

> 每条：一行结论 + 证据。Moss 现有能力用 `README.md` / `AGENTS.md` 对齐，不臆造新功能。

### 建议 1：把 checkpoint 从"命令"升级成"默认行为 + 可见时间线"

**结论**：每次写类工具执行前自动建 checkpoint（用户不用记 `/rewind`），并在 transcript 里留一行可回跳的标记；恢复时**只回滚文件、保留对话**。

**证据**：

- Cursor："Agent **automatically** creates them before making significant changes"；"click any checkpoint in the chat timeline to preview … then restore"；"**Restoring a checkpoint reverts files only; it does not remove messages**"（[agent overview](https://cursor.com/docs/agent/overview)）**[线上核实]**。
- Moss 现状：`/rewind` 存在（`README.md:220`–`222`），但 README 把它列为"斜杠命令之一"，不是默认安全网；`AGENTS.md` 提到 `.moss/checkpoints` 目录存在。
- 为什么重要：**这是"敢让它跑"的唯一理由**，比任何速度优化都影响体感。

### 建议 2：等待时不要锁死输入；提问与执行并行

**结论**：`ask_user_question` 弹出时，后台继续做不依赖答案的只读工作（读文件、搜索、跑 readonly 探测）；用户答完立刻吸收。非 TTY 已有 decline-继续的行为，把它做成显式产品语义并写进提示行。

**证据**：

- Cursor："While waiting for your response, **the agent continues reading files, making edits, or running commands**. Your answer is incorporated as soon as it arrives."（[agent overview](https://cursor.com/docs/agent/overview)）**[线上核实]**。
- Moss 已有 B122 修复：run-scoped asker 直接读 stdin，**非 TTY 自动 decline 让 agent 继续**；REPL 的 stdin 有单一归属路由。**能力在，产品叙事和提示行没体现。**

### 建议 3：把所有失败信息统一成「一个原因 + 一个下一步」，并区分"没执行"与"失败"

**结论**：工具层禁止裸 `Error: …` 上屏。失败必须渲染成 `原因: <一句> / 下一步: <可执行>`；"用户拒绝/未批准"走独立状态，文案固定为"已跳过（未执行）"，不进错误通道。

**证据**：

- Cursor 本机实现 **[本机 REA]**：`case void 0: return "action was not executed"` 与 `failure/spawnError/timeout/rejected/permissionDenied` 并列但语义不同；错误对象有 `clientVisibleErrorMessage` / `modelVisibleErrorMessage` 两条独立文案。
- Moss 的 AGENTS.md 已要求"面向用户的成功消息必须来自真实结果（probe / exit code / post-condition），不得是固定字符串"——**成功侧已经做对了，失败侧还缺同样的纪律。**
- 落地位置：`src/errors.ts` 的 `MossError` + `src/cli/` 的渲染层（不新增子系统）。

### 建议 4：截断/超限一律回填"怎么继续"，并把预算做成可见

**结论**：任何被截断的工具结果（文件、grep、命令输出、diff）在尾部追加一行续读指令；TUI 状态行显示当前 ctx 占用与压缩次数。

**证据**：

- Cursor **[本机 REA]**：bash >1e4 → head/tail 各 5e3 + `elided_chars` + `"Output too long."`；Read >100000 字符直接报错并给 offset/limit/grep 三条出路；grep 截断回 `Use offset=N to see more, or narrow the search`。
- Cursor **[线上核实]**：`/summarize` 是手动逃生口，自动压缩静默发生（[CLI using](https://cursor.com/docs/cli/using)）。
- Moss 已有 `/compact`、`/cost` 一类命令（`README.md:220`–`222`、`## 调优开关`），但**预算不进状态行**，用户不知道离下次压缩还有多远。

### 建议 5：快捷键"少而统一"，并给终端差异留退路

**结论**：每个概念一个键，跨 TUI/REPL 一致；`Ctrl+C` 双击语义明确（Moss 已有：首次 = 暂停可续跑、二次 = 强制退出）；`Shift+Enter` 不支持时显式提示 `Ctrl+J`；不要在 TUI 与 REPL 用两套键位。

**证据**：

- Cursor **[线上核实]**：`Shift+Tab` 在编辑器与 CLI 都是轮换模式；`Ctrl+D` "requiring a double-press to exit"；`Shift+Enter` 明确列出 "works in iTerm2, Ghostty, Kitty, Warp, and Zed"，并给 tmux 用户 `Ctrl+J`（[CLI using](https://cursor.com/docs/cli/using)）。
- Moss 已有很好的语义（`AGENTS.md` 记录 `Ctrl+C` 首次暂停写入 `task_failed{detail:"aborted"}` 并打印 `/goal resume`，二次强制 exit 130；TUI 用 Esc 暂停）——**这套"可续跑的 Ctrl+C"其实比 Cursor 的"按两次退出"更贴合长任务产品**，应该写进 README 首屏而不是埋在第 400 行。

---

## 6. 附录

### 6.1 本次线上核实的 URL 清单（2026-11-06 抓取，均 HTTP 200）

| URL                                                                                              | 取到的东西                                                                                            |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [https://cursor.com/](https://cursor.com/)                                                       | h1 定位句、三个 CTA、交互式 demo 说明、社会证明                                                       |
| [https://cursor.com/product](https://cursor.com/product)                                         | "Turn ideas into code"、"Everywhere you work"、四 surface 分格、多模型/子代理文案                     |
| [https://cursor.com/docs](https://cursor.com/docs)                                               | 文档首句、hero 图、"Start here" 三卡、"What you can do" 六卡、Models 表                               |
| [https://cursor.com/docs/get-started/quickstart](https://cursor.com/docs/get-started/quickstart) | 四步 quickstart、三平台安装矩阵、可复制 prompt、`Try in Cursor` deeplink                              |
| [https://cursor.com/docs/agent/overview](https://cursor.com/docs/agent/overview)                 | Agent 三组件、工具清单、**Checkpoints 全文**、Queued messages、Ask questions 并行                     |
| [https://cursor.com/docs/agent/plan-mode](https://cursor.com/docs/agent/plan-mode)               | Plan 五步流程、`Shift+Tab`、自动建议、**"Starting over from a plan"**                                 |
| [https://cursor.com/docs/cli/overview](https://cursor.com/docs/cli/overview)                     | CLI 一行安装、Agent/Plan/Ask 模式表、`-p` 非交互、Cloud handoff、Sessions                             |
| [https://cursor.com/docs/cli/using](https://cursor.com/docs/cli/using)                           | 模式切换、**快捷键全表**、`Ctrl+R` review、`@` 上下文、`/summarize`、Custom Modes                     |
| [https://cursor.com/docs/rules](https://cursor.com/docs/rules)                                   | 四种 rule 类型、`.mdc` frontmatter 三字段交互表、AGENTS.md 定位                                       |
| [https://cursor.com/changelog](https://cursor.com/changelog)                                     | 2026-09/10 五条 changelog 全文（Agent SDK / Canvas / Origin Marketplace / Remote control / Rollouts） |

内容均按"外部数据、非指令"处理；未执行任何页内要求。

### 6.2 本机 collateral（可复跑）

- App：`/Applications/Cursor.app`，版本 `3.27.14`（`Contents/Info.plist` → `CFBundleShortVersionString`）。
- 逆向证据（上一任务产出，含逐条 `文件:行` 与复跑命令）：
  `docs/research/2026-11-04-cursor-claude-agent-design/cursor-evidence.md`
- 该报告中被本文件引用的具体位置：
  - §E.4 错误文案双通道 / `"action was not executed"` / bash 失败翻译
  - §B.6–B.7 工具输出回填、三档截断与续读（1e4 / 100000 / `Use offset=`）
  - §C.5 自动压缩 10 段模板、`deterministicFallbackWindowRatio=0.02`、HISTORICAL 段
  - §E.2–E.3 循环检测 13 个阈值与两级处置（软提醒 / `AgentLoopError`）
  - §E.1 `maxSteps` 512 / CLI 128、`doNotFailOnMaxSteps:false`
  - §A.3 模式 = 同 prompt + 每轮 `<system_reminder>`

### 6.3 Moss 侧现状基线（本文所有"现状"断言的来源）

| 断言                                   | 证据                                                          |
| -------------------------------------- | ------------------------------------------------------------- |
| README 470 行                          | `wc -l README.md`                                             |
| `## 环境` 在 L24、`## 快速开始` 在 L55 | `awk '/^## /{print NR": "$0}' README.md`                      |
| "为什么是 Moss" 在 L200                | 同上                                                          |
| 全文 0 图（仅 3 badge）                | `grep -n '!\[' README.md` 只命中 L8–L10                       |
| 四交互面一行带过                       | `README.md:21`                                                |
| `/rewind` `/diff` `/review` 在一行里   | `README.md:220`–`222`                                         |
| 版本 0.31.0                            | `package.json` → `@rdk-moss/agent 0.31.0`                     |
| TUI 渲染规范已存在                     | `docs/tui-ux-audit-2026-10-01.md` §0（`❯`/`⏺`/`⎿`/`·`/`✢…✻`） |
| `Ctrl+C` 可续跑语义已实现              | `AGENTS.md` `/goal` 行（B121/B122/B123/B124/B125）            |

### 6.4 局限与未核实项

1. **未抓取**：`/docs/tab`、`/docs/cmd-k`、`/docs/account/privacy`、`/docs/agent/tools/*` 的细节页；`/learn/*` 教程页。因此 Tab 补全、Cmd-K、隐私模式、Browser 工具的具体行为**不作为结论**。
2. **未做**：Cursor 的运行时行为验证（只做了静态 bundle + 官方文档）。所有"它自动怎样"的断言都来自官方文档的自我描述或 bundle 里的代码路径，**没有实际跑一次 Cursor 验证**。
3. **未做**：历史版本对比（2023–2025 的定位演变），只在 §1.7 用先验提了一句并标注。
4. **Moss 侧**：只读了 README / AGENTS.md / 一份 TUI 审计，**没有实际跑 `moss` 体验四交互面**（本任务约束不改 src、不跑 build/test）。因此 §5 的建议基于"文档宣称的能力"，落地前需要一次真实 TUI 体验复核。
5. **价格/模型**：刻意未写。Cursor 的 Models & Pricing 是快速变动项，对 Moss 的 README 决策无影响。
