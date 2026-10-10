/**
 * TUI chrome localization (v0.25, Part B).
 *
 * Moss's own fixed chrome — help, key hints, resume picker, approval/question
 * footers, boot status, task notices, the bottom hint/status rows, and the
 * catalog command descriptions — renders in the user's locale. Everything that
 * is NOT moss's own wording is deliberately left alone: command names, keys,
 * paths, model / skill / MCP / tool names, user input, and every byte of model
 * or raw shell/git/MCP output.
 *
 * Design (deliberately simpler than a typed i18n object):
 *   - the dictionary is keyed by the EXACT English string the call site builds;
 *   - `tui(text, params)` looks the English string up under zh, and a miss
 *     passes the text through unchanged — so any string moss does not own (a
 *     command name, a path, a model's own output) is never touched;
 *   - English mode is byte-for-byte identical: `tui()` still substitutes
 *     `{placeholders}` so a parameterized template reproduces the old
 *     concatenation exactly. Existing specs run with `LANG=C` and must not
 *     change.
 *
 * There is no i18n framework and no dependency: the locale is decided once per
 * shell by `setTuiLocale(isZhLocale(locale))` at the app entry, and every
 * render reads the module-global flag. Pure mapping only — no ink imports, so
 * this module stays usable from the pure projections (and can never cycle back
 * into them).
 */

/** The active shell renders zh chrome. Defaults to false (English). */
let zhActive = false;

/** Install the shell's locale choice. Called once at the TUI entry. */
export function setTuiLocale(zh: boolean): void {
  zhActive = zh;
}

/** True when the shell should render zh chrome. */
export function isTuiZh(): boolean {
  return zhActive;
}

/** Esc during /goal or `moss task`. English is the dictionary key; zh is just 已中断. */
export const INTERRUPT_NOTICE = 'Interrupted — /goal resume to continue';

/** Esc in ordinary chat. Must not tell the user to resume a goal. */
export const CHAT_INTERRUPT_NOTICE = 'Interrupted';

const USER_ABORT_RESULT_PREFIX = 'Execution error: aborted_by_user';

/**
 * The engine's own user-cancel tool result. A command whose output merely
 * contains "This operation was aborted" (a Node fetch timeout, for example)
 * is not one of these.
 */
export function isUserAbortToolResult(result: unknown): boolean {
  return typeof result === 'string' && result.startsWith(USER_ABORT_RESULT_PREFIX);
}

/** Structured user Esc: `aborted.by === 'user'` or the engine's abort result prefix. */
export function isStructuredUserAbort(event: {
  aborted?: { by?: string };
  result?: unknown;
}): boolean {
  return event.aborted?.by === 'user' || isUserAbortToolResult(event.result);
}

/**
 * Error text the loop emits for Esc. The whole message has to be that abort,
 * so a longer tool error that quotes the same sentence stays a failure.
 */
export function isUserAbortErrorText(text: string): boolean {
  const message = text.trim();
  return (
    message === 'This operation was aborted' ||
    message.startsWith('agent run aborted before start:') ||
    message.startsWith(USER_ABORT_RESULT_PREFIX)
  );
}

export function interruptNoticeLine(): string {
  return tui(INTERRUPT_NOTICE);
}

export function chatInterruptNoticeLine(): string {
  return tui(CHAT_INTERRUPT_NOTICE);
}

/** Abort actor shown inside `aborted ({by})`. Only the two engine values are translated. */
export function localizeAbortActor(by: string | undefined): string {
  const actor = by ?? '';
  if (actor === 'user' || actor === 'timeout') return tui(actor);
  return actor;
}

/**
 * English (exact call-site string) → Simplified Chinese chrome. Exported so the
 * locale spec can verify the two invariants exhaustively: no zh value is itself
 * an English key (so `tui()` is idempotent), and every value is non-empty.
 */
export const ZH: Readonly<Record<string, string>> = {
  // ── interaction mode hint (transcript.ts) ──────────────────────────────
  '⏵⏵ {label} mode on': '⏵⏵ {label}已开启',
  '{glyph} {label} mode on (shift+tab to cycle)': '{glyph} {label}已开启 (shift+tab 切换)',

  // ── run verbs (transcript.ts) ──────────────────────────────────────────
  Working: '处理中',
  Thinking: '思考中',
  Probing: '探测中',
  Checking: '检查中',
  Wiring: '接线中',
  Verifying: '验证中',

  // ── tool completion headline (transcript.ts) ───────────────────────────
  ok: '成功',
  failed: '失败',

  // ── collapsed-preview markers (transcript.ts) ──────────────────────────
  '… {count} more lines · ctrl+o': '… 还有 {count} 行 · ctrl+o',
  '… {count} lines · ctrl+o': '… {count} 行 · ctrl+o',
  'ctrl+o to expand': 'ctrl+o 展开',
  '  ⎿ thought for {seconds}s · click or ctrl+o': '  ⎿ 思考了 {seconds} 秒 · 点击或 ctrl+o 展开',
  '  ⎿ thinking · click or ctrl+o': '  ⎿ 思考过程 · 点击或 ctrl+o',

  // ── live region (transcript.ts) ────────────────────────────────────────
  '  ↻ provider retry {attempt} — {error}': '  ↻ 提供方重试 {attempt} — {error}',
  ' · {count} out': ' · 输出 {count}',
  ' · {count} queued': ' · {count} 排队',
  '  … stream quiet for {seconds}s — the gateway may be stuck': '  … 流已静默 {seconds} 秒',
  '  … waiting for device': '  … 正在等待设备',
  'Waiting for device': '等待设备',
  '  ⏐ next: {preview}': '  ⏐ 下一条：{preview}',

  // ── run summary (transcript.ts) ────────────────────────────────────────
  ' · done {time}': ' · 完成于 {time}',
  '✻ {verb} for {seconds}s · interrupted': '✻ {verb} {seconds} 秒 · 已中断',
  user: '用户',
  timeout: '超时',
  'run interrupted': '运行已中断',
  'run finished': '运行已结束',
  'operation was interrupted': '操作已中断',
  'Cancelled: {message}': '已取消：{message}',
  '✻ {verb} for {seconds}s{doneAt}': '✻ {verb} {seconds} 秒{doneAt}',
  '✻ worked for {seconds}s{doneAt}': '✻ 用时 {seconds} 秒{doneAt}',

  // ── todo panel (transcript.ts / render-bridge.ts) ──────────────────────
  '{done}/{total} done': '{done}/{total} 完成',
  '{count} more': '还有 {count} 项',

  // ── approval (transcript.ts / approval-view.ts frozen defaults) ────────
  Yes: '是',
  "Yes, and don't ask again this session": '是，本次会话内不再询问',
  No: '否',
  'Esc to deny · ↑↓ then Enter': 'Esc 拒绝 · ↑↓ 后 Enter',
  'Do you want to proceed?': '是否继续？',
  'Do you want to make this edit to {target}?': '要对 {target} 做这个修改吗？',
  'Do you want to create {target}?': '要创建 {target} 吗？',
  'Yes, and always allow {tool} (saved)': '是，并始终允许 {tool}（已保存）',
  'Yes, and always allow {tool} this session': '是，并在本次会话始终允许 {tool}',
  'Yes, and don’t ask again for file edits this session': '是，本次会话内文件修改不再询问',
  'Yes, and don’t ask again for file edits (saved)': '是，文件修改不再询问（已保存）',
  'keys paused — dialog just opened': '按键已暂停 — 对话框刚刚打开',
  'Press up to edit queued messages': '按 ↑ 编辑排队消息',
  'ctrl+x ctrl+s to send now': 'ctrl+x ctrl+s 立即发送',
  '[Pasted text #{id} +{lines} lines]': '[粘贴文本 #{id} +{lines} 行]',
  'paste again to expand': '再次粘贴可展开',
  'Yes, and tell moss what to do next': '是，并告诉 moss 接下来做什么',
  'Esc to cancel · Tab to amend': 'Esc 取消 · Tab 补充说明',

  // ── composer placeholder (transcript.ts) ───────────────────────────────
  'Next: ask me to look around this folder.': '下一步：让我看看这个目录里有什么。',
  "workspace-write confines Moss's own file tools. Shell commands run normally without an OS sandbox.":
    'workspace-write 只约束 Moss 自己的文件工具。shell 命令照常运行，没有操作系统沙箱。',
  'terminal is shorter than 10 rows': '终端高度不足 10 行',
  'terminal is narrower than {min} columns': '终端宽度不足 {min} 列',
  '{reason} — using the inline view. Resize the window to use fullscreen.':
    '{reason} — 使用内联视图。把窗口拉大即可全屏。',
  '  Select model · {count} available · ↑↓ move · Enter this session · d save as default · Esc close':
    '  选择模型 · {count} 个 · ↑↓ 移动 · Enter 仅本会话 · d 存为默认 · Esc 关闭',
  'saved {model} as the default ({path})': '已把 {model} 存为默认（{path}）',
  'could not save the default: {error}': '没能保存默认模型：{error}',
  'Try "stream the camera at 30 fps and verify it"': '试试 “以 30 fps 推流相机并验证”',
  'Try "fix the failing test and explain the change"': '试试 “修好失败的测试，并说明改了什么”',
  'Try "look around and tell me what this folder is"': '试试 “看看这个目录是做什么的”',

  // ── status row (transcript.ts) ─────────────────────────────────────────
  '● waiting for you': '● 等待你的输入',
  '● running': '● 运行中',
  verbose: '详细',
  '› stashed': '› 已暂存',
  '{pct}% ctx': '{pct}% 上下文',
  'price unknown': '价格未知',
  '{count} out': '{count} 输出',
  '{in} in / {out} out': '{in} 入 / {out} 出',

  // ── hint row (transcript.ts) ───────────────────────────────────────────
  '! for shell mode': '! 进入 shell 模式',
  'Esc to cancel': 'Esc 取消',
  '? for shortcuts': '? 查看快捷键',
  '1/2/3 to answer': '1/2/3 作答',
  '{keys} to answer': '{keys} 作答',
  '  ❯ {preview}': '排队 ❯ {preview}',
  'type answer · Enter to send': '输入回答 · Enter 发送',
  'Esc to skip': 'Esc 跳过',
  'Tab to amend': 'Tab 补充说明',
  'Esc to interrupt': 'Esc 中断',
  'verbose transcript · ctrl+o to exit': '详细对话记录 · ctrl+o 退出',
  '{count} queued': '{count} 排队',
  '{count} task': '{count} 个任务',
  '{count} tasks': '{count} 个任务',

  // ── render bridge (render-bridge.ts) ───────────────────────────────────
  '↻ provider retry {attempt} — {error}': '↻ 提供方重试 {attempt} — {error}',
  'aborted ({by})': '已中止（{by}）',
  'compressed {count} old tool result': '压缩了 {count} 条旧工具结果',
  'compressed {count} old tool results': '压缩了 {count} 条旧工具结果',
  ' · saved ~{count} tokens': ' · 省下约 {count} tokens',
  'compacted {count} earlier messages': '已合并 {count} 条更早消息',
  ' · now ~{count} tokens': ' · 现在约 {count} tokens',

  // ── help overlay (app.ts / help.ts) ────────────────────────────────────
  Language: '语言',
  'PgUp / PgDn / wheel': 'PgUp / PgDn / 滚轮',
  click: '点击',
  prefixes: '前缀',
  shortcuts: '快捷键',
  'all commands': '全部命令',
  'common commands': '常用命令',
  'type / to browse commands · /help --all for the rest':
    '输入 / 浏览命令 · /help --all 查看其余命令',
  'edited JS/TS files but did not run tests': '改过 JS/TS 文件，但没有跑测试',
  'run a shell command inline (result lands in the transcript)':
    '内联执行 shell 命令（结果进入对话记录）',
  'run a moss command (/help lists them all)': '执行 moss 命令（/help 列出全部）',
  'reference a workspace file or directory': '引用工作区文件或目录',
  'send the goal · run the shell command in `!` mode': '发送目标 · 在 `!` 模式下执行 shell 命令',
  'cycle the interaction mode (manual → accept-edits → plan → full)':
    '循环切换交互模式（manual → accept-edits → plan → full）',
  'first character only: run a shell command inline': '仅限首字符：内联执行 shell 命令',
  'interrupt the run · cancel `!` shell mode · press again to clear the composer':
    '中断运行 · 取消 `!` shell 模式 · 再按清空输入框',
  'walk back through what you typed': '回溯你输入过的内容',
  'scroll the transcript · at the top, walk back through what you typed':
    '滚动对话记录 · 到顶后回溯你输入过的内容',
  'caret to line start / end': '光标移到行首 / 行尾',
  'delete to line start · paste deleted text': '删除到行首 · 粘贴已删除文本',
  'stash the draft · press again to bring it back': '暂存草稿 · 再按取回',
  'search your earlier prompts': '搜索早先的提示',
  'edit the draft in $EDITOR': '用 $EDITOR 编辑草稿',
  'scroll the transcript': '滚动对话记录',
  'scroll the transcript · End jumps to the latest': '滚动对话记录 · End 跳到最新',
  'expand a collapsed block · drag to copy': '展开被折叠的块 · 拖动复制',
  'print failures · deployments are /deployments': '打印 failures · deployments 用 /deployments',
  'print task artifacts': '打印任务工件',
  'work until a condition is met · enter plan mode': '做到条件满足 · 进入 plan 模式',
  aliases: '别名',
  'clear the composer': '清空输入框',
  'interrupt the run · press again to quit': '中断运行 · 再按退出',
  quit: '退出',
  'print tasks · evidence': '打印 tasks · evidence',
  'print deployments · failures': '打印 deployments · failures',
  'this list': '本列表',

  // ── catalog command descriptions (interactive-commands.ts) ─────────────
  'view model, workspace, and tool state': '查看模型、工作区与工具状态',
  'choose or switch the active model for this session': '为本会话选择或切换当前模型',
  'show or set interaction mode (plan = read-only planning; Shift+Tab cycles)':
    '查看或设置交互模式（plan = 只读规划；Shift+Tab 循环切换）',
  'compress older conversation history into a summary': '将较早的对话历史压缩为摘要',
  'run or inspect a verified Task OS task; view [tasks|history|evidence|deployments|failures] prints its artifacts':
    '运行或查看已校验的 Task OS 任务；view [tasks|history|evidence|deployments|failures] 打印其工件',
  'resume a failed, blocked, or abandoned task through Task OS':
    '通过 Task OS 恢复失败、受阻或已放弃的任务',
  'show current context-window usage': '查看当前上下文窗口用量',
  Usage: '用量',
  'show cumulative token usage for this session': '查看本会话累计 token 用量',
  'export this session to markdown (path optional; - prints to stdout)':
    '将会话导出为 markdown（路径可选；- 打印到标准输出）',
  'review the working-tree diff (or a GitHub PR) for bugs and security':
    '审查工作区 diff（或 GitHub PR）中的 bug 与安全问题',
  'list saved conversations': '列出已保存的会话',
  'health-check model, egress, and config in this session':
    '在本会话中对模型、出口与配置做健康检查',
  'show git working-tree changes': '显示 git 工作区改动',
  'undo file edits from a checkpoint': '从检查点撤销文件编辑',
  'list MCP server status': '列出 MCP 服务状态',
  'list discovered skills; create more with moss skill create':
    '列出已发现的技能；用 moss skill create 创建更多',
  'list file-defined sub-agents with source paths and warnings':
    '列出文件定义的子代理、来源路径和加载警告',
  'show safety and approval settings; --verbose prints every knob':
    '显示安全与审批设置；--verbose 打印每个开关',
  'show or switch the UI language for this session': '显示或切换本会话的界面语言',
  'show or set the terminal colour theme for this session': '显示或设置本会话的终端配色',
  'caret to line start': '光标移到行首',
  'caret to line end': '光标移到行尾',
  'delete to line start': '删除到行首',
  'delete to line end': '删除到行尾',
  'delete the previous word': '删除上一个词',
  'paste deleted text': '粘贴刚删除的文字',
  'detailed transcript (full output, reasoning)': '详细记录（完整输出与思考）',
  'NO_COLOR is set — the theme stays mono': '已设置 NO_COLOR — 主题保持单色',
  'current theme: {name}': '当前主题：{name}',
  '/theme <name> switches it for this session': '/theme <name> 只在本会话内切换',
  'unknown theme "{name}" — dark, light, or mono': '未知主题“{name}” — 只能是 dark、light 或 mono',
  'theme: {name}': '主题：{name}',
  'list configured lifecycle hooks and where to edit them':
    '列出已配置的生命周期 hooks 及其编辑位置',
  'trust this folder for project settings (remembered in your user config)':
    '信任此文件夹的项目设置（记在你的用户配置里）',
  'forget trust for this folder; applies the next time Moss starts':
    '取消对此文件夹的信任；下次启动 Moss 时生效',
  'interrupt the active run': '中断当前运行',
  'show the key and command reference': '显示快捷键与命令参考',
  'exit moss': '退出 moss',
  'start a new conversation with an empty context': '开始一段空上下文的新对话',
  'list background shell and sub-agent jobs': '列出后台 shell 与子 agent 任务',
  'inspect or control the input queue': '查看或控制输入队列',
  'inject a constraint into the live run': '向当前运行注入一条约束',
  'work until a condition is met; /goal clear cancels': '持续工作直到条件满足；/goal clear 取消',
  'enter plan mode; with a description, start planning immediately':
    '进入 plan 模式；带描述则立即开始规划',
  'Task OS entry (hidden): status, timeline, resume, view, and verify — everyday work is /goal':
    'Task OS 入口（隐藏）：status、timeline、resume、view、verify — 日常用 /goal',
  'resume a saved conversation': '恢复已保存的会话',
  'stop background processes; Esc interrupts the current run': '停止后台进程；Esc 中断当前运行',
  'create or update an AGENTS.md project memory file': '创建或更新 AGENTS.md 项目记忆文件',

  // ── app.ts chrome ──────────────────────────────────────────────────────
  'Approval required': '需要审批',
  Question: '问题',
  'type 1,3 below · ↑↓ then Enter · Esc to skip': '在下方输入 1,3 · ↑↓ 后 Enter · Esc 跳过',
  '{keys} · ↑↓ then Enter · Esc to skip': '{keys} · ↑↓ 后 Enter · Esc 跳过',
  'type your answer below · Enter to send · Esc to skip': '在下方输入回答 · Enter 发送 · Esc 跳过',
  yes: '是',
  'yes (session)': '是（会话）',
  amend: '补充说明',
  no: '否',
  now: '刚刚',
  '{n}m': '{n}分',
  '{n}h': '{n}时',
  '{n}d': '{n}天',

  // ── resume picker + session meta (app.ts) ──────────────────────────────
  'Resume session  ⌕ {query}': '恢复会话  ⌕ {query}',
  '{count} messages': '{count} 条消息',
  '  … {count} more': '  … 还有 {count} 条',
  '  no matching session': '  没有匹配的会话',
  '  ↑/↓ to pick · type to filter · Esc starts fresh': '  ↑/↓ 选择 · 输入筛选 · Esc 开始新会话',
  '[tool {name}]': '[工具 {name}]',
  '[tool result]': '[工具结果]',
  '(nothing to show)': '（无内容）',
  ' ({count} messages)': '（{count} 条消息）',
  ' ({count} tools, lazy)': '（{count} 个工具，懒加载）',

  // ── dialog/notice rows (app.ts) ────────────────────────────────────────
  'answer: {value}': '回答：{value}',
  'answer: skipped': '回答：已跳过',
  'approval: {label}': '审批：{label}',
  'question needs your answer': '有提问等待你的回答',
  'approval needed': '需要审批',
  'Interrupted — /goal resume to continue': '已中断',
  Interrupted: '已中断',
  'no saved sessions': '没有已保存的会话',
  'no MCP servers configured (.moss/mcp.json)': '未配置 MCP 服务（.moss/mcp.json）',
  'no sub-agent tasks': '没有子 agent 任务',
  'no background tasks running': '没有运行中的后台任务',
  '{connected}/{total} MCP servers connected': '已连接 {connected}/{total} 个 MCP 服务',
  'context: {parts}': '上下文：{parts}',

  // ── boot status (app.ts) ───────────────────────────────────────────────
  '{count} skill': '{count} 个技能',
  '{count} skills': '{count} 个技能',
  '{count} MCP server': '{count} 个 MCP 服务',
  '{count} MCP servers': '{count} 个 MCP 服务',
  '{count} MCP server connecting': '{count} 个 MCP 服务连接中',
  '{count} MCP servers connecting': '{count} 个 MCP 服务连接中',
  '⚠ {count} MCP server failed to start': '⚠ {count} 个 MCP 服务启动失败',
  '⚠ {count} MCP servers failed to start': '⚠ {count} 个 MCP 服务启动失败',
  ' — /mcp for details': ' — 详情见 /mcp',
  'previous session: {title} — restart with `moss --continue` to resume it':
    '上一个会话：{title} — 用 `moss --continue` 重启以恢复',
  'previous session: {title} ({count} messages) — restart with `moss --continue` to resume it':
    '上一个会话：{title}（{count} 条消息）— 用 `moss --continue` 重启以恢复',

  // ── paste staging (app.ts) ─────────────────────────────────────────────
  '[paste: {lines} lines · LARGE {size}k chars — Enter sends it all; @-mention a file instead to send a path]':
    '[粘贴：{lines} 行 · 过大 {size}k 字符 — Enter 全部发送；改用 @ 提及文件以发送路径]',
  '[paste: {lines} lines — Enter sends as one message, Esc discards]':
    '[粘贴：{lines} 行 — Enter 作为一条消息发送，Esc 丢弃]',

  // ── model picker (app.ts) ──────────────────────────────────────────────
  '  Select model · {count} available · ↑↓ move · Enter choose · Esc close':
    '  选择模型 · 共 {count} 个 · ↑↓ 移动 · Enter 选择 · Esc 关闭',
  '  … type /model <name> for any other model': '  … 输入 /model <name> 选择其他模型',

  // ── task / status chrome (app.ts) ──────────────────────────────────────
  '◇ Working out the steps': '◇ 正在理清步骤',
  '◇ Doing the work': '◇ 正在做',
  '◇ Checking the result': '◇ 正在核对结果',
  '◇ Looking at what failed': '◇ 正在看哪里失败了',
  '◇ Fixing it': '◇ 正在修复',
  '◇ Checks passed': '◇ 检查通过',
  '◇ Checks did not pass': '◇ 检查未通过',
  '◇ Waiting on you': '◇ 等你决定',
  '◇ Working': '◇ 进行中',
  '◇ Checks passed ({met}/{total})': '◇ 检查通过（{met}/{total}）',
  '◇ Checks did not pass ({met}/{total}) · /task resume':
    '◇ 检查未通过（{met}/{total}）· /task resume',
  '◇ Blocked — {reason} · /task resume': '◇ 受阻 — {reason} · /task resume',
  '{count} measurement hidden — expand to see': '{count} 项测量已折叠 — 展开查看',
  '{count} measurements hidden — expand to see': '{count} 项测量已折叠 — 展开查看',
  'observed {observed} (want {expected})': '测得 {observed}（期望 {expected}）',
  'observed {observed}': '测得 {observed}',
  '◇ task {id} — PASS ({criteria} met)': '◇ 任务 {id} — PASS（达成 {criteria} 项）',
  '◇ task {id} — FAIL ({criteria} met) · /task resume {task} to repair':
    '◇ 任务 {id} — FAIL（达成 {criteria} 项）· /task resume {task} 修复',
  '◇ task {id} — PASS ({criteria} criteria met)': '◇ 任务 {id} — PASS（达成 {criteria} 项）',
  '◇ task {id} — FAIL ({criteria} criteria met) · /task resume {task} to repair':
    '◇ 任务 {id} — FAIL（达成 {criteria} 项）· /task resume {task} 修复',
  '◇ task {phase} — {text}': '◇ 任务 {phase} — {text}',
  '◇ task {id} blocked — {reason} · /task resume {task}':
    '◇ 任务 {id} 受阻 — {reason} · /task resume {task}',
  'user decision required': '需要用户决策',
  'context {pct}% full — auto-compact will trim older messages · /compact to do it now':
    '上下文已用 {pct}% — 自动压缩将裁剪较早消息 · 立刻执行用 /compact',
  'interaction mode: {label}': '交互模式：{label}',

  // ── queue / steer control (app.ts) ─────────────────────────────────────
  'paused — new submissions wait': '已暂停 — 新提交将排队等待',
  resumed: '已恢复',
  'dropped: {text}': '已丢弃：{text}',
  'queue empty': '队列为空',
  'cleared {count} queued item': '已清空 {count} 条排队消息',
  'cleared {count} queued items': '已清空 {count} 条排队消息',
  'usage: /steer <constraint> — injects at the next boundary':
    '用法：/steer <constraint> — 在下一个边界注入',
  'rejected — no single active run on this session': '已拒绝 — 本会话没有单一活动运行',
  'queued: {text}': '已排队：{text}',
  'applies at the next step': '将在下一步生效',
  'applies when this run finishes': '将在本次运行结束后生效',
  'queued — applies when this run finishes': '已排队 — 将在本次运行结束后生效',
  '  ↑↓ to scroll': '  ↑↓ 滚动',
  'unknown command "{name}" — try /help': '未知命令 "{name}" — 试试 /help',

  // ── status-line notices (app.ts) ───────────────────────────────────────
  'approved — type what moss should do next; your message is queued':
    '已批准 — 输入 moss 接下来该做什么；你的消息将排队',
  'run interrupted — press Ctrl+C again to quit': '运行已中断 — 再按 Ctrl+C 退出',
  'press Ctrl+C again to quit': '再按 Ctrl+C 退出',
  'Esc again to clear the composer': '再按 Esc 清空输入框',
  'Esc again to rewind': '再按一次 Esc 回退',
  'set $EDITOR to edit the draft externally': '设置 $EDITOR 后可在外部编辑草稿',
  'could not read the edited draft': '读不回编辑后的草稿',
  'copied {count} chars to clipboard': '已复制 {count} 个字符到剪贴板',
  '  ↓ Jump to bottom (click or End)': '  ↓ 跳到底部（点击或按 End）',
  'Ctrl+D quits — press Esc twice to drop the draft first': 'Ctrl+D 退出 — 先连按两次 Esc 丢弃草稿',
  'finish the pending approval before changing interaction mode':
    '请先处理待审批项，再切换交互模式',
  'fresh session — `moss resume` reopens the picker': '新会话 — `moss resume` 重新打开选择器',
  'prompt staged from history — Enter sends': '已从历史暂存提示 — Enter 发送',
  'history {n}/{total} — ↑↓ to walk · type to edit': '历史 {n}/{total} — ↑↓ 浏览 · 输入以编辑',
  'History {n}/{total}': '历史 {n}/{total}',
  Permissions: '权限',
  '  mode  {mode}    Shift+Tab cycles': '  模式  {mode}    Shift+Tab 循环',
  "  workspace-write confines Moss's own file tools.":
    '  workspace-write 只约束 Moss 自己的文件工具。',
  '  Shell commands run normally without an OS sandbox.':
    '  shell 命令照常运行，没有操作系统沙箱。',
  '  no rules — full allows tools; deny still wins everywhere':
    '  无规则 — full 放行工具；deny 在任何模式都优先',
  session: '会话',
  '  ↑↓ select · d remove session rule · Esc close': '  ↑↓ 选择 · d 删除会话规则 · Esc 关闭',
  '  add   /permissions add deny "exec(rm *)"': '  添加  /permissions add deny "exec(rm *)"',
  'removed session rule {spec}': '已删除会话规则 {spec}',
  'config rules stay in the config file': '配置文件里的规则留在配置文件中',
  'nothing to paste — Ctrl+U / Ctrl+K / Ctrl+W delete into the kill ring':
    '无可粘贴 — Ctrl+U / Ctrl+K / Ctrl+W 删除并入 kill ring',
  'swapped — Ctrl+S again to swap back': '已交换 — 再按 Ctrl+S 换回',
  'prompt stashed — Ctrl+S brings it back': '提示已暂存 — Ctrl+S 取回',
  'nothing to stash — the composer is empty': '无可暂存 — 输入框为空',
  'deleted {what} — Ctrl+Y to paste back': '已删除 {what} — Ctrl+Y 粘回',

  // ── question / plan gate (app.ts) ──────────────────────────────────────
  'Ready to code?': '准备写代码？',
  'The plan is above. How should moss proceed?': '计划如上。moss 应如何推进？',
  'Proceed — accept edits this session': '继续 — 本会话自动接受编辑',
  'Proceed — keep manual approvals': '继续 — 保留手动审批',
  'Tell moss what to change (type below)': '告诉 moss 要改什么（在下方输入）',
  '↑↓ then Enter · or type feedback below · Esc keeps planning':
    '↑↓ 后 Enter · 或在下方输入反馈 · Esc 继续规划',

  // ── command block bodies (app.ts) ──────────────────────────────────────
  'a run is in flight — press Esc to interrupt it first': '有运行正在进行 — 先按 Esc 中断它',
  'no failed, blocked, abandoned, or in-progress task is available to resume':
    '没有可恢复的失败、受阻、已放弃或进行中的任务',
  'interrupted the active run': '已中断当前运行',
  'no run in flight — nothing to interrupt': '没有正在进行的运行 — 无需中断',
  'transcript cleared — new conversation, empty context (previous: `moss --continue`)':
    '对话记录已清空 — 新对话，上下文为空（上一段：`moss --continue`）',
  'a run is in flight — press Esc to interrupt it, then /clear':
    '有运行正在进行 — 先按 Esc 中断，再 /clear',
  '{command} is not available while a run is in flight — press Esc to interrupt, then retry':
    '{command} 在运行中不可用 — 先按 Esc 中断，再重试',
  '  queued {n}. {text}': '  排队 {n}. {text}',
  'a run is in flight — press Esc to interrupt it, then /compact':
    '有运行正在进行 — 先按 Esc 中断，再 /compact',
  'a run is in flight — press Esc to interrupt it before switching models':
    '有运行正在进行 — 切换模型前先按 Esc 中断',
  'switched to {model} ({provider})': '已切换到 {model}（{provider}）',
  'this session only — /model save {model} writes the default':
    '仅本次会话 — `/model save {model}` 会写成默认',
  'switched to custom model {model} ({provider})': '已切换到自定义模型 {model}（{provider}）',
  'context usage will appear after the first response from this model':
    '本模型首次响应后将显示上下文用量',
  '/model config is not wired in the shell — use `moss setup` for a guided':
    'shell 中未接入 /model config — 用 `moss setup` 进行引导式',
  'provider/model/key change, or `moss config set model <name>` to persist one.':
    'provider/模型/密钥 变更，或用 `moss config set model <name>` 持久化一个。',
  '`/model <name>` still switches the active model for this session.':
    '`/model <name>` 仍可切换本会话的活动模型。',
  'Not a git repository: {path} — /diff needs a git workspace.':
    '不是 git 仓库：{path} — /diff 需要 git 工作区。',
  'git diff failed (exit {code}): {error}': 'git diff 失败（退出码 {code}）：{error}',
  '(no unstaged working-tree changes)': '（无未暂存的工作区改动）',
  '(no output)': '（无输出）',
  '(no output · exit {code})': '（无输出 · 退出码 {code}）',
  'terminated by {signal}': '被 {signal} 终止',
  'exit code {code}': '退出码 {code}',
  // Fallback for a null exit code whose signal the platform did not report —
  // `tui('signal')` is substituted in *both* locales, so the key must exist.
  signal: '信号',
  'background shell:': '后台 shell：',
  'sub-agents:': '子 agent：',
  'no skills found': '未找到技能',
  '  ({count} skill(s) · load with the skill tool)': '  （{count} 个技能 · 用技能工具加载）',
  'restored checkpoint {seq}: {detail}': '已恢复检查点 {seq}：{detail}',
  'rewind to {seq} failed': '回退到 {seq} 失败',
  'no hooks configured — add a "hooks" object to the config file:':
    '未配置 hooks — 在配置文件中添加 "hooks" 对象：',
  'config dir: {path} (or MOSS_CONFIG_FILE)': '配置目录：{path}（或 MOSS_CONFIG_FILE）',
  'create one: moss skill create <name>': '创建一个：moss skill create <name>',
  'could not resume {key}: {error}': '无法恢复 {key}：{error}',
  'resumed {key} — replayed {count} rows': '已恢复 {key} — 回放了 {count} 行',
  'compaction failed: {error}': '压缩失败：{error}',
  'git diff failed: {error}': 'git diff 失败：{error}',
  '! {command} failed: {error}': '! {command} 失败：{error}',
  'could not load the model catalog: {error}': '无法加载模型目录：{error}',
  'could not resolve the provider config — run `moss setup`.':
    '无法解析 provider 配置 — 请执行 `moss setup`。',
  'could not switch to {model}: {error}': '无法切换到 {model}：{error}',
  '{command} failed: {error}': '{command} 失败：{error}',
  met: '达成',
  'blocked: {reason}': '受阻：{reason}',
  'Tasks ({count})': '任务（{count}）',
  'Evidence ({count})': '证据（{count}）',
  'Deployments ({count})': '部署（{count}）',
  'History ({count})': '历史（{count}）',
  'Failures ({count})': '失败（{count}）',

  // ── /mcp status (rdk-docs-mcp.ts formatMcpStatusLine) ──────────────────
  '● {name} — connected': '● {name} — 已连接',
  '○ {name} — connecting': '○ {name} — 连接中',
  '○ {name} — failed: {reason}': '○ {name} — 失败：{reason}',
  'connection failed': '连接失败',

  // ── tool-result headline (tool-summary.ts / transcript.ts) ─────────────
  '{count} line': '{count} 行',
  '{count} lines': '{count} 行',
  '{ms}ms': '{ms} 毫秒',
  '{seconds}s': '{seconds} 秒',
  'Read {count} line': '读取 {count} 行',
  'Read {count} lines': '读取 {count} 行',
  'Read lines {start}-{end} of {total}': '读取第 {start}-{end} 行，共 {total} 行',
  'Read (unchanged)': '读取（未变化）',
  'Wrote {count} line': '写入 {count} 行',
  'Wrote {count} lines': '写入 {count} 行',
  'Added {count} line': '增加 {count} 行',
  'Added {count} lines': '增加 {count} 行',
  'removed {count} line': '删除 {count} 行',
  'removed {count} lines': '删除 {count} 行',
  'Edited (too large for inline diff)': '已编辑（差异过大，无法内联显示）',
  'Edited (no line changes)': '已编辑（行数无变化）',
  Patched: '已打补丁',
  'Listed {count} entry': '列出 {count} 项',
  'Listed {count} entries': '列出 {count} 项',
  'Found {count} match': '找到 {count} 处',
  'Found {count} matches': '找到 {count} 处',
  'No matches': '无匹配',
  'failed — {detail}': '失败 — {detail}',

  // ── /help overlay title (app.ts) ───────────────────────────────────────
  '  Help · Esc or Enter to close': '  帮助 · Esc 或 Enter 关闭',
  '  Help · full reference · Esc to close': '  帮助 · 完整参考 · Esc 关闭',

  // ── workspace trust prompt (workspace-trust.ts) ────────────────────────
  'project hooks ({count})': '项目钩子（{count}）',
  'status line': '状态栏',
  'stdio MCP ({names})': 'stdio MCP（{names}）',
  'HTTP MCP ({names})': 'HTTP MCP（{names}）',
  'agent {names}': '子代理 {names}',
  'plugin {names}': '插件 {names}',
  'Trusting loads {summary}.': '信任后将加载 {summary}。',
  'This project has no hooks, MCP servers, agents, or plugins.':
    '此项目没有钩子、MCP 服务、子代理或插件。',
  'A trusted project can change the model gateway, proxy, and TLS.':
    '受信任的项目可以更改模型网关、流量代理和 TLS。',
  'This folder is your home directory.': '此文件夹是你的主目录。',
  'This folder is the filesystem root. Trusting it is not remembered.':
    '此文件夹是文件系统根目录。这里的信任不会被记住。',
  'Trust this folder?': '信任此文件夹？',
  'Yes, trust this folder': '是，信任此文件夹',
  'No, exit': '否，退出',
  '[moss] This folder was not trusted. Exiting.': '[moss] 未信任此文件夹。正在退出。',
  '[moss] Ancestor .env routing keys ignored from {dir}: {list}. Trust that directory to apply them.':
    '[moss] 已忽略来自 {dir} 的上级目录 .env 路由键：{list}。信任该目录后才会应用它们。',
  '[moss] Untrusted folder — ignored project settings: {list}. Trust this folder with --trust-workspace or MOSS_TRUST_WORKSPACE=1.':
    '[moss] 文件夹未信任 — 已忽略项目设置：{list}。用 --trust-workspace 或 MOSS_TRUST_WORKSPACE=1 信任此文件夹。',
  '[moss] Untrusted folder — project settings that change where traffic goes stay ignored. Trust this folder with --trust-workspace or MOSS_TRUST_WORKSPACE=1.':
    '[moss] 文件夹未信任 — 会改变流量去向的项目设置保持忽略。用 --trust-workspace 或 MOSS_TRUST_WORKSPACE=1 信任此文件夹。',
  '[moss] Project base URL {url} needs its own apiKey. The primary key is not sent to that host.':
    '[moss] 项目 base URL {url} 需要自己的 apiKey。主密钥不会发往该主机。',
  'Trusted {path}. It applies the next time Moss starts.': '已信任 {path}。下次启动 Moss 时生效。',
  'The filesystem root is not remembered as trusted.': '文件系统根目录不会被记为已信任。',
  'Removed trust for {path}. It applies the next time Moss starts.':
    '已取消对 {path} 的信任。下次启动 Moss 时生效。',
  'This folder is not trusted.': '此文件夹未被信任。',
  'No trusted folders.': '没有已信任的文件夹。',
  Model: '模型',
  Command: '命令',
};

/**
 * Render one chrome string for the active locale. In English mode the argument
 * is returned with its `{placeholders}` substituted (byte-identical to the old
 * concatenation); in zh mode the dictionary value is used, falling back to the
 * English text when moss does not own the string.
 */
/** Translate approval sentences the policy builds with a target baked in. */
export function localizeApprovalText(text: string): string {
  const patterns: Array<{ re: RegExp; key: string }> = [
    {
      re: /^Yes, and always allow (.+) \(saved\)$/,
      key: 'Yes, and always allow {tool} (saved)',
    },
    {
      re: /^Yes, and always allow (.+) this session$/,
      key: 'Yes, and always allow {tool} this session',
    },
    {
      re: /^Do you want to make this edit to (.+)\?$/,
      key: 'Do you want to make this edit to {target}?',
    },
    {
      re: /^Do you want to create (.+)\?$/,
      key: 'Do you want to create {target}?',
    },
  ];
  for (const pattern of patterns) {
    const match = pattern.re.exec(text);
    if (!match?.[1]) continue;
    const field = pattern.key.includes('{tool}') ? 'tool' : 'target';
    return tui(pattern.key, { [field]: match[1] });
  }
  return tui(text);
}

/**
 * Same lookup as `tui()`, with the locale passed in. Startup prompts (workspace
 * trust) run before the TUI sets the module flag, so they cannot read `isTuiZh()`.
 */
export function chrome(
  text: string,
  zh: boolean,
  params?: Record<string, string | number>
): string {
  const template = zh ? (ZH[text] ?? text) : text;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  );
}

export function tui(text: string, params?: Record<string, string | number>): string {
  return chrome(text, isTuiZh(), params);
}

/**
 * The transient status notes a real edit dismisses (the history walk and the
 * kill-ring notes). The producer sets them through `tui()`, so the dismisser
 * must recognize the LOCALIZED wording too — it matches on the localized
 * leading word, which keeps producer and dismisser in agreement in both
 * locales without duplicating the Chinese strings at the dismiss site.
 */
export function transientStatus(text: string): boolean {
  const probes = [
    tui('history {n}/{total} — ↑↓ to walk · type to edit', { n: 0, total: 0 }),
    tui('deleted {what} — Ctrl+Y to paste back', { what: 'x' }),
    tui('nothing to paste — Ctrl+U / Ctrl+K / Ctrl+W delete into the kill ring'),
  ];
  return probes.some((probe) => {
    const head = probe.split(' ')[0] ?? '';
    return head.length > 0 && text.startsWith(head);
  });
}
