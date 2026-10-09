# Moss TUI 对齐 Claude Code：参考实现分析与 v0.30 规划

> 日期：2026-10-08。状态：规划 + 第一批已落地改动（见 §6）。
> 前置文档：`2026-10-08-tui-cc-feel.md`（v1）、`2026-10-08-tui-cc-feel-v2.md`（v2，本文承接其 Phase 4 之后）。

## 0. TL;DR

- **Claude Code 没有公开源码。** 官方仓库 `anthropics/claude-code` 只有插件、示例、`CHANGELOG.md`；npm 包是压缩产物；网络流传的"泄露源码"有版权问题，**不使用**。
- 因此参考实现取 **Google `gemini-cli`**（Apache-2.0，TypeScript + Ink + React，和 moss 同栈），克隆在 `../ref-gemini-cli`；Claude Code 的行为基线取 `../ref-claude-code-official/CHANGELOG.md`（逐条真实行为/缺陷史）加上 moss 自己已有的 `docs/cli-parity/claude-code-surface.md`（103 条 MUST）。两个克隆都在仓库之外，不入库。
- 结论：moss 的渲染骨架（Ink + 单列 transcript + 全屏视口）方向正确，差距集中在 **滚动模型、布局预算、思考/工具的呈现、按键与主题的可配置性、验证体系** 五处。本文给出 v0.30 的 8 个阶段、每阶段可机检的验收标准。
- 本次已先落地了 6 项低风险高收益改动并用 PTY 探针验证（§6）。

## 1. 参考实现分析（gemini-cli）

只读结构，不拷贝代码。路径均相对 `ref-gemini-cli/packages/cli/src/ui/`。

| 主题     | gemini-cli 做法                                                                                                                                                  | moss 现状                                                                                    | 可借鉴点                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 渲染底座 | 依赖 **fork 的 Ink**（`@jrichman/ink`：`ResizeObserver`、`StaticRender`、`overflowToBackbuffer`），能测量元素高度                                                | 原版 `ink@7`；高度全靠手算（`layout.ts`）                                                    | 不 fork；把"手算高度"收敛成一个函数并加不变量校验（P0）                 |
| 长列表   | `components/shared/VirtualizedList.tsx`：按**条目**滚动，锚点 = `(index, offsetInItem)`，`SCROLL_TO_ITEM_END` + `isStickingToBottom`；新内容在底部追加时视图不动 | `viewport.ts`：整段 transcript 投影成视觉行，用"距底部行数"滚动（本次已修复追加漂移，见 §6） | 条目锚点 + 逐条目高度缓存，避免每帧重投影全部行（P1）                   |
| 截断     | `shared/MaxSizedBox.tsx`：内容感知截断，`overflowDirection`，通过 `OverflowContext` 告知页脚"有内容被折叠，按键展开"                                             | `transcript.ts` 中零散的 `PREVIEW_LINES` 常量 + `… N lines · ctrl+o`                         | 统一截断组件与"是否有折叠内容"全局信号，页脚据此提示（P3）              |
| 工具展示 | `messages/ToolGroupMessage.tsx`、`DenseToolMessage.tsx`、`ToolResultDisplay.tsx`：同组工具共用一个边框，紧凑/详细两种密度，确认框与结果同组                      | 调用行 + 结果行分开；结果头是 `ok · 7ms`（无语义摘要）                                       | 工具组为一个视觉单元；每个工具提供语义摘要（"Listed 12 entries"）（P3） |
| 思考     | `messages/ThinkingMessage.tsx`：主题加粗、正文次要色斜体，左边框；"Thinking..." 只在首条出现                                                                     | 本次已改为默认隐藏 + `thought for Ns` 行                                                     | CC 的折叠行 + ctrl+o 展开更克制，保持现方案（P3 补全）                  |
| 闪烁检测 | `hooks/useFlickerDetector.ts`：每次渲染后量根节点高度，**高于终端高度即上报**                                                                                    | 无；本次发现的"光标偏一行""jump 行把顶部顶掉"都是这一类 bug，只能靠人眼                      | 在开发/测试模式加同样的帧高度不变量；PTY 探针做成回归（P0）             |
| 按键     | `key/keyBindings.ts`：`Command` 枚举约 80 项，默认绑定表 + 用户 `keybindings.json`（zod 校验）；`keyMatchers` 解耦"按键"与"动作"                                 | `app.ts` 的 `useInput` 约 800 行 if 链，`help.ts` 另有一份展示表                             | 动作注册表 + 可配置绑定 + 帮助页自动生成（P4）                          |
| 主题     | `semantic-colors.ts` / `themes/`：语义色（text.primary/secondary、status.error…），`light`/`dark`/`no-color`，调用方不写色值                                     | 8 个具名色散落在渲染函数里；模式色在 `INTERACTION_MODE_TONES`                                | 语义色表 + 终端明暗探测 + `NO_COLOR`（P5）                              |
| 状态管理 | 拆成 `UIStateContext` / `UIActionsContext` / `StreamingContext` / `KeypressContext` / `MouseContext` / `ScrollProvider`                                          | `app.ts` 3572 行单文件持有绝大部分状态                                                       | v2 的 Phase 3 "结构拆分"仍有效，按上述边界切（P2 前置）                 |
| 测试     | 每个组件旁有 `*.test.tsx` + `__snapshots__`，布局用 `DefaultAppLayout.test.tsx`                                                                                  | `test/tui-*.spec.mjs` 31 个文件，断言多为字符串；真实屏幕靠 `scripts/tui-feel`               | 用 PTY 探针产出"黄金屏幕"快照做回归（P0）                               |

### 1.1 gemini-cli 不该照搬的部分

- 依赖 fork 的 Ink：维护成本高，moss 的 AGENTS.md 要求依赖精简。
- 配置、遥测、配额、IDE 集成等周边：不在 moss 范围（AGENTS.md "维持冻结"清单）。
- 它的"全屏"是可选实验开关（`getUseAlternateBuffer`），moss 已把全屏定为默认（v2 D0），方向比它更接近 Claude Code。

## 2. Claude Code 行为基线（来自官方 CHANGELOG 与 moss 既有 parity 文档）

CHANGELOG 反复出现、且 moss 尚未具备或未验证的体验项：

1. **全屏滚动**：滚动位置在回复结束时不得跳动；滚动条（列表内悬停出现，可点击/拖拽，带 ↑/↓）；"N more" 行可点击跳转；点击折叠行（如 "Thought for 4s"）展开。
2. **折叠与展开**：ctrl+o 全文视图，工具很多时不得卡顿；折叠摘要（"N hooks ran"）计数必须真实。
3. **光标**：终端光标必须跟随输入（含搜索框、IME、屏幕阅读器模式）；粘贴含制表符、换行的内容不得错位。
4. **输入**：外部编辑器按光标行号打开；vim 模式；排队消息可取回编辑；Esc-Esc 回退。
5. **主题**：`/theme` 滚动列表，自适应终端高度。
6. **键位**：`keybindings.json`，且对非法绑定给出告警而不是静默失效。
7. **稳定性**：全屏下大窗口 resize/Ctrl+L 不得整屏清除；终端变矮后非全屏渲染器不得残留错位行。

moss 的 `docs/cli-parity/claude-code-surface.md` 已把其中 103 条整理成 MUST 清单，v2 plan §3 列了 G1–G7 差距。本文不重复，只补**本次实测与参考实现新暴露的差距**。

## 3. 差距清单（本次新增，证据来自 PTY 探针 `scratch/tui-probe.py` 与源码阅读）

| 编号 | 差距                                                                     | 证据                                                                     | 状态                             | 阶段 |
| ---- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------- | ---- |
| N1   | 画面刚好占满终端高度时，硬件光标偏高一行（落在分隔线上）                 | 100×30 流式中 `cursor y=26`、提示符在 27；44×14 同样                     | **已修**                         | P0   |
| N2   | 向上滚动时 `Jump to bottom` 行不在高度预算内，整帧高于终端，顶部被顶掉   | 20 行终端滚动后提示符 17→16                                              | **已修**                         | P0   |
| N3   | 向上滚动期间新内容追加，窗口内容漂移                                     | 探针 diff：改前 `SCREEN DRIFTED`，改后 `SCREEN STABLE WHILE SCROLLED UP` | **已修**（见 §6）                | P1   |
| N4   | 全屏下 transcript 不满一屏时，输入框紧跟内容悬在半空，不在底边           | 探针空闲屏：提示符在第 11 行，下方 18 行空                               | **已修**                         | P2   |
| N5   | 空闲时状态行是空白行，白占一行                                           | 探针空闲屏第 10/11 行                                                    | 待做                             | P2   |
| N6   | 工具结果头 `ok · 7ms` 没有语义摘要；同组工具结果之间原本有空行           | 探针 toolstorm                                                           | 空行与 1–2 行折叠已修，摘要待做  | P3   |
| N7   | 同一轮里工具调用之间的 prose 被拼成一行（`Step 2.Step 3.Done.`）         | 探针 toolstorm（stub 在同一响应里先吐文本再吐 tool_call）                | **待复现**：先写失败用例，再定位 | P3   |
| N8   | 全屏滚动每帧重投影全部行；条目锚点缺失                                   | `app.ts` 投影循环；`test/tui-perf` 10k 行 1.6ms 目前不构成瓶颈           | 观察项                           | P1   |
| N9   | 按键散落在 800 行 `useInput` 中，无用户配置，帮助表另存一份              | `app.ts:2241` 起                                                         | 待做                             | P4   |
| N10  | 无语义色、无明暗适配、无 `NO_COLOR`                                      | `transcript.ts` 中 `color: 'cyan'` 等字面量                              | 待做                             | P5   |
| N11  | 无滚动条、无 Home / Ctrl+Home、无拖拽选区外的鼠标交互                    | `mouse-route.ts` 仅 scroll/pin/caret/select                              | 待做                             | P1   |
| N12  | 窄终端：底部提示行只能尾部截断，不能按重要性取舍（原有测试把截断当契约） | `test/tui-shell.spec.mjs:267`                                            | 需先改契约再改实现               | P2   |
| N13  | 真实终端（iTerm2 / Terminal.app / tmux / Windows Terminal）人工验证缺失  | pyte 不处理 alt-screen、IME、真实光标样式                                | 待做                             | P7   |

## 4. 目标版本：v0.30「CC-parity shell」

**定义**：同一份脚本在 moss 与 Claude Code 上并排运行（`scripts/tui-feel/compare_feel.py --compare claude` 已具备骨架），在下列维度没有可观察差异：布局（输入框贴底、状态行、提示行）、流式（回答边生成边可读、不闪）、滚动（不漂移、有滚动条、End 回底）、折叠（思考/工具默认折叠、一键展开）、光标（始终在输入处，含 IME）、按键（可配置、帮助自动生成）、窄终端（优雅降级）。

### 阶段总览

| 阶段 | 内容                                                               | 估时   | 依赖 |
| ---- | ------------------------------------------------------------------ | ------ | ---- |
| P0   | 测量护栏：探针回归化 + 帧高度不变量                                | 1 天   | 无   |
| P1   | 滚动模型：条目锚点、滚动条、Home/End、拖拽                         | 2–3 天 | P0   |
| P2   | 布局：贴底输入框、去空白状态行、窄终端按重要性降级、小窗口兜底     | 1.5 天 | P0   |
| P3   | 思考与工具呈现：语义摘要、工具组、统一截断、N7 修复                | 3 天   | P0   |
| P4   | 按键注册表 + `keybindings.json` + 帮助自动生成（vim 模式列为可选） | 3–4 天 | P2   |
| P5   | 语义色与主题：明暗探测、`NO_COLOR`、`/theme`、模式色单点定义       | 2 天   | P3   |
| P6   | 输入收尾：IME 光标、外部编辑器行号、排队消息取回、粘贴边界         | 2 天   | P4   |
| P7   | 并排复核与真实终端清单                                             | 2 天   | 全部 |

合计约 15–18 天，P1/P2/P3 可并行（不同文件）。每阶段独立合入、独立可回退。

### P0 测量护栏（先做，其余都靠它）

- 把 `scratch/tui-probe.py` 升级为 `scripts/tui-feel/` 的场景断言：对 `{fullscreen, inline} × {100×30, 70×24, 44×14, 30×12}` × `{空闲, 流式中, 滚动后, 审批框}` 断言：**光标所在行 = 提示符行**、**画面行数 ≤ 终端行数**、**无整屏清除**、**滚动期间流式画面稳定**。
- 在 `app.ts` 渲染末尾加开发期不变量（`MOSS_TUI_DEBUG=1`）：`frameRows <= rows`，违反时写入 `tui-*.log`——对应 gemini-cli 的 `useFlickerDetector`。
- 验收：本文 N1–N4 各有一个先红后绿的探针用例。

### P1 滚动模型

- `ViewportState` 由"距底部行数"改为"条目锚点（rowId, lineIndex）+ stickToBottom"，保持 `viewport.ts` 的纯函数接口；已落地的 `total` 补偿是过渡方案。
- 每行投影结果按 `(row.id, width, verbose, expanded)` 缓存，流式尾部单独计算。目标：10k 行滚动一帧 < 5ms（`test/tui-perf` 现有预算）。
- 右侧 1 列滚动条（悬停显示，可点击/拖拽，↑/↓ 箭头），Home / Ctrl+Home 回顶，End 回底（End 已落地）。
- 回复结束时不得因折叠/合并行而跳动（CC changelog 的同类缺陷）。
- 验收：探针"滚动中 + 回复结束"画面稳定；`tui-viewport.spec` 增加锚点用例。

### P2 布局

- 输入框贴底已落地；去掉空闲时的空白状态行（把 `● running` 等并入提示行右侧，或仅在有内容时占行）。
- 窄终端：提示行按重要性取舍（模式 > `Esc to interrupt` > `? for shortcuts` > 任务数），**先修改 `tui-shell.spec.mjs:267` 的契约再改实现**，并在 `docs/cli-parity` 记录这是有意变更。
- 小于 10 行 / 40 列时的兜底：回退内联渲染并给出一次性提示。

### P3 思考与工具呈现

- 思考：运行中只显示 `✻ Thinking… Ns`；完成后留 `⎿ thought for Ns · click or ctrl+o`（已落地）；展开后用 gemini-cli 式左边框 + 次要色斜体。
- 每个工具提供语义摘要：`Listed N entries` / `Read N lines` / `Edited path (+a −b)`；失败保持展开。
- 同组工具共用一个视觉单元（紧凑密度），确认框与结果同组；统一截断组件输出 `… +N lines (ctrl+o)` 并向页脚上报"存在折叠内容"。
- N7：先写失败用例（工具调用之间的 prose 不得合并），再定位 `app.ts` 工具边界 flush 与 `foldReadonlyRows` 的交互。
- 验收：`tui-markdown` / `tui-shell` 新增用例；探针 toolstorm 画面每个调用都有自己的摘要行。

### P4 按键

- 建立 `Command` 注册表（动作 id、默认绑定、说明、可用上下文），`useInput` 改为查表分发；`help.ts` 与 `?` 面板从同一表生成。
- `~/.config/moss/keybindings.json`：schema 校验，非法项给告警行而不是静默忽略。
- vim 模式作为可选（`/vim`），不进默认路径；范围：normal/insert、`hjkl wbe 0$ x dd yy p u`、`i a o`。
- 验收：现有按键行为全部由表驱动且 spec 不变；新增 `keybindings.json` 用例。

### P5 主题

- 语义色表（`text.primary/secondary/accent`、`status.*`、`diff.*`、`mode.*`），渲染函数只引用语义名；`INTERACTION_MODE_TONES` 并入表。
- 终端明暗探测（`COLORFGBG` 与 OSC 11 查询，超时回退暗色）、`NO_COLOR`、`/theme` 选择。
- 验收：同一屏在 dark / light / no-color 三种主题下可读（探针断言前景色集合）。

### P6 输入收尾

- 输入框 IME：硬件光标已跟随输入；补搜索框与选择器内的光标跟随（CC changelog 的同类缺陷）。
- Ctrl+G 外部编辑器带光标行号；队列消息取回编辑（v2 Phase 5 已覆盖，复核）；粘贴含制表符/换行的边界用例。

### P7 并排复核

- `compare_feel.py --compare claude` 在同一 stub 与同一脚本下，对布局/光标/滚动/折叠打分，输出到 `bench/results/`（不入库）。
- 真实终端人工清单：iTerm2、Terminal.app、tmux（鼠标开/关）、GNU screen、VS Code 终端、Windows Terminal（REPL 回退）；每项在 PR 描述里写"测了什么、没测什么"。

## 5. 风险与边界

- **不照搬受版权保护的源码**；参考实现只取结构与行为，不拷贝代码。
- **TUI 不在 SDK 公共面**（`src/index.ts` 无导出），本计划不触发 `sdk-contract` 快照变更。
- 契约变更点集中在 N12（提示行截断契约）与按键表（P4）；两处都要先改 spec 与文档再改实现。
- 单文件 `app.ts` 3572 行是最大的回归风险源：P2/P4 之前先执行 v2 的 Phase 3 拆分，否则每个阶段都在同一文件里相互冲突。
- pyte 无法覆盖 alt-screen 与 IME：P7 的人工清单不可省略。
- 范围边界：memory / mesh / observability / web-ui / 插件市场仍冻结，本计划不涉及。

## 6. 本次已落地的改动（可复现）

均在工作区，未提交。验证方法：`node scratch/tui-probe` 同款脚本（`python3 scratch/tui-probe.py --prompt <longstream|toolstorm|hello> --rows R --cols C [--keys ...] [--post S]`），对本地 stub provider 运行，零 API 费用。

| 改动                                                                                 | 对应差距 | 验证                                                                                     |
| ------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------- |
| 画面占满终端时光标补偿一行                                                           | N1       | 全屏/内联 × 100×30、70×24、44×14、30×12：光标行 = 提示符行                               |
| `Jump to bottom` 行计入帧高度并移到视口正下方；新增 End 回底                         | N2       | 20 行终端滚动后帧高 = 20，光标正确                                                       |
| 视口记录滚动时的总行数，追加内容不拖动窗口                                           | N3       | 探针 `--post 3`：改前 `SCREEN DRIFTED`，改后 `SCREEN STABLE WHILE SCROLLED UP`；单测新增 |
| 全屏下短 transcript 用空行把输入框顶到底边                                           | N4       | 16×60 空闲屏提示符在第 13 行、光标 y=13                                                  |
| 思考默认隐藏；完成后留 `thought for Ns` 行；缓冲 6000 字符上限，不再写入 transcript  | §2-1     | `tui-run-state` 更新并通过                                                               |
| 工具结果紧贴调用；1–2 行结果直接显示；状态行窄屏先丢模型名与 token；流式标题提前渲染 | N6 部分  | `tui-markdown` 新增回归用例；探针 toolstorm                                              |

**对"改前"对比的说明**：N3 的"改前"是把工作区整体 `git stash` 后的结果，不只含该项改动；漂移的根因（距底部行数在内容增长时不变）已由单测直接覆盖。

## 7. 进度（2026-10-09）

P0–P6 已在 main 上落地，证据是 `npm test`（含 `test/tui-screen-layout.spec.mjs`）和 `scripts/tui-feel/compare_feel.py --compare claude`（`failures: []`，光标列与 Claude Code 同为 22 / 16）。结果文件在 `bench/results/`，不入库。布局探针最近一次 **74/74**：在 68 项之上补了审批框（问题、选项、硬件光标落在选中项、帧高不变量）、`Ctrl+Home` 回顶、浅色主题把 spinner 从黄色改成品红而暗色保持黄色。窄终端提示行的有意契约写在 `docs/cli-parity/tui-narrow-hint.md`。

`app.ts` 仍未按 v2 Phase 3 拆分。vim 模式按计划保持可选，未做。

### P7 真机（2026-10-09，macOS，`feat/tui-p7-real-terminals`）

`python3 scripts/tui-feel/real-terminals.py` 在这台 Mac 上连续跑过两次，退出码都是 0。第二次输出：

| 检查                      | 结果     | 依据                                                                                                                   |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| tmux，session `mouse off` | pass     | `alternate_on=0`，`mouse_sgr_flag=0`，硬件光标在提示符行第 2 列 `(2,8)`，composer 与 `Done.` 可见                      |
| tmux，session `mouse on`  | pass     | `alternate_on=1`，`mouse_sgr_flag=1`，光标 `(2,27)` 在提示符行；composer 一出现就送 `测`，画面上只有一个，光标列变成 4 |
| tmux，global `mouse on`   | pass     | `alternate_on=1`，光标 `(2,27)`，composer 与 `Done.` 可见                                                              |
| GNU screen 4.00.03        | pass     | 用 pty attach 读到 composer 与 `Done.`。`hardcopy` 在这个版本上写出 0 字节文件，不能当证据                             |
| Terminal.app              | pass     | AppleScript 只开标题为 `moss-p7-<pid>` 的窗口，读到 composer 与 `Done.`，然后 `/quit`、`exit`、关闭该窗口              |
| iTerm2                    | 本机没有 | 无 `iTerm.app` / `iTerm2.app`，脚本打印 skip                                                                           |
| VS Code 终端              | 本机没有 | 无 `Visual Studio Code.app`，也无 `code`。装上之后脚本仍 skip：集成终端没有可抓取的 API，步骤在手动清单                |
| Windows Terminal          | 手动     | 这台是 macOS。云上的 Linux VM 也开不了它                                                                               |
| 中文输入法候选框          | 手动     | 候选窗本身没有自动化。真终端上能核对的是硬件光标：tmux 全屏时光标在提示符格上，打一个宽字符后右移 2 列                 |

修了一处输入缺陷：Ink 的 kitty `auto` 在探测窗口里把 stdin 旁路缓冲再 unshift，启动后约 200ms 内的按键会进两次（`测` 变成 `测测`，光标多走一格）。`TUI_KITTY_KEYBOARD` 改为 `enabled`，跳过这次探测。回归在 `test/tui-renderer.spec.mjs`，现网行为在上面的 tmux `测` 检查里。

手动步骤写在 `docs/cli-parity/tui-real-terminals.md`。云上的 Linux 可以重跑 tmux 和 GNU screen；iTerm2、Terminal.app、VS Code 终端和输入法候选框必须留在 Mac 上，或者按那份清单手工做。Windows Terminal 只能在 Windows 上做。
