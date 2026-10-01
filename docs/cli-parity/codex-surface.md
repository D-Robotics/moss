# OpenAI Codex CLI 0.155.1 交互面逐屏实测（真实 PTY ground truth）

本文件是 moss CLI parity 工作的 R2 参考面：用真实 PTY 驱动本机安装的 **Codex CLI 0.155.1**，
把它的启动界面、输入编辑、斜杠命令、审批、工具渲染、会话生命周期逐屏抓成可复核的证据。
**每条断言都附引用的屏幕 dump 或明确标注「not verified」**；引用的 dump 一律来自
`scratch/cx-*/NAME.txt`（明文屏）与 `NAME.style` / `raw.log`（属性与原始字节）。

- 被测二进制：`/opt/homebrew/bin/codex`（symlink → `@openai/codex` npm 包内的
  `aarch64-apple-darwin` 原生二进制），`codex-cli 0.155.1`。
- 本机登录状态：`codex login status` → `Logged in using ChatGPT`（**可用**，见 §0.3）。
- 本机 `~/.codex/config.toml` 是重度定制配置（自定义 provider、skills、plugins、hooks、
  多 MCP server、`model = "deepseek-flash@latest"`、`model_reasoning_effort = "xhigh"`），
  所有抓屏都用 `--realhome` 加载这份真实配置。

---

## 0. 方法、环境与可复现步骤

### 0.1 Harness 与调用约定

复用仓库内既有的 PTY 驱动器（`pyte` 重建屏幕，含单元格属性）：

```bash
cd /Users/d-robotics/Desktop/RDK_Studio/moss
CX="env -u NO_COLOR TERM=xterm-256color COLORTERM=truecolor \
  python3 scratch/tui-drive.py --bin /opt/homebrew/bin/codex --realhome \
  --workspace /private/tmp/cx-ws \
  --args '-c projects.\"/private/tmp/cx-ws\".trust_level=\"trusted\"'"
# 用法：$CX --cols 90 --rows 30 --out scratch/cx-<name> --boot-ms 12000 --steps '<DSL>'
```

DSL：`wait:MS` · `shot:NAME` · `key:NAME`（`enter esc tab up down left right bs space pgup pgdn
ctrl-<a-z>`）· `text:STR` · `raw:HEXBYTES` · `resize:COLSxROWS`。dump 落在 `<out>/NAME.txt`（明文）
与 `<out>/NAME.style`（逐单元格颜色/属性）。DSL 用逗号分隔，提示词里含逗号时改用 `--scenario <json>`
（本文件里的多步模型回合都用 scenario）。

**环境陷阱（必须复现）。** 本 agent 的父 shell 带 `NO_COLOR=1` 与 `TERM=dumb`；驱动器对 `--bin`
会继承父环境，因此不带前缀的调用会得到**完全无颜色的屏幕**。第一轮抓屏（`scratch/cx-s1*`、
`cx-size80/120`、`cx-turn4/5/6/7/8`、`cx-menus`、`cx-slash*`、`cx-keys`、`cx-diff`）就是这样产生的：
**文字内容有效，颜色属性无效**。此后所有颜色相关结论都来自 `env -u NO_COLOR` 的
`scratch/cx-color*`、`cx-csize*`、`cx-diff2/3/4`、`cx-replay*`、`cx-exit*`、`cx-mcp` 抓屏，
并用 `--rawlog` 的原始 SGR 字节复核。凡引用到无颜色抓屏的地方，本文都显式说明。

**pyte 的能力边界。** `pyte` 不建模 SGR 2（faint/dim），所以 `.style` 里看不到暗淡属性；
「次要文字用 dim」这类结论只用原始字节佐证。**SGR 色板**（逐条来自 `raw.log`；`pyte` 把 ANSI-256
归一成十六进制，所以同一颜色有两种写法）：

| 原始序列                          | pyte 呈现 | 用途（证据目录）                                                                 |
| --------------------------------- | --------- | -------------------------------------------------------------------------------- |
| `\x1b[38;5;6;49m`                 | `#00cdcd` | 斜杠菜单选中行、`@@` hunk 头、内联 code（`cx-color1`、`cx-diff4`、`cx-replay3`） |
| `\x1b[38;5;1;49m`                 | `#cd0000` | diff `-` 行、工具调用失败 bullet（`cx-diff4`、`cx-replay3`）                     |
| `\x1b[38;5;2;49m`                 | `#00cd00` | diff `+` 行、工具调用成功 bullet（`cx-diff4`、`cx-replay3`）                     |
| `\x1b[38;5;3;49m`                 | `#cdcd00` | 会话选择器选中项、`⚠` 警告（`cx-replay3`、`cx-color1`）                          |
| `\x1b[38;5;5;49m`                 | `#cd00cd` | 选择器过滤器当前值（`cx-replay2`）                                               |
| `\x1b[38;2;246;226;183;49m`       | `#f6e2b7` | 状态行模型名（`cx-color1`）                                                      |
| `\x1b[38;2;171;223;167;49m`       | `#abdfa7` | 状态行 cwd（`cx-color1`）                                                        |
| `\x1b[38;2;137;180;250;49m`       | `#89b4fa` | 命令名语法高亮（`cx-replay3`）                                                   |
| `\x1b[38;2;147;153;178;49m`       | `#9399b2` | 命令分隔符 `-` 高亮（`cx-replay3`）                                              |
| `\x1b[38;2;235;160;172;49m`       | `#eba0ac` | flag 字母高亮（`cx-replay3`）                                                    |
| `\x1b[38;2;205;214;244;49m`       | `#cdd6f4` | 参数/路径高亮（`cx-replay3`）                                                    |
| `\x1b[2m` / `\x1b[22m`            | —         | dim（占位符、菜单描述、`└` 输出行、段落 bullet）——**pyte 不建模，只看 raw**      |
| `\x1b[1m` / `\x1b[3m` / `\x1b[4m` | B / I / U | bold / italic / underline（标题、`›` 提示符）                                    |

### 0.2 抓屏索引（每条都给出确切命令）

所有命令都以上面的 `$CX` 展开为前缀（`/tmp/cx-ws` 是工作区，`/tmp/cx-git` 是一个含分支的 git 仓库）。

| 目录                                           | 关键参数                                                                                                              | 证明了什么                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `scratch/cx-color1/`                           | `--cols 90 --rows 30 --rawlog --steps 'shot:c-boot,text:/,wait:1200,shot:c-slash,key:esc,…,text:/status…'`            | 90×30 启动 chrome、斜杠菜单颜色、`/status` 面板（§1/§3）     |
| `scratch/cx-csize80/`、`cx-csize120/`          | `--cols 80 --rows 24` / `--cols 120 --rows 40`，`--steps 'key:down,key:enter,wait:3500,shot:cboot80'`                 | 80×24 与 120×40 的布局（§1）                                 |
| `scratch/cx-size80/`、`cx-size120/`、`cx-s1c/` | 同上但**未**去 `NO_COLOR`（早期抓屏）                                                                                 | 文字版布局，用于交叉核对（§1）                               |
| `scratch/cx-s1/`                               | `--workspace scratch/codex-ws`（moss 仓库子目录）                                                                     | 目录信任对话框原文（§0.4/§4）                                |
| `scratch/cx-s2/`、`cx-s2b/`、`cx-s2c/`         | `--steps 'text:/,wait:1500,key:down×5,shot:d5,…'` / `…×45,shot:a45,key:down…`                                         | 斜杠弹窗滚动窗口、48 条清单（§3）                            |
| `scratch/cx-slashkeys/`                        | `--steps 'text:/mo,…,key:tab,…,key:enter,…'`                                                                          | 过滤 / Tab 补全 / Enter 执行（§3）                           |
| `scratch/cx-s3/`                               | `--steps 'key:up,shot:hist-up,key:ctrl-c,text:line1,key:ctrl-j,…,raw:1b5b3230307e…'`                                  | 历史、Ctrl+J、Shift+Enter、bracketed paste（§2）             |
| `scratch/cx-keys/`                             | `--steps 'text:abc,key:left,key:left,text:X,…,key:ctrl-a,…,key:ctrl-e,…,key:ctrl-w,key:ctrl-u'`                       | 光标移动、Ctrl+A/E/W/U（§2）                                 |
| `scratch/cx-s4/`、`cx-s5/`、`cx-s5d/`          | `--steps 'text:probe,key:esc,…,key:ctrl-c,…'` / `'key:ctrl-c,…'` / `'key:ctrl-d,…'`                                   | Esc/Ctrl+C/Ctrl+D 语义（§8）                                 |
| `scratch/cx-exit1/`、`cx-exit2/`、`cx-exit3/`  | `--steps 'key:down,key:enter,wait:2500,key:ctrl-c,wait:4000,shot:x1,…'`（exit2 换 `ctrl-d`；exit3 连按三次 `ctrl-c`） | Ctrl+C 的「首次按键被吞」与 Ctrl+D 的退出时序（§8）          |
| `scratch/cx-mcp/`                              | `--steps 'key:down,key:enter,wait:3000,shot:m0,key:ctrl-t,wait:2500,shot:m1'`                                         | MCP 启动告警行 + Ctrl+T 转录查看器（§1.4/§8）                |
| `scratch/cx-menus/`                            | `--scenario` 依次 `/permissions`、`/status`、`/statusline`、`/title`、`/plan`                                         | 权限菜单、状态面板、状态行/标题配置项、Plan 模式（§1/§4/§5） |
| `scratch/cx-color2/`                           | `--steps 'text:/permissions,…,key:down,…,shot:p-open,p-down'`                                                         | 权限菜单颜色版（§4）                                         |
| `scratch/cx-model/`                            | `--steps 'text:/model,key:enter,shot:model-picker,…'`                                                                 | `/model` 选择器（§4）                                        |
| `scratch/cx-modes/`                            | `--steps 'shot:mode0,raw:1b5b5a,…,shot:mode4'`                                                                        | Shift+Tab 模式循环（§5）                                     |
| `scratch/cx-turn2/`、`cx-turn3/`               | `--scenario scratch/cx-turn{,2,3}.json`                                                                               | 配置模型不可用时的报错渲染（§10）                            |
| `scratch/cx-turn4/`                            | `--scenario scratch/cx-turn4.json --args '… -m glm-5.3-flash -c model_reasoning_effort="low"'`                        | 真实回合：Working spinner、`• Ran`/`└`、done 标记（§6）      |
| `scratch/cx-turn6/`、`cx-turn7/`               | 同上，提示词分别为工作区内写文件、网络访问                                                                            | 无需审批 vs 触发网络审批（§4/§6）                            |
| `scratch/cx-turn8/`                            | 要求 markdown 输出                                                                                                    | 流式与 markdown 渲染（§7）                                   |
| `scratch/cx-replay/`                           | `--args '… resume'`，`--steps 'shot:plist'`                                                                           | 启动自更新提示（§10）                                        |
| `scratch/cx-replay2/`                          | `--args '… resume'`，`--steps 'key:down,key:enter,…,key:ctrl-t,wait:2500,shot:v-preview'`                             | 会话选择器 + 转录预览器（§9）                                |
| `scratch/cx-replay3/`                          | `--steps 'key:down,key:enter,wait:3000,key:down,key:down,key:enter,wait:8000,shot:w-replay'`                          | 恢复会话后的彩色转录（§6/§9）                                |
| `scratch/cx-resume2/`                          | `--args '… resume'`，`--steps 'shot:rlist,…,key:ctrl-t,…,key:ctrl-o,…'`                                               | 选择器列表、comfy/dense、预览（§9）                          |
| `scratch/cx-s6/`、`cx-s6b/`、`cx-s6c/`         | `--args 'resume'`（s6 无信任覆盖）/ `--args '… resume'`                                                               | 选择器空态、过滤器/状态/排序选项、Esc=new（§9）              |
| `scratch/cx-diff/`、`cx-diff2/3/4/`            | git 工作区 `--steps 'text:/diff,key:enter,wait:2500,shot:…'`                                                          | `/diff` 全屏分页器与 +/− 颜色（§6）                          |

非 PTY 的免费佐证：

```bash
/opt/homebrew/bin/codex --version                 # codex-cli 0.155.1
/opt/homebrew/bin/codex --help                    # 顶层子命令 + -a/-s/--search/--no-alt-screen
/opt/homebrew/bin/codex resume --help             # --last / --all / --include-non-interactive
/opt/homebrew/bin/codex features list | wc -l     # 142 行特性开关
/opt/homebrew/bin/codex debug prompt-input "test" # 模型可见的 input 列表（JSON，5 条 message）
/opt/homebrew/bin/codex login status              # Logged in using ChatGPT
strings -a <原生二进制> | grep -c apply_patch     # 74（update_plan 38、shell_command 9、view_image 21）
```

### 0.3 模型可用性（重要且必须先说）

`--realhome` 加载的真实配置里 `model = "deepseek-flash@latest"`（D-Robotics 网关）。2026-10-01
实测该模型在当前网关**不可用**：

```
⚠ Model metadata for `deepseek-flash@latest` not found …
• Reconnecting... 3/5 (5s • esc to interrupt)
■ stream disconnected before completion: 模型不存在，请检查模型代码。
[20261001013745c6ff1b1eb7354d86]
```

（`scratch/cx-turn2/s49.txt`；`-m gpt-5.4-mini` 同样报 `模型不存在`，见 `cx-turn3/p15.txt`。）

`/model` 面板列出的 7 个可选模型里，`glm-5.3-flash` 实测可用（`codex exec -m glm-5.3-flash "reply OK"`
→ `OK`，62,460 tokens），本文件的**所有真实模型回合都用 `-m glm-5.3-flash -c model_reasoning_effort="low"`**。
这是抓屏环境的事实，不是 codex 的缺陷；但对 moss 有意义：codex 在模型不可用时会**自动重连 5 次**
并把原始错误 + request id 以 `■` 行留在转录里（§10）。

### 0.4 目录信任（每次进入未信任目录都会先问）

在 `scratch/codex-ws`（moss 仓库子目录，`scratch/cx-s1/boot90.txt`）：

```
  Welcome to Codex, OpenAI's command-line coding agent

> You are in /Users/d-robotics/Desktop/RDK_Studio/moss/scratch/codex-ws

  Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository
  root: /Users/d-robotics/Desktop/RDK_Studio/moss

  Do you trust the contents of this directory? Working with untrusted contents comes with
  higher risk of prompt injection. Trusting the directory allows project-local config,
  hooks, and exec policies to load.

› 1. Yes, continue
  2. No, quit

  Press enter to continue
```

在 `/private/tmp/cx-ws`（非 git）同样弹（`scratch/cx-s1b/boot90.txt`，少了 `Note:` 两行）。
箭头键在该对话框上**可见地移动 `›`**（`scratch/cx-s6/resume-sel2.txt` 里 `› 2. No, quit`），
**Esc 直接退出**（`cx-s6` 的 harness 报 `process exited code=0` after esc）。
为避免污染真实配置，本文所有抓屏都用 `-c projects."<dir>".trust_level="trusted"` 覆盖，
**没有**在 `~/.codex/config.toml` 里写入信任条目（复核：`grep -c 'private/tmp/cx' ~/.codex/config.toml` = 0）。

---

## 1. 布局与 chrome

### 1.1 90×30 启动屏（颜色版 `scratch/cx-color1/c-boot.txt`）

```
╭──────────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.155.1)                               │
│                                                          │
│ model:     deepseek-flash@latest xhigh   /model to chan… │
│ directory: /private/tmp/cx-ws                            │
╰──────────────────────────────────────────────────────────╯

  Tip: New Build faster with the Desktop app. Run 'codex app' or visit
  https://chatgpt.com/codex?app-landing-page=true


› Ask Codex to do anything

  deepseek-flash@latest xhigh · /private/tmp/cx-ws
```

解剖（顺序即屏幕自上而下）：

| 区块     | 位置                                          | 内容 / 属性                                                                                                                                                                                               |
| -------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 横幅盒   | 顶部 5 行，**固定 60 列宽、不随终端宽度缩放** | 第 2 行 `>_ OpenAI Codex (v0.155.1)`（`OpenAI Codex` bold）；第 4 行 `model:     <模型> <effort>   /model to chan…`（模型名默认色、`/model` 高亮 `#00cdcd`、超宽用 `…` 截断）；第 5 行 `directory: <cwd>` |
| Tip 行   | 盒下空 1 行                                   | 每次启动轮换（本文件见过三种：Desktop app、`/rename`、`/personality`），2 空格缩进，`Tip:` 后 bold 关键字 + italic                                                                                        |
| 转录区   | 中间                                          | 初始为空                                                                                                                                                                                                  |
| Composer | 底部上方                                      | `› ` + dim 占位符 `Ask Codex to do anything`；**没有边框盒**（单列、`›` 前缀、续行缩进 2 空格）                                                                                                           |
| 状态行   | 最后 1 行                                     | `  <模型> <effort> · <cwd>`，2 空格缩进                                                                                                                                                                   |

### 1.2 其他宽度（`scratch/cx-csize80/cboot80.txt`、`cx-csize120/cboot120.txt`）

80×24：

```
╭──────────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.155.1)                               │
│                                                          │
│ model:     deepseek-flash@latest xhigh   /model to chan… │
│ directory: /private/tmp/cx-ws                            │
╰──────────────────────────────────────────────────────────╯

  Tip: New Build faster with the Desktop app. Run 'codex app' or visit
  https://chatgpt.com/codex?app-landing-page=true


› Ask Codex to do anything

  deepseek-flash@latest xhigh · /private/tmp/cx-ws
```

120×40：同样内容，但 Tip 折成一行 `…Run 'codex app' or visit https://chatgpt.com/codex?app-landing-page=true`。
**横幅盒在 80/90/120 列下都是 60 列宽**（`cx-size80/boot80.txt` 与 `cx-size120/boot120.txt` 对照），
即 chrome 是「定宽卡片 + 定宽状态行」，不做响应式重排；宽的只有转录区。

（早期无颜色的 `cx-size80/120`、`cx-s1c` 明文与颜色版逐字一致，可用于交叉核对。
另：`scratch/cx-csize80/cboot80.txt` 顶部还有自更新提示盒，见 §10.3。）

### 1.3 状态行与 `/statusline`、`/title` 配置

状态行 = `模型名 effort · cwd`，颜色：模型名 `#f6e2b7`、`·` 默认、cwd `#abdfa7`（`cx-color1/c-boot.style` 第 14 行）。
工作期间状态行尾部追加瞬态片段，例如 `· renaming... ⠴`（`cx-turn4/q08.txt`，braille 动画）。
进入 Plan 模式后右侧右对齐追加 `Plan mode (shift+tab to cycle)`（`cx-modes/mode1.txt`）：

```
› Ask Codex to do anything

  deepseek-flash@latest medium · /private/tmp/cx-ws       Plan mode (shift+tab to cycle)
```

**git 分支默认不出现在状态行**：在分支 `feature/parity` 的 `/private/tmp/cx-git` 里启动，
状态行仍是 `deepseek-flash@latest xhigh · /private/tmp/cx-git`（`scratch/cx-git/bootgit.txt`）。
分支是**终端标题**的可选项，而不是状态行的：

`/statusline`（`scratch/cx-menus/statusline-menu.txt`）：

```
  Configure Status Line
  Select which items to display in the status line.

  Type to search
  >
› [x] Use theme colors      Apply colors from the active /theme
  ───────────────────────
  [x] model-with-reasoning  Current model name with reasoning level
  [x] current-dir           Current working directory
  [x] thread-name           Current thread name (omitted when unnamed)
  [ ] model                 Current model name
  [ ] reasoning             Current reasoning level
  [ ] project-name          Project name (omitted when unavailable)

  deepseek-flash@latest xhigh · /private/tmp/cx-ws · thread name
  Press space to toggle; ←/→ to move; enter to confirm and close; esc to close
```

`/title`（`scratch/cx-menus/title-menu.txt`）：

```
  Configure Terminal Title
  Select which items to display in the terminal title.

  Type to search
  >
› [x] activity      Spinner while working, action-required message while blocked.
  [x] thread-name   Current thread name (omitted when unnamed)
  [x] project-name  Project name (falls back to current directory name)
  [ ] app-name      Codex app name
  [ ] current-dir   Current working directory
  [ ] run-state     Compact session run-state text (Ready, Working, Thinking)
  [ ] thread-title  Current thread title, or thread identifier when unnamed
  [ ] git-branch    Current Git branch (omitted when unavailable)

  [ ! ] Action Required | thread name | cx-ws
  Press space to toggle; ←/→ to move; enter to confirm and close; esc to close
```

两个菜单都**带实时预览行**（状态行预览在最后一屏行、标题预览在提示行上方），改动即时生效。
终端标题实际是 OSC 0：`\x1b]0;⠦ cx-ws\x07`（`scratch/cx-s2raw/raw.log`），即标题里跑 braille spinner。

`/status` 是会话配置总览（`scratch/cx-color1/c-status.txt`，命令本身以 `/status` 明文留在转录里）：

```
╭────────────────────────────────────────────────────────────────────────────────╮
│  >_ OpenAI Codex (v0.155.1)                                                    │
│                                                                                │
│  Model:                deepseek-flash@latest (reasoning xhigh, summaries auto) │
│  Model provider:       bigmodel                                                │
│  Directory:            /private/tmp/cx-ws                                      │
│  Permissions:          Workspace (Ask for approval)                            │
│  Agents.md:            ~/.codex/AGENTS.md                                      │
│  Collaboration mode:   Default                                                 │
│  Session:              01a0f377-3b7a-7341-806a-eef1c8ca9551                    │
│                                                                                │
│  Token usage:          0 total  (0 input + 0 output)                           │
│  Limits:               data not available yet                                  │
╰────────────────────────────────────────────────────────────────────────────────╯
```

**状态行里没有 token/上下文余量、没有 git 分支、没有沙箱名**；token 只在 `/status` 面板里
（且这里显示 `0 total`，因为该面板在回合前打开）。`Context left` 之类的百分比在抓到的所有屏里**未观察到**
（**not verified**：未在长会话中观察状态行是否出现上下文百分比）。

### 1.4 启动期的内联告警与转录查看器

MCP server 启动失败时，转录区（composer 上方）出现一行带快捷键提示的告警
（`scratch/cx-exit1/x1.txt`、`cx-exit3/c1.txt`，100×32 为 `cx-mcp/m0.txt` 的对照——后者本次无告警）：

```
⚠ 1 MCP startup issue · ctrl + t for details
```

按 **Ctrl+T** 在主界面打开转录查看器（与 §9.3 会话选择器里的预览器同一套骨架，
`scratch/cx-mcp/m1.txt`）：

```
/ T R A N S C R I P T / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / /
…（当前滚动缓冲的完整内容，含启动横幅与自更新通知盒）…
~
~
───────────────────────────────────────────────────────────────────────────────────────────── 100% ─
 ↑/↓ to scroll   pgup/pgdn to page   home/end to jump
 q close   esc to edit prev
```

即：**主界面里的 Ctrl+T = 「把滚动缓冲当转录读」**，与会话选择器里的 Ctrl+T 语义一致。

---

## 2. Composer / 输入编辑

Composer 是 `› ` 前缀 + dim 占位符，**无边框**。多行时首行 `› `、续行缩进 2 空格（§2.1 的
`cx-s3/multiline.txt` 与 §1.1 里 4 行换行的长提示词都可见）。

| 行为                      | 证据                                                                                        | 结果                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 光标左右移动 + 行中插入   | `cx-keys/cursor-mid.txt`：`text:abc` → `left` ×2 → `text:X`                                 | `› aXbc`                                                                                |
| Ctrl+A = 行首             | `cx-keys/ctrl-a.txt`：接上再 `ctrl-a` → `text:S`                                            | `› SaXbc`                                                                               |
| Ctrl+E = 行尾             | `cx-keys/ctrl-e.txt`：接上再 `ctrl-e` → `text:E`                                            | `› SaXbcE`                                                                              |
| Ctrl+W = 删除前一个词     | `cx-keys/ctrl-w.txt`（整串无空格，整段被删）                                                | 占位符恢复                                                                              |
| Ctrl+U                    | `cx-keys/ctrl-u.txt` 在空 composer 上按                                                     | 无变化（**not verified**，无法区分 no-op 与清空）                                       |
| Ctrl+J = 插入换行         | `cx-s3/multiline.txt`：`text:line1` → `ctrl-j` → `text:line2`                               | `› line1` / `  line2`                                                                   |
| Shift+Enter = 插入换行    | `cx-s3/shift-enter.txt`：`raw:1b0d`（ESC CR）→ `text:SHIFTENTER`                            | 第一行空、第二行 `SHIFTENTER`                                                           |
| bracketed paste（含换行） | `cx-s3/paste.txt`：`text:PASTEA` + `raw:1b5b3230307e` `PASTEB 0d PASTEC` `raw:1b5b3230317e` | `› PASTEAPASTEB` / `  PASTEC`（粘贴内的 `\r` 变真换行）                                 |
| Up = 历史召回             | `cx-s3/hist-up.txt`：空 composer 上 `up`                                                    | 召回 `~/.codex/history.jsonl` 上一条（此机为一条 `/` 开头的旧提示），**不触发斜杠弹窗** |
| Ctrl+C = 清空             | `cx-s3/after-ctrlc.txt`、`cx-s4/ctrlc1.txt`                                                 | 有文字时清空回占位符                                                                    |
| Esc = 空操作（有文字时）  | `cx-s4/esc-on-text.txt`                                                                     | 文字不变                                                                                |
| Esc = 「编辑上一条消息」  | `cx-diff/diff-after-esc.txt`（从 `/diff` 退出后）                                           | 转录出现 `• No previous message to edit.`                                               |

历史落盘格式（`~/.codex/history.jsonl`，JSONL）：

```
{"session_id":"01a0f35f-c60e-7750-8623-2d8a1c4c9085","ts":1790789550,"text":"line1\nline2"}
{"session_id":"01a0f35f-c60e-7750-8623-2d8a1c4c9085","ts":1790789552,"text":"\nSHIFTENTER"}
{"session_id":"01a0f35f-c60e-7750-8623-2d8a1c4c9085","ts":1790789555,"text":"PASTEAPASTEB\nPASTEC"}
```

**注意**：这三条是上面 paste/newline 实验的草稿，它们**从未被提交**（一次 Enter 都没按），
却被写进了全局历史 —— 观察到的事实是「未提交的草稿（在被 Ctrl+C 清空 / 会话结束时）也会进历史」；
具体写入时机（按键时 vs 清空时 vs 会话收尾）未逐一定位。
`/vim` 命令可切换 Vim 编辑模式（`cx-s2/slash-all.txt`），但本文件**未实测** vim 键位（**not verified**）。

---

## 3. 斜杠命令菜单

### 3.1 弹窗形态（`scratch/cx-color1/c-slash.txt`，颜色见 `.style` + raw）

输入 `/`：

```
› /

  /model         choose what model and reasoning effort to use
  /ide           include current selection, open files, and other context from your IDE
  /permissions   choose what Codex is allowed to do
  /keymap        remap TUI shortcuts
  /vim           toggle Vim mode for the composer
  /experimental  toggle experimental features
  /approve       approve one retry of a recent auto-review denial
  /memories      configure memory use and generation
```

- 两列排版：命令名左对齐、内边距对齐到最长命令名，其后是描述；**描述用 dim**（raw：`\x1b[2m`）。
- **一眼可见 8 条**，无滚动条、无行号、无 `[n]` 计数。
- 选中行（raw）：`\x1b[1m\x1b[38;5;6;49m/model  …`——**bold + cyan(ANSI 6)**；未选中行命令名默认色。
  （`pyte` 的 `.style` 里选中行只体现为 `B`，颜色体现为 `f00cdcd`；dim 不体现。）
- 选择状态本身没有额外 gutter 标记（与 §4 的权限菜单不同，后者有 `›`）。

### 3.2 键位

| 操作         | 命令                                | 结果                                                                                |
| ------------ | ----------------------------------- | ----------------------------------------------------------------------------------- |
| 过滤         | `scratch/cx-slashkeys/`，`text:/mo` | 只剩 `  /model  choose what model and reasoning effort to use`（单条对齐到 2 空格） |
| Tab 补全     | 同上，`key:tab`                     | 弹窗关闭，composer 变成 `› /model`                                                  |
| Enter 执行   | 同上，`key:enter`                   | 打开 `Select Model and Effort` 面板                                                 |
| ↑/↓ 移动选择 | `cx-s2/sel2`、`cx-s2b/d5…d50`       | 窗口高度 7（可见 8 行含选中行），越界后整窗滚动，到底环绕                           |
| Esc 关闭     | `cx-s2b/esc-clear`                  | 弹窗消失，composer 保留文字（Esc 不清文字）                                         |

窗口模型（由 `cx-s2b` 的 d5/d10/…/d50 与 `cx-s2c` 的 a45–a50 推出）：**选择索引 = 按下 down 的次数 mod N；
可见窗口起点 = max(0, sel−7)**。`a45` 顶行 `/mcp`（索引 38）、`a46` 顶行 `/plugins`（39）、
`a47` 顶行 `/logout`（40）、`a48` 回到 `/model`（索引 0）⇒ **N = 48**。

### 3.3 完整命令清单（48 条，逐条来自 `cx-s2b`/`cx-s2c` 的连续滚动，1:1 无缺号）

| #   | 命令            | 描述（屏幕原文）                                                       |
| --- | --------------- | ---------------------------------------------------------------------- |
| 1   | `/model`        | choose what model and reasoning effort to use                          |
| 2   | `/ide`          | include current selection, open files, and other context from your IDE |
| 3   | `/permissions`  | choose what Codex is allowed to do                                     |
| 4   | `/keymap`       | remap TUI shortcuts                                                    |
| 5   | `/vim`          | toggle Vim mode for the composer                                       |
| 6   | `/experimental` | toggle experimental features                                           |
| 7   | `/approve`      | approve one retry of a recent auto-review denial                       |
| 8   | `/memories`     | configure memory use and generation                                    |
| 9   | `/skills`       | use skills to improve how Codex performs specific tasks                |
| 10  | `/import`       | import setup, this project, and recent chats from Claude Code          |
| 11  | `/hooks`        | view and manage lifecycle hooks                                        |
| 12  | `/review`       | review my current changes and find issues                              |
| 13  | `/rename`       | rename the current thread                                              |
| 14  | `/new`          | start a new chat during a conversation                                 |
| 15  | `/archive`      | archive this session                                                   |
| 16  | `/delete`       | permanently delete this session and exit                               |
| 17  | `/resume`       | resume a saved chat                                                    |
| 18  | `/fork`         | fork the current chat                                                  |
| 19  | `/app`          | continue this session in the Desktop app                               |
| 20  | `/init`         | create an AGENTS.md file with instructions for Codex                   |
| 21  | `/compact`      | summarize conversation to prevent hitting the context limit            |
| 22  | `/recap`        | summarize the current conversation now                                 |
| 23  | `/plan`         | switch to Plan mode                                                    |
| 24  | `/goal`         | set or view the goal for a long-running task                           |
| 25  | `/agents`       | view and switch between all active agent sessions                      |
| 26  | `/side`         | start a side conversation in an ephemeral fork                         |
| 27  | `/copy`         | copy the last response or part of it                                   |
| 28  | `/export`       | export the conversation as markdown                                    |
| 29  | `/raw`          | toggle raw scrollback mode for copy-friendly terminal selection        |
| 30  | `/diff`         | show git diff (including untracked files)                              |
| 31  | `/mention`      | mention a file                                                         |
| 32  | `/status`       | show current session configuration and token usage                     |
| 33  | `/cd`           | change the current working directory                                   |
| 34  | `/pwd`          | show the current working directory                                     |
| 35  | `/title`        | configure which items appear in the terminal title                     |
| 36  | `/statusline`   | configure which items appear in the status line                        |
| 37  | `/theme`        | choose a syntax highlighting theme                                     |
| 38  | `/pets`         | choose or hide the terminal pet                                        |
| 39  | `/mcp`          | list configured MCP tools; use /mcp verbose for details                |
| 40  | `/plugins`      | browse plugins                                                         |
| 41  | `/logout`       | log out of Codex                                                       |
| 42  | `/exit`         | exit Codex                                                             |
| 43  | `/feedback`     | send logs to maintainers                                               |
| 44  | `/ps`           | list background terminals                                              |
| 45  | `/stop`         | stop all background terminals                                          |
| 46  | `/clear`        | clear the terminal and start a new chat                                |
| 47  | `/personality`  | choose a communication style for Codex                                 |
| 48  | `/subagents`    | switch between this session's subagents                                |

注意：**没有 `/help`、没有 `/quit`、没有 `/login`、没有 `/undo`**（48 条全清单里都不存在）；
退出是 `/exit`。这批清单与本机配置相关（`/skills`/`/hooks`/`/memories`/`/pets`/`/personality`
由特性开关与 config 决定），换机器可能增减。

---

## 4. 审批 / 权限

### 4.1 `/permissions` 面板（`scratch/cx-color2/p-open.txt`）

```
  Update Model Permissions

› 1. Ask for approval (current)  Codex can read and edit files in the current workspace,
                                 and run commands. Approval is required to access the
                                 internet or edit other files.
  2. Approve for me              Only ask for actions detected as potentially unsafe.
  3. Full Access                 Codex can edit files outside this workspace and access
                                 the internet without asking for approval. Exercise
                                 caution when using.

  Press enter to confirm or esc to go back
```

`›` 标记选中项（down 后移到 2，`cx-color2/p-down.txt`）；**Esc 关闭且不修改**（`cx-menus/perm-esc.txt`）。
选中项的描述续行用 `#00cdcd` bold 着色（`p-open.style` 第 16 行 `f00cdcdB`）。
`/status` 面板把同一状态显示为 `Permissions:          Workspace (Ask for approval)`。

### 4.2 CLI 旗标（`codex --help` 原文摘录）

```
  -s, --sandbox <SANDBOX_MODE>
          [possible values: read-only, workspace-write, danger-full-access]
  -a, --ask-for-approval <APPROVAL_POLICY>
          - on-request: The model decides when to ask the user for approval
          - never:      Never ask for user approval Execution failures are immediately returned to the model
      --approve-for-me                      Route approval requests through automatic review using the workspace-write sandbox
      --dangerously-bypass-approvals-and-sandbox
      --add-dir <DIR>                       Additional directories that should be writable alongside the primary workspace
      --search                              Enable live web search … (no per-call approval)
      --no-alt-screen                       Runs the TUI in inline mode, preserving terminal scrollback history.
```

**未观察到** UI 里显示沙箱名（`/status` 只显示 `Permissions:` 三档；状态行无沙箱段）；
`-s read-only` / `-s danger-full-access` 下的状态行差异**not verified**。

### 4.3 什么触发审批（实测三例）

1. **工作区内写文件不触发**（`scratch/cx-turn4/q22.txt`）：
   `• Ran printf 'codex parity probe' > /private/tmp/cx-ws/parity.txt` → `└ (no output)`，直接执行。
2. **`/private/tmp` 下的工作区外写也不触发**（`cx-turn6/f22.txt`）：
   `• Ran printf probe > /private/tmp/cx-approval-probe.txt` → `└ (no output)`。
   （默认 `workspace-write` 策略放行 TMPDIR；这与 macOS 临时目录被沙箱白名单包含一致。）
3. **网络访问触发**（`scratch/cx-turn7/h32.txt`，全文）：

```
• Running curl -s -o /dev/null -w ok https://example.com


  Would you like to run the following command?

  Environment: local

  Reason: The first attempt failed with a DNS resolution error inside the sandbox. Do
  you want to allow network access so curl can reach https://example.com?

  $ curl -s -o /dev/null -w ok https://example.com

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `curl -s -o /dev/null -w` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
```

批准（Enter 选 1）后转录出现确认行并重跑命令（`cx-turn7/i_approve.txt`）：

```
✔ You approved codex to run curl -s -o /dev/null -w ok https://example.com this time
• Ran curl -s -o /dev/null -w ok https://example.com
  └ ok
```

**关键机制（会话转录预览器里看得更清楚，`cx-replay2/v-preview.txt`）**：命令先在沙箱里跑，
失败后 codex 才升级为「申请网络访问」并重跑：

```
$ /bin/zsh -lc 'curl -s -o /dev/null -w ok https://example.com'
status: Failed · exit 6
  ok

$ /bin/zsh -lc 'curl -s -o /dev/null -w ok https://example.com'
status: Completed · exit 0
  ok
```

另：命令实际经**用户登录 shell** 执行（`/bin/zsh -lc '<cmd>'`）。

**文件编辑审批对话框：not verified。** 在默认 `Workspace (Ask for approval)` 下工作区内编辑无需批准
（§4.3 第 1 例）；改用 `-s read-only` 后，本机可用的 `glm-5.3-flash` 直接拒绝执行编辑
（`cx-turn5/e25.txt`：`• I can't comply as specified: this environment exposes neither an update_plan tool
nor an apply_patch tool …`），因此没有抓到「编辑确认」对话框的原文、`+/-` 预览或 approve-all 选项。
这条必须由实现方以别的方式验证或在 moss 中自行设计。

---

## 5. Plan / Todo

### 5.1 Plan 模式（已实测）

Shift+Tab 循环 Default ↔ Plan（`scratch/cx-modes/mode0…mode4.txt`），每次切换都在转录里留一行：

```
• Model changed to deepseek-flash@latest medium for Plan mode.
```

同时状态行右侧出现 `Plan mode (shift+tab to cycle)`，且**模型名从 xhigh 变 medium**（Plan 模式自带
较低 reasoning effort）。`/plan` 命令等价（`cx-menus/plan-on.txt`）。
**不一致点**：横幅盒仍显示启动时的 `deepseek-flash@latest xhigh`，状态行显示 `medium`——
两处会打架（`cx-menus/plan-on.txt` 第 4 行 vs 第 16 行）。

### 5.2 工作期 checklist / todo 列表：**not verified**

三次回合（`cx-turn4`、`cx-turn5`、`cx-turn8`）都明确要求「先用 update_plan 计划 N 步」，
**没有一次**出现任何 checklist/todo 渲染：转录里只有 `• Working (Ns • esc to interrupt)`、
`• Ran …` 和最终答案（见 §6）。其中一次模型还明确声称工具集里没有 plan 工具（§4.3）。

旁证（非 UI，但说明工具确实存在于二进制）：

```bash
strings -a <codex 原生二进制> | grep -c update_plan   # 38
/opt/homebrew/bin/codex features list | grep goals    # goals  stable  true
/opt/homebrew/bin/codex features list | grep apply_patch
# apply_patch_freeform            removed            false
# apply_patch_preserve_line_endings under development false
```

⇒ **结论：codex 有 `/plan` 协作模式与 `goals` 特性，但本次没有取得「工作期实时 checklist」的屏幕证据。**
moss 需要 checklist 时不能引用本文件作为 codex 已在做的依据；应把它当作 codex-only 的**待确认**项。

---

## 6. 工具 / 命令执行渲染与 diff

### 6.1 实时转录里的命令调用（`scratch/cx-turn4/s08.txt`）

```
• Ran echo CODEX_PROBE
  └ CODEX_PROBE

• Ran printf 'codex parity probe' > /private/tmp/cx-ws/parity.txt
  └ (no output)

• Done

  - echo CODEX_PROBE exited 0 and printed CODEX_PROBE.
  - parity.txt created in /private/tmp/cx-ws with exactly codex parity probe.

  done 1:44 AM
```

- 工具调用 = `• Ran <命令原文>`（单行、原样、不换行截断到组内），**输出 = 下一行缩进 2 空格的
  `└ ` 前缀**；无输出时字面写 `(no output)`。
- 助手文字与工具调用共用 `• ` 起始符；助手多行内容续行缩进 2 空格；因此**工具调用和助手段落混排在同一列**，
  没有面板/边框，靠 `•`/`└` 区分。
- 命令原文带**语法高亮**，逐段来自 raw（`cx-replay3/raw.log` 的 `• Ran curl …` 一帧）：
  `Ran` 与 bullet 用 `\x1b[1m`，`curl` 命令名 `\x1b[38;2;137;180;250;49m`（#89b4fa），
  ` -` 分隔符 `\x1b[38;2;147;153;178;49m`（#9399b2），flag 字母 `s`/`o`/`w`
  `\x1b[38;2;235;160;172;49m`（#eba0ac），路径与参数值 `\x1b[38;2;205;214;244;49m`（#cdd6f4）。
- **输出行是 dim**：raw 为 `\x1b[2m  └ ok`（`cx-replay3/raw.log`），即 `└` 行整体用 SGR 2
  （pyte 不建模，因此 `.style` 里看不出来）；助手正文里的 `•` 起始符同样是 dim，正文恢复默认。
- **bullet 颜色编码退出码**（`cx-replay3/raw.log` + `w-replay2.style`）：成功 `•` =
  `\x1b[38;5;2;49m`（pyte `#00cd00`）+ bold；失败（curl 沙箱 DNS 失败那次）=
  `\x1b[38;5;1;49m`（pyte `#cd0000`）+ bold。一眼可辨成败。
- 回合结束标记：`done 1:44 AM`（本地时间）；有耗时则 `Worked for 1m 7s · done 1:53 AM`
  （`cx-turn7/i11.txt`）。两者都在答案之后、空一行。
- 工作态：`◦ Working (4s • esc to interrupt)`，bullet 在 `◦`/`•` 间脉动、秒数递增、附 `esc to interrupt`
  提示（`cx-turn4/q04.txt`、`q12.txt`、`q22.txt`）；状态行同时出现 `· renaming... ⠴`。
- `⚠` 行（黄色 `#cdcd00`）用于非致命警告：`⚠ Skill descriptions were shortened to fit the skills context
budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or
plugins to leave more room for the rest.`（`cx-turn4/q08.txt`）。

**长输出折叠/展开：not verified**（本文件所有命令输出都很短；未观察到 `… +N lines` 之类的折叠标记）。

### 6.2 `/diff` 全屏分页器（`scratch/cx-diff4/d4.txt`）

```
/ D I F F / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / /

diff --git a/README.md b/README.md
index 85c3040..acf1aab 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,3 @@
 alpha
-beta
 gamma
+delta
diff --git a/untracked.txt b/untracked.txt
new file mode 100644
index 0000000..fa49b07
--- /dev/null
+++ b/untracked.txt
@@ -0,0 +1 @@
+new file
~
~
~
~
~
~
~
~
~
~
~
───────────────────────────────────────────────────────────────────────────────────────────── 100% ─
 ↑/↓ to scroll   pgup/pgdn to page   home/end to jump
 q close
```

- 顶部是**标题横幅** `/ D I F F / / / …`（同款也用于 `TRANSCRIPT`，见 §9.3）。
- 内容是原始 `git diff`（**包含未跟踪文件**，描述里也这么写），空行用 `~` 填充。
- 颜色（raw，`cx-diff4/raw.log`）：`-` 行 `\x1b[38;5;1;49m`（pyte `#cd0000`）、`+` 行
  `\x1b[38;5;2;49m`（`#00cd00`）、`@@` hunk 头 `\x1b[38;5;6;49m`（`#00cdcd`）、
  `diff --git`/`index`/`---`/`+++` 用 `\x1b[1m` **bold 无颜色**、上下文行 `\x1b[39;49m` 默认色。
- 底栏：进度条 `… 100% ─` + 键位提示 `↑/↓ to scroll  pgup/pgdn to page  home/end to jump` / `q close`。
- **没有行号列**（+/- 直接贴行首）。退出后转录出现 `• No previous message to edit.`（Esc 绑定「编辑上一条」）。

**apply_patch/文件编辑在转录里的 diff 渲染：not verified**（同上，未拿到编辑回合）。

---

## 7. 流式与 markdown

**流式（实测）**：同一回合按 4 秒间隔抓屏，答案逐步长出（`scratch/cx-turn8/`）：

```
k16（16s）:  • Bold / Italic / # Heading
k20（20s）:  • Bold / Italic / # Heading / - Item one / - Item two / done 1:55 AM
```

即 token 到达即渲染、未整段等待。工具调用同理逐步追加（`cx-turn4/q12.txt` 出现第一条 `• Ran`，
`q22.txt` 才出现第二条）。

**markdown 渲染（`scratch/cx-turn8/k46.txt` 明文 + `k46.style` 属性）**：

```
• Bold

  Italic

  # Heading

  - Item one
  - Item two

  done 1:55 AM
```

| 源 markdown  | 屏幕结果                            | 属性（`.style`）               |
| ------------ | ----------------------------------- | ------------------------------ |
| `**Bold**`   | `• Bold`（助手起始 bullet + 文本）  | bullet 默认、`Bold` = **bold** |
| `*Italic*`   | `Italic`                            | **italic**                     |
| `# Heading`  | `# Heading`（**保留 `#` 字面量**）  | 整行 **bold + underline**      |
| `- Item one` | `- Item one`（**保留 `-` 字面量**） | 默认色，无缩进/无项目符号替换  |
| 内联 code    | 例如 §6.1 的 `ok`、`-w`             | `\x1b[38;5;6;49m`（`#00cdcd`） |
| 段落分隔     | 空行                                | 空行                           |

**代码围栏：not verified** —— 该回合模型没有输出 fenced code block（提示里要求了，回答里没有），
所以「代码块如何渲染（是否有语言标签、是否加边框/背景）」没有屏幕证据。

---

## 8. 中断 / 退出语义

| 按键   | 场景                         | 结果                                                                                                                                                  | 证据                                                                                              |
| ------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Ctrl+C | composer 有文字              | 清空文本，回到占位符，**不退出**                                                                                                                      | `cx-s4/ctrlc1.txt`                                                                                |
| Ctrl+C | composer 空、有挂起活动      | **第一次按键被吞**（无任何可见变化/或让内联告警重绘）；第二次才退出                                                                                   | `cx-exit3/c1.txt`（仍是 `› Ask Codex to do anything`）→ `cx-exit3/c2.txt`（`› Shutting down...`） |
| Ctrl+C | composer 空、无挂起活动      | 单次按键即退出：最后一行变 `› Shutting down...`                                                                                                       | `cx-s5/ctrlc-empty1.txt` + harness `process exited code=0`（`cx-s4`）                             |
| Ctrl+D | composer 空                  | `› Shutting down...`，**exit 0**（4s 内）                                                                                                             | `cx-s5d/ctrld1.txt`、`cx-exit2/y1.txt` + harness `process exited code=0`                          |
| Esc    | composer 有文字              | 空操作（文字保留）                                                                                                                                    | `cx-s4/esc-on-text.txt`                                                                           |
| Esc    | 回合进行中                   | 中断回合，转录留下 `■ Conversation interrupted - tell the model what to do differently. Something went wrong? Hit \`/feedback\` to report the issue.` | `cx-color1/c-status.txt` 上半屏                                                                   |
| Esc    | 覆盖层（菜单/选择器/分页器） | 关闭回到 composer；空 composer 下再 Esc 得到 `• No previous message to edit.`                                                                         | `cx-menus/perm-esc.txt`、`cx-diff/diff-after-esc.txt`                                             |
| Esc    | 目录信任对话框               | 直接退出进程（exit 0）                                                                                                                                | `cx-s6`（esc 后 harness 报 exit 0）                                                               |
| Ctrl+T | 主界面                       | 打开 `/ T R A N S C R I P T /` 查看器（滚动缓冲可读、`q close`）                                                                                      | `cx-mcp/m1.txt`                                                                                   |
| q      | `/diff`、转录预览器          | 关闭分页器                                                                                                                                            | `cx-diff4/d4.txt` 底栏 `q close`                                                                  |

**退出时序的确定性有限**：`› Shutting down...` 出现后进程不一定立刻消失——`cx-exit2`（Ctrl+D）
在 4s 内 `exit 0`，而 `cx-exit3` 在 `Shutting down...` 之后 3s 仍停在屏上（harness 未报退出）。
引用「退出码 0」时请以 `cx-s4`/`cx-exit2` 那两次为准。

中断**不会**清掉转录：被中断的提示词与已完成工具调用仍留在转录里（`cx-color1/c-status.txt` 可见
`› //permissions` 与 `■ Conversation interrupted` 并存）。
「Working 行里写着 `esc to interrupt`」，但 `esc` 中断时状态行与 `■` 行的组合已经抓到（同上）。

---

## 9. 会话生命周期

### 9.1 磁盘布局（实测）

```
~/.codex/sessions/2026/10/01/rollout-2026-10-01T01-52-11-01a0f372-054e-7662-a35a-98a78229d61e.jsonl
{"timestamp":"2026-09-30T17:52:23.996Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a0f372-…",
 "cwd":"/private/tmp/cx-ws","runtime_workspace_roots":["/private/tmp/cx-ws"],"originator":"codex-tui",
 "cli_version":"0.155.1","source":"cli","thread_source":"user","model_provider":"bigmodel",
 "base_instructions":{"text":"","provenance":{"type":"model","model":"glm-5.3-flash"}},
 "history_mode":"paginated","context_window":{"window_id":"01a0f372-…"}}}
{"timestamp":"…","ordinal":1,"type":"event_msg","payload":{"type":"task_started", …}}
```

即：会话 = 按日期分目录的 JSONL rollout，首行 `session_meta`（含 cwd、cli 版本、provider、模型、
history_mode、context_window），随后是 `event_msg` 事件流。另外
`~/.codex/session_index.jsonl`、`state_5.sqlite`、`thread_history_1.sqlite` 也是会话状态的一部分。
`~/.codex/history.jsonl` 是纯输入历史（`{session_id,ts,text}`，见 §2）。

### 9.2 会话选择器（`codex resume`，`scratch/cx-replay2/v-sel.txt`）

```
 Resume a previous session

 Type to search          Filter: [Cwd] All    Status: [Active] Archived    Sort: [Updated] Created

    //permissions
    2m ago          no branch

    Step A: call the update_plan tool to record two steps: draft answer, verify answer. Step B:...
    5m ago          no branch

  ❯ Run this shell command exactly: curl -s -o /dev/null -w ok https://example.com
    7m ago          no branch
…
───────────────────────────────────────────────────────────────────────────────────── 3 / 8 · 100% ─
 enter resume   ctrl+a archive   esc new   ctrl+c quit   tab focus   ←/→ option
 ctrl+o dense   ctrl+t preview   ctrl+e exp   ↑/↓ browse
```

- 每项 = **首条用户提示词（截断）+ 相对时间 + 分支**（此工作区非 git ⇒ `no branch`，italic）。
- 顶部一行是搜索/过滤/排序：`Type to search` + `Filter:`/`Status:`/`Sort:` 三组选项，
  当前值用 `#cd00cd` 高亮（`[]` 里的是当前值），Tab 聚焦、←/→ 改选项（`cx-s6c/r-filter.txt`：
  `Filter: [Cwd] All    Status:  Active [Archived]   Sort: [Updated] Created`）。
- 选中项 `❯` + `#cdcd00` bold（`v-sel.style` 第 11–12 行）。
- 底部 `N / M · 100%` 进度 + 两行键位：`enter resume`（在 All 过滤器下变 `enter restore`）、
  `ctrl+a archive`、**`esc new`（Esc 直接开新会话）**、`ctrl+c quit`、`tab focus`、`ctrl+o comfy/dense`、
  `ctrl+t preview`、`ctrl+e exp`（展开）、`↑/↓ browse`。
- 空态（`cx-s6b/resume-picker.txt`）：`No sessions yet` + `0 / 0 · 100%`，`esc new`。
- `ctrl+o` 的 comfy/dense **会持久化**到 `~/.codex/config.toml` 的 `[tui] session_picker_view`
  （本次抓屏副作用，见 §B 说明）。
- `codex resume --help`：`--last`（不弹选择器直接续最近）、`--all`（取消 cwd 过滤并显示 CWD 列）、
  `--include-non-interactive`、可选 `[SESSION_ID]`（UUID 或会话名，UUID 优先）。

### 9.3 `ctrl+t` 转录预览器（`scratch/cx-replay2/v-preview.txt`）

```
/ T R A N S C R I P T / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / / /

› Run this shell command exactly: curl -s -o /dev/null -w ok https://example.com


$ /bin/zsh -lc 'curl -s -o /dev/null -w ok https://example.com'
status: Completed · exit 0
  ok

• Command executed exactly as requested:
…
~
~
~
───────────────────────────────────────────────────────────────────────────────────── 100% ─
 ↑/↓ to scroll   pgup/pgdn to page   home/end to jump
 q close   esc to edit prev
```

预览器与 `/diff` 共用横幅/分页器骨架；转录里用户消息用 `›`、助手/tool 用 `•`、
shell 调用用 `$ <shell> -lc '<cmd>'` + `status: Completed · exit 0`。

### 9.4 会话相关命令与线程名

- `/new`（会话中开新会话）、`/clear`（清屏 + 新会话）、`/resume`、`/fork`、`/rename`、`/archive`、
  `/delete`（永久删除并退出）、`/export`（导出 markdown）、`/copy`、`/compact`、`/recap`、`/status`
  （显示 `Session: <uuid>`）、`/cd`、`/pwd`（§3.3 全清单原文）。
- 线程名出现在状态行（`/statusline` 的 `thread-name` 默认开；预览行
  `deepseek-flash@latest xhigh · /private/tmp/cx-ws · thread name`）。
- `/rename` 会被 Tip 行推荐（`Tip: Use /rename to rename your threads for easier thread resuming.`）。
- 恢复会话后转录**完整重放**（含彩色 bullet 与耗时标记，`cx-replay3/w-replay2.txt`），可直接继续对话。

---

## 10. 错误、重试、自更新（附加，但对 moss 有参考价值）

### 10.1 模型/流错误

```
⚠ Model metadata for `deepseek-flash@latest` not found. Defaulting to fallback metadata; this can …
• Reconnecting... 3/5 (5s • esc to interrupt)
■ stream disconnected before completion: 模型不存在，请检查模型代码。
[20261001013745c6ff1b1eb7354d86]
```

（`scratch/cx-turn2/p05.txt`、`p10.txt`、`p49.txt`；`-m gpt-5.4-mini` 同类，`cx-turn3/p15.txt`。）
要点：**自动重连带计数与倒计时**（`Reconnecting... 3/5 (5s • esc to interrupt)`，bullet 在 `•`/`◦` 间脉动）、
原始错误原样保留（含中文 provider 文案）、附 **request id** 便于反馈。

### 10.2 中断与审批有关的两条状态行

- 中断：`■ Conversation interrupted - tell the model what to do differently. Something went wrong? Hit \`/feedback\` to report the issue.`
- 审批确认：`✔ You approved codex to run <cmd> this time`

### 10.3 启动自更新提示（`scratch/cx-replay/plist.txt`、`cx-csize80/cboot80.txt`）

模态版本（启动时先于 TUI，`/` 选择器样式）：

```
  ✨ Update available! 0.155.1 -> 0.159.2

  Release notes: https://github.com/openai/codex/releases/latest

› 1. Update now (runs `npm install -g @openai/codex`)
  2. Skip
  3. Skip until next version

  Press enter to continue
```

跳过之后，转录里留下一条常驻横幅盒：

```
╭─────────────────────────────────────────────────╮
│ ✨ Update available! 0.155.1 -> 0.159.2         │
│ Run npm install -g @openai/codex to update.     │
│                                                 │
│ See full release notes:                         │
│ https://github.com/openai/codex/releases/latest │
╰─────────────────────────────────────────────────╯
```

**默认选项是「Update now」**（会真的执行 `npm install -g @openai/codex`）——这是一个危险默认值：
无人值守的 PTY 脚本一个 Enter 就可能升级全局 CLI。（本次抓屏用 `down` 选 Skip，未升级。）

---

## 11. codex-only ideas worth stealing（Claude Code 没有的）

1. **工具调用 bullet 用颜色编码退出码**：成功 `#00cd00`、失败 `#cd0000`，一个字符就能扫成败（§6.1）。
2. **审批确认行**：`✔ You approved codex to run <cmd> this time` 把「谁批准了什么」写进转录，
   天然是审计记录（§4.3）。
3. **沙箱失败 → 自动升级为审批请求**：命令先在沙箱跑，失败后带着原因（含原始 exit code）
   再问一次网络/写权限，而不是直接硬失败（§4.3、§6.1）。
4. **审批选项 2 = 前缀级持久允许**：`Yes, and don't ask again for commands that start with \`curl -s -o /dev/null -w\` (p)`
   —— 允许条目按命令前缀生成，而不是全工具级 allowlist（§4.3）。
5. **自动重连计数器**：`• Reconnecting... 3/5 (5s • esc to interrupt)`，带倒计时且可打断（§10.1）。
6. **配置化状态行 + 终端标题**：`/statusline`、`/title` 逐项开关、带实时预览；终端标题里跑 spinner，
   连分支都能进标题（§1.3）。
7. **会话选择器**：首条提示词 + 相对时间 + 分支、comfy/dense 双密度、`ctrl+t` 全转录预览、
   `esc new`、`ctrl+a archive`（§9.2/9.3）。
8. **启动时的目录信任对话框**：明说 prompt injection 风险、说明「信任会作用于仓库根」、
   `1. Yes, continue / 2. No, quit`（§0.4）。
9. **Plan 模式自动降 reasoning effort 并在转录里公告**：`• Model changed to <model> medium for Plan mode.`（§5.1）。
10. **`/diff` 全屏分页器**：含未跟踪文件、`+/-/@@` 三色、`100%` 进度、`q close`（§6.2）。
11. **`/import`**：从 Claude Code 导入 setup、项目与最近会话（§3.3）——迁移友好型设计。
12. **`/raw` 与 `--no-alt-screen`**：为「复制友好」的滚动缓冲提供一等公民开关（§3.3、§4.2）。
13. **`done 1:44 AM` / `Worked for 1m 7s · done 1:53 AM`**：回合结束带本地时间与耗时（§6.1）。
14. **`/ps` + `/stop`** 后台终端管理、**`/side`（临时 fork 的旁路对话）**、**`/subagents`**、
    **`/agents`**、**`/goal`**：多 agent / 长任务的表面入口（§3.3）。
15. **`/personality`、`/pets`、`/theme`、`/vim`、`/keymap`、`/experimental`、`/memories`、`/skills`、
    `/hooks`、`/plugins`、`/mcp`、`/feedback`**：把「外壳性格」「宠物」「键位重映射」「特性开关」
    都做成会话内命令（§3.3）。
16. **启动自更新提示 + 常驻转录横幅**（危险默认值，但提醒本身是好设计；moss 若要抄，应把默认设为 Skip）（§10.3）。
17. **内联健康告警带快捷键**：`⚠ 1 MCP startup issue · ctrl + t for details`——把 MCP/插件启动失败做成
    转录区里一行可操作的告警，而不是塞进日志；`ctrl+t` 直接在原地打开可滚动的转录/详情查看器（§1.4）。
18. **主界面 Ctrl+T = 转录查看器**：同一套 `/ T R A N S C R I P T /` 分页器在主界面与会话选择器里复用（§1.4/§9.3）。

---

## A. moss MUST 清单（可测试）

每条都能用「跑 moss CLI、按键、看屏幕」直接判定通过/失败。带 **(codex 证据)** 的条目有 §0–§10 的 dump 支撑；
标 **(design)** 的是从 codex 观察到但 moss 需自定义取舍的项。

**启动与 chrome**

1. moss MUST 在 TTY 启动时先画一个**定宽能力卡片**：产品名 + 版本、当前模型 + reasoning effort、
   当前工作目录；卡片宽度不随终端宽度变化，超宽字段用 `…` 截断。(codex 证据 §1.1/§1.2)
2. moss MUST 在卡片与 composer 之间放一行可轮换的 Tip，且 Tip 中的关键词有强调样式。(§1.1)
3. moss MUST 的 composer 保持单列 `› ` 前缀形态：无边框、多行时续行缩进 2 空格、占位符为 dim。(§1.1/§2)
4. moss MUST 在底部保留一行状态行，至少显示 `模型 + effort · cwd`，且模型名/cwd 用不同颜色区分。(§1.3)
5. moss MUST 在状态行右侧右对齐显示当前交互模式（如 `Plan mode (shift+tab to cycle)`），
   且模式名与左侧信息不互相覆盖。(§1.3/§5.1)
6. moss MUST 提供状态行与终端标题的**逐项配置命令**，带实时预览、Tab/←→/space/enter/esc 键位说明。(§1.3)
7. moss MUST 让「上下文剩余/token」至少有**一个稳定去处**（codex 放 `/status` 面板）；不得只有状态行
   一个未经验证的位置。(§1.3)
8. moss MUST 在终端标题里显示活动指示（spinner/状态），且可关闭。(§1.3)
9. moss MUST 在进入未信任目录时先问信任，并明说风险与作用范围；`1 Yes / 2 No` 两项、Esc 退出。(§0.4)

**输入编辑**

10. moss MUST 支持 Ctrl+J 与 Shift+Enter 插入换行（不提交）。(§2)
11. moss MUST 正确处理 bracketed paste 中的换行，保留为多行而不提交。(§2)
12. moss MUST 支持 ↑ 召回输入历史，且历史落盘为可审计的 JSONL（含 session id 与时间戳）。(§2)
13. moss MUST 支持 Ctrl+A/Ctrl+E/Ctrl+W 与左右光标移动、行中插入。(§2)
14. moss MUST 在 Ctrl+C 时「有文字先清空、空文本才退出」，退出前给出可见提示行（如 `Shutting down...`）。(§8)
15. moss MUST 支持 Ctrl+D 在空 composer 退出，且退出码为 0。(§8)

**斜杠命令**

16. moss MUST 在输入 `/` 时弹出**两列**命令菜单（命令 + 描述），一次可见约 8 条，超出滚动。(§3.1)
17. moss MUST 对选中行给出**可见高亮**（codex：bold + cyan；moss 至少有 bold 或反显）。(§3.1)
18. moss MUST 支持在菜单中打字过滤（`/mo` → 只剩匹配项）与 Tab 补全命令名到 composer。(§3.2)
19. moss MUST 支持 ↑/↓ 在菜单内移动选择并在边界滚动/环绕，Esc 关闭菜单但不清除已输入文字。(§3.2)
20. moss MUST 的命令清单覆盖：模型、权限、状态、状态行/标题、diff、会话（new/resume/fork/rename/
    archive/delete/clear）、压缩（compact/recap）、导出/复制、退出。(§3.3 对照 48 条)
21. moss MUST 说明自己是否提供 `/init`（生成项目指令文件）、`/review`、`/mention`、`/import` 等等价物；
    缺哪个都要在 help 里显式标注为不支持。(§3.3)

**审批与安全**

22. moss MUST 在 TTY 提供三级权限档（ask / auto / full），每档带**逐条描述**和当前值标记。(§4.1)
23. moss MUST 在 `/status`（或等价面板）里回显当前权限档，措辞与权限菜单一致。(§1.3/§4.1)
24. moss MUST 让审批对话框包含：`Would you like to run the following command?`、环境、
    **理由（reason）**、`$ <命令原文>`、三个选项（proceed / 前缀记住 / 拒绝并说明）。(§4.3)
25. moss MUST 支持「按命令前缀记住」的持久允许条目，并在 UI 里展示该前缀。(§4.3)
26. moss MUST 在批准后往转录写一条可审计确认行（codex：`✔ You approved … this time`）。(§4.3)
27. moss MUST 在沙箱拒绝/失败时**先失败后升级**：把原始失败（含 exit code）展示出来，再请求提权。(§4.3)
28. moss MUST 明确审批对话框的键盘快捷键（codex：`(y)`/`(p)`/`(esc)`，底部 `Press enter to confirm
or esc to cancel`）。(§4.3)
29. moss MUST **不需要**审批的路径也要可验证（工作区内读写、TMPDIR）——避免无意义弹窗刷屏。(§4.3)
30. moss MUST 把文件编辑审批的预览（+/- 行、范围）做成可测的需求；codex 侧未取得证据，
    moss 需自行定义并加 PTY 测试。(§4.3 not verified)

**执行渲染**

31. moss MUST 用统一前缀渲染工具调用（codex：`• Ran <cmd>`）并在下一行以 `└ ` 前缀渲染输出，
    无输出时写显式占位（如 `(no output)`）。(§6.1)
32. moss MUST 用颜色区分工具调用成败（成功绿、失败红）。(§6.1)
33. moss MUST 在工作期显示 `Working (Ns • esc to interrupt)` 形态的活动行（含秒数 + 可打断提示）。(§6.1)
34. moss MUST 在回合结束给出行标记（本地时间；有时长则带 `Worked for …`）。(§6.1)
35. moss MUST 对命令原文做语法高亮（至少区分命令名与参数）。(§6.1)
36. moss MUST 让转录里助手段落与工具调用**共用同一列**、靠前缀区分，不做面板/边框。(§6.1)
37. moss MUST 定义长输出的截断/折叠规则并在 UI 上标出（codex 未验证；moss 必须自己可测）。(§6.1)
38. moss MUST 提供全屏 diff 分页器：标题横幅、`+`绿/`-`红/`@@`强调、含未跟踪文件、
    `100%` 进度、`q close`、滚动键位提示。(§6.2)
39. moss MUST 在分页器里不为 diff 行加行号（或显式决定加并测试）。(§6.2)

**流式与 markdown**

40. moss MUST 边到边渲染流式文本（不需要整段等待）。(§7)
41. moss MUST 渲染 `**bold**` 为 bold、`*italic*` 为 italic、内联 `code` 为强调色。(§7)
42. moss MUST 明确并测试标题与列表的渲染策略（codex 保留 `#`/`-` 字面量、标题加粗下划线）；
    moss 要么一致，要么在 spec 里写清差异。(§7)
43. moss MUST 有 fenced code block 的渲染规格与 PTY 断言（codex 本次未取得证据）。(§7 not verified)

**中断与会话**

44. moss MUST 让 Esc 在回合进行中中断，并在转录留下**固定措辞**的中断说明行。(§8)
45. moss MUST 让中断**不清空**已产生的转录（提示词与已完成工具调用保留）。(§8)
46. moss MUST 提供会话选择器：相对时间 + 首条提示词 + 分支；`enter resume`/`esc new`/`ctrl+t preview`
    等键位写在底部。(§9.2)
47. moss MUST 为选择器提供搜索、过滤（cwd/all）、状态（active/archived）、排序（updated/created）。(§9.2)
48. moss MUST 提供全转录预览器（标题横幅 + 分页 + `q close`）。(§9.3)
49. moss MUST 把会话按可审计的 JSONL 落盘，首条含 cwd、CLI 版本、provider、模型、history_mode。(§9.1)
50. moss MUST 支持 `resume` 的「直接续最近」与「列全部会话」两种入口。(§9.2)
51. moss MUST 支持会话内 `/new`、`/clear`、`/rename`（线程名进状态行）、`/export`。(§9.4)
52. moss MUST 恢复会话时重放完整转录（含颜色与耗时标记）。(§9.4)

**错误路径**

53. moss MUST 对 provider 失败展示原始错误 + request id，并提供可打断的重试倒计时。(§10.1)
54. moss MUST 把非致命警告渲染为独立 `⚠` 行（黄色）而不是混进助手正文，并在适用时附**可操作的快捷键**
    （codex：`⚠ 1 MCP startup issue · ctrl + t for details`）。(§1.4/§6.1)
55. moss MUST 提供主界面内打开转录/滚动缓冲的查看器（codex：Ctrl+T），且与会话选择器里的预览器同骨架。(§1.4)
56. moss MUST 若有自更新提示，**默认值不得是「立即安装」**（codex 的默认是危险默认）。(§10.3 design)

---

## B. 显式未验证（not verified）清单

以下条目在本次抓屏里**没有**取得证据，引用本文件时不得当作已确认事实：

1. 工作期实时 checklist / todo 列表的渲染（`update_plan` 工具三次未被调用；§5.2）。
2. 文件**编辑**审批对话框的原文、+/- 预览与「记住」选项（§4.3）。
3. `apply_patch`/文件编辑在转录里的 diff 渲染（§6.2）。
4. 长输出的截断/折叠/展开行为（未产生长输出；§6.1）。
5. fenced code block 的渲染（模型未按要求输出；§7）。
6. 上下文/token 余量是否出现在状态行（只在 `/status` 面板见到 `Token usage` 与 `Limits`）。
7. 单会话内 `resize` 的重排行为：本次各尺寸用**独立会话**抓，`resize` 抓屏（早期 `cx-s1`）
   受 pyte 限制画面残留，不作为结论。
8. `-s read-only` / `-s workspace-write` / `-s danger-full-access` / `-a never` /
   `--dangerously-bypass-approvals-and-sandbox` 在 UI 上的差异（只从 `--help` 文本确认旗标存在）。
9. `/model` 面板里 reasoning effort 的子选择（只抓到了模型列表本身）。
10. `/vim` 模式的键位；`/keymap`、`/experimental`、`/ide`、`/import`、`/side`、`/agents`、
    `/subagents`、`/pets`、`/theme`、`/compact`、`/recap` 的具体界面。
11. `Ctrl+U`、`Ctrl+R`（历史搜索）、`Alt+←/→`（词跳转）、kitty 键盘协议下的 Shift+Enter 编码。
12. 未做「模型回合」验证的菜单：`/hooks`、`/skills`、`/plugins`、`/mcp`、`/review`、`/init`、`/goal`。
13. 状态行是否显示 git 分支的**可配置性**：本机 `git-branch` 只出现在 `/title` 项里，
    `/statusline` 的可视 8 项里没有分支（列表可滚动，未逐项翻到底）。
14. Ctrl+C 在空 composer 上「何时需要按两次」的**精确状态机**：观察到有挂起活动时首键被吞
    （`cx-exit3`），无活动时单键即退（`cx-s5`）；触发条件未穷举。
15. `› Shutting down...` 之后进程消失的耗时（一次 4s 内 exit 0，一次 3s 仍在屏上）；退出码只在
    两次成功退出的抓屏里确认为 0。

**抓屏副作用（如实记录）**：`--realhome` 会让 codex 写真实状态：
`~/.codex/history.jsonl` 增加了本次实验的草稿条目；`~/.codex/config.toml` 增加了
omx 插件的 `hooks.state` 信任哈希，以及 `[tui] session_picker_view = "comfortable"`
（由选择器里的 `ctrl+o` 触发）。**没有**写信任条目、没有升级 codex、没有让 codex 触碰 moss 仓库
（所有回合都在 `/private/tmp/cx-ws`、`/private/tmp/cx-git`、`scratch/codex-ws` 里跑）。
`/private/tmp/cx-ws/parity.txt`、`/private/tmp/cx-ws/note.txt` 等是抓屏产物，可随时删除。
