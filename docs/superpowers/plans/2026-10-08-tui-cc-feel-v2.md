# Moss TUI「Claude Code 体感」改造 v2：基于长会话实测的规划与执行方案

> 日期：2026-10-08。取代同目录 `2026-10-08-tui-cc-feel.md`（下称 v1）的规划部分；v1 中的零配额 stub
> 探针证据（E1 幽灵帧、E2 90×14 清屏风暴）仍然有效并在本文引用，不再重复推导。
> 本文自包含：怎么测的、测到了什么、要改什么、按什么顺序改、怎么验收、已拍板的决策（§4）。
> 被测版本：moss `58e7f614`（v0.25.0，构建于 `../moss-tui-feel` worktree）；Claude Code 2.1.286
> （测试途中自动升级为 2.1.293）。代码行号以 `58e7f614` 为准；main 工作区正在进行 v0.26 权限模型改动，
> 行号可能漂移，以符号名为准。

---

## 0. TL;DR

1. **按键延迟不是问题**。真实长会话中 moss 回显 p50 8.7ms / max 13ms，CC p50 4.7ms / max 18ms，同一量级。
   「卡、不顺」来自**输入语义、光标、输出管理**，不是 React 性能。
2. **光标是最大的体感差距**（v1 完全没有覆盖）：CC 的**真实硬件光标可见并精确停在插入点**（中英文混排
   列位置正确），moss 把硬件光标隐藏在屏幕左下角、用"插入一个反色空格"画假光标——文字随光标移动左右
   抖动，**中文输入法候选框出现在左下角而不是输入位置**。ink 7.1.1 自带 `useCursor`（文档原话即为 IME 设计），
   修复成本低。
3. **粘贴是第二大差距**：moss 粘贴会吞掉草稿；粘贴后继续打字**完全无反应**；Backspace 删不掉粘贴块；
   ↑ 历史也被挡住，只有 Esc Esc 能脱困。CC：`请总结下面内容：[Pasted text #1 +29 lines] 谢谢`。
4. **输出管理问题被真实会话证实**：Ctrl+O 开关两次后整份 transcript 在 scrollback 中出现 **3 遍**；
   排队消息回显 2 次；流式期间只看到 6 行无渲染的原始尾巴（还从半个单词开始：`s It`）；缩窄终端在屏幕上
   留下一份残影 composer。同一场景 moss 写出 **1.10MB**，CC **175KB**（6.3 倍）。
5. **重大前提变化**：本机 CC 在信任对话框之后进入 `?1049h` 备用屏并整场不退出，同时开启鼠标跟踪
   （1000/1002/1003/1006）、焦点事件（1004），用绝对光标定位做差量重绘——**CC 现在是全屏渲染器**：
   滚轮回看是应用内虚拟滚动（带 `Jump to bottom (click) ↓`），点击 composer 定位光标，拖选 transcript
   自动复制并提示 `copied 5 chars to clipboard`。
   **已拍板（D0，2026-10-08 产品负责人）：对齐 CC，全屏渲染器（备用屏 + 鼠标）作为 TTY 默认形态；
   v0.22 的 primary screen 内联形态保留为回退。** v1 的「明确不做 alternate screen」作废。
6. 执行顺序：**输入手感（光标/粘贴/键流/帮助键，两种形态共用）→ 共用输出通道与布局 → 结构拆分（让渲染器
   可替换）→ 全屏渲染器（默认）→ 队列与流式 → CC 交互件 → 回退形态加固**。全屏渲染器从根上消除
   G4（流式不可读）、G6（Ctrl+O 重复）、G7（缩放残影）与 E2（清屏重放）——这些在全屏下不再是独立任务，
   只在回退形态里保留轻量修复。

---

## 1. 实测方法（可复现）

### 1.1 工具

- 驱动器：`scratch/cc-vs-moss/session.py`（本次新增，`scratch/` 被 gitignore；Phase 0 会入库为
  `scripts/tui-feel/`）。真实 PTY + `pyte.HistoryScreen`，**同一剧本**分别驱动 `claude` 与 `node dist/cli.js`。
  每个截屏记录：屏幕文本、**硬件光标 (x, y, 是否隐藏) 与光标下字符**、自上一截屏以来的写出字节、
  `ESC[2J` / `ESC[3J` / 同步帧数；逐字输入时记录每个键的回显延迟；结束时导出完整 scrollback 与原始字节。
- 摘要：`scratch/cc-vs-moss/summ.py <log.json> [shot前缀,...]`。
- 两边都用**真实模型**（不是 `-p`，是同一进程内多轮交互）：CC 用本机账号（模型 glm-5.3），moss 用本机
  `~/.config/moss`（DashScope qwen3.8-max）。样例工程为 4 文件的 `sensor-kit`（README、app.py、utils.py、
  tests/test_utils.py），每个工具一份独立副本、已 `git init`。

### 1.2 剧本

| 剧本             | 尺寸 / 语言                | 覆盖                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main`           | 100×30，`LANG=en_US.UTF-8` | 中英混排输入、←×3 中间插入、Ctrl+A/E、Backspace；四种换行键；`/` 菜单上下选择/过滤/Esc；`@` 菜单/Tab 补全；回合 1（中文，只读工具）+ 运行中打字；回合 2（英文，写文件 + 执行，**两次审批**，审批时误触 `x`）；回合 3（600 词长回答流式 + 运行中提交排队消息）；回合 4（长故事 + Esc 中断）；Ctrl+O 进出；带草稿粘贴 30 行后继续打字；缩放 100×30→80×16→120×36；↑ 历史；空 composer Esc Esc |
| `zh`             | 80×20，`LANG=zh_CN.UTF-8`  | 空 composer 按 `?`；Shift+Tab 模式循环；长中文提示自动折行；改代码 + 补测试 + 跑 pytest（三次审批，数字键作答）；`/状态`；未请求的鼠标 SGR 序列                                                                                                                                                                                                                                            |
| `mouse`（仅 CC） | 100×30                     | 长输出后滚轮上/下、滚动中打字、点击 composer 第 9 列、拖选 transcript                                                                                                                                                                                                                                                                                                                      |

复现命令（需在沙箱外运行，PTY 与网络都要放开）：

```bash
B=/tmp/ccmoss   # 样例工程，见 §1.1；每个工具一份 git init 过的副本
cd scratch/cc-vs-moss
python3 session.py --tool claude --out out-claude --ws $B/ws-claude
python3 session.py --tool moss   --out out-moss   --ws $B/ws-moss
SESSION_LANG=zh_CN.UTF-8 python3 session.py --tool moss --scenario zh --cols 80 --rows 20 --out zh-moss --ws $B/zh-moss
python3 summ.py out-moss/log.json 21,22,23   # 只看某几个截屏
```

> moss 路径写死为 `../moss-tui-feel/dist/cli.js`（`session.py` 顶部 `MOSS_CLI`），换 worktree 时改这一行。

---

## 2. 实测结果对照

### 2.1 总量指标

| 指标                           | moss                                      | CC                                                                                          | 备注                                                 |
| ------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 逐字输入回显（中英混排 13 键） | p50 8.7ms，max 13.1ms                     | p50 4.7ms，max 18.1ms                                                                       | 都没问题                                             |
| 运行中打字回显                 | p50 7.4ms，max 9.9ms                      | p50 6.2ms，max 9.5ms                                                                        | 都没问题                                             |
| `main` 剧本总写出              | **1,097,971 B**，1035 个同步帧            | **175,244 B**                                                                               | 6.3 倍；moss 每帧整块重写动态区，CC 用光标定位差量写 |
| 整屏清除 `ESC[2J`              | 0（100×30 下）                            | 3（进入全屏 + 2 次 resize）                                                                 | moss 在 90×14 工具风暴下 372 次（v1 E2）             |
| 终端模式                       | 仅 `?25`（光标显隐）、`?2026`（同步输出） | `?1049` 备用屏、`?1000/1002/1003/1006` 鼠标、`?1004` 焦点、`?2004` 括号粘贴、`?2031`、`?25` | §4 D0                                                |

### 2.2 逐场景对照（截屏名 = `log.json` 中的 shot name）

| #   | 场景                                                    | CC 实测                                                                                                                                            | moss 实测                                                                                                                                                                                                                                      | 差距                |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1   | 输入 `hello 世界，测试光标`                             | 硬件光标**可见**，在第 22 列（= 2 + 6 + 7×2，宽字符计算正确）（`01`）                                                                              | 硬件光标**隐藏**，停在 (0, 屏幕最后一行)（`01`）                                                                                                                                                                                               | **G1**              |
| 2   | ← ×3                                                    | 光标落在「试」上，文字不动（`02`）                                                                                                                 | 渲染为 `测 试光标`：在插入点**多插入一个反色空格**，后半段右移一格（`02`）                                                                                                                                                                     | **G1**              |
| 3   | Ctrl+A                                                  | 光标到 `h`（`04`）                                                                                                                                 | `❯  hello…`：行首多一个空格（`04`）                                                                                                                                                                                                            | **G1**              |
| 4   | Shift+Enter(CSI-u) / Alt+Enter / Ctrl+J / `\`+Enter     | 全部换行；多行时右侧提示 `ctrl+g to edit in Vim`（`06`）                                                                                           | 全部换行（`06`）                                                                                                                                                                                                                               | moss 无 Ctrl+G      |
| 5   | `/` 菜单                                                | 固定 4 行窗口，两行描述（`08`）                                                                                                                    | 8 项 + `… 17 more`，菜单高度随内容变（`08`）                                                                                                                                                                                                   | 小                  |
| 6   | `/mod` 后 Esc                                           | 关闭菜单，保留文本（`11`）                                                                                                                         | 关闭菜单，在原位置打印 `Esc again to clear the composer`（`11`）                                                                                                                                                                               | 小                  |
| 7   | `@` → `app` → Tab                                       | 菜单混入大量 `~/.claude/skills/…` 无关全局路径（`13`）                                                                                             | 只列工作区文件，Tab 补全为 `@app.py`（`12–14`）                                                                                                                                                                                                | **moss 更好**，保持 |
| 8   | 运行中 spinner                                          | `· Ruminating…`；页脚 `esc to interrupt`                                                                                                           | `✽ Working… 2s` + 右侧 `● running`；页脚 `Esc to interrupt`                                                                                                                                                                                    | 基本一致            |
| 9   | 回合 1 只读工具                                         | 折叠为一行 `Thought for 2s, read 4 files, listed 2 directories`（`17`）                                                                            | 每个读取各占 2 行（`⎿ Read 3 lines · 10ms` + `… 3 lines · ctrl+o`）（`17`）                                                                                                                                                                    | **G8**              |
| 10  | 回合结束                                                | 回合结束后 composer 出现**灰色建议提示**（如 `运行一下测试和 app.py 验证`）（`17`、`20`、`24`）                                                    | 固定占位 `Try "stream the camera at 30 fps and verify it"`                                                                                                                                                                                     | G13（P2）           |
| 11  | 写文件审批                                              | 标题 `Create file / greet.py`，带完整内容预览；选项 1/2/3；**审批期间隐藏 composer 与硬件光标**；误触 `x` 无效（`18–19`）                          | 内容一致，选项 1/2/3，误触 `x` 无效；composer 仍显示在审批框下方（`18–19`）                                                                                                                                                                    | 小                  |
| 12  | Bash 审批                                               | 先在 transcript 打 `Running 1 shell command… ⎿ $ python3 …`，完成后折叠为 `Ran 1 shell command`（`20`）                                            | `⏺ Exec(python3 greet.py)` + `⎿ ok · 42ms` + 输出                                                                                                                                                                                              | G8                  |
| 13  | 长回答流式 6s / 10s                                     | 整段**渐进渲染**（标题、段落、列表、代码块），开头一直可见（`21`、`23`）                                                                           | 6s 时只有 spinner；10s 时 live 区显示 6 行**未渲染**原始文本，从半个单词开始（`s It`），开头不在屏幕也不在 scrollback（`23`）                                                                                                                  | **G4**              |
| 14  | 运行中提交 `然后用一句话总结`                           | 不进 transcript；显示在流式内容下方 `❯ 然后用一句话总结 / ctrl+x ctrl+s to send now`；composer 占位变为 `Press up to edit queued messages`（`22`） | **立即**以 `❯ 然后用一句话总结` 插入 transcript（在它并未回应的回答之前），另有 `⏐ next:` 预览；出队时**再回显一次**（scrollback 中每份 2 次）（`22`、`24`）                                                                                   | **G5**              |
| 15  | Esc 中断                                                | 部分输出原地保留，`⎿ Interrupted · What should Claude do instead?`（`26`）                                                                         | `interrupted — partial output kept` + `✻ Thinking for 5s · interrupted`（本例中断前尚无正文）                                                                                                                                                  | 小                  |
| 16  | Ctrl+O                                                  | 进入 `Showing detailed transcript · ctrl+o to toggle`，同一画面内显示时间戳/模型，**不写 scrollback**（`27`）                                      | 把整份 transcript 以 verbose 形式**重新打印**进 scrollback；关闭时再打印一遍。结束时 `history.txt` 中 transcript 共 **3 份**（第 2、174、380 行各有一个 banner）（`27–28`）                                                                    | **G6**              |
| 17  | 先输入 `请总结下面内容：`，再粘贴 30 行，再输入 ` 谢谢` | `❯ 请总结下面内容：[Pasted text #1 +29 lines] 谢谢`，页脚 `paste again to expand`；Backspace 能整体删除（`29–30`）                                 | 草稿被替换为 `[paste: 30 lines — Enter sends as one message, Esc discards]`；之后输入 ` 谢谢` **写出 0 字节**（无反应）；200 次 Backspace 删不掉；↑ 无反应；只有 Esc Esc 清除（`29–35`）                                                       | **G2**              |
| 18  | 缩放 100×30 → 80×16 → 120×36                            | 每次清屏后从自有缓冲重绘，干净（`31–32`）                                                                                                          | 80×16 时屏幕上残留一份旧 composer（第 4–6 行）在新 composer 上方，放大后仍在（`31–32`）                                                                                                                                                        | **G7**              |
| 19  | ↑ 历史                                                  | 分隔线上显示 `History 5/5`、`History 4/5`；页脚提示 `ctrl+r to search history`（`33–34`）                                                          | 被粘贴块挡住（场景 17 的连带问题）；v1 C6：重启后历史为空                                                                                                                                                                                      | G11                 |
| 20  | 空 composer Esc Esc                                     | 打开 **Rewind** 面板：`Restore the code and/or conversation to the point before…`，列出各轮消息与「No code changes」（`35`）                       | 无反应（仅 `/rewind` 列表）                                                                                                                                                                                                                    | G10                 |
| 21  | zh：空 composer 按 `?`                                  | 立即在 composer 下方展开三列快捷键面板（`z01`）                                                                                                    | 把 `?` 当作文字输入（`❯ ?`）。根因：`app.ts:1576` 只在**提交** `?` 时打开帮助，与页脚 `? 查看快捷键` 的承诺不符                                                                                                                                | **G3**              |
| 22  | zh：Shift+Tab 循环                                      | manual → accept edits → plan → manual                                                                                                              | 默认 → 自动接受编辑 → 计划 → 默认，标签已中文化                                                                                                                                                                                                | 一致                |
| 23  | zh：编辑审批                                            | 标题 `Edit file / utils.py`，带 diff；`Do you want to make this edit to utils.py?`                                                                 | 标题 `Edit file / multi_edit`，问句 `Do you want to make this edit to multi_edit?`——**显示工具名而不是文件路径**；选项只有 `1. 是`、`3. 否`（**缺 2**），页脚却写 `1/2/3 作答`；且「自动接受编辑已开启」时仍然弹出编辑审批（`z06-approval-0`） | **G9**              |
| 24  | zh：Bash 审批                                           | 英文（CC 不做本地化）                                                                                                                              | `Do you want to proceed?`、`Yes, and always allow exec (saved)` 未翻译，与 `是/否` 混排（`z06-approval-2`）                                                                                                                                    | G9                  |
| 25  | zh：回合结束行                                          | `✻ Brewed for 19s · done 16:21`                                                                                                                    | `✻ 探测中 43s · 完成于 16:21`（「探测中」是进行时，与「完成于」矛盾）                                                                                                                                                                          | G9                  |
| 26  | 未请求的鼠标 SGR 序列 `ESC[<0;10;5M…m`                  | 吞掉，无副作用（`z09`）                                                                                                                            | 以字面 `[<0;10;5M[<0;10;5m` **进入 composer**（`z09`）。同类风险：焦点事件 `ESC[I/O`、F 键、未知 CSI                                                                                                                                           | **G12**             |
| 27  | 滚轮回看（CC `mouse`）                                  | 应用内滚动，composer 不动，右下浮出 `Jump to bottom (click) ↓`；滚动中打字不跳回底部                                                               | primary screen，由终端原生 scrollback 负责（终端行为，非 moss 实现）                                                                                                                                                                           | §4 D0               |
| 28  | 点击 composer 第 9 列（CC）                             | 光标移到点击处的 `w`                                                                                                                               | 不适用（未开鼠标跟踪）                                                                                                                                                                                                                         | §4 D0               |
| 29  | 拖选 transcript（CC）                                   | 应用内选区，松开自动复制，提示 `copied 5 chars to clipboard · disable auto-copy in /config`                                                        | 终端原生选择（未开鼠标跟踪时可用）                                                                                                                                                                                                             | §4 D0               |

### 2.3 来自 v1 stub 探针、本次真实会话未复现但仍有效的问题

- **E1 幽灵帧**：provider 重试 + 默认 `MOSS_LOG_LEVEL=warn` 时，logger 绕过 ink 直写 stderr，残留
  spinner 帧、重试行打印两次。根因 `src/logger.ts:155-194` 及同类直写点（v1 §2 E1 列表）。
- **E2 矮终端清屏风暴**：90×14 工具风暴 8 秒内 372 次 `ESC[2J` + 整段历史重放。根因：动态区高度无预算，
  超过终端行数时 ink 走 `clearTerminal + fullStaticOutput`。
- **E5 跨轮 prose 粘连**（`Step 2.Step 3.Done.`）、**C5 `@` 首开同步遍历**、**C7 Kitty 键盘协议未启用**
  （本次 Shift+Enter 用 CSI-u 序列直接发送能工作，但真实终端不开协议时不会发出该序列）、**C8 140ms 整树重渲染**。

---

## 3. 差距清单（按体感影响重排）

| ID       | 问题                                                                                                       | 用户感受                                                                                          | 根因（`58e7f614`）                                                                                                                                                        | 级别                      |
| -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| G1       | 假光标 + 硬件光标隐藏                                                                                      | 光标移动时文字抖动；**中文输入法候选框在左下角**；终端的光标样式/闪烁设置失效；屏幕阅读器无法跟踪 | `composer.ts:380-391` 插入反色空格；`caretGlyph` 分支同理；从未调用 ink `useCursor`                                                                                       | **P0**                    |
| G2       | 粘贴吞草稿、粘贴后输入无效、无法删除                                                                       | 「我写的字没了」「卡住了，只能 Esc Esc」                                                          | `app.ts:2577-2600` 自研 stdin 监听，完成后 `setInput('[paste: …]')` 覆盖整个 composer；粘贴预览存在时 `useInput` 的编辑分支被短路（具体分支待 systematic-debugging 确认） | **P0**                    |
| G3       | `?` 不打开帮助                                                                                             | 页脚写「? 查看快捷键」，按了没用                                                                  | `app.ts:1576` 只在提交 `?` 时处理                                                                                                                                         | **P0**（一行级）          |
| G4       | 流式期间看不到回答                                                                                         | 长回答期间无法边生成边读，只能看到无渲染的碎片                                                    | `render-bridge.ts` 只保留 400 字符尾巴；live 区只画 8 行；整段回答等到 `done` 才提交（v1 §1.3）                                                                           | **P0**                    |
| G5       | 排队消息双回显且位置错误                                                                                   | 「我的消息怎么出现在它回答之前」「发了两次？」                                                    | `submit()` 运行中先 `appendRow(user)`，`drainQueue()` 出队时再 `appendRow(user)`（v1 §1.3）                                                                               | **P0**                    |
| G6       | Ctrl+O 重新打印整段 transcript                                                                             | scrollback 越用越长、内容重复，回看时找不到位置                                                   | `app.ts:2518` + `2908` 改 key 重挂 `<Static>`                                                                                                                             | **P0**                    |
| G7       | 缩窄终端留下残影帧                                                                                         | 画面错乱，看起来像有两个输入框                                                                    | 宽度变小后终端已对旧帧软换行，ink 擦除行数不足（v1 Phase 6 已预判，本次实测证实）                                                                                         | **P0**                    |
| G8       | 只读工具刷屏                                                                                               | 有效信息被淹没                                                                                    | 每个工具调用独立成块（v1 E6）                                                                                                                                             | P1                        |
| G9       | 审批框内容与中文文案                                                                                       | 不知道在批准改哪个文件；选项编号跳号；中英混排                                                    | 审批标题取工具名（`multi_edit`）而非目标路径；隐藏选项后未重新编号；部分 payload 文案未进 ZH 字典；spinner 动词 + 「完成于」语法冲突                                      | P1（与 v0.26 协调）       |
| G10      | 无 Rewind 面板                                                                                             | 想回退只能记命令                                                                                  | 仅 `/rewind`                                                                                                                                                              | P1                        |
| G11      | 历史不持久、无位置指示                                                                                     | 重启后 ↑ 为空；不知道在第几条                                                                     | `app.ts:353` 内存数组（v1 C6）                                                                                                                                            | P1                        |
| G12      | 未知转义序列漏进 composer                                                                                  | 偶发乱码字符（鼠标/焦点/功能键）                                                                  | `useInput` 把未识别 CSI 当作普通文本插入                                                                                                                                  | P1                        |
| G13      | 回合后无建议提示                                                                                           | —                                                                                                 | 无该功能                                                                                                                                                                  | P2                        |
| G14      | 运行中 `/` 命令全关（v1 C3）、中断后队列自动发出（v1 C9）、无 Ctrl+G（v1 T5.4）、启动期按键丢失（v1 T4.8） | —                                                                                                 | 见 v1                                                                                                                                                                     | P1/P2                     |
| E1/E2/E5 | 幽灵帧、清屏风暴、跨轮粘连                                                                                 | 闪屏、错位                                                                                        | 见 §2.3                                                                                                                                                                   | **P0**（E1/E2）/ P1（E5） |

---

## 4. 决策

### D0（已拍板 2026-10-08）：全屏渲染器为默认，primary screen 内联形态为回退

**决定**：TTY 下默认进入全屏渲染器（备用屏 + 鼠标跟踪 + 应用内虚拟滚动），与本机 CC 当前形态一致；
v0.22 的 primary screen 内联形态保留为回退（`MOSS_TUI_RENDERER=inline` / `/tui inline`，以及自动探测到
不适合全屏的环境）；非 TTY / `MOSS_NO_TUI=1` / Windows 仍走 readline REPL，不变。
**连带修改**：AGENTS.md 支持矩阵「交互面」一行、`docs/cli-parity/target-spec.md` §Z「不做全屏」条目、
v1 §11 第 4 条「不要把主界面切到 alternate screen」——在全屏渲染器合入的同一 PR 中更新（T7.2）。

以下为决策时依据的事实与取舍，保留备查。

**事实**：本机 CC 2.1.286/2.1.293 在没有任何显式配置（`~/.claude/settings.json`、`~/.claude.json`
均无 renderer 相关项）的情况下整场运行在备用屏；其 `/tui` 命令的说明为 `Set the terminal UI renderer
(default | fullscreen)`（`docs/cli-parity/claude-code-surface.md` §13）。**这是否已对所有用户默认开启，
本机无法确认**（可能是灰度开关）。v0.22 对齐时（2.1.285）记录的是 primary screen + 终端 scrollback 形态。

**两种形态的取舍**：

|          | primary screen（moss 现状，v0.22 形态）        | 全屏渲染器（CC 当前本机形态）                                |
| -------- | ---------------------------------------------- | ------------------------------------------------------------ |
| 回看     | 终端原生 scrollback，退出后仍在                | 应用内虚拟滚动；退出后 transcript 不留在终端                 |
| 复制     | 终端原生选择                                   | 应用内选区 + 自动复制（需 OSC 52 或 pbcopy）                 |
| 点击     | 无                                             | 点击定位光标、点击按钮/跳到底部                              |
| 输出成本 | 已提交内容不可重绘；动态区超高就整屏重放（E2） | 只差量重绘可见区，字节量约 1/6，不存在「重放历史」           |
| 实现成本 | 修 G1–G7 即可                                  | 新渲染层：虚拟 viewport、滚动、选区、鼠标路由、resize 重排   |
| 风险     | 低                                             | tmux/screen/SSH/Windows 终端兼容性；与 REPL 回退形态差异变大 |

**由决策带来的硬约束**（实施必须满足，否则不得切默认）：

1. **退出后不丢上下文**：备用屏退出时终端回到启动前画面，transcript 消失。退出时必须在 primary screen 打印
   一份会话收尾（至少：会话 id、`moss resume <id>` 提示、最后一条回答）；完整 transcript 由 `/export` 获取。
   CC 退出行为本次未实测，实施前用 `--compare claude` 核对并照做。
2. **复制可用**：开启鼠标跟踪后终端原生选择失效（多数终端需按住 Option/Shift 才能原生选择）。必须提供应用内
   选区复制（OSC 52，macOS 回退 `pbcopy`），并在 `?` 帮助中说明原生选择的修饰键。
3. **自动回退**：`TERM=dumb`、终端行数 < 10、tmux/screen 未开启鼠标、用户显式 `inline` 时进入回退形态；
   回退形态必须保持当前全部能力（Phase 1 的修复对两种形态都生效）。
4. **回看等价**：应用内滚动必须能回看本会话全部内容（不是只保留最近 N 屏）；长会话内存占用纳入基准。

### D1–D4：v1 已拍板，继续有效（2026-10-08 产品负责人）

总原则：**与 Claude Code 保持一致；不确定的以 CC 为准；moss 自有的冲突项可以删除。**

- D1 运行中 Enter = 排到下一轮；Esc = 取消当前轮。本次实测补充 CC 细节：排队消息显示在流式内容下方、
  `ctrl+x ctrl+s to send now` 立即发送、composer 占位 `Press up to edit queued messages`、↑ 取回编辑。
- D2 移除 `y/a/n` 裸字母审批（实测 moss 已对 `x` 无反应，但 `y/a/n` 仍是答复键，见 v1 C1）。
- D3 Ctrl+G = 外部编辑器；删除 deployments 快捷键。
- D4 Ctrl+T = 切换 todo 面板；moss 自有 Ctrl+T/V/G/F 快捷键删除，功能走 slash 命令。

### D5（新，建议直接按 CC 做，不必再问）

- 审批期间隐藏 composer 与硬件光标（CC 行为，减少「我该在哪输入」的困惑）。
- 回合结束后的灰色建议提示（G13）作为 P2，可延后，不阻塞其他任务。

---

## 5. 体感 SLO（可自动测量）

在 v1 S1–S12 基础上增补 S13–S18（全部由 Phase 0 基准自动判定）。

| #       | SLO                                                  | 基线（`58e7f614`）            | 目标                                     |
| ------- | ---------------------------------------------------- | ----------------------------- | ---------------------------------------- |
| S1      | 按键回显 p95 / max                                   | p50 7–9ms，偶发 75ms          | p95 ≤ 33ms，max ≤ 100ms                  |
| S2      | 非 resize 的整屏清除次数（≥ 80×10）                  | 90×14 工具风暴 372 次 / 8s    | 0                                        |
| S3      | 动态区高度                                           | 无上限                        | ≤ rows − 1                               |
| S4      | TUI 存活期间绕过 ink 直写 TTY 的字节                 | 默认日志级别下 > 0            | 0                                        |
| S5      | 已完成 markdown 块进入 scrollback 的延迟             | 整轮结束前不进入              | ≤ 100ms                                  |
| S6      | 运行中提交消息的回显次数                             | 2 次，且位置错误              | 1 次，下一轮发出时落位                   |
| S7      | 审批弹出 350ms 内按键被当作答复                      | 是（`y/a/n`）                 | 否                                       |
| S8      | Ctrl+O 对 scrollback 的写入                          | 整段 transcript ×2（开 + 关） | 0                                        |
| S9      | 首次 `@` 菜单（5 万文件）                            | 同步阻塞                      | ≤ 50ms 且不阻塞输入                      |
| S10     | 粘贴后草稿保留、可在前后继续输入、Backspace 整体删除 | 全部失败                      | 全部满足                                 |
| S11     | 运行中可用的 `/` 命令                                | 0                             | 只读即时执行，其余排队                   |
| S12     | 启动到可输入；启动期按键不丢                         | 0.64–1.0s；丢失               | ≤ 1.0s；不丢                             |
| **S13** | **硬件光标可见且位于插入点**（含宽字符、多行、折行） | 隐藏，固定在 (0, 最后一行)    | 空闲/运行中均满足；审批/查看器打开时隐藏 |
| **S14** | **光标移动时 composer 文本的单元格位置不变**         | 每次移动整行右移 1 格         | 不变                                     |
| **S15** | **缩放后屏幕上 composer 分隔线组数**                 | 2 组（残影）                  | 恰好 1 组                                |
| **S16** | **未知转义序列进入 composer 的字节**                 | `ESC[<…M` 全部进入            | 0                                        |
| **S17** | **空 composer 按 `?` 到帮助面板出现**                | 不出现                        | ≤ 100ms                                  |
| **S18** | **同剧本总写出字节（`main` 100×30）**                | 1.10MB                        | ≤ 550KB（−50%）；全屏渲染器 ≤ 250KB      |

---

## 6. 设计原则与不变量

沿用 v1 §4 全部条目（形态不变、终端唯一出口、帧预算、已提交即事实、键不误伤、不丢用户输入、
纯函数优先、SDK 公共面不动、本地化、REPL 回退永久保留、子进程纪律），并增补：

1. **光标是真的**：TUI 只显示**一个**光标，即硬件光标，位置由 composer 投影计算出的 (row, col) 通过
   `useCursor().setCursorPosition` 设置；不再用插入或覆盖字符的方式画光标。模态（审批、查看器、选择器）
   打开时 `setCursorPosition(undefined)` 隐藏。
2. **键流先分类再分发**：stdin 字节先经一个纯函数分类器（printable / 已知键 / 粘贴 / 鼠标 / 焦点 / 未知 CSI），
   只有 printable 与已知键进入 composer；未知序列丢弃并计数（debug 日志可见）。
3. **渲染器可替换**：transcript 的语法投影（`transcript.ts` / `markdown.ts` → `TuiLine[]`）是两种渲染器
   共用的唯一来源；全屏渲染器只负责「把 `TuiLine[]` 切成可见窗口」，内联渲染器只负责「把已提交的
   `TuiLine[]` 交给 `<Static>`」。任何行语法改动都不得只在一个渲染器里做。
4. **鼠标是增强，不是前提**：所有操作都必须有键盘路径（滚动：PgUp/PgDn、Ctrl+Home/End；跳到底部：End；
   复制：查看器内选择 + `y`）。回退形态不开鼠标。
5. **v1 §4「形态不变」条目按 D0 修订**：单列 transcript、底部 composer、`❯ ⏺ ⎿ ✻` 标记语法、内联审批
   不变；「transcript 进终端 scrollback」改为「transcript 进应用内可滚动视口（全屏）/ 终端 scrollback（回退）」。

---

## 7. 分阶段实施

每个任务一个（或几个）独立 commit；每个 commit 后 `npm run test:filter -- --filter tui` 绿；阶段结束跑
`npm run verify` + Phase 0 基准 + §8.3 真实终端人工清单。修 bug 的任务必须先写**修复前失败**的 spec。

### Phase 0 — 测量护栏（0.5–1 天）

**T0.1 长会话对照基准入库**

- 把 `scratch/cc-vs-moss/session.py` 与 v1 的 `scratch/tui-feel-probe/{stub.mjs,probe.py}` 合并为
  `scripts/tui-feel/`：
  - `driver.py`：PTY + `pyte.HistoryScreen`，记录 §1.1 的全部字段；`python3`/`pyte` 缺失时跳过
    （沿用 `scripts/smoke-moss-cli.mjs` 的做法）。
  - `scenarios/*.json`：把 §1.2 的三个剧本 + v1 的零配额场景（longstream、toolstorm、ghost-on-retry、
    resize-shrink、approval-popup-while-typing）改为数据驱动的步骤 DSL；剧本支持 `waitIdle`、
    `ifApproval`、`expect` 断言。
  - `stub.mjs`：零配额 OpenAI 兼容 stub（注意 v1 记录的坑：流式定时器监听 `res.on('close')`）。
  - `run.mjs`：默认用 stub 跑 moss 全部场景并按 §5 判定 SLO，输出 `bench/results/tui-feel-<ts>.json`
    （不入库）；`--real` 用本机配置跑真实模型；`--compare claude` 同剧本跑本机 `claude` 并生成并排截屏。
- `package.json`：`"bench:tui-feel": "npm run build && node scripts/tui-feel/run.mjs"`；AGENTS.md 命令表补一行。
- 验收：在 `58e7f614` 上跑出的 JSON 复现 §2 与 §5 基线列（S13–S17 全部判为失败）。

**T0.2 进程内帧预算 spec**：同 v1 T0.2（ink `render()` + 假 TTY Writable，统计 `ESC[2J` 与动态区高度；
先以 skip 入库，Phase 2 转绿）。

**T0.3 键流与光标 spec 骨架**：新建 `test/tui-cursor.spec.mjs`、`test/tui-key-stream.spec.mjs`，
写入 G1/G3/G12 的失败用例（先红，标注将在 Phase 1 转绿）。

### Phase 1 — 输入手感（P0，2–3 天；本地小改动，收益最大）

**T1.1 真实硬件光标与输入法定位（G1，S13/S14）**

- `composer.ts`：
  - 删除插入反色空格与 `caretGlyph` 两条分支；投影函数改为返回 `{ lines, caretRow, caretCol }`
    （`caretCol` 以单元格计，含前缀宽度；宽字符、折行、滚动窗口、`… ` 省略头都要算对）。
  - 保留「整行恰好填满时为光标补一个合成行」的逻辑（`composer.ts:348-353`），这是光标落点的合法位置。
- `app.ts`（或 Phase 3 后的 `components/composer-view.ts`）：用 ink `useCursor()`，在每次渲染后按
  composer 在动态区中的行偏移 + `caretRow/caretCol` 调用 `setCursorPosition({ x, y })`。
  y 是**相对 ink 输出原点**（动态区顶部）的行号，必须由与渲染相同的布局数据计算，不得硬编码固定行数。
- 隐藏时机：审批/提问对话框、Ctrl+O 查看器、会话选择器、模型选择器打开时 `setCursorPosition(undefined)`；
  运行中**不**隐藏（运行中仍可打字）。
- 占位文本（`Try "…"`）时光标在 `❯ ` 之后第一个单元格，占位文本以 dim 显示且不影响光标。
- 验收：
  - `tui-cursor.spec.mjs`：性质测试——随机中英混排文本 × 随机光标位置 × 宽度 20–120，断言
    `caretCol` 等于前缀宽度 + 光标前文本的单元格宽度（折行后按行计）；光标移动前后各行文本不变（S14）。
  - PTY：`main` 剧本 `01–05` 截屏中硬件光标可见，坐标与 CC 同一截屏一致（CC：22/16/20/2/22 列）。
  - 人工：iTerm2、Terminal.app、VS Code 终端中用系统拼音输入法输入中文，候选框出现在输入位置旁。

**T1.2 粘贴 token 与草稿保留（G2，S10）**

- 先用 systematic-debugging 定位「粘贴后输入无效、Backspace 无效、↑ 无效」的具体短路分支，写失败 spec。
- 用 ink 7 的 `usePaste` 替换 `app.ts:2577-2600` 的自研 `stdin.on('data')` 监听与 `input-box.ts` 的捕获。
- 新建 `paste-tokens.ts`（纯）：≤ 2 行且 ≤ 800 字符的粘贴直接插入光标处；更大的粘贴在光标处插入原子
  token `[Pasted text #n +N lines]`（文案对齐 CC，走 `tui()` 并补 zh），内容存在 composer 侧表。
  token 作为不可分割单元：光标跳过、Backspace 整体删除、Ctrl+W 视为一个词；提交时按序展开为原文。
- 「再次粘贴展开」（CC 页脚 `paste again to expand`）作为可选项，放在 T1.2 末尾，时间不够可延后。
- `> 100k` 字符的大粘贴保留现有 LARGE 警示语义，并入 token 文案。
- transcript 中的用户行显示 token 形式（不把 300 行打进 scrollback），模型收到展开后的全文。
- 验收：spec——`请看日志：` → 粘贴 300 行 → ` 哪里报错？` → Enter，模型收到
  `请看日志：\n<300 行>\n 哪里报错？`；transcript 行含 token；Backspace 一次删除整个 token；
  粘贴后 ↑ 历史可用。PTY `main` 剧本 `29–30` 与 CC 截屏形态一致。

**T1.3 键流分类器（G12，S16）**

- 新建 `input/key-stream.ts`（纯）：把一个 stdin chunk 拆为 `printable | key | mouse | focus | unknown-csi`
  事件序列（处理被拆到两个 chunk 的转义序列；注意与 ink 自身的按键解析不重复——若 ink `useInput`
  已经把序列拆成 `input` 字符串传入，则在 `useInput` 入口先过滤，不另起 stdin 监听）。
- composer 只接收 `printable` 与已知 `key`；`mouse`/`focus`/`unknown-csi` 丢弃。
- 验收：spec 覆盖 SGR 鼠标、X10 鼠标、焦点 `ESC[I`/`ESC[O`、F1–F12、`ESC[200~` 残片；
  PTY `zh` 剧本 `z09` composer 为空。

**T1.4 `?` 即时帮助（G3，S17）**

- composer 为空（不含占位）时按 `?` 直接打开帮助面板（与 CC 一致，三列布局走帧预算）；composer 非空时
  `?` 是普通字符。保留提交 `/help` 的路径。
- 验收：spec + PTY `z01` 截屏出现键位表。

**T1.5 审批框内容与本地化（G9，与 v0.26 协调）**

- 审批标题/问句的目标取**被修改的路径**（多文件编辑时列出文件，超出时 `+N more`），不是工具名。
- 隐藏选项后重新连续编号；页脚 `1/2/3 作答` 由实际选项数生成。
- 所有审批 payload 文案（`Do you want to proceed?`、`Yes, and always allow exec (saved)` 等）进 ZH 字典。
- 审批期间隐藏 composer 与硬件光标（D5）。
- spinner 完成行：zh 下用完成态措辞（例如 `✻ 用时 43s · 完成于 16:21`），不要「探测中」+「完成于」并列。
- 「自动接受编辑已开启」时仍弹出编辑审批：**这是 v0.26 的权限语义问题，不在本方案修**，转交 v0.26 负责人
  核对（`multi_edit` 是否被归入编辑类）。
- **文件冲突**：`approval-view.ts`（N1 冻结接口）、`copy.ts`、`transcript.ts` 正被 v0.26 修改。
  T1.5 必须在 v0.26 合入 main 后开工，或由 v0.26 负责人在其 PR 内一并处理。
- 验收：spec（zh/en 双 locale）；PTY `zh` 剧本 `z06-*` 标题为文件路径、选项编号连续、无英文残留。

### Phase 2 — 共用输出通道与布局（P0，1.5–2 天）

**T2.1 TUI 期间唯一输出出口（E1，S4）**：同 v1 T1.1（`logger` 注入 sink、`terminal-io.ts`、清理
`tool-hooks.ts` / `cli/hooks.ts` / `agent-loop.ts` 中的直写、`/clear` 与 `notifyAttention` 改用
`useStdout().write`）。全屏下任何直写都会直接打碎画面，这是全屏渲染器的前置条件。

**T2.2 帧布局分配器（E2，S2/S3）**：同 v1 T1.2 的 `layout.ts` 纯函数，但输出改为两种渲染器共用的布局：
`{ chrome: TuiLine[][], composer: { lines, caretRow, caretCol }, viewportRows }`。

- 内联形态：动态区总高 ≤ rows − 1（S3），优先级 dialog > overlay > status-notes > todo > queue > live。
- 全屏形态：`viewportRows = rows − chrome − composer`，viewport 恒 ≥ 3 行；chrome 超预算时按同一优先级裁剪。
- 同一份布局数据给 T1.1 提供光标的屏幕坐标。

**T2.3 内联形态的 Ctrl+O 临时修复（G6，S8）**：删除 `verboseRevision` 重挂 `<Static>` 的机制（`app.ts:2518`、
`2908`），Ctrl+O 只切换后续内容的详细程度。全屏形态下 Ctrl+O 由 T4.5 处理。验收：内联形态 `main` 剧本结束后
`history.txt` 中 banner 恰好 1 个。

### Phase 3 — 结构拆分（无行为变化，2–3 天）

同 v1 Phase 2（store 订阅化、键位路由分层栈、控制器 hooks、slash 命令表化、组件化 + Spinner 自带定时器），
并新增本方案必需的一刀：

- **T3.6 渲染器接口**：`components/transcript-surface.ts` 定义

  ```ts
  interface TranscriptSurfaceProps {
    rows: readonly TranscriptRow[]; // 已提交
    live: TuiLine[]; // 流式 / spinner / 队列
    width: number;
    viewportRows: number; // 内联形态忽略
  }
  ```

  现有 `<Static>` + live 区实现搬进 `inline-surface.ts`（纯搬移）；`runTuiApp` 根据渲染器选择挂载哪一个。

阶段验收：`app.ts` < 600 行；全部 tui spec 不改断言地通过；T0.1 基准各指标不劣化（±10%）。

### Phase 4 — 全屏渲染器（默认，P0，6–9 天）

**T4.1 viewport 模型（纯）**：新建 `viewport.ts`

- 输入：全部 transcript 行投影（`TuiLine[]`，按 row 缓存，宽度变化时整体重投影）+ live 行 + `viewportRows`；
  状态：`{ offsetFromBottom, pinned }`。
- `pinned = true`（贴底）时新内容自动可见；用户向上滚动后 `pinned = false`，新内容只累加未读计数，
  **打字不改变滚动位置**（CC 实测 `m03`）。
- resize：以 viewport 顶部可见的「row id + 行内偏移」为锚点重排，保持用户正在看的内容不跳。
- 性能：只投影可见窗口附近的 row（上下各一屏缓冲），长会话不随历史线性变慢；行投影结果按 `(rowId, width)` 缓存。
- 验收：`test/tui-viewport.spec.mjs` 性质测试——随机追加/滚动/resize 序列下，可见窗口不越界、锚点 row
  在 resize 后仍可见、贴底时最后一行恒可见；1 万 row 下单次滚动 ≤ 5ms。

**T4.2 全屏外壳**

- `render(..., { alternateScreen: true })`（ink 7.1.1 原生选项）；根节点固定高度 = rows：
  viewport（`T4.1` 的可见行）+ chrome + composer + 提示行。
- 流式内容直接在 viewport 中**完整渲染**（开放块用稳定前缀算法渲染已闭合部分、尾部 plain），
  因此全屏形态下 G4 无需 `stream-commit`；回合结束后该 row 原地定稿，不重复、不跳动。
- 已提交 row 在全屏下**可以重投影**（宽度变化、Ctrl+O 详细模式），这是相对 `<Static>` 的本质优势。
- 验收：PTY `main` 剧本全程 `ESC[2J` 仅在进入与 resize 时出现；流式 10s 截屏可见渲染后的第一个标题；
  S18 ≤ 250KB。

**T4.3 鼠标与键盘滚动**

- 进入时经 `useStdout().write` 开启 `?1000h ?1002h ?1006h`（按需 `?1003h`）与 `?1004h`，退出/挂起时关闭
  （`suspendTerminal` 前后、异常退出路径都要恢复，复用 ink 的 teardown 钩子）。
- T1.3 键流分类器解析 SGR 鼠标事件并路由：滚轮 → viewport；左键点击 composer → 光标定位（按单元格宽度
  换算到字符偏移，宽字符点在右半格时落到该字符）；点击 `Jump to bottom (click) ↓` → 贴底；
  拖拽 → T4.4 选区。
- 键盘等价：PgUp/PgDn 翻页、Ctrl+Home/Ctrl+End 到顶/底（composer 有内容时 Home/End 仍属于 composer）。
- 离开底部时 viewport 右下浮出 `Jump to bottom (click) ↓`（走 `tui()`，zh：`跳到底部（点击）↓`），
  有未读内容时附计数。
- 验收：`mouse` 剧本对 moss 跑通 `m01–m05`，形态与 CC 一致；spec 覆盖点击宽字符左右半格。

**T4.4 选区与复制**

- 拖拽产生应用内选区（反色高亮），松开时复制：优先 OSC 52（`ESC]52;c;<base64>BEL`），macOS 下同时经
  `runProcess('pbcopy')` 兜底；提示 `copied N chars to clipboard`，可在配置中关闭自动复制。
- 复制内容取 `TuiLine` 的纯文本（去掉 `⎿ ` 等装饰前缀的规则与 `/export` 一致），宽字符不拆半。
- `?` 帮助中说明：按住 Option（iTerm2/Terminal.app）或 Shift（多数 Linux 终端）可用终端原生选择。
- 验收：spec 覆盖跨行选区、含宽字符选区、选区跨越折叠块；PTY `m07` 出现复制提示。

**T4.5 全屏下的 Ctrl+O 详细视图（S8）**：不再需要 v1 T5.1 的 `suspendTerminal` 独立查看器——在同一 viewport
内把全部 row 以 verbose 重投影（显示时间戳与模型名、折叠块全展开、reasoning 全文），页脚
`Showing detailed transcript · ctrl+o to toggle`，退出时恢复原滚动锚点。验收：PTY `27–28` 形态与 CC 一致。

**T4.6 退出与挂起**

- 正常退出（Ctrl+C ×2、Ctrl+D、`/exit`）：离开备用屏后在 primary screen 打印会话收尾（D0 硬约束 1）。
- 异常退出（未捕获异常、SIGTERM）：恢复终端模式（备用屏、鼠标、光标、括号粘贴）后再打印错误。
- Ctrl+Z：关闭鼠标与备用屏后挂起，`fg` 回来后重新进入并整屏重绘。
- 验收：PTY 三种退出路径后终端模式全部恢复（原始字节中每个 `h` 都有对应 `l`）；收尾内容来自真实会话数据。

**T4.7 渲染器选择与自动回退**

- 优先级：`MOSS_TUI_RENDERER=inline|fullscreen` > 配置 `tui.renderer` > 自动探测（默认 fullscreen）。
- 自动回退到 inline：`TERM=dumb`、rows < 10、tmux 中 `mouse` 选项为 off（经 `runProcess('tmux',
['show','-gv','mouse'])` 探测，失败按 off 处理）、GNU screen。
- `/tui` 命令：无参数显示当前渲染器与原因；`/tui inline|fullscreen` 写入配置，下次启动生效
  （运行中切换需要重挂 ink，第一版不做）。
- 验收：spec 覆盖探测矩阵；`/status` 显示当前渲染器。

### Phase 5 — 队列、流式与审批语义（P0，3–4 天，两种形态共用）

**T5.1 待送达消息模型（G5，S6，D1）**：同 v1 T4.1，并按本次 CC 实测补齐：

- 排队消息不进 transcript，显示在 live 区底部（流式内容之下），`❯ <消息>` dim，下附 `ctrl+x ctrl+s to send now`；
- 立即发送 = 取消当前轮并以该消息开启下一轮（不使用 `/steer`）；
- 有排队消息时 composer 占位为 `Press up to edit queued messages`（走 `tui()`），↑ 取回最后一条编辑；
- Esc 中断后未送达的排队消息退回 composer（v1 C9），不自动发出。
- 验收：PTY `main` 剧本 `22` 截屏形态与 CC 一致；对应 transcript 中 `然后用一句话总结` 恰好 1 次且在 GIL 回答之后。

**T5.2 轮次边界冲刷（E5）**：同 v1 T3.2。

**T5.3 思考呈现**：同 v1 T3.3（运行中一行 `∴ Thinking… (Ns)`，结束后 `Thought for Ns`）。

**T5.4 审批防误触（D2，S7）**：同 v1 T4.2。

**T5.5 运行中 `/` 命令（S11）**：同 v1 T4.3。

### Phase 6 — CC 交互件（P1，3–4 天）

- **T6.1 只读工具折叠（G8）**：同 v1 T5.2；文案对齐 CC：`Thought for 2s, read 4 files, listed 2 directories`；
  shell 命令运行中 `Running 1 shell command…`、完成后 `Ran 1 shell command`。全屏下点击折叠行可展开
  （键盘等价：Ctrl+O）。
- **T6.2 Esc Esc → Rewind 面板（G10）**：同 v1 T5.3；面板文案对齐 CC：
  `Rewind / Restore the code and/or conversation to the point before…`，每项显示消息首行与
  `No code changes` / 改动文件数。
- **T6.3 Ctrl+G 外部编辑器（D3）**：同 v1 T5.4（`suspendTerminal` 内要先关鼠标、离开备用屏）；
  多行时右侧显示 `ctrl+g to edit in $EDITOR`。
- **T6.4 键位对齐 CC（D4）**：同 v1 T5.5。
- **T6.5 历史持久化与位置指示（G11）**：同 v1 T4.6，并在浏览历史时于分隔线显示 `History k/N`，页脚提示
  `ctrl+r to search history`。
- **T6.6 `@` 索引异步化（S9）**：同 v1 T4.5。保持「只列工作区文件」的现有优点，不引入全局路径。
- **T6.7 Kitty 键盘协议与启动期按键（S12）**：同 v1 T4.7、T4.8。
- **T6.8 回合后建议提示（G13，P2，可延后）**：回合结束时生成一条灰色建议（额外模型调用，默认关闭，配置开启；
  Tab/→ 接受）。实现前评估 token 成本。

### Phase 7 — 回退形态加固与收尾（1.5–2 天）

- **T7.1 内联形态专项**（只在 `inline` 下生效）：
  - 流式块渐进提交（G4/S5）：同 v1 T3.1 的 `stream-commit.ts`；live 尾部按块边界截取，不从半个单词开始。
  - 缩放残影（G7/S15）：在 `useWindowSize` 变化时按旧宽度估算软换行后的实际占用行数，多擦后重绘。
  - `incrementalRendering` / `maxFps` 评估（v1 T1.3）。
- **T7.2 文档与契约**（与 Phase 4 合入同一 PR）：AGENTS.md 支持矩阵「交互面」改为「TTY：全屏渲染器（备用屏 +
  鼠标，默认）/ 内联形态（回退）」；`target-spec.md` §Z 删除「不做全屏」并增补「体感」节（S1–S18 与基准命令）；
  `claude-code-surface.md` 补充 2.1.286 全屏渲染器观测（§2.2 第 27–29 行）；release note 写明默认形态变化与
  `MOSS_TUI_RENDERER=inline` 回退方式。
- **T7.3 文案**：新增文案全部 zh 覆盖；`?` 帮助键位表同步（滚动、复制修饰键、`/tui`、队列、Ctrl+G 等）。

---

## 8. 验收体系

### 8.1 阶段门禁

| 阶段 | 必须绿的 spec                                                    | 必须达标的 SLO                                  |
| ---- | ---------------------------------------------------------------- | ----------------------------------------------- |
| P0   | 现有全部；新增 spec 以 skip/失败标注入库                         | 基准 JSON 复现 §5 基线                          |
| P1   | + `tui-cursor`、`tui-key-stream`、粘贴 token、审批文案（zh/en）  | S10、S13、S14、S16、S17                         |
| P2   | + `tui-frame-budget` 转绿、`tui-layout`、`tui-terminal-io`       | S2、S3、S4、S8（内联临时）                      |
| P3   | 全部 tui spec 不改断言通过                                       | S1 不劣化；S18 ±10%                             |
| P4   | + `tui-viewport`、全屏外壳、鼠标路由、选区、退出恢复、渲染器探测 | S5、S8、S15、S18（全屏 ≤ 250KB），D0 四条硬约束 |
| P5   | + 队列、轮次冲刷、防误触、运行中命令                             | S6、S7、S11                                     |
| P6   | + 工具折叠、rewind、外部编辑器、历史、异步索引                   | S9、S12                                         |
| P7   | + 内联形态流式提交、resize 残影                                  | 内联形态 S5、S15                                |
| 全部 | `npm run verify` 全绿；两种渲染器各跑一遍 `main`/`zh` 剧本       | S1–S18 写入 §9                                  |

### 8.2 与 CC 的并排复核

体感类任务（T1.1、T1.2、T4.2–T4.6、T5.1、T6.1、T6.2）完成后，用
`npm run bench:tui-feel -- --real --compare claude` 跑一次对应剧本，把关键帧并排贴进 PR 说明。
CC 需要真实额度，每个任务收尾只跑一次。CC 会自动升级（本次测试中途从 2.1.286 升到 2.1.293），对照结果需注明
CC 版本。

### 8.3 真实终端人工清单（pyte 覆盖不到）

每阶段收尾在 iTerm2、macOS Terminal、VS Code 内置终端各过一遍；Phase 4 起加 tmux（mouse on/off 两态）与
SSH 远端。结果写进 PR 说明（「跑了什么、没跑什么」）：

1. **系统拼音输入法**输入中文：候选框位置、上屏后光标位置、组合过程中按 ← → 的表现。
2. 光标样式（块/竖线/下划线、闪烁）是否遵循终端设置。
3. 长回答边生成边滚动回看；15 行高分屏里跑工具风暴；运行中打字回车再 Esc；粘贴 300 行并前后补字；
   Ctrl+O 进出；缩窄/放大窗口。
4. 全屏：滚轮、`Jump to bottom`、点击定位光标、拖选复制后在别处粘贴、Option/Shift 原生选择、
   正常/异常/Ctrl+Z 退出后终端状态与收尾内容。

---

## 9. 进度与基线记录（实施者维护）

| 日期       | 阶段/任务 | commit   | 渲染器 | S1 p95                               | S2 清屏(90×14) | S6   | S13 光标   | S18 字节 | 备注                     |
| ---------- | --------- | -------- | ------ | ------------------------------------ | -------------- | ---- | ---------- | -------- | ------------------------ |
| 2026-10-08 | 基线      | 58e7f614 | inline | ~13ms（真实会话）/ 75ms（stub 偶发） | 372 / 8s       | 2 次 | 隐藏于左下 | 1.10MB   | 本文 §2；CC 同剧本 175KB |
| 2026-10-08 | P0–P2 代码落地（未跑 PTY 基线） | worktree `tui/cc-feel-v2` | fullscreen 默认 / inline 回退 | 未重测 | 未重测 | 排队不再双写 transcript | 投影给出 caretCol，硬件光标由 useCursor 放置 | 未重测 | tui spec 绿；全屏点击/选区/结构拆分未做 |

---

## 10. 风险与回退

| 风险                                 | 缓解                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `useCursor` 的坐标与实际渲染行不一致 | 坐标由 T2.2 布局数据计算；性质测试覆盖各状态组合；PTY 断言光标下字符                             |
| 某些终端在硬件光标可见时闪烁         | 在同步输出（`?2026`）内移动光标；人工清单覆盖；`MOSS_TUI_HW_CURSOR=0` 应急开关（一个版本后删除） |
| 全屏退出后用户找不到刚才的内容       | D0 硬约束 1：退出收尾 + `moss resume` 提示；`/export`                                            |
| 鼠标跟踪导致无法原生复制             | 应用内选区复制 + 帮助中说明修饰键；配置可关鼠标（仍保留全屏）                                    |
| tmux/screen/SSH 下鼠标或备用屏异常   | 自动探测回退 inline；`MOSS_TUI_RENDERER=inline` 一键回退                                         |
| 异常退出后终端停留在备用屏/鼠标模式  | T4.6 的 teardown 覆盖所有退出路径；spec 检查每个 `h` 都有 `l`                                    |
| 长会话 viewport 投影变慢 / 内存增长  | 只投影可见窗口附近的 row + 按 `(rowId, width)` 缓存；基准纳入 1 万 row 与 2 小时会话 RSS         |
| 粘贴迁移到 `usePaste` 后旧 spec 失效 | 迁移 spec 后删除 `input-box.ts`；行为变更写进 commit 说明                                        |
| 与 v0.26 改同一批文件                | 见 §11；T1.5 由 v0.26 负责人处理或在 v0.26 合入后开工                                            |
| 结构拆分回归、kitty 探测误判         | 同 v1 §10                                                                                        |

---

## 11. 交接与协调

1. **工作区**：v0.26 合入 main 后，从该 commit 开新 worktree：
   `git worktree add ../moss-tui-feel-v2 -b tui/cc-feel-v2 <v0.26 合入后的 main commit>`。
   现有 `../moss-tui-feel`（分支 `tui/cc-feel`，只有一个包含 v1 文档的 checkpoint commit）可作为基准构建保留，
   不在其上开发。build / test / bench 全在新 worktree；禁止 `git add -A` / `git add .`。
2. **可与 v0.26 并行的任务**（无文件交集）：T0.1–T0.3、T1.1（`composer.ts` + `app.ts` 渲染段局部）、
   T1.3（新纯模块）、T1.4（`app.ts:1576` 附近一处）、T2.1（`logger.ts` / `terminal-io.ts`）、
   T4.1（新纯模块 `viewport.ts`，不接线）。其余等 v0.26 合入。
3. **先读**：本文 §2–§4、§6；v1 §1（现状全景与数据流）、§5（目标架构）；`src/cli/tui/app.ts` 全文
   （注释记录了 D-1…D-15 的边界条件，拆分时不得丢失）；`docs/cli-parity/target-spec.md` §N；
   `node_modules/ink/build/render.d.ts` 中 `alternateScreen`、`useCursor`、`usePaste`、`suspendTerminal` 的说明。
4. **流程**：bug 类（T1.2、T2.1、T5.1、T5.2、T7.1）先 systematic-debugging 复现并写失败 spec；功能类按 TDD；
   每个任务完成跑 `npm run test:filter -- --filter tui` + 对应 PTY 剧本（两种渲染器）。
5. **不要做**：引入新依赖（ink 7.1.1 已有 `alternateScreen`、`useCursor`、`usePaste`、`suspendTerminal`、
   `kittyKeyboard`）；改 `src/index.ts` 导出面；改 v0.22 标记语法；删除 inline 回退或 REPL 回退；
   为了「像 CC」改 moss 的任务/证据/设备区块；改掉 `@` 菜单「只列工作区文件」的现有优点。
6. **报告**：每阶段在 §9 填一行真实数字（注明渲染器）；PR 说明写清跑了哪些 spec、哪些 PTY 剧本、哪些终端人工
   验证、哪些没跑。

### 建议工期

| 阶段 | 估时     | 并行                                                       |
| ---- | -------- | ---------------------------------------------------------- |
| P0   | 0.5–1 天 | 可与 v0.26 并行                                            |
| P1   | 2–3 天   | T1.1/T1.3/T1.4 可与 v0.26 并行；T1.2、T1.5 等 v0.26        |
| P2   | 1.5–2 天 | T2.1 可先行                                                |
| P3   | 2–3 天   | 串行（同一文件）                                           |
| P4   | 6–9 天   | T4.1 可最早并行开工；T4.3/T4.4 依赖 T1.3；T4.6/T4.7 可并行 |
| P5   | 3–4 天   | 与 P4 后半段可并行（T5.1 的 live 区接口在两种渲染器一致）  |
| P6   | 3–4 天   | 各项并行                                                   |
| P7   | 1.5–2 天 | T7.2 随 P4 合入                                            |

**最小可感知交付**：P0 + P1 + P2（约 4–6 天）先在现有内联形态上解决「吞字 / 光标错位 / 粘贴卡死 /
幽灵帧 / Ctrl+O 重复」；P3 + P4（约 8–12 天）切到全屏默认，一并解决流式可读性、缩放残影、清屏重放与鼠标交互。
合计约 20–28 个工作日。
