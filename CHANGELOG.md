# Changelog

## Unreleased

### The plan → approve → execute ritual is in README and verified end to end (B250)

- A real plan-mode session (`/plan`, one-file plan) hit the blocked `run_tests` explainer, produced a clear
  plan, showed `Ready to code?` with the three decisions, switched to accept-edits on `1`, made both edits
  without approval, asked once for the test command, and finished with the todo panel at 4/4 — the mode
  label and footer hint stayed consistent throughout. README's handfeel tables now name this ritual
  (`Ready to code?` → 1/2/3, `Esc keeps planning`).

### 计划 → 批准 → 执行的流程写进 README，并做了真实端到端验证（B250）

- 真实 plan 模式会话（`/plan` + 单文件计划）触发了 plan 模式对 `run_tests` 的阻断说明，产出清晰计划后显示
  `Ready to code?` 三选项；按 `1` 切到 accept-edits，两次编辑免批准，测试命令确认一次，最后 todo 面板 4/4；
  模式标签与 footer 提示全程一致。README 中英手感表补上这个流程
  （`Ready to code?` → 1/2/3，`Esc keeps planning`）。

### A tool result no longer repeats its own headline (B249)

- A real sub-agent run printed `⎿ [Sub-agent aadde5f2] SUCCESS · 4s` and then `[Sub-agent aadde5f2]
SUCCESS` again as the first body line. When a result body begins with the exact summary line, that
  leading line is dropped (`dropDuplicatedLeadingLine`); the headline already carries it. Real: the row
  now starts with `scope: explore | runId: … | turns: 3 | toolCalls: 2 | elapsed: …`.

### 工具结果不再重复自己的标题行（B249）

- 真实 sub-agent 运行里先打印 `⎿ [Sub-agent aadde5f2] SUCCESS · 4s`，结果体第一行又是
  `[Sub-agent aadde5f2] SUCCESS`。现在当结果体以与摘要完全相同的行开头时会去掉该行
  （`dropDuplicatedLeadingLine`）；真实复核后首行直接是
  `scope: explore | runId: … | turns: 3 | toolCalls: 2 | elapsed: …`。

### `moss workflow status|resume latest` works like the other read paths (B248)

- A real two-step workflow (`moss goal --workflow plan.json`) passed both steps and landed one workflow
  row in the ledger, but `moss workflow status latest` failed with `no workflow run "latest"` — the one
  read path that did not accept the word the ledger and loop commands accept. `status` and `resume` now
  resolve `latest` to the newest workflow state (and say `no workflow runs under .moss/workflows` instead
  of quoting the word back).

### `moss workflow status|resume latest` 与其他读路径一致（B248）

- 真实两步 workflow（`moss goal --workflow plan.json`）两个 step 都通过并写入一条 workflow 账本行，但
  `moss workflow status latest` 报 `no workflow run "latest"`——唯一不接受 `latest` 的读路径。现在 `status`
  与 `resume` 会把 `latest` 解析为最新 workflow state（无运行时提示 `no workflow runs under .moss/workflows`，
  不再把 `latest` 当 id 回显）。

### `moss loop` reports option-like tokens it treats as prompt text (B247)

- Real loop runs validated the engine (pass on attempt 1, a pass after a fed-back failure, and an honest
  failure with exit 1), but a typo like `--max-attempts 2` was silently folded into the prompt — the run
  used the default three attempts while the user believed they had capped it. Unknown `--flag` tokens are
  still prompt text (a prompt may legitimately contain them), but the CLI now prints one note naming them
  and the real loop flags; `--` remains the way to pass option-like prompt text silently, and the usage
  text says so.

### `moss loop` 会提示被当作 prompt 的"伪选项"（B247）

- 真实 loop 运行验证了引擎（首轮通过、失败反馈后第二轮通过、诚实失败 exit 1），但像 `--max-attempts 2`
  这样的拼写会被静默折进 prompt——用户以为限制了次数，实际跑默认 3 轮。未知 `--flag` 仍作为 prompt 文本
  （prompt 里确实可能有），但 CLI 现在会打印一条提示，列出未知选项与真正的 loop 选项；`--` 仍是静默传入
  含 `--flag` prompt 的方式，usage 里也写明了。

### `moss review check` states the verdict once (B246)

- Real `/review` → `moss review check` printed `PASS — verdict: PASS (working tree + staged changes,
quick, critical 0, important 0, suggestion 0)`: the gate word twice, then the details. The check line
  now reads `PASS — working tree + staged changes, quick · critical 0, important 0, suggestion 0`
  (FAIL and unknown get the same treatment); `review list` keeps the verdict label because the verdict is
  its primary column.

### `moss review check` 只报一次结论（B246）

- 真实 `/review` 后跑 `moss review check`，输出 `PASS — verdict: PASS (…, critical 0, …)`：结论词出现两次，再加细节。
  现在 check 行是 `PASS — working tree + staged changes, quick · critical 0, important 0, suggestion 0`
  （FAIL 与 unknown 同理）；`review list` 保留 verdict 标签，因为那是它的主列。

### The idle status bar does not print `ctx ~0%` (B245)

- Switching model in-session made the status bar show `ctx ~0%` even though the window had not been used;
  the share is meaningful after a turn, not at zero. The status row now renders the context share only
  once `contextUsed > 0` (the legacy row already behaved this way).

### 空闲状态栏不再显示 `ctx ~0%`（B245）

- 会话中切换模型后，状态栏会显示 `ctx ~0%`，但窗口还没被用过；0% 没有信息量。现在 `contextUsed > 0` 时才渲染
  上下文占比（legacy 行本来就是这个行为）。

### `/skills` keeps one readable line per skill, and README names memory/permissions/extension (B243/B244)

- The in-session `/skills` panel printed each skill's full catalog description; nineteen skills filled the
  whole screen with wrapped prose. The panel now shows a compact one-line description (72 chars,
  ellipsis), while `moss skill list` keeps the full text. Real: 19 skills fit on one screen with the
  catalog-budget summary.
- README's handfeel tables now cover three surfaces that existed but were undocumented: remembering a
  project fact (`moss remember "…"` / `/remember`, preview-then-append, explicit only), permissions and
  scoped rules (`/permissions` · `/rules`), and the extension surface (`/skills` · `/mcp` · `/hooks`).

### `/skills` 每个技能一行，README 补记忆/权限/扩展面（B243/B244）

- 会话内 `/skills` 面板原来打印每条技能的完整 catalog 描述，19 个技能会刷满整屏并折行。现在面板显示 72 字符的
  单行摘要（超出省略），`moss skill list` 保留完整文本。真实：19 个技能一屏放下，底部仍显示 catalog 预算摘要。
- README 手感表补上三个已存在但未记录的能力：记一条项目事实（`moss remember "…"` / `/remember`，预览后追加、仅显式写入）、
  权限与作用域规则（`/permissions` · `/rules`）、扩展面（`/skills` · `/mcp` · `/hooks`）。

### The first screen names project memory; panel titles read as labels (B242)

- `moss remember` writes `AGENTS.md`, but the boot context line only listed git/skills/MCP, so a project
  with remembered facts looked no different from one without. The line now adds `AGENTS.md · N facts`
  (or just `AGENTS.md` when the file has no remembered section), so the memory the model will load is
  visible where the rest of the loaded context is.
- `/mcp`, `/sessions`, `/subs`, `/bg` printed their action ids as block titles (`⏺ mcp`). They now read
  `MCP`, `Sessions`, `Sub-agents`, `Background`, matching the other panels.

### 首屏标注项目记忆；面板标题改为可读标签（B242）

- `moss remember` 会写 `AGENTS.md`，但启动 context 行只列 git/skills/MCP，记过事实的项目和没有的看起来一样。
  现在该行追加 `AGENTS.md · N 条记忆`（文件存在但没有 Remembered facts 小节时只显示 `AGENTS.md`），
  模型将要加载的记忆与其他已加载上下文一起可见。
- `/mcp`、`/sessions`、`/subs`、`/bg` 之前把动作 id 当标题打印（`⏺ mcp`）；现在分别是
  `MCP`、`Sessions`、`Sub-agents`、`Background`，与其他面板一致。

### The reply language follows the user's latest message (B241)

- The contract never said which language to answer in, so a zh-UI session answered an English prompt in
  Chinese (and vice versa). The communication contract now states: answer in the language of the user's
  latest message; the interface language (`MOSS_LANG`) governs chrome, not the reply.

### 回答语言跟随用户最新消息（B241）

- 通信契约没有规定回答语言，于是中文界面会话会用中文回答英文提问（反过来也一样）。现在契约明确：用用户最新一条消息的语言回答；
  界面语言（`MOSS_LANG`）只管界面文案，不管回答。

### Every harness correction asks for the delta (B240)

- B238/B239 fixed the gate corrections; a real multi-step run (`add mul + test + run tests`) still ended
  with a second answer block re-summarizing the task. The rule now lives in ONE place —
  `buildCorrectionMessage` appends "Add only what is new in your next message — do not restate or re-print
  your earlier answer" to every correction, so no nudge can buy a turn that re-tells everything. It is
  not appended twice when a caller already carries its own copy.

### 所有 harness correction 都要求"只给增量"（B240）

- B238/B239 只修了 gate correction；真实多步 run（`add mul + test + run tests`）结尾仍会多一个总结块。
  现在规则集中在 `buildCorrectionMessage`：每条 correction 都追加"下一条消息只写新增内容——不要重述或重贴先前的回答"，
  因此任何 nudge 都不会再买到"重讲一遍"的回合；调用方自带同类规则时不会重复追加。

### The verification gate stands down when the user asked for no commands (B239)

- A real run showed the gate's cost: "add a comment at the top of math.js… do not run any commands" was
  edited, answered, held by the unverified-change gate, answered again, and only then read back — three
  answer blocks for one comment, and inline scrollback keeps every one. The gate exists to stop silence,
  not to overrule the person who asked: the latest human instruction is now checked, and
  `do not run any commands` / `without running tests` / `不要运行` let the honest answer through.
- Also: an explicit "no commands were run" / `未运行` is accepted as an unverified disclosure instead of
  demanding a second turn.

### 用户明确要求"不要运行命令"时，验证门放行（B239）

- 真实 run 暴露了验证门的代价："在 math.js 顶部加一行注释……不要运行任何命令" 被编辑、回答、被未验证门拦下、
  再回答、最后才读回——一行注释换来三个回答块，而内联滚动区全部保留。门的作用是防止沉默，而不是否决提出要求的人：
  现在会检查最新的人类指令，`do not run any commands` / `without running tests` / `不要运行` 都会让诚实回答通过。
- 另外，显式声明 "no commands were run" / `未运行` 视为未验证披露，不再要求额外回合。

### A gate retry asks for the delta instead of a second full answer (B238)

- Real TUI in manual mode showed the same change reported three times in one run: the answer, then
  `Interpretation: …`, then `Done. math.js:1 now has a file-level header comment` with the whole file
  again. The retried turn is bought by the completion gate's correction, and that correction only said
  "verify and report what you observed", so the model restated everything. Inline scrollback cannot
  retract a printed row, so the fix belongs upstream: every gate correction now ends with
  "report only what changed since your previous message … do not restate or re-print the earlier answer".

### 完成门重试只要求"增量"，不再要求第二个完整回答（B238）

- 真实 TUI（manual 模式）一次 run 里同一改动被报告三次：回答、`Interpretation: …`、再
  `Done. math.js:1 now has a file-level header comment` 并重贴整份文件。重试回合由完成门的 correction 换来，
  而 correction 只说"检查并报告你观察到的"，模型于是把全部内容重述一遍。内联滚动区无法撤回已打印的行，
  所以修复放在上游：每个完成门 correction 现在以"只报告自上一条消息以来的变化……不要重述或重贴先前的回答"结尾。

### Two full answers for one turn: the superseded one folds (B237)

- Third-audit top-1: a turn nudged into answering again printed both answers in full (`⏺ Fixed …`
  followed by `⏺ Interpreted …` with the same bullets and a second code block). A fresh answer block
  arriving while the previous row is also a **fresh** answer block (no tool/result between) now folds
  the earlier one to a single dim line; paragraphs of one answer (`continuation` rows) are untouched.
- Real `done`-gate reproduction: two assistant messages (`done` → nudge → `done`) now render as one
  folded progress line plus the final answer instead of two full answers.

### 一轮两个完整回答：被取代的那个折叠（B237）

- 第三轮审计 top1：被 nudged 再次作答的回合会把两个回答都完整打印（`⏺ Fixed …` 后又有
  `⏺ Interpreted …`，同样的 bullet 和第二段代码块）。现在，当新的回答块前面也是**全新的**回答块
  （中间没有工具/结果）时，前一块折叠为一行 dim；同一答案的段落（`continuation` 行）不受影响。
- 真实 `done`-gate 复现：两条 assistant 消息（`done` → nudge → `done`）现在显示为一行折叠进度 + 最终回答，
  而不是两个完整回答。

### The PostToolUse probe waits for content, not just file existence (B236)

- `scripts/verify/skill-hooks.mjs` polled `existsSync(marker)` then read the file. On a slow CI runner the
  hook had created the file but not finished writing, so shard 2 read `''` against `'post'` (run
  42255871389). The probe now polls the content until it equals `post` (bounded, same 2 s window).

### PostToolUse 探针等待内容而不是文件存在（B236）

- `scripts/verify/skill-hooks.mjs` 先轮询 `existsSync(marker)` 再读文件。CI 慢机上 hook 已创建文件但尚未写完，
  shard 2 读到 `''` 而期望 `'post'`（run 42255871389）。现在轮询文件内容直到等于 `post`（同样的 2 秒上限）。

### A resumed boot does not show onboarding's `Next:` (B235)

- Third-audit finding #5: after `moss --continue`, the first screen still printed
  `Next: /init (detect this project, write AGENTS.md)` above the replayed conversation — the next step
  for a session that already has context is not project init. The `Next:` row is now omitted when the
  boot is a resume (replay rows or resume picker); the `[session] Resuming session:` line and the replayed
  conversation are the confirmation.

### 恢复会话的首屏不再显示 onboarding 的 `Next:`（B235）

- 第三轮审计 #5：`moss --continue` 后首屏仍在回放的对话上方打印
  `Next: /init (detect this project, write AGENTS.md)`——已有上下文的会话，下一步不是初始化项目。
  现在恢复启动（有 replay 行或 resume picker）不再显示 `Next:` 行；`[session] Resuming session:` 与回放的
  对话就是确认。

### Prompt recall is per workspace (B234)

- The TUI and REPL merged the user config dir's `prompt-history.jsonl` into every project's history,
  so ctrl+r in a fresh project offered prompts typed in other projects (third audit #4) — one Enter away
  from sending them here. Recall now reads and writes only the workspace's
  `.moss/prompt-history.jsonl`; existing global files are left untouched but no longer merged.

### prompt 历史按工作区隔离（B234）

- TUI/REPL 原先把用户 config 目录的 `prompt-history.jsonl` 合并进每个项目的历史，于是新项目的 ctrl+r
  会列出其它项目输入过的 prompt（第三轮审计 #4）—— 一次 Enter 就可能误发到当前项目。现在只读写工作区的
  `.moss/prompt-history.jsonl`；旧的全局文件保留但不再合并。

### A failing `exec` reads as failed, with the message instead of a stack frame (B233)

- Third-audit finding #2: a command that exited 1 was summarized as `10 lines` (success path) or, as an
  error, `failed — at Module._load (node:internal/…)` — the error line was below the preview fold.
  Non-zero `exec` exits now summarize as `failed — Error: Cannot find module '…'` (the message line, not
  a stack frame), and the result body lifts the exit label + first message line above the fold.
- `exit_code: N` inside a successful tool result (the non-error path) is treated as a failure too.

### 失败的 `exec` 显示为失败，并给出消息行而不是栈帧（B233）

- 第三轮审计 #2：退出码 1 的命令原本被摘要成 `10 lines`（成功路径），或作为错误时摘要成
  `failed — at Module._load (node:internal/…)`——真正的错误行被折在预览下方。现在非零 `exec` 摘要为
  `failed — Error: Cannot find module '…'`（消息行，不是栈帧），结果体把退出标签 + 首条消息行提到折叠线以上。
- 成功工具结果里出现 `exit_code: N`（非错误路径）同样按失败处理。

### Resume replay uses live tool labels and compresses across turns (B232)

- A third real-TUI audit found the replay was "another interface": raw `read_file`/`run_tests` names
  instead of the live `Read(...)`/`Run Tests(...)`, and tool-only turns printed one `⎿` row each, so seven
  calls in a row filled the screen. Replay now reuses the live tool labels, and consecutive tool rows
  (across assistant turns) collapse into one line when there are more than three
  (`⎿ 14 tool calls: Read ×6 · List Directory · Exec ×2 · Task Define · +3 more`).
- Same audit: fixed the top-1 duplicate-answer issue is still open (same-turn multiple final answers).

### 恢复会话回放使用实时工具名，并跨回合压缩（B232）

- 第三轮真实 TUI 审计发现回放像"另一个界面"：工具名是原始 `read_file`/`run_tests`，而不是实时的
  `Read(...)`/`Run Tests(...)`；且只有工具调用的回合各打一行 `⎿`，连续 7 次调用占满屏幕。现在回放复用实时
  工具标签，连续的 `⎿` 行（跨 assistant 回合）超过 3 行时折叠为一行
  （`⎿ 14 tool calls: Read ×6 · List Directory · Exec ×2 · Task Define · +3 more`）。
- 同一审计的 top1（同回合多段最终答复重复）仍未关闭。

### Long tool turns compress to one line when a session replays (B231)

- After `[Steering]` was filtered (B230), the remaining noise in a resumed transcript was tool headlines:
  one turn that called eight tools printed eight `⎿ …` rows. A replay turn with more than three calls now
  prints one grouped row (`⎿ 7 tool calls: read_file ×3 · exec ×2 · list_directory · write_file`); short
  turns keep per-call detail.

### 会话回放时，长工具轮折叠成一行（B231）

- B230 过滤 `[Steering]` 之后，恢复会话的主要噪音变成工具行：一个回合调用 8 个工具就打印 8 行 `⎿ …`。
  现在回放中超过 3 次调用的回合折叠为一行
  （`⎿ 7 tool calls: read_file ×3 · exec ×2 · list_directory · write_file`）；短回合保留逐条细节。

### `[Steering]` loop guidance no longer replays as user text (B230)

- When a resumed session had hit the extended-tool-loop (or any other) steering nudge, `moss --continue`
  replayed `❯ [Steering] Extended tool loop detected…` as if the user had typed it. Steering is
  model-facing guidance, never user words: `resumeUserText` now drops it alongside `[System]` corrections
  and the `<turn-context>` preamble.

### `[Steering]` 循环引导不再回放成用户发言（B230）

- 被恢复的会话如果触发过 extended-tool-loop 等 steering 提示，`moss --continue` 会回放
  `❯ [Steering] Extended tool loop detected…`，像用户自己说的。steering 是给模型的引导，不是用户的话：
  `resumeUserText` 现在与 `[System]` 纠偏、`<turn-context>` 前导一样把它丢掉。

### README documents the review gate for CI (B229)

- `moss review check` is the verifiability story's CI hook (0 pass / 1 unresolved / 2 none-or-unknown,
  `--json` added in B223), but neither README mentioned it. The handfeel tables now carry
  "Gate the review in CI" / "把评审接进 CI" next to `/diff` · `/review`, with the exit-code contract and
  the JSON form.

### README 记录可接进 CI 的评审门禁（B229）

- `moss review check` 是可验证性叙事的 CI 入口（0 通过 / 1 有未解决问题 / 2 无评审或未知，`--json` 见 B223），
  但两版 README 都没写。现在中英手感表在 `/diff` · `/review` 旁新增"把评审接进 CI"一行，
  写明退出码约定与 JSON 形式。

### `/usage` states the unpriced cost in one line (B228)

- The unknown-price note was a two-line config tutorial (`input, output, and cached per 1M tokens;
currency USD or CNY`) shown on every `/usage` and in the usage block. It is now
  `cost: unpriced (set pricing.models["<model>"] to show cost)`; the schema lives in
  `moss config --help`, not on the usage screen.

### `/usage` 用一行说明未定价（B228）

- 未知价格提示原本是两行配置教程（`input/output/cached per 1M tokens; currency USD or CNY`），
  `/usage` 与用量块里都会出现。现在改为 `cost: unpriced (set pricing.models["<model>"] to show cost)`；
  完整字段说明留在 `moss config --help`，不占用量屏。

### `/context` labels an unprobed context window (B227)

- The status row has shown `ctx ~N%` for an unprobed window since B198, but `/context` printed
  `usage ~0 / 1,000,000 tokens` as if 1M were measured. It now adds
  `window unprobed — conservative 1,000k default (/model probes the real value)` when the provider had
  no window to report, so the number below it is not mistaken for a fact.

### `/context` 标注未探测的上下文窗口（B227）

- 自 B198 起状态行会用 `ctx ~N%` 表示未探测窗口，但 `/context` 仍打印 `usage ~0 / 1,000,000 tokens`，
  像是实测的 1M。现在 provider 没有可报告窗口时会加一行
  `window unprobed — conservative 1,000k default (/model probes the real value)`，避免把下面的数字当成事实。

### The status row counts only tasks that still need attention (B225)

- After `/goal` finished, the chrome kept `· 1 task` / `· 2 tasks` forever: it counted every task
  snapshot in the session, including settled ones, so it read like work still in flight. It now counts
  only `PLANNING` / `EXECUTING` / `BLOCKED`; a finished goal leaves the row clean.

### 状态行只统计仍需要处理的任务（B225）

- `/goal` 结束后，状态行会一直保留 `· 1 task` / `· 2 tasks`：它统计会话里所有任务快照（含已结束的），
  看起来像还有任务在跑。现在只统计 `PLANNING` / `EXECUTING` / `BLOCKED`；goal 完成后该计数消失。

### `moss goal --max-turns N` is no longer swallowed (B224)

- The top-level parser treated `--max-turns` as the chat agent's turn budget for every command except
  `task`, so the `goal` shortcut lost it before `task-run` could bound the run: `goal … --max-turns 1`
  planned, executed, repaired, and only stopped after the default budget. It is now preserved for `goal`
  as well (plus the `task` alias), matching the documented `--max-turns` semantics.
- Real: `moss goal "say hi in a file" --accept false --max-turns 1 --max-repairs 0` now fails with
  `turn budget exhausted (1 turns)`, `turns: 1`, and a `next: moss task resume … --max-turns 2`.

### `moss goal --max-turns N` 不再被吞掉（B224）

- 顶层解析器把 `--max-turns` 当作聊天 agent 的轮次预算，除 `task` 外都吃掉，于是 `goal` 快捷方式在 task-run
  看到它之前就丢了：`goal … --max-turns 1` 仍会规划、执行、修复，直到默认预算。现在 `goal`（以及 `task` 别名）
  也会保留该 flag，符合文档语义。
- 真实：`moss goal "say hi in a file" --accept false --max-turns 1 --max-repairs 0` 现在以
  `turn budget exhausted (1 turns)` 失败，`turns: 1`，并给出 `next: moss task resume … --max-turns 2`。

### `moss review check --json` for CI gates (B223)

- The review gate had the right exit codes (0 pass / 1 unresolved / 2 none-or-unknown) but only prose,
  so a pipeline that needed the verdict or findings had to scrape text. `--json` now returns one object:
  `{ schema: "moss_review_check.v1", reviewed, verdict, exitCode, record?, repair? }`; the exit codes are
  unchanged, so `review check && …` keeps working.

### `moss review check --json` 供 CI 使用（B223）

- review 门的退出码（0 通过 / 1 有未解决问题 / 2 无评审或未知）一直正确，但只输出散文，流水线要 verdict/findings
  只能抓文本。现在 `--json` 返回单个对象：`{ schema: "moss_review_check.v1", reviewed, verdict, exitCode, record?, repair? }`；
  退出码不变，`review check && …` 的用法保持有效。

### One Chinese word for full mode, a localised `/goal` row, readable gitignore advice (B221)

- The same mode was `全开` (status bar, `/mode` block) and `完全访问` (help, doctor, config). It is now
  `完全访问` everywhere; `/mode 全开` and the old value still parse as aliases.
- The help overlay's `/goal` row was the last untranslated command description; it now reads Chinese in
  a zh UI (the CLI tokens in the usage column stay as typed).
- The startup `.gitignore` advice said "建议加入 .gitignore：.moss/ 与 !.moss/skills/", which reads as if
  the negated line should be searched for rather than written to keep the skills dir; it now says to add
  `.moss/` and then `!.moss/skills/` to keep the skills directory.

### 全模式统一叫"完全访问"，`/goal` 帮助行本地化，gitignore 建议更好读（B221）

- 同一模式在状态栏/`/mode` 块叫"全开"，在帮助、doctor、config 里叫"完全访问"。现在统一为"完全访问"；
  `/mode 全开` 与旧值仍作为别名解析。
- 帮助浮层里 `/goal` 行是最后一个未翻译的命令描述，中文界面现在显示中文（用法列里的 CLI token 保持原样）。
- 启动的 `.gitignore` 建议原文读起来像"把 !.moss/skills/ 也加进去"（其实是要保留技能目录）；现在明确说
  先加 `.moss/`，再加 `!.moss/skills/` 以保留技能目录。

### Pre-tool narration folds, and `exit_plan` stops reprinting the plan (B220)

- The second audit's top issue was "the same thing said four times": an assistant paragraph immediately
  followed by a tool call (progress narration) was rendered as a full answer block, then the real answer
  repeated it, and `exit_plan` re-dumped the entire plan already visible above the gate.
- When a tool starts, the preceding assistant row is marked as progress and rendered as one dim line
  (verbose reveals it); the final answer keeps its full markdown. `exit_plan` now summarizes as
  `Plan submitted for approval` and drops its body, so the plan appears once (in the plan message) plus
  the gate panel's decision.

### 工具调用前的叙述折叠，`exit_plan` 不再重打印计划（B220）

- 第二轮审计的头号问题是"同一件事说四遍"：紧接工具调用的 assistant 段落（进度叙述）被当成完整回答渲染，
  真正回答又重复一遍；`exit_plan` 还把已经显示在上方的整份计划再打印一次。
- 工具开始时把前一条 assistant 行标记为 progress，渲染为一行 dim（verbose 展开）；最终回答保持完整 markdown。
  `exit_plan` 现在摘要为 `Plan submitted for approval` 并丢弃正文，计划只出现在计划消息与 gate 面板决策中。

### A real-TUI re-audit: stale wait verbs, stale interrupt hint, lying search summaries (B219)

A second read-only UX audit (3 real sessions) found the next layer of friction. This round fixes three
of its items:

- **The wait verb means quiet.** `Waiting on the model, 30s` could keep ticking while reasoning tokens
  were arriving (reasoning keeps `streaming` empty). A wait verb now requires no event for five seconds;
  otherwise the row says `Thinking`.
- **The interrupt hint dies with the run.** After Ctrl+C stopped a run, `run interrupted — press
Ctrl+C again to quit` stayed in the status row after the composer went idle. It is cleared (and the
  arm disarmed) when the run settles.
- **An empty search is not a match.** `Search Files … Found 1 match` sat directly above `No files found`;
  a `No files found`/`No matches` body now summarizes as `No matches`.
- Also: the plan gate's status hint said `Esc to skip` while its footer said `Esc keeps planning`; the
  hint now follows the dialog (`Esc keeps planning`).

Remaining from the audit (not this round): near-duplicate final answer paragraphs, and plan text
appearing in the exit-plan result plus the gate panel.

### 真实 TUI 复审计：过期的等待动词、残留的中断提示、说谎的搜索摘要（B219）

第二轮只读 UX 复审计（3 个真实会话）找到下一层摩擦，本轮修其中三项：

- **等待动词意味着"真的安静"**：推理 token 到达时 `streaming` 仍为空，于是 `Waiting on the model, 30s`
  会一直刷。现在要求 5 秒内没有任何事件才显示等待动词，否则显示 `Thinking`。
- **中断提示随运行结束消失**：Ctrl+C 结束运行后，`run interrupted — press Ctrl+C again to quit`
  在 composer 已恢复空闲后仍留在状态行。现在运行收尾时清除该行并解除 quit arm。
- **空搜索不是命中**：`Search Files … Found 1 match` 与 `No files found` 同屏；body 为
  `No files found`/`No matches` 时摘要改为 `No matches`。
- 另：计划确认弹窗的状态行原来写 `Esc to skip`，而 footer 写 `Esc keeps planning`；现在状态行跟随弹窗。

审计剩余（本轮未做）：最终答复近似重复段落；计划在 Exit Plan 结果与 gate 面板各出现一次。

### `moss sessions export --last` exports the newest non-empty session (B218)

- Export needed an opaque key (`moss sessions list` first), unlike `moss resume --last` and
  `runs export latest`. `sessions export --last` (and `latest`) now resolves the newest session with
  messages; `--out` works in both spellings and `--out=-` writes stdout, so
  `moss sessions export --last --out=-` is the one-line form.

### `moss sessions export --last` 导出最新的非空会话（B218）

- 导出需要先 `moss sessions list` 拿到不透明 key，而 `moss resume --last`、`runs export latest` 都支持"最新"。
  现在 `sessions export --last`（或 `latest`）会解析最新的非空会话；`--out` 两种写法与 `--out=-`（stdout）都可用，
  因此 `moss sessions export --last --out=-` 就是一行式导出。

### `loop show` no longer prints a dead PID as if the run were alive (B217)

- The detail view printed `PID` whenever the ledger had one, including finished and interrupted runs
  (`RESULT passed` next to `PID 54655`). The pid is only meaningful while the process is alive, so it
  now appears only for `running`; interrupted runs still say the process is gone.

### `loop show` 不再把已死进程的 PID 当成运行中（B217）

- 详情视图只要账本里有 PID 就打印，已结束/被中断的运行也会出现 `RESULT passed` 旁边的 `PID 54655`。
  PID 只在进程存活时有意义，所以现在仅 `running` 显示；被中断的运行仍会说明进程已消失。

### `moss runs export --out=-` writes stdout, not a file named `-` (B216)

- `moss sessions export --out=-` and `/export -` already mean stdout; `moss runs export` did not, so
  `--out=-` created a literal `./-` file. Both the single-run and filtered export paths now print to
  stdout for `--out=-` and create no file; probe covers both.

### `moss runs export --out=-` 输出到 stdout，而不是创建名为 `-` 的文件（B216）

- `moss sessions export --out=-` 与 `/export -` 一直表示 stdout，但 `moss runs export` 没有处理，
  于是 `--out=-` 会生成一个名为 `-` 的文件。单条与过滤合并两条导出路径现在都对 `--out=-` 输出到 stdout 且不落盘；探针覆盖两者。

### The untracked section of `/diff` follows the UI language (B215)

- B214 added `Untracked files (N):` in English even when the rest of `/diff` is Chinese. The collector now
  takes the locale: `未跟踪文件（N）：` and `… 还有 N 个` in Chinese, unchanged English elsewhere; both the
  TUI and the REPL pass their locale.

### `/diff` 的未跟踪文件段跟随界面语言（B215）

- B214 的 `Untracked files (N):` 在中文界面里仍是英文。收集器现在接收 locale：中文为 `未跟踪文件（N）：`
  与 `… 还有 N 个`，英文保持不变；TUI 与 REPL 各自传入当前语言。

### `/diff` names untracked files too (B214)

- A newly created file is untracked, so `git diff HEAD` was silent: right after the agent wrote new
  files, `/diff` claimed "(no changes)". Diff output now ends with `Untracked files (N):` and up to ten
  `?? path` lines (then `… and N more`), so a new file is visible without dumping its contents into the
  diff gutter.

### `/diff` 也会列出未跟踪的新文件（B214）

- 新建文件处于未跟踪状态，`git diff HEAD` 对它静默：模型刚写完新文件时 `/diff` 会显示 "(no changes)"。
  现在 diff 输出末尾追加 `Untracked files (N):` 与最多十行 `?? path`（超出显示 `… and N more`），
  新文件可见，同时不会把内容灌进 diff gutter。

### `/diff` shows staged changes too (B213)

- `/diff` ran `git diff`, which only covers unstaged edits: after `git add`, the file looked unchanged
  and a staged-only change produced "(no changes)". It now compares against `HEAD` when the repo has
  one (staged + unstaged), and before the first commit shows the index plus the working tree.

### `/diff` 也显示已暂存的改动（B213）

- `/diff` 原来只跑 `git diff`（仅未暂存改动）：`git add` 之后文件看起来没变，只有暂存改动时会显示 "(no changes)"。
  现在仓库有 `HEAD` 时按 `HEAD` 比较（暂存 + 未暂存），首次提交前则显示索引与工作区。

### `moss artifacts --json` returns JSON for every kind (B212)

- `--json` is advertised for the whole command, but only the delegated kinds honored it; `tasks`,
  `history` and `failures` printed their human text, and the global-flag spelling
  (`moss --json artifacts …`) was dropped before the handler. All local kinds now emit JSON (empty
  results are `[]`), and both flag positions work.

### `moss artifacts --json` 对所有 kind 都返回 JSON（B212）

- 帮助里 `--json` 是为整个命令声明的，但只有委托给 task 命令的 kind 生效；`tasks`、`history`、`failures`
  仍打印人类文本，而且全局写法（`moss --json artifacts …`）在到达 handler 前被丢弃。现在本地 kind 都输出 JSON
  （空结果为 `[]`），两种 flag 位置都生效。

### `moss review list --json` actually prints JSON (B211)

- `--json` is a global flag, so the top-level parser removes it from the subcommand args; the review
  handler only looked at those args and printed the human table. The dispatcher now forwards the global
  flag, so `moss review list --json` returns the records as JSON (real CLI verified; probe now spawns
  the binary instead of only calling the handler in-process).
- Maintenance: the two `<turn-context>` strippers (`resume` replay and session titles) are now one
  helper; the title path collapses whitespace on top of it. −3 lines, probes unchanged.

### `moss review list --json` 真的输出 JSON（B211）

- `--json` 是全局 flag，顶层解析会把它从子命令参数里移除；review handler 只看子命令参数，于是打印了人类可读表格。
  dispatcher 现在转发该全局 flag，`moss review list --json` 返回 JSON（真实 CLI 验证；探针改为真正 spawn 二进制，
  不再只进程内调用 handler）。
- 维护：两处 `<turn-context>` 剥离实现（resume 回放与会话标题）合并为一个 helper，标题路径在其上再做空白折叠。−3 行，探针不变。

### In-session `/export <path>` stays inside the workspace too (B210)

- `/export /tmp/x.md` (or `../x.md`) wrote the session export wherever the path pointed. It now uses the
  same workspace confinement as `moss sessions export --out` and `moss runs export --out`; the shared
  message is generic (`path must stay inside the workspace: …`) because all three spell the destination
  differently. `/export` with no path (default `moss-session-<key>.md`) and `/export -` are unchanged.

### 会话内 `/export <path>` 同样限定在工作区内（B210）

- `/export /tmp/x.md`（或 `../x.md`）会把会话导出写到任意位置。现在与 `moss sessions export --out`、
  `moss runs export --out` 共用工作区限定；错误文案统一为 `path must stay inside the workspace: …`
  （三者参数写法不同，不再写死 `--out`）。不带路径（默认 `moss-session-<key>.md`）与 `/export -` 不变。

### `moss sessions export --out` stays inside the workspace (B209)

- `--out=../x.md` wrote the exported session outside the workspace (same class as the `runs export`
  fix); the usage line also advertised `--out <file>` while only `--out=<file>` worked and the spaced
  form was silently ignored (the export went to stdout instead). `--out` now supports both spellings,
  is confined to the workspace (escape exits 2 and writes nothing), and `moss runs export` shares the
  same helper so the two cannot drift.

### `moss sessions export --out` 限定在工作区内（B209）

- `--out=../x.md` 会把导出的会话写到工作区之外（与 `runs export` 同类问题）；帮助里写的是 `--out <file>`，
  但实际只认 `--out=<file>`，空格形式被静默忽略（导出跑到 stdout）。现在两种写法都支持，`--out` 限定在工作区内
  （越界 exit 2 且不写文件），`moss runs export` 共用同一 helper，二者不会再漂移。

### Session export/search show the conversation, not the injected turn context (B208)

- `moss sessions export` wrote the stored `<turn-context>` preamble (environment, skills catalog)
  into the shared Markdown, and `moss sessions search` matched/echoed it — searching "Environment"
  matched every session. Both now strip the preamble from user turns (the same helper behind `/resume`
  replay); the prompt, assistant turns and tool blocks are unchanged.

### 会话导出/搜索不显示注入的 turn context（B208）

- `moss sessions export` 会把存储的 `<turn-context>` 前缀（环境、技能目录）写进对外分享的 Markdown；
  `moss sessions search` 也会匹配并回显它——搜索 "Environment" 会命中所有会话。现在两者都会从用户回合剥离该前缀
  （与 `/resume` 回放共用同一 helper）；用户提问、助手回合与工具块保持不变。

### The plan gate advertises its number keys (B207)

- The "Ready to code?" gate only showed `↑↓ then Enter · or type feedback below · Esc keeps planning`,
  while `1/2/3` are the fastest answers (and are printed in the status row only after the dialog opens).
  The footer now reads `↑↓ then Enter, or 1/2/3 · or type feedback below · Esc keeps planning`.
- Real plan-mode check on the deepseek-flash gateway: plan mode refused a model's `exec` attempts with
  the documented "blocked (plan mode …)" message and the model switched to read-only tools to produce
  the plan; choosing `1` applied the plan and switched to accept-edits, and `run_tests` still asked
  approval as that mode promises.

### 计划确认弹窗标出数字键（B207）

- "Ready to code?" 弹窗原来只显示 `↑↓ then Enter · or type feedback below · Esc keeps planning`，而 `1/2/3`
  是最快的回答方式（且只在弹窗打开后的状态行里出现）。现在 footer 为
  `↑↓ then Enter, or 1/2/3 · or type feedback below · Esc keeps planning`。
- 真实计划模式验证（deepseek-flash）：计划模式按文档拒绝模型的 `exec` 尝试（"blocked (plan mode …)"），
  模型改用只读工具产出计划；选择 `1` 后应用计划并切到 accept-edits，`run_tests` 按该模式承诺仍需审批。

### `--continue` / `resume --last` skip sessions with nothing to resume (B206)

- After `/undo` dropped a session's turns it stayed the newest session, so `moss --continue` resumed
  an empty conversation (and `moss resume` offered it in the REPL picker). Implicit selection now only
  considers sessions with at least one message; an explicit key is still honoured.
- Real check: in a workspace whose newest entry was a 0-message session, `moss --continue` resumed the
  newest non-empty session and replayed its prompt + answer instead of booting blank.

### `--continue` / `resume --last` 跳过没有内容的会话（B206）

- `/undo` 把某会话的回合清空后，它仍是最新会话，于是 `moss --continue` 恢复了一个空对话（REPL 的 `moss resume`
  也会把它列出来）。隐式选择现在只考虑至少有一条消息的会话；显式指定 key 仍照常。
- 真实验证：在一个最新条目是 0 消息会话的工作区里，`moss --continue` 恢复了最新的非空会话，
  回放了它的提问与回答，而不是启动空白会话。

### The `/resume` picker lists each session once (B205)

- Opening `/resume` drew the overlay **and** printed the same ten-session list into the transcript
  behind it, and offered an all-empty session (0 messages, left over after `/undo`) that resumes to
  nothing. The picker now filters sessions with no messages and no longer duplicates the list in the
  transcript; the overlay is the list.

### `/resume` 选择器只列一次会话（B205）

- 打开 `/resume` 时既画了选择器，又在背后往转录里打印同一份十行会话列表；还列出 0 条消息的空会话
  （`/undo` 清空后遗留），恢复它没有任何变化。现在选择器过滤掉无消息会话，且不再把同一份列表打进转录；
  选择器本身就是列表。

### Resuming a session shows your prompt, not the injected turn context (B204)

- A stored user turn carries the `<turn-context>` preamble (skills catalog, environment, context
  window). `/resume` replayed the whole block as if the user had typed it; in a real resumed session
  that meant three screens of environment text under `❯ hi`. `resumeUserText` now strips the block
  (closed or truncated) while keeping the user's own text, so the replay is the conversation.
- Probe `rewind-conversation` 6/6 covers closed and unclosed preambles plus real user/assistant turns.

### 恢复会话显示你的输入，而不是注入的 turn context（B204）

- 存储的用户回合带有 `<turn-context>` 前缀（技能目录、环境、上下文窗口）。`/resume` 会把它整块当成用户输入回放：
  真实恢复会话里 `❯ hi` 下面出现三屏环境文本。`resumeUserText` 现在会剥掉该块（闭合或被截断），保留用户自己的文字，
  回放就是对话本身。
- 探针 `rewind-conversation` 6/6 覆盖闭合/未闭合前缀与真实用户/助手回合。

### `/undo` actually undoes, and replay no longer shows harness corrections as user text (B203)

- The TUI rewrites aliases before dispatch, so `/undo` arrived as the canonical `/rewind`; the new
  undo branch checked the rewritten text and never ran. It now reads the raw submission:
  `/undo` restores the latest checkpoint directly (`reverted checkpoint 1: 1 file(s) restored,
16 message(s) dropped` in a real resumed session), while `/rewind` still lists/restores by seq.
- Harness corrections were injected as `role: user` with bare text; some gates (verification) did not
  prefix `[System]`, so a resumed session replayed the nudge as if the user had typed it. Every
  correction is now marked `[System]` at the single injection point, and replay/internal filters drop
  it. Probes: `rewind-conversation` 5/5, `verification-gate` 23 assertions.

### `/undo` 真正执行撤销；恢复会话不再把内部纠正显示成用户输入（B203）

- TUI 在分发前会展开别名，`/undo` 到达处理处时已变成规范名 `/rewind`；新的撤销分支检查的是改写后的文本，所以从未执行。
  现在改为读取原始输入：`/undo` 直接恢复最近检查点（真实恢复会话中显示
  `reverted checkpoint 1: 1 file(s) restored, 16 message(s) dropped`），`/rewind` 仍可列出/按序号恢复。
- 内部纠正以 `role: user` 注入且部分 gate（verification）没加 `[System]` 前缀，恢复会话时会被当成用户输入回放。
  现在统一在单一注入点标记 `[System]`，回放/内部过滤会丢弃。探针：`rewind-conversation` 5/5、`verification-gate` 23 条断言。

### `/rewind` now sees surgical edits, and says how to restore (B202)

- Checkpoints only tracked `write_file` / `move_file` / `apply_patch`. A turn that used `edit_file` or
  `multi_edit` opened a checkpoint but tracked no file, so it was filtered out as empty and `/rewind`
  reported `Checkpoints (0)` even though the edit had happened. Both tools now register their paths
  (`multi_edit` dedupes the batch plus fallback path).
- A bare `/rewind` listed checkpoints without saying how to restore one, so typing a number was sent
  to the model as a chat message. The list now ends with `restore one with /rewind <seq>`; an empty
  list says when checkpoints appear.

### `/rewind` 现在能看到外科手术式编辑，并说明如何恢复（B202）

- 检查点原先只跟踪 `write_file` / `move_file` / `apply_patch`。使用 `edit_file` 或 `multi_edit` 的回合会打开检查点但不记录文件，
  因此被当作空检查点过滤，`/rewind` 明明编辑过也显示 `Checkpoints (0)`。现在两种工具都会登记路径
  （`multi_edit` 对批次路径去重并包含 fallback path）。
- 裸 `/rewind` 列出检查点却没说明如何恢复，用户输入数字会被当成聊天消息发给模型。现在列表末尾提示
  `restore one with /rewind <seq>`；空列表也会说明何时出现检查点。

### Maintenance: drop the unused `ink-testing-library` dev dependency (B201)

- No file imports it (the TUI probes render through the real transcript functions), so it leaves
  `package.json` and the lockfile: one dev dependency fewer to install, no runtime or test change.

### 维护：移除未使用的 `ink-testing-library` 开发依赖（B201）

- 仓库没有任何文件 import 它（TUI 探针直接走真实 transcript 渲染函数），因此从 `package.json` 与 lockfile 移除：
  少装一个开发依赖，运行时与测试行为不变。

### Validation round: real TUI task, plus the last two unreferenced exports removed (B200)

- Ran a real end-to-end TUI task on the deepseek-flash gateway (`Create sum.js + node:test, run it`):
  two files written, `Run Tests` reported `ALL PASSED · 2/2 passed · 227ms`, final answer one sentence.
  The chrome behaved as designed: one-row tool previews, `in 9.7k · out … · ctx ~2%` (unprobed window
  marked approximate), no todo panel noise, quiet run end.
- The last two exports with no reference anywhere (AST-scanned) are gone (`isDenialClass`,
  `clearSkillToolScope` plus their now-unused local constants): −15 lines, no behavior change.
- Honest gap observed: the model still volunteered an audit-style aside ("Before editing further: … no
  external spec cited …") even though the nudge did not fire. It is model behavior, not a code path;
  per the owner's "don't over-design" instruction this round did not add filtering code for it.

### 验证轮：真实 TUI 任务 + 删除最后两个无引用导出（B200）

- 在 deepseek-flash 真实网关上跑了一次完整 TUI 任务（`Create sum.js + node:test, run it`）：
  两个文件写入成功，`Run Tests` 报 `ALL PASSED · 2/2 passed · 227ms`，最终回答一句话。
  界面按设计工作：工具预览单行、`in 9.7k · out … · ctx ~2%`（未探测窗口标为近似）、无 todo 噪音、收尾安静。
- AST 扫描出最后两个全仓无引用导出（`isDenialClass`、`clearSkillToolScope`）及其连带未用常量已删除：−15 行，无行为变化。
- 诚实缺口：模型仍会自发来一句审计式旁白（"Before editing further: … no external spec cited …"），本次 nudge 并未触发；
  这是模型行为而非代码路径。按 owner "不要过度设计" 的指示，本轮没有为它增加过滤代码。

### Maintenance: 19 unreferenced exports removed (−158 lines, no behavior change) (B199)

- A repo-wide reference scan found 24 exported helpers whose only occurrence was their declaration
  (no `src`/`scripts`/`bench`/`examples`/docs reference, none re-exported through the public barrels in
  `src/index.ts`). 19 safe internal ones are gone: superseded tool-result/command formatters, unused
  test-only reset helpers, dead probe counters and config readers. Two multi-line-signature functions
  were restored rather than risk a mechanical cut.
- No behavior change: the full gate passes; public API barrels are untouched. This is a deliberate
  subtraction round after a long additive stretch — no new capability was added.

### 维护：删除 19 个无引用导出（−158 行，无行为变化）（B199）

- 全仓引用扫描发现 24 个导出辅助函数只在声明处出现（`src`/`scripts`/`bench`/`examples`/docs 均无引用，
  也未通过 `src/index.ts` 的公开 barrel 导出）。删除了其中 19 个安全项：被取代的工具结果/命令格式化器、
  仅供测试的重置函数、无用的探测计数与配置读取。两个多行签名的函数选择恢复原状，避免机械切割风险。
- 无行为变化：完整门禁通过；公开 API barrel 未动。这是一轮在长期"只加不减"之后的刻意减法，不新增能力。

### An unprobed context window is shown as approximate (B198)

- When the provider has no `/models` context-length API (the common gateway case), the window falls
  back to the conservative 1M default — but the status row still printed `ctx 2%` with the same
  confidence as a probed window. It now prints `ctx ~2%`; `npm run doctor` and `/context` already say
  the source is unprobed, so the chrome no longer overstates precision.

### 未探测的上下文窗口显示为近似值（B198）

- 当 provider 没有 `/models` 上下文长度接口（常见网关情况）时，窗口会退回保守的 1M 默认值，
  但状态行仍以和已探测窗口一样的确定性打印 `ctx 2%`。现在显示 `ctx ~2%`；`moss doctor` 与 `/context`
  本就说明来源未探测，界面不再夸大精度。

### The approval footer states every key that works (B197)

- `Esc to deny · ↑↓ then Enter` left Enter's target implicit (the focused option, usually `1. Yes`),
  which is what surprised users when an adjacent protected-path dialog made Enter mean deny. The
  footer now reads `Esc to deny · ↑↓ + Enter, or press 1/2/3` — the focused-option semantics and the
  direct number keys are both visible. Protected-path dialogs keep their explicit
  `Esc or Enter = deny` footer because there deny is the deliberate default.
- Capability spot-check this round: 3 tasks × 3 samples on the real gateway (deepseek-flash) —
  `single-edit`, `test-fix-loop`, `error-recovery` — all **9/9 PASS (100%)**, ~5.5 turns / ~12s per
  sample.

### 审批 footer 明确列出所有可用按键（B197）

- `Esc to deny · ↑↓ then Enter` 没说明 Enter 选中什么（当前高亮项，通常是 `1. Yes`），这正是用户在相邻
  受保护路径弹窗里遇到"Enter 变成拒绝"时困惑的来源。现在 footer 为
  `Esc to deny · ↑↓ + Enter, or press 1/2/3`——高亮项语义与数字直选都可见。受保护路径弹窗保留显式的
  `Esc or Enter = deny`（那里拒绝是刻意的默认值）。
- 本轮能力抽查：真实网关（deepseek-flash）3 个任务 × 3 样本——`single-edit`、`test-fix-loop`、`error-recovery`——
  全部 **9/9 PASS（100%）**，每样本约 5.5 回合 / ~12s。

### Leaving the TUI says what the command does (B196)

- The inline exit hint was a bare `moss --continue`. It now says
  `Resume this session: moss --continue` (`继续本次会话：moss --continue`), so a first-time user knows the
  command continues _this_ session rather than starting something new.
- Capability spot-check this round: `npm run bench -- --task single-edit --samples 3` on the real
  gateway (deepseek-flash) passed **3/3 (100%)**, 5.5 turns / 11.4s / ~60k in / 698 out per sample.

### 退出 TUI 时说明命令的作用（B196）

- inline 退出提示原来只有裸 `moss --continue`；现在为 `Resume this session: moss --continue`
  （中文 `继续本次会话：moss --continue`），第一次使用的用户也能知道这是续上本次会话，而不是开新会话。
- 本轮能力抽查：真实网关（deepseek-flash）`npm run bench -- --task single-edit --samples 3` 通过 **3/3（100%）**，
  每样本约 5.5 回合 / 11.4s / ~60k in / 698 out。

### README handfeel/capability claims match the shipped behavior again (B195)

- The handfeel table still promised that a fresh folder shows `Try "/init"` in the empty-composer
  hint; since B192 `/init` lives in the `Next:` row and the hint follows the workspace kind. The row
  now says exactly that, and the table gained the two new interaction surfaces: `/style` (switch the
  voice mid-session) and `moss runs follow` (watch the ledger settle).
- The quality section still claimed "~40s locally"; the sharded CI gate and heavier probe set make
  the real number ~1–1.5 min locally depending on load. Both READMEs now state the local figure and
  the two-shard/60s-per-shard CI arrangement. The README parity probe also pins `/style` and
  `moss runs follow` so the product page cannot drift from the CLI surface.

### README 的手感/能力表述再次与实现一致（B195）

- 手感表还写着"全新目录提示 `Try "/init"`"；自 B192 起 `/init` 只在 `Next:` 行，占位提示跟随工作区类型。
  该行已改正，并补上两个新交互面：`/style`（会话内切换语气）与 `moss runs follow`（实时盯着账本收尾）。
- 质量段还写"本地约 40s"；分片 CI 与更重的探针集后实际约 1–1.5 分钟（随负载）。中英 README 现在同时写明本地耗时
  与"两片并行、每片 60s 预算"的 CI 安排；README parity 探针新增 `/style` 与 `moss runs follow` 断言，防止产品页与 CLI 面漂移。

### The status row labels every number, and a long wait names what it waits for (B194)

- `9.7k in / 161 out · 1% ctx` read like one value plus an unexplained `ctx`. The row now says
  `in 9.7k · out 161 · ctx 2%` (`入 9.7k · 出 161 · 上下文 2%` in Chinese).
- A model that takes minutes used to say `Still reasoning, waited 60s`, which sounds stuck and offers
  no next step (the separate stall line already carries the Esc hint). The wait verb is now
  `Waiting on the model, 60s` / `等待模型响应，已 60s`, and its second bucket is not appended twice
  (a stale `waited`-only check printed `Waiting on the model, 30s… 30s`).

### 状态行给每个数字加标签；长时间等待说明在等什么（B194）

- `9.7k in / 161 out · 1% ctx` 读起来像一个值与一个没解释的 `ctx`。现在显示为
  `in 9.7k · out 161 · ctx 2%`（中文 `入 9.7k · 出 161 · 上下文 2%`）。
- 模型跑上几分钟时旧文案是 `Still reasoning, waited 60s`，像卡住且没有下一步（旁边已有 Esc 提示）。
  等待动词改为 `Waiting on the model, 60s` / `等待模型响应，已 60s`，并修掉第二次追加秒数的问题
  （旧检测只认 `waited`，曾显示 `Waiting on the model, 30s… 30s`）。

### A streamed bullet list stays one list (B193)

- The stream commits prose at paragraph boundaries, so a three-bullet answer arrived as three separate
  assistant rows — each with its own `⏺`-less indent but a paragraph gap between them, which read as
  three spaced blocks. A continuation row whose text starts with a list marker (and whose previous row
  ends with one) is now attached: bullets render as one contiguous list; genuine paragraph
  continuations keep their blank line.

### 流式输出的项目符号列表保持为一个列表（B193）

- 流式回答按段落边界提交，三段 bullet 会变成三行独立的 assistant 行——虽已去掉 `⏺` 并缩进，但行间仍有段落空行，
  看起来像三个分散的块。现在"以列表标记开头且上一行也以列表项结尾"的 continuation 行会紧贴：三个 bullet 连成一个列表；
  真正的段落 continuation 仍保留空行。

### First screen, approval dialogs and tool rows: fewer duplicates, full commands (B192)

A real-TUI usability audit (two PTY sessions, four real model turns) ranked the remaining "feel"
problems. This round fixes the four cheapest high-impact ones:

- **First screen says `/init` once.** `Next: /init` and the composer placeholder both said it. The
  composer now uses the workspace-kind hint; `/init` stays in the `Next:` row only.
- **Approval dialogs show the whole command.** A long `&&` chain is shown as `$ <full command>` in the
  dialog body (wrapped), not just a clipped subject; protected-path dialogs also print the real command
  instead of "non-literal command name". The redundant "(try to save in user config)" suffix is gone.
- **One row per read-only observation and per todo update.** `Read(x) · Read 7 lines` no longer gets a
  second `… 7 lines · ctrl+o` line (`ctrl+o` moves onto the headline); `todo_write` folds to
  `⎿ 1/3 done` instead of reprinting the checklist that the composer panel already shows.
- **Quieter cold start.** The interactive TUI no longer prints the `[moss] Interaction mode …` line
  (its persistent status row shows the mode); the `.gitignore` suggestion is one line, not three.

### 首屏、审批弹窗、工具行：去重并显示完整命令（B192）

真实 TUI 可用性审计（两次 PTY 会话、四轮真实模型）排出了剩余"手感"问题，本轮修掉成本最低、影响最大的四项：

- **首屏只说一次 `/init`**：`Next: /init` 与输入框占位符重复；占位符改为按工作区类型的提示，`/init` 只留在 `Next:` 行。
- **审批弹窗显示完整命令**：长 `&&` 链以 `$ <完整命令>`（自动换行）出现在弹窗正文，不再只靠被截断的 subject；
  受保护路径弹窗也打印真实命令，而不是 "non-literal command name"；去掉多余的 "(try to save in user config)" 后缀。
- **每次只读观察/待办更新只占一行**：`Read(x) · Read 7 lines` 不再多一行 `… 7 lines · ctrl+o`（`ctrl+o` 并入标题）；
  `todo_write` 折叠成 `⎿ 1/3 done`，不再重打印输入框上方已有的清单。
- **冷启动更安静**：交互 TUI 不再打印 `[moss] Interaction mode …`（常驻状态行已显示模式）；`.gitignore` 建议压成一行。

### The first hint follows the workspace, not a checkout's `.env` (B191)

- A dev checkout's `.env` can name a board (`MOSS_DEVICE_HOST`). Because the CLI also loads the
  install directory's `.env`, every unrelated folder used to open with `Try "stream the camera at 30
fps and verify it"` — a board workflow offered as the first move in a plain folder.
- The empty-composer hint now treats a device host as this workspace's board only when it comes from
  the project's own `.env`/an ancestor's, or the real process environment; a device configured in a
  checkout no longer turns unrelated workspaces into board sessions. Code and general hints unchanged.

### 首屏提示跟随工作区，而不是检出目录的 `.env`（B191）

- 开发检出的 `.env` 可以指定开发板（`MOSS_DEVICE_HOST`）；由于 CLI 也会加载安装目录的 `.env`，任何无关目录的首屏都会显示
  `Try "stream the camera at 30 fps and verify it"`——在普通文件夹里把开发板流程当成第一步。
- 现在只有设备 host 来自本项目（自身或祖先目录的 `.env`）或真实进程环境时，才把该工作区视为开发板；检出目录里配置的设备
  不再让无关工作区变成 board 会话。代码/通用提示保持不变。

### The CI gate runs as two parallel shards, each with the same 60s budget (B190)

- GitHub's runner speed varies; the same gate that passed in 36.8s tripped the 60s budget on a slower
  run (61.1s) while every individual stage stayed under 10s — the wall was total work / cores.
- The gate now runs as two parallel jobs (`VERIFY_SHARD=i/2`): each runs `static`, `build` and
  alternating stages of the fast gate under the same 60s budget, and a final **Fast gate** aggregator
  ([scripts/verify/ci-gate.mjs](scripts/verify/ci-gate.mjs)) remains the single required status check.
  No stage is dropped and the budget is not relaxed; `npm run verify` locally still runs the whole gate.
  `--shard i/n` validates its argument (bad values exit 2).

### CI 门禁改为两个并行分片，各自保持 60s 预算（B190）

- GitHub runner 速度波动大：同一条门禁先 36.8s 通过，下一次在更慢的 runner 上 61.1s 触线，而单 stage 都不到 10s——墙钟约等于总工作量/核数。
- 现在拆成两个并行 job（`VERIFY_SHARD=i/2`）：各自运行 `static`、`build` 与快速门禁的交替 stage，预算仍是 60s；
  最终 **Fast gate** 聚合 job（[scripts/verify/ci-gate.mjs](scripts/verify/ci-gate.mjs)）仍是唯一的必需状态检查。
  不删 stage、不放宽预算；本地 `npm run verify` 仍一次跑完整门禁。`--shard i/n` 会校验参数（坏值 exit 2）。

### A cited-but-missing authority becomes a question, not a SPEC-AUDIT detour (B189)

- "Per the docs, …" correctly triggers the spec-audit nudge, but the old correction told the model to
  write `SPEC-AUDIT.md` whenever the authority was unclear. In a fresh workspace it did exactly that:
  16s, eight tool calls, a 33-line audit file, and a long answer to a one-file request.
- The correction now says: if the cited authority is missing, **ask for the exact doc path/text in one
  short question and stop** — only write `SPEC-AUDIT.md` when the docs exist and conflict or are stale.
  Same prompt after the change: 7s, two tool calls, no audit file, two-line answer plus one question.
- Model asides about its own process (`Spec audit: …`, `Interpretation: …`) are folded to one dim line in
  the TUI instead of a bright markdown block; verbose mode still shows the full text.

### 引用了不存在的"权威"时应追问，而不是去做 SPEC-AUDIT（B189）

- "Per the docs, …" 会正确触发 spec-audit nudge，但旧提示让模型在权威不明确时就写 `SPEC-AUDIT.md`。在空工作区里它真的这么做了：
  16s、8 次工具调用、33 行审计文件，对一个单文件请求给出长回答。
- 现在改为：引用的权威不存在时，**用一句短问题问清 doc 路径/原文并停下**；只有 docs 确实存在且与任务冲突或过期时才写
  `SPEC-AUDIT.md`。同一句 prompt 改后：7s、2 次工具调用、无审计文件、两行回答 + 一个追问。
- 模型关于自身过程的旁白（`Spec audit: …`、`Interpretation: …`）在 TUI 中折叠为一行 dim 文本，不再是醒目的 Markdown 块；
  verbose 模式仍显示全文。

### The status row stops saying "price unknown" forever (B188)

- On an unpriced gateway (the common local setup) the TUI status row carried a permanent
  `price unknown` label on every frame — noise, not information. The label is gone; cost still shows
  when it is actually computable, and `/usage` plus the run ledger still state that pricing is
  unavailable. The headless profile keeps its honest `cost: unpriced` wording.
- Verification: the three `moss doctor` boots in the tiny-window gate now run concurrently, cutting
  that stage from ~26s on CI to ~2s locally; the gate regains a comfortable budget margin.

### 状态行不再永久显示 "price unknown"（B188）

- 在没有公开定价的网关上（本地常见配置），TUI 状态行每一帧都挂着 `price unknown`——这是噪音而不是信息。
  该标签已去掉；可计算时仍显示费用，`/usage` 与运行账本仍如实说明无法定价。headless 输出保留诚实的 `cost: unpriced`。
- 验证：tiny-window 门禁里的三次 `moss doctor` 启动改为并发，该 stage 从 CI 上约 26s 降到本地约 2s，门禁预算余量恢复。

### The built-in discipline prompt was dead code; it is installed now, with a communication contract (B187)

- `buildMossDefaultWorkflowPrompt()` was exported but never added to any prompt layer, so a workspace
  without an `AGENTS.md` ran with **no** built-in engineering contract — the discipline text, including
  its new communication rules, never reached the model.
- The CLI prompt setup now installs it as a stable `cli:default-workflow` contract layer (project
  instructions stack on top and may override specifics). A new final "Communication contract" asks for
  outcome first, at most two lines of evidence, and no process/self-audit narration, tutorial sections,
  or restating the request/diff.
- The spec-audit nudge no longer fires on a bare "docs/文档/说明/需求" mention: it requires citation
  phrasing ("per the docs", "the spec says", "按文档要求", …), so ordinary tasks stop turning into
  SPEC-AUDIT detours.

### 内置纪律提示词此前是死代码；现在真正装上，并加入沟通契约（B187）

- `buildMossDefaultWorkflowPrompt()` 只被导出、从未加进任何提示层，因此**没有 AGENTS.md 的工作区完全没有内置工程契约**，
  其中的沟通规则也从未到达模型。
- CLI 提示层现在把它作为稳定的 `cli:default-workflow` 契约层安装（项目指令可叠加并覆盖具体规则）。末尾新增
  "Communication contract"：先给结果、最多两行证据，不叙述过程/自审、不写教程段、不复述请求或屏幕上的 diff。
- spec-audit nudge 不再因为裸提"docs/文档/说明/需求"就触发：必须出现引用语气（"per the docs"、"the spec says"、
  "按文档要求" 等），普通任务不再被拉去做 SPEC-AUDIT。

### `/style` makes the voice visible and switchable mid-session (B186)

- The output style (`default` / `explanatory` / `learning`) could only be changed through config, and
  nothing on screen said which voice was active — a `learning` config left users with "teaching run"
  explanations they never asked for. The first screen now says `output style: learning — /style
default to switch back` when a non-default style is active.
- New `/style` (alias `/output-style`): no argument prints the current style, options and the
  persist command; `/style default|explanatory|learning` switches this session immediately (the prompt
  layer is dynamic, so the next turn uses the new voice) and prints how to persist it.

### `/style` 让"语气"可见、可在会话中切换（B186）

- 输出风格（`default` / `explanatory` / `learning`）以前只能改配置，界面上也不说明当前是什么语气——
  配成 `learning` 后用户会一直收到没要的"教学式"解释。现在首屏在有非默认风格时会显示
  `output style: learning — /style default to switch back`。
- 新增 `/style`（别名 `/output-style`）：不带参数打印当前风格、可选项与持久化命令；
  `/style default|explanatory|learning` 立即切换本次会话（提示词层是动态的，下一回合即生效），并提示如何持久化。

### A successful command is one line, not a dump (B185)

- Every successful `exec` still printed up to three preview lines plus its headline; six commands in a
  row meant ~30 transcript rows of file lists the user rarely needs mid-run. Successful exec output is
  now the headline plus **one** line, with the rest behind `ctrl+o` (failures keep their fuller preview
  and `Next:` line, code dumps keep theirs).

### 成功的命令只占一行，而不是一段输出（B185）

- 每条成功的 `exec` 仍会打印最多 3 行预览加上标题；连续六条命令就是 ~30 行文件列表，运行时很少需要。
  现在成功 exec 只显示标题 + **1** 行输出，其余收进 `ctrl+o`（失败仍保留更完整的预览与 `Next:` 行，
  代码块保持原样）。

### Two ledger safety fixes: prune keeps in-flight runs, export stays in the workspace (B184)

- `moss runs prune` could delete a `running` row that happened to be older than the newest N runs.
  That row is the only place the owner pid lives, so a live run would lose its in-progress record.
  Prune now never removes `running` rows (a reconciled `paused` row is history and may be removed).
- `moss runs export --out ../x.md` (single or filtered) wrote outside the workspace, unlike every
  other user-visible artifact. `--out` is now confined to the workspace and escapes exit 2 with a
  clear message; no file is written.

### 两处账本安全修复：prune 保留进行中运行，export 不写工作区外（B184）

- `moss runs prune` 可能删掉一条比最新 N 条更旧的 `running` 行——那是进程 pid 唯一的落点，
  删除会让正在跑的任务失去进行中记录。现在 prune 永不删除 `running` 行（已归一为 `paused` 的崩溃行属于历史，可以删）。
- `moss runs export --out ../x.md`（单条或过滤合并）会写到工作区之外，与其它用户可见产物不一致。
  现在 `--out` 限定在工作区内，越界 exit 2 并给出明确信息，且不写任何文件。

### Watch autonomous runs settle: `moss runs follow` (B183)

- The ledger could be read after the fact; there was no way to watch it like `loop follow` watches a
  loop. `moss runs follow [--interval 1s] [--timeout 10m] [--kind <engine>] [--json]` polls the
  ledger and prints new runs (`+`) and status changes (`~`, e.g. running → completed), then exits 0
  with `all runs settled` once nothing is in flight. The first poll is a baseline that only announces
  in-flight rows, so history is not a wall of `+` lines; a timeout with work still running exits 1.

### 观察自主运行收尾：`moss runs follow`（B183）

- 账本此前只能事后读，不能像 `loop follow` 那样"盯着看"。`moss runs follow [--interval 1s] [--timeout 10m] [--kind <引擎>] [--json]`
  轮询账本，打印新运行（`+`）与状态变化（`~`，如 running → completed），没有在飞运行后打印
  `all runs settled` 并 exit 0。第一次轮询只作基线、只播报进行中的行（不会把历史刷成一屏 `+`）；
  超时仍有运行在跑则 exit 1。

### `moss runs export` can report many runs at once (B182)

- Exporting one run was fine for a single PR, but a week of autonomous work (or a CI job's last day)
  needed `--since`/`--kind`/`--limit`: `moss runs export --since 7d --kind task --format md` now emits
  one Markdown report with a `# Moss runs — since 7d (N)` header and one `## Run …` section per record;
  `--json` returns `{ total, ledgerRuns, runs[] }`; `--out` writes the combined file. Passing a run id
  together with a filter is a usage error.

### `moss runs export` 可以一次导出一批运行（B182）

- 单条导出适合一次 PR，但"一周的自主运行"或"CI 当天的运行"需要 `--since`/`--kind`/`--limit`：
  `moss runs export --since 7d --kind task --format md` 现在输出一份 Markdown 报告——`# Moss runs — since 7d (N)`
  标题 + 每条运行一个 `## Run …` 段；`--json` 返回 `{ total, ledgerRuns, runs[] }`；`--out` 写整份文件。
  同时给 run id 和过滤条件属于用法错误。

### A goal/task run is visible from its first planned turn (B181)

- B178–B180 covered superagent/loop/workflow; a `moss goal` run (which can take minutes) still appeared
  only at the end. As soon as the task engine creates its native task id, the CLI publishes a
  pid/host-tagged `running` row (next: `moss task status <id>`); the final write awaits that row and
  overwrites the same id, so the ledger never shows two rows for one task and B179's crash
  reconciliation applies.

### goal/task 运行从第一个计划回合起即可见（B181）

- B178–B180 覆盖了 superagent/loop/workflow；`moss goal`（可能跑数分钟）仍只在结束时出现。
  现在任务引擎一创建原生 task id，CLI 就发布带 pid/host 的 `running` 行（next：`moss task status <id>`）；
  最终写入会先 await 该行再覆盖同一 id，因此一个任务不会出现两行，且自动享有 B179 的崩溃对账。

### Loop and workflow runs are visible while they run (B180)

- B178/B179 gave superagent in-flight rows; `moss loop` (which can run for minutes across attempts) and
  `moss workflow` still appeared only at the end. Both now publish a `running` row when they start —
  `writeRunningRecord` carries pid/host, so B179's crash reconciliation applies to them too — and the
  final write with the same run id overwrites it (one row, never two).

### loop 与 workflow 运行中即可见（B180）

- B178/B179 只为 superagent 做了进行中行；`moss loop`（可能跨多轮跑数分钟）与 `moss workflow` 仍只在结束时出现。
  现在两者启动即写 `running` 行——`writeRunningRecord` 带 pid/host，因此 B179 的崩溃对账同样适用——
  结束时用同一 run id 覆盖（始终只有一行，不会出现两条）。

### A crashed in-flight run no longer looks "in progress" forever (B179)

- B178's `running` row had no reconciliation: a `moss superagent work` killed mid-ticket left the row
  running indefinitely. The row now records `pid` + `host`; on read, a running row whose owning
  process is gone **on this host** becomes `interrupted` (paused) with exit 130 and an explicit reason
  ("the run process is gone"). Foreign hosts and rows without a pid stay `running` — genuinely unknown
  is not guessed.
- `runs show` for a live pid keeps `running` + `exit: —`; a dead pid shows `paused`, `exit: 130`.
  Probe runs-ledger 15/15 covers dead/live/foreign/missing pid.

### 崩溃的进行中运行不会永远显示「进行中」（B179）

- B178 的 `running` 行没有对账：`moss superagent work` 在工单中途被杀会留下永远 running 的行。现在运行行记录
  `pid` + `host`；读取时，若该行属于**本机**且其进程已不存在，就归一为 `interrupted`（暂停），exit 130，
  并给出明确原因（"the run process is gone"）。异机 pid 或没有 pid 的行保持 `running`——真正未知就不猜。
- `runs show`：活 pid 仍显示 `running` + `exit: —`；死 pid 显示 `paused`、`exit: 130`。
  探针 `runs-ledger` 15/15 覆盖 dead/live/foreign/missing pid 四种情况。

### An in-flight ticket is visible: `running` rows in the ledger (B178)

- A superagent ticket used to appear in `moss runs` only when it ended — a 6-minute ticket was
  invisible (and the first screen had nothing to show) until then. The runtime now writes a
  `running` row when the dispatch starts and overwrites it with the final outcome.
- The ledger vocabulary gains `running`: `moss runs --status running` lists it, the header shows
  `· N running` only when present, and `runs show` prints `exit: —` without a misleading 0s
  duration. The first screen says `In progress — …` / `进行中：…` and points at `/runs` (interactive)
  or `moss runs show latest` (CLI) instead of offering a pointless "resume".

### 进行中的工单可见：账本新增 `running` 行（B178）

- 之前 superagent 工单只有在结束时才出现在 `moss runs`——一个跑 6 分钟的工单在此之前完全不可见，
  首屏也无从提示。现在派发开始时写一条 `running` 行，结束时用最终结果覆盖它。
- 账本状态词汇新增 `running`：`moss runs --status running` 可筛，表头仅在有进行中运行时显示
  `· N running`；`runs show` 打印 `exit: —` 而不是误导性的 0s 耗时。首屏改为
  `In progress — …` / `进行中：…`，交互面指向 `/runs`，CLI 指向 `moss runs show latest`，
  不再提示无意义的「继续」。

### Workflow runs report their model too (B177)

- B167 recorded the model for chat/task/loop/superagent runs but not workflow: children write their
  usage to `MOSS_USAGE_FILE`, and the parent only read the numbers, so `--by model` bucketed every
  workflow as `unknown`.
- The usage file now carries `{ usage, model }` (B164's bare-usage shape is still read), each step
  keeps its model, and the workflow record records it **only when every step reports the same one** —
  a mixed or partial set stays `undefined` instead of mis-attributing cost.
- Real two-step workflow (deepseek-flash): `runs show latest` prints `model: deepseek-flash@latest`,
  and `moss runs summary --by model` shows the workflow bucket with its tokens.

### workflow 运行也开始记录模型（B177）

- B167 已为 chat/task/loop/superagent 记录模型，但 workflow 没有：子进程把用量写进 `MOSS_USAGE_FILE`，
  父进程只读了数字，于是 `--by model` 把所有 workflow 归到 `unknown`。
- 用量文件现在带 `{ usage, model }`（仍兼容 B164 的裸 usage 形状），每个 step 保留自己的模型，
  workflow 记录**只有所有 step 一致时才写 model**——混合或缺失一律 `undefined`，不错误归因成本。
- 真实两步 workflow（deepseek-flash）：`runs show latest` 打印 `model: deepseek-flash@latest`，
  `moss runs summary --by model` 出现该 workflow 的 bucket 与 token。

### README: the verifiability story is now concrete (B176)

- The README said "probes exist" but never showed what a recorded run looks like. A new
  "Reading one run" / 「怎么读一次运行」 block shows a real `moss runs show latest` output —
  status, exit code, acceptance command, counts, `model`, `usage`, `gate`, `next` — and names the
  three exits (human `show`, script `--json`, PR `export`).
- The quality section now states the current scale honestly: **90+ re-runnable probes/stages** in
  `npm run verify` (~40s locally, 60s CI budget, same command in CI).
- Fixed a stale sentence that claimed a `Next` line is reprinted after _every_ autonomous run; it is
  printed after goal/task runs and points at the resume command / `/diff` / `moss runs` (B157).
  Both languages updated together.

### README：可验证性叙事变得具体（B176）

- 之前 README 只说"有探针"，却没展示一条被记录下来的运行长什么样。新增「怎么读一次运行」/
  "Reading one run" 区块，给出真实 `moss runs show latest` 的输出——状态、退出码、验收命令、
  计数、`model`、`usage`、`gate`、`next`——并点名三个出口（人看 `show`、脚本读 `--json`、
  PR 贴 `export`）。
- 质量章节现在如实写出规模：`npm run verify` 里 **90+ 个可复跑探针/阶段**（本地约 40s，
  CI 预算 60s，CI 跑同一条命令）。
- 修正一句过期描述（声称**每次**自主运行后都重印 `Next`）；实际在目标/任务运行后打印，指向
  续跑命令 / `/diff` / `moss runs`（B157）。中英同步更新。

### Manual mode stops asking for read-only shell chains (B175)

- Manual mode promises "mutations and device changes confirm one by one", but a read-only chain like
  `ls -l note.md && cat note.md` opened an approval dialog: the readonly fast path rejected shell
  operators wholesale, so the whole compound line was classified as a write.
- The fast path now splits `&&`, `||`, `;` and `|` outside quotes and trusts the line only when every
  segment is readonly. Redirections, substitutions, absolute paths, backslash escapes and
  background `&` stay unclassified and still prompt, so the boundary did not move.
- Real TUI (manual mode, deepseek-flash): `ls -l note.md && cat note.md` runs immediately with no
  dialog; heredoc writes still show the approval with the full first line as its subject.

### 手动模式不再为只读 shell 链弹审批（B175）

- 手动模式承诺「变更与设备操作逐个确认」，但像 `ls -l note.md && cat note.md` 这样的只读链也会弹审批：
  只读快路径遇到 shell 操作符就整行放弃，于是把整条命令当成写操作。
- 现在快路径会在引号外拆分 `&&`、`||`、`;`、`|`，只有每一段都只读时才信任整行；重定向、命令替换、
  绝对路径、反斜杠转义与后台 `&` 仍不分类、仍会弹审批——安全边界没有移动。
- 真实 TUI（手动模式，deepseek-flash）：`ls -l note.md && cat note.md` 直接执行、无对话框；
  heredoc 写文件仍弹审批，且审批目标显示完整首行。

### CI-only flake fixes: same-millisecond rows and a starved interrupt probe

- `goal-runs` failed `newest first` again on CI: the tie-break ranked `startedAt` before the ledger
  position, so two runs recorded in the same millisecond could show an older long-running entry
  first. Append order is the record order now (endedAt → later row → startedAt), and the probe
  constructs that tie directly (7/7).
- `repl-interrupt` retries a key once when the REPL never starts streaming on a heavily loaded
  machine, with a message that names the cause instead of reporting a false interrupt regression.

### The mutation notice only fires when a read body actually went stale (B173)

- After B172, `2>/dev/null` no longer produced the notice, but it still printed for every real
  shell write — including files this run had never read, where there is no read credit to clear
  and therefore nothing to re-read. In the long screenshot run that meant a notice after almost
  every command.
- `invalidateFileState` now reports whether it actually cleared a recorded read; the exec result
  only prints the notice for those paths (and the wording is shorter: "Re-read before the next
  surgical edit"). Writing a fresh file is silent.

### 文件变更提示只在读取内容真的过期时出现（B173）

- B172 之后 `2>/dev/null` 不再触发提示，但**真实** shell 写入仍会打印——包括本次运行从未读过的文件，
  那里没有读取信用可清、也没有东西需要重读。长截图那次运行因此几乎每条命令后都有一行提示。
- `invalidateFileState` 现在返回"是否真的清掉了已记录的读取"；exec 结果只对这类路径打印提示，
  并把文案缩短为「Re-read before the next surgical edit」。写入全新文件保持安静。

### No more `/dev/null` mutation notice; the wait line stops repeating itself (B172)

A long real TUI run showed two wrong lines after every noisy command:

- `[moss] Detected shell file mutation — prior read credit cleared for: /dev/null` was printed for
  ordinary `2>/dev/null` redirects. A character device cannot have a stale read body, so device and
  fd pseudo-paths (`/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/fd/*`, `/proc/self/fd/*`, …) are
  no longer treated as workspace mutations, while real file targets (`> out.txt`, `sed -i`) still
  invalidate read credit and still print the notice.
- `Still reasoning, waited 570s 573s` appended the raw elapsed seconds after the wait bucket. The
  live line now prints the bucket once (`… waited 570s`) and keeps the token count.

### 不再为 `/dev/null` 报「shell 文件变更」；等待行不再重复秒数（B172）

一次真实的长 TUI 运行里，每条带重定向的命令后都会出现两行错误信息：

- 普通 `2>/dev/null` 会触发 `[moss] Detected shell file mutation — prior read credit cleared for:
/dev/null`。字符设备没有可能过期的读取内容，因此设备与 fd 伪路径（`/dev/null`、
  `/dev/stdout`、`/dev/stderr`、`/dev/fd/*`、`/proc/self/fd/*` …）不再被当作工作区文件变更；
  真实文件目标（`> out.txt`、`sed -i`）仍会失效旧的读取并打印提示。
- `Still reasoning, waited 570s 573s` 在等待分桶后又拼了一次原始秒数。现在实时行只打印一次
  （`… waited 570s`），并保留 token 计数。

### Shell writes through a symlinked workspace path are no longer refused (B91)

- On macOS `/tmp` is a symlink to `/private/tmp`. With workspace-write shell confinement, a
  workspace opened as `/private/tmp/ws` and a command writing `/tmp/ws/x` failed a _lexical_
  containment check even though the target is inside the workspace (`/tmp/ws` and
  `/private/tmp/ws` are the same directory).
- `assertSandboxPath` now retries through `realpath` when the lexical check misses: it resolves
  the nearest existing ancestor and compares the real target against real roots. Real escapes are
  still refused, and a symlink inside the root pointing outside is still refused (the retry is not
  a bypass). New offline probe `shell-write-sandbox` covers both spellings, a relative write, a
  real escape and the inside-symlink escape.

### 通过符号链接路径的 shell 写入不再被误拦（B91）

- macOS 上 `/tmp` 是指向 `/private/tmp` 的符号链接。开启 workspace-write 的 shell 约束时，工作区以
  `/private/tmp/ws` 打开、命令写 `/tmp/ws/x`，会因**词法**包含判断失败而被拦——尽管目标就在工作区内
  （`/tmp/ws` 与 `/private/tmp/ws` 是同一目录）。
- `assertSandboxPath` 现在在词法判断失败时改用 `realpath` 重试：解析最近的存在祖先，把真实目标与
  真实根比较。真正的逃逸仍被拒绝，根内指向外部的符号链接也仍被拒绝（重试不是绕过）。新增离线探针
  `shell-write-sandbox` 覆盖两种拼写、相对写入、真实逃逸与根内符号链接逃逸。

### Code blocks lose their full-width rules (B171)

- The fenced-code frame spent most of each line on `────` (`┌ bash ─────…`, `└────…`), which made
  code the loudest thing on screen and reflowed the block when the closing fence arrived. The
  frame is now a short label plus the left bar — `┌ bash` / `│ echo hello` / `└` — and the
  streaming and closed forms share it, so closing only adds the footer row.

### 代码块去掉整行横线（B171）

- 代码围栏的边框把每一行大部分都花在 `────` 上（`┌ bash ─────…`、`└────…`），既抢视觉，又会在围栏
  闭合时重排整块。现在边框是短标签 + 左侧竖线 —— `┌ bash` / `│ echo hello` / `└`；流式与闭合形态
  共用同一套边框，闭合只多出一行底边。

### Streaming answers no longer flash raw fences; file titles are workspace-relative (B170)

- While an answer streamed, an unterminated fenced block was rendered by the plain-tail path, so a
  literal ` ``` ` row appeared before the code frame arrived (visible in a screenshot). An open
  fence now renders as a code block immediately (`┌ bash`, `│ …`) and the closing bar appears when
  the fence closes; a partial fence marker (`\`\``) is hidden until complete.
- File tool titles no longer spend the line on absolute paths: `Read(/private/tmp/ws/a.txt)` becomes
  `Read(a.txt)` (paths outside the workspace fall back to `~/…` when under home).

### 流式回答不再闪出裸围栏；文件标题改为相对工作区（B170）

- 回答流式输出时，尚未闭合的围栏块会走「普通尾部」渲染，于是先出现一行裸 ``` ````，代码框随后才到
（截图里可见）。现在未闭合围栏立即按代码块渲染（`┌ bash`、`│ …`），围栏闭合时才补上底边；
只输入了一半的围栏标记（`\`\``）在完成前不显示。
- 文件类工具标题不再浪费在绝对路径上：`Read(/private/tmp/ws/a.txt)` 变成 `Read(a.txt)`
  （工作区之外的路径在 home 下时回退为 `~/…`）。

### Tool titles and stall hints read like product, not debug output (B169)

- `Exec(cd /private/tmp/ws && ls -l … && wc -c …)` wasted the one-line title on the working
  directory and let terminal clipping eat the command. Tool titles now strip a leading `cd <path>
&&` / `cd <path>;` prefix (quoted paths included) and keep the command itself: the real run
  shows `Exec(ls -l /tmp/b169-ws)`.
- The quiet-stream hint (`stream quiet for 20s — the gateway may be stuck`) read like an internal
  log. It now says what the user can do: `… no output for 20s — Esc to interrupt, or wait if the
gateway is slow` (zh: `… 已 20 秒没有输出 · Esc 中断，或等待网关恢复`).
- `⏺ Model` confirmation dropped its third line (`context usage will appear after the first
response…`); switching now prints the model and the save/session note only.

### 工具标题与静默提示更像产品、不像调试输出（B169）

- 以前 `Exec(cd /private/tmp/ws && ls -l … && wc -c …)` 把一行标题浪费在工作目录上，命令本身反而被裁掉。
  现在标题会去掉开头的 `cd <路径> &&` / `cd <路径>;`（含引号路径），保留命令本身：真实运行显示
  `Exec(ls -l /tmp/b169-ws)`。
- 静默提示 `stream quiet for 20s — the gateway may be stuck` 像内部日志；现在告诉用户能做什么：
  `… no output for 20s — Esc to interrupt, or wait if the gateway is slow`
  （中文：`… 已 20 秒没有输出 · Esc 中断，或等待网关恢复`）。
- `⏺ Model` 确认去掉了第三行（`context usage will appear after the first response…`），
  切换后只打印模型与保存/仅本会话的说明。

### The end of a TUI run is quiet: one stamp, a collapsed checklist, one error (B168)

A screenshot-driven review of a real 85s TUI run found three pieces of end-of-run noise:

- A generic completed run printed `✻ worked for 85s · done 14:41` and then `Completed: run
finished` — the same fact twice. The TUI now drops that line when it carries nothing
  (`run finished` / `运行结束`); informative conclusions (verification passed, unverified,
  failed, blocked) and the mandatory headless line are unchanged.
- The live todo checklist stayed expanded above the composer forever, with a stale `4/5 done`
  and the unfinished item still listed — even after the user typed a new prompt. A new run now
  starts with no inherited checklist (`beginRun` clears it), a fully finished list disappears
  when the run ends (the `✻ worked for` stamp already says it is done), and an unfinished one
  collapses to `4/5 done · 1 left open when the run ended`.
- A failed exec printed its error twice: the headline `failed — ls: … No such file or
directory` and then the structured result's `Command failed (exit 1):` + the same sentence.
  The duplicate message is dropped; the exit-code label and real output stay.

### TUI 一轮结束时更安静：一行收尾、清单折叠、错误只说一次（B168）

根据一次真实 85 秒 TUI 运行的截图复盘，发现三处「结束噪音」：

- 普通完成的运行会先打印 `✻ worked for 85s · done 14:41`，紧接着再打印 `Completed: run
finished`——同一件事说两遍。现在当这行不携带信息（`run finished` / `运行结束`）时 TUI 不再打印；
  有信息量的结论（验证通过、未验证、失败、被拦）与 headless 的强制末行保持不变。
- 实时 todo 清单在运行结束后仍常驻展开，显示过期的 `4/5 done` 和未完成项——用户输入新内容后它还在。
  现在新运行开始时不再继承上一轮的清单（`beginRun` 清空）；全部完成时运行结束清单直接消失
  （`✻ worked for` 已经说明完成），未完成时折叠成一行 `4/5 done · 运行结束时还有 1 项未完成`。
- 失败的 exec 会把错误说两遍：标题 `failed — ls: … No such file or directory`，以及结构化结果里的
  `Command failed (exit 1):` + 同一句话。现在去掉重复的消息，保留退出码标签与真实输出。

### Runs record the model they used, and `summary --by model` attributes the cost (B167)

- Cost per model was unknowable: run records had no model field, so a workspace using two
  providers could only see a single blended number.
- `RunRecord.model` is now written by chat (`-p`), task, loop and superagent runs (workflow
  steps report through the same config but the parent does not yet record a name); `runs
show`/`export` print a `model:` line, and `moss runs summary --by model` groups the same
  filtered runs by model (runs with no recorded model are an honest `unknown` bucket, ordered
  by run count). Unknown granularity stays a usage error.

### 账本记录所用模型，`summary --by model` 按模型归因成本（B167）

- 之前每条运行记录没有模型字段，用多个 provider 的工作区只能看到一个混合的总数，无法按模型归因。
- 现在 chat（`-p`）、task、loop 与 superagent 运行都会写 `RunRecord.model`
  （workflow 各步骤共用配置，但父行暂不记录名字）；`runs show/export` 打印 `model:` 行，
  `moss runs summary --by model` 把同一批过滤结果按模型分组（没记录模型的运行进入诚实的
  `unknown` 桶，按次数排序）。未知粒度仍是用法错误。

### `moss runs summary --by day|week` shows the trend, not just the total (B166)

- The summary answered "how are my runs doing" per kind but not over time. `--by day` (local
  calendar day) and `--by week` (ISO week, Monday start) now bucket the same filtered runs,
  newest first, each with runs/pass/fail/other and token usage; the total row is unchanged and
  `--json` carries `by` plus a `buckets` array. An unknown granularity is a usage error (exit 2).

### `moss runs summary --by day|week` 看趋势而不只是总量（B166）

- 汇总以前只能按引擎回答"最近运行怎么样"，看不到时间趋势。`--by day`（本地自然日）与
  `--by week`（ISO 周，周一起）现在把同一批过滤后的运行分桶，最新在前，每桶给出
  次数/通过/失败/其他与 token 用量；合计行不变，`--json` 增加 `by` 与 `buckets` 数组。
  未知粒度是用法错误（exit 2）。

### Super-agent tickets report their work's usage (B165)

- A ticket runs its work in a separate worktree through `moss superagent worker`, which uses the
  task engine directly — no task run row exists there, so the ticket's ledger row was always
  `usage: n/a` even after a real 40s run.
- The worker now accumulates the usage of its task turns and reports it over IPC
  (`SuperagentWorkerResult.usage`); the runtime validates it, writes it on the one superagent row,
  and falls back to a task row in the worktree only when an older worker reports none.
- Real evidence: a completed ticket row shows `usage: 82.8k in / 5.2k out · cache read 79.7k`, and
  `moss runs summary --kind superagent` includes it.

### superagent 工单行带上自己工作的用量（B165）

- 工单在独立 worktree 里通过 `moss superagent worker` 直接跑 task 引擎，那里没有 task run 行，
  所以即使真实跑了 40s，工单账本行一直是 `usage: n/a`。
- worker 现在累加自己的任务回合用量并通过 IPC 上报（`SuperagentWorkerResult.usage`）；runtime 校验后
  写到唯一的 superagent 行上，只有在旧 worker 没上报时才回退读 worktree 里的 task 行。
- 真实证据：完成的工单行显示 `usage: 82.8k in / 5.2k out · cache read 79.7k`，
  `moss runs summary --kind superagent` 也把它计入。

### Workflow rows aggregate their steps' usage (B164)

- `moss workflow run` writes one row and deliberately suppresses the per-step chat rows, so its
  `usage` used to be `n/a` even after a real two-step run.
- Each child `-p` step now drops its usage JSON into
  `.moss/workflows/<runId>/usage/<step>.json` (internal `MOSS_USAGE_FILE`), and the workflow
  record sums the steps: a real two-step run reports `usage: 57.4k in / 1.8k out`. A step that
  died before reporting contributes no numbers instead of a guess, and `--kind chat` stays
  empty for the parent run.

### workflow 行汇总各步骤的用量（B164）

- `moss workflow run` 只写一条行、故意抑制每步的 chat 行，所以即使真实跑完两步，它的
  `usage` 一直是 `n/a`。
- 现在每个子 `-p` 步骤把用量 JSON 落到 `.moss/workflows/<runId>/usage/<step>.json`
  （内部 `MOSS_USAGE_FILE`），workflow 记录再按步骤求和：真实两步运行报告
  `usage: 57.4k in / 1.8k out`。中途死掉、没来得及报用量的步骤不贡献数字（不猜），
  父运行的 `--kind chat` 保持为空。

### Loop runs stop double-recording and carry their usage (B163)

- Every `moss loop` attempt runs a headless chat, and each attempt was also writing its own
  `kind: chat` ledger row: one loop of three attempts produced four runs, inflating `moss runs`,
  `--kind chat` and the summary, and leaving the loop row with `usage: n/a`.
- Loop attempts now pass `suppressRunLedger` (the loop row is the one authoritative record) and
  tap `onAgentEvent` into a session-usage accumulator; the loop record stores the summed
  `usage` of all attempts. Workflow children already had env-level suppression; workflow and
  superagent rows still do not aggregate usage (honest gap).

### loop 不再重复记账，并带上自己的用量（B163）

- `moss loop` 的每次 attempt 都是一次 headless chat，而每次 attempt 还会写一条自己的
  `kind: chat` 账本行：一次 3 attempt 的 loop 会产生 4 条运行，虚增 `moss runs`、`--kind chat`
  与 summary，同时 loop 行一直是 `usage: n/a`。
- 现在 loop 的 attempt 传 `suppressRunLedger`（loop 行是唯一权威记录），并把 `onAgentEvent`
  汇入 session usage 累加器；loop 记录保存所有 attempt 汇总后的 `usage`。workflow 子步骤本来就有
  env 级抑制；workflow 与 superagent 行仍未聚合 usage（诚实缺口）。

### `moss runs summary` answers "how are my runs doing, and what did they cost" (B162)

- The ledger could list and export single runs, but not aggregate. `moss runs summary
[--since] [--kind] [--json]` now reports per-kind runs/pass/fail/other plus token usage and
  priced cost, with a total row: `chat 1 runs · 1 pass · 0 fail · … usage: 1.4k in / 2 out ·
cost: unpriced`. Cost is summed only from records that carry `costUsd`, and the total says
  how many of the usage-bearing runs were priced; a gateway without public pricing stays
  "unpriced" instead of inventing a number. `--since`/`--kind` reuse the list filters, and
  `/runs summary` works in-session through the same command.

### `moss runs summary` 回答「最近的运行怎么样、花了多少」（B162）

- 账本之前只能列出/导出单条运行，不能汇总。`moss runs summary [--since] [--kind] [--json]`
  现在按引擎给出 次数/通过/失败/其他 + token 用量与可算费用，并有一行合计：
  `chat 1 runs · 1 pass · 0 fail · … usage: 1.4k in / 2 out · cost: unpriced`。
  费用只汇总带 `costUsd` 的记录，合计行会说明有价记录占带用量记录的比例；
  网关没有公开价就显示 unpriced，不编造数字。`--since`/`--kind` 复用 list 的过滤，
  会话内 `/runs summary` 也直接可用。

### `moss init` and `/init` are one onboarding with two documented modes (B158)

- The same verb had two behaviours: the CLI command is a deterministic scan (no model,
  never overwrites AGENTS.md) while the interactive `/init` was a generic model prompt
  ("Analyze this repository..."). They could claim different commands and users had no way
  to know which they got.
- `buildInitPrompt` now receives the deterministic `detectProject` result: the model gets
  the verified entry points (`- test: npm test`, ...) with "keep them verbatim unless
  running them proves otherwise", or an explicit "no entry point detected - say so"
  instead of guessing. The review variant also says never to delete a user instruction.
- Both surfaces name each other: `/init` says it is the model-drafted variant of
  `moss init`; `moss init` prints a `/init` line for the richer variant. README,
  cli-reference and AGENTS document the split.

### `moss init` 与 `/init` 是同一套 onboarding 的两种已说明模式（B158）

- 同一个动词曾有两种行为：CLI 命令是确定性扫描（不需要模型、绝不覆盖 AGENTS.md），交互式 `/init`
  却是一个通用模型提示（"分析这个仓库..."）。两者可能声称不同的命令，用户也无法知道自己拿到哪一种。
- `buildInitPrompt` 现在注入确定性 `detectProject` 的结果：模型拿到已验证入口
  （`- test: npm test` ...）与"除非运行证明不同，否则逐字保留"的指令，或者明确的
  "未检测到入口——如实说明"而不是猜测。review 变体还明确"不得删除用户指令"。
- 两个界面互相点名：`/init` 说明自己是 `moss init` 的模型草稿版；`moss init` 打印一行指向
  更丰富的 `/init`。README、cli-reference、AGENTS 都已记录这个分工。

### The first screen has one next step, and the REPL can resume too (B157)

- After a **completed** run the interactive `Next:` pointed at `/runs` (read the ledger) — the
  lowest-value action on the happy path. It now points at `/diff` ("review what changed / ship
  it"); a pending run still leads with its resume command and a fresh folder with `/init`. The
  CLI keeps `moss runs` because there is no `/diff` shell command.
- The TUI's "previous session … `moss --continue`" hint now comes from one shared formatter
  (`formatPreviousSessionHint`) and the REPL prints the same one dim line on a fresh session, so
  the two surfaces agree and the restart path is discoverable in both. The hint is computed once
  at boot, localised, and skipped when the session was resumed (it already has messages).

### 首屏只有一个「下一步」，而且 REPL 也能续旧会话（B157）

- **完成**一次运行后，交互面 `Next:` 以前指向 `/runs`（去读账本）——happy path 上价值最低的动作。
  现在指向 `/diff`（看改了什么 / 收尾）；有未收尾运行时仍是续跑命令，全新目录仍是 `/init`。
  CLI 保留 `moss runs`（shell 里没有 `/diff`）。
- TUI 的「previous session … `moss --continue`」提示改为共享格式化函数
  （`formatPreviousSessionHint`），REPL 在全新会话上打印同一行 dim 提示：两个界面一致，
  续旧会话的路径在两处都能被发现。提示只在启动时算一次、本地化，并且在 resuming（已有消息）时跳过。

### The REPL tells the truth about modes, stopping and help (B156)

- `/help` said only `Ctrl+C exit`, while Ctrl+C pauses a goal run (resumable with
  `/goal resume`) and Esc interrupts a turn. The shortcuts block now names idle exit,
  run pause + resume, Esc interrupt and prompt history, in both locales.
- A goal run now prints `Ctrl+C pauses (/goal resume to continue) · Esc interrupts` before
  work starts, and a lone Esc byte aborts the run like chat turns do (arrow-key escape
  sequences are ignored). Verified in a real PTY: the hint appears, Esc produces
  `[goal] paused by user … /goal resume`.
- The REPL prompt is mode-aware (`plan›`, `manual›`, `accept-edits›`) and recomputed on
  every prompt, so a mode change can no longer scroll out of sight; `›` alone means full.

### REPL 如实说明模式、停止方式与帮助（B156）

- `/help` 以前只写 `Ctrl+C exit`，但运行中 Ctrl+C 是暂停（可用 `/goal resume` 续跑）、Esc 可中断。
  快捷键块现在按中英双语列出：空闲退出、运行中暂停+续跑、Esc 中断、历史输入。
- goal 运行开始前打印 `Ctrl+C 暂停（/goal resume 续跑）· Esc 中断`；单独的 Esc 字节会像聊天回合一样
  中断运行（方向键的转义序列被忽略）。真实 PTY 验证：提示出现、按 Esc 后打印
  `[goal] paused by user … /goal resume`。
- REPL 提示符带模式（`plan›`、`manual›`、`accept-edits›`），每次 prompt 重新计算，模式变化不会再
  滚出视野；只有 `›` 表示 full。

### The CI Fast gate is green again (B161)

- Every push had failed the Fast gate, and the cause was CI-only:
  - `output-style` failed because GitHub runners export `XDG_CONFIG_HOME`; the probe
    inspected `$HOME/.config/moss` while the CLI wrote the config under the runner's
    XDG directory. Reproduced locally with `XDG_CONFIG_HOME=/tmp/fake-xdg` and fixed by
    pinning `MOSS_CONFIG_DIR` to the probe's own config dir.
  - `goal-runs` could fail `newest first` when two fixtures were written in the same
    millisecond; the table now tie-breaks by `startedAt` and then by the later ledger row.
  - `repl-interrupt` could flag a slow runner: it now waits for the stub to observe the
    client disconnect (up to 4s) as the authoritative interrupt signal.
- With the probes fixed, the gate tripped its 60s budget (1m1.5s) because `static` and
  `build` ran cold on the runner (39s + 20s) — the immutable `node_modules` cache kept
  restoring the first, empty static/build cache. The workflow now warms both caches in an
  explicit untimed step, so the budget measures the same warm gate developers run; the
  budget itself is unchanged. Latest run: **PASS 42.0s** on `ubuntu-latest`.

### CI 的 Fast gate 恢复绿色（B161）

- 之前每次 push 都失败，且是 CI-only：
  - `output-style`：GitHub runner 会导出 `XDG_CONFIG_HOME`，探针检查 `$HOME/.config/moss`，
    而 CLI 写到了 runner 的 XDG 目录。用 `XDG_CONFIG_HOME=/tmp/fake-xdg` 本地复现后，
    通过把 `MOSS_CONFIG_DIR` 固定到探针自己的配置目录修复。
  - `goal-runs`：两条 fixture 在同一毫秒写入时 `newest first` 不稳定；表格排序改为
    `startedAt` + 后写入优先的确定性 tie-break。
  - `repl-interrupt`：慢 runner 上误报；现在以 stub 观察到客户端断开（最多等 4s）为准。
- 探针修好后门禁撞 60s 预算（1m1.5s）：runner 上 `static`/`build` 是冷的（39s + 20s），
  不可变的 `node_modules` 缓存一直在恢复最初那个空缓存。workflow 现在用显式的**不计时**
  预热步骤把两个缓存烤热，预算衡量的是开发者本地同样的 warm gate；预算本身不变。
  最新一次：**ubuntu-latest 上 PASS 42.0s**。

### Run records say which gate stopped the answer (B155)

- `RunRecord.reason` was a free-text summary, so `moss runs show` could not tell a verification
  hold from an acceptance hold or a plan-mode hold. The completion-gate contract now carries
  `gate` (`acceptance` / `verification` / `review` / `plan` / `background` / `host`) and `kind`
  (`unverified-change`, `review-fail`, `missing-review`, `no-verdict`, `unrepaired-fail`,
  `missing-plan`, `background-running`); `MossAgent` records every hold per run (also exposed via
  `gateBlocksFor(sessionKey)` and the `onCompletionGateBlocked` hook), and the headless `-p` chat
  and task ledgers write `gates[] {gate, kind?, reason, turn?}`.
- `moss runs show` prints `gate: verification/unverified-change — <reason>`; `export` writes the
  same as a Markdown bullet; `--json` carries the array. Loop/workflow/superagent rows still only
  carry their own ledgers' reasons (honest gap).

### 运行账本记录「哪道闸门拦下了答案」（B155）

- `RunRecord.reason` 只是自由文本，`moss runs show` 分不清是验收门、验证门还是 plan 门拦的。
  完成门契约现在带 `gate`（`acceptance` / `verification` / `review` / `plan` / `background` /
  `host`）与 `kind`（`unverified-change`、`review-fail`、`missing-review`、`no-verdict`、
  `unrepaired-fail`、`missing-plan`、`background-running`）；`MossAgent` 按 run 记录每次拦截
  （也暴露 `gateBlocksFor(sessionKey)` 与 `onCompletionGateBlocked` 钩子），headless `-p` chat
  与 task 账本写入 `gates[] {gate, kind?, reason, turn?}`。
- `moss runs show` 打印 `gate: verification/unverified-change — <原因>`；`export` 在 Markdown 里
  写同一行；`--json` 带数组。loop/workflow/superagent 仍只带各自账本的原因（诚实缺口）。

### The verified-run verb is `goal` again; `run` is the alias (B160)

- "Every invocation is a run": `moss "…"` already runs the agent, so `moss run` did not say what
  made it different. The difference is **completion authority** — chat ends when the model stops;
  a goal ends when _your_ acceptance command passes (or the contract verdict is reached). Both
  Cursor and Claude Code name that concept _goal_, and Claude Code's automation docs list `goal`
  explicitly; `run` was our own invention from the N1 experiment.
- `moss goal "<intent>" [--accept] [--resume] [--until] [--workflow]` is now the canonical verb;
  `moss run` resolves to it as a compatibility alias. In-session `/goal <condition>` is canonical
  again (`/goal resume`, `/goal clear`), `/run` stays as an alias, and the catalog row now shows
  the real syntax (`resume`/`--accept`) instead of `<condition> | clear`.
- The first-screen `Next:` hints name `/goal resume` and `moss goal …`, so the interactive surface
  and the CLI tell the same story; the ledger noun stays `moss runs` (one row per recorded
  autonomous execution: task / loop / workflow / -p chat / superagent — interactive chat is not
  recorded).

### 验证式运行改回 `goal`；`run` 作为别名（B160）

- "每次调用都是 run"：`moss "…"` 本身就在跑 agent，所以 `moss run` 没说出区别。真正的区别是
  **完成由谁裁决**——chat 在模型停下时结束；goal 在你指定的验收命令通过（或契约裁决达成）时结束。
  Cursor 与 Claude Code 都把这个概念叫 goal（Claude Code 的 Automation 文档里就有 `goal`），
  `run` 只是我们在 N1 实验里自造的名字。
- `moss goal "<意图>" [--accept] [--resume] [--until] [--workflow]` 成为规范动词；`moss run`
  解析为它的兼容别名。会话内 `/goal <条件>` 恢复规范名（`/goal resume`、`/goal clear`），`/run`
  保留为别名；命令目录里的参数提示改成真实语法（含 `resume`、`--accept`），不再是 `<condition> | clear`。
- 首屏 `Next:` 提示改为 `/goal resume`、`moss goal …`，交互面与 CLI 说同一套话；账本名词仍是
  `moss runs`（每一次被记录的自主执行一条：task / loop / workflow / -p chat / superagent；
  交互式 chat 不记账）。

### Run records carry token usage (B159)

- `moss runs show`/`export --json` answered "what did this run cost?" with nothing: the ledger had
  status, reason and next, but no usage. `RunRecord.usage {inputTokens, outputTokens,
cacheReadTokens?, cacheCreationTokens?, costUsd?}` is now written by task runs (from the
  `llm_usage` tap) and headless `-p` chat runs (from the headless print state's usage slices).
- `moss runs show` prints `usage: 1.4k in / 2 out · cache read 1.3k`; `export` puts the same line
  in the Markdown; `--json` carries the object. `costUsd` is filled only when every model call has
  a known price — a gateway without public pricing stays unpriced instead of inventing a number.
- Loop/workflow/superagent records do not carry usage yet (their ledgers are the source); this is
  an honest gap, not a display omission.

### 运行账本记录 token 用量（B159）

- `moss runs show`/`export --json` 此前回答不了"这次运行花了多少"：账本只有状态、原因、下一步，没有用量。
  现在 task 运行（来自 `llm_usage` tap）与 headless `-p` chat（来自 print state 的 usage slices）都会写
  `RunRecord.usage {inputTokens, outputTokens, cacheReadTokens?, cacheCreationTokens?, costUsd?}`。
- `moss runs show` 打印 `usage: 1.4k in / 2 out · cache read 1.3k`；`export` 在 Markdown 里给同一行；
  `--json` 带对象。`costUsd` 只在每个模型调用都有已知价格时填写——没有公开定价的网关保持无价，不编造数字。
- loop/workflow/superagent 记录暂不带 usage（各自账本是来源）；这是诚实的缺口，不是显示遗漏。

### Interactive surfaces name the command they can run (B154)

- The first-screen `Next:` line and the post-run hint named shell verbs even inside the REPL and
  TUI: a fresh workspace said `moss init`, a completed run said `moss runs`, a paused task said
  `moss task resume <id>`. Those commands are not what the user can type there.
- `renderWelcomeContextLines` / `renderCliWelcome` / `renderNextHint` now take a surface:
  interactive surfaces get `/init`, `/runs`, `/run resume <id>` and
  `/run "<intent>" --accept "<cmd>"`; the CLI keeps the shell forms. TUI boot/setup/refresh and
  the REPL pass `interactive`, so the welcome line and the composer hint agree.

### 交互面只提示它真正能敲的命令（B154）

- 首屏 `Next:` 与运行后提示在 REPL/TUI 里也写着 shell 动词：全新工作区写 `moss init`、完成的运行写
  `moss runs`、暂停的任务写 `moss task resume <id>`——这些都不是用户在会话里能直接输入的。
- `renderWelcomeContextLines` / `renderCliWelcome` / `renderNextHint` 增加 surface 参数：交互面得到
  `/init`、`/runs`、`/run resume <id>`、`/run "<意图>" --accept "<命令>"`；CLI 保持 shell 形式。
  TUI 的 boot/setup/刷新与 REPL 都传 `interactive`，首屏与输入框提示一致。

### `/capabilities` in-session and `--kind` narrowing (B153)

- The capability panel was CLI-only: answering "what is installed here?" mid-session meant
  leaving it. `/capabilities` now runs the same read-only panel in the REPL and TUI (registry
  CommandSpec, so both surfaces share one code path, and the catalog makes it appear in help,
  the palette and completion).
- `--kind <runtime|tools|skills|commands|agents|hooks|mcp|devices>` narrows the text view to one
  section, and `--json` still carries every section (`--kind` + `--json` is an explicit exit-2
  error rather than a silently ignored flag).

### 会话内 `/capabilities` 与 `--kind` 收窄（B153）

- 能力面板以前只在 CLI 里：会话中想知道"这台机器装了什么"必须退出。现在 `/capabilities`
  在 REPL 与 TUI 内复用同一只读面板（registry CommandSpec，两条交互面共用一条代码路径，
  命令目录让它出现在帮助、面板与补全里）。
- `--kind <runtime|tools|skills|commands|agents|hooks|mcp|devices>` 只显示一节文本视图；
  `--json` 仍包含全部 section（`--kind` 与 `--json` 同用是明确的 exit 2 错误，而不是被静默忽略）。

### `moss runs list --since` narrows by recency (B152)

- "What failed today" meant reading the whole ledger. `--since` accepts a window
  (`90s` / `30m` / `24h` / `7d`) or a date (`2026-11-06`, ISO), filters on `endedAt`, combines with
  `--status` and `--kind`, appears in the header suffix (`— since 24h (2)`) and in `--json` as
  `since` (ISO cutoff). An empty filter says `no runs match …` instead of pretending the ledger is
  empty, and a bad value is exit 2 with the accepted forms.

### `moss runs list --since` 按时间窗过滤（B152）

- "今天有什么失败"以前只能翻整本账。`--since` 接受时间窗（`90s` / `30m` / `24h` / `7d`）或日期
  （`2026-11-06`、ISO），按 `endedAt` 过滤，可与 `--status`、`--kind` 组合；表头后缀显示
  `— since 24h (2)`，`--json` 里带 `since`（ISO 截止点）。过滤为空时打印 `no runs match …`，
  不再假装账本是空的；非法值 exit 2 并列出可用形式。

### The REPL repeats the ledger-derived next step after a run (B151)

- The TUI composer refreshes its hint when a run settles (B145), but the REPL only showed
  `Next:` at boot, so a finished run left the startup suggestion standing. The REPL now
  prints the same ledger-derived line after a normal (non-aborted) autonomous run:
  a pending run's resume command, `moss runs` after a completed one, or `moss init` on a
  fresh workspace. Aborted runs keep their dedicated resume/pause lines.

### REPL 在运行结束后重新打印账本派生的下一步（B151）

- TUI 的输入框提示会在运行收尾时刷新（B145），但 REPL 只在启动时显示一次 `Next:`，跑完一次
  自主运行后仍留着启动时的建议。现在 REPL 在正常（未中断）运行结束后打印同一条账本派生提示：
  有未收尾运行 → 续跑命令；最新已完成 → `moss runs`；全新工作区 → `moss init`。中断的运行仍走
  专门的暂停/续跑提示。

### Super-agent tickets join the unified ledger — and can finally write (B149, B150)

- `kind: superagent` is no longer an empty filter: every ticket that ends leaves
  `.moss/runs/<ticketId>/run.json` with the ticket title as the goal, the native task id,
  the fixed acceptance command, the worktree path, the superagent sqlite artifact and a
  `moss superagent retry <id>` next step when blocked. `moss runs` / `--kind superagent` /
  `exports` now cover all five engines.
- Real run found a blocker first: workers were spawned with `--workspace-write`, which maps
  to the `manual` interaction mode; a non-interactive worker cannot approve anything, so
  every `write_file` was denied and a ticket burned 18 attempts into `blocked` without
  creating a file. Run jobs now inherit the operator's resolved mode through the worker
  policy file (assess stays read-only); the worktree still isolates the work.
- After the fix the same flow completes: real repo + `moss superagent init/submit/work` →
  ticket `completed`, `ok.txt` written in its worktree, oracle passed, ledger row
  `pass · superagent · 20.3s`.

### Super-agent 工单进入统一账本，并且终于能写文件（B149、B150）

- `kind: superagent` 不再是空集：每个结束的工单都会写 `.moss/runs/<ticketId>/run.json`——
  目标取工单标题、带原生 task id、固定验收命令、worktree 路径、superagent sqlite 工件，
  blocked 时给出 `moss superagent retry <id>` 下一步。`moss runs` / `--kind superagent` /
  `export` 现在覆盖全部五个引擎。
- 真实运行先发现了阻断：worker 被以 `--workspace-write` 启动，而该 flag 会映射到 `manual`
  交互模式；非交互 worker 无法审批，于是所有 `write_file` 被拒，工单烧掉 18 次尝试进入
  `blocked` 却没写出任何文件。现在 run job 通过 worker policy 继承操作者的解析模式
  （assess 仍为只读），worktree 隔离不变。
- 修复后同一流程完成：真实 repo + `moss superagent init/submit/work` → 工单 `completed`、
  `ok.txt` 写进它的 worktree、外部 oracle 通过、账本行 `pass · superagent · 20.3s`。

### `/runs` in the REPL and TUI (B148)

- The unified ledger was only reachable by leaving the session for `moss runs`. `/runs`
  (list / show / export / prune, `--json`, `--kind`) now runs the same implementation inside
  the REPL and the TUI, so "what ran, how did it end, what is next" is one keystroke away
  mid-session. The command catalog, help, palette and REPL dispatch all know it, and the
  filter header shows the matched total even when `--limit` pages the rows.

### REPL/TUI 里也能直接 `/runs`（B148）

- 统一账本此前只能退出会话用 `moss runs` 看。现在 `/runs`（list / show / export / prune，支持
  `--json`、`--kind`）在 REPL 与 TUI 内复用同一实现——"跑了什么、怎么结束、下一步"在会话里一键可见。
  命令目录、帮助、面板与 REPL 分发都认识它；带 `--limit` 分页时表头仍显示过滤后的总数。

### `moss runs list --kind` narrows the ledger by engine (B147)

- The unified ledger has five kinds (`task`, `loop`, `workflow`, `chat`, `superagent`) but only
  `--status` filtered it. `moss runs list --kind <engine>` now narrows the same way: the header
  keeps the whole-ledger counts and appends `— kind <engine> (N)`, `--json` carries the `kind`
  field, `--status` and `--kind` combine, and an unknown kind is exit 2 with the valid list.

### `moss runs list --kind` 按引擎过滤（B147）

- 统一账本有五种 kind（`task`、`loop`、`workflow`、`chat`、`superagent`），但此前只有 `--status`
  能过滤。`moss runs list --kind <引擎>` 现按同样方式收窄：表头保留全账本计数并追加
  `— kind <引擎> (N)`，`--json` 带 `kind` 字段，`--status` 与 `--kind` 可组合，未知 kind 是
  exit 2 并列出合法值。

### `/run --accept` keeps quotes out of the command and survives later flags (B146)

- A real interactive run surfaced a broken oracle: `/run "create ok.txt" --accept "test -f
ok.txt"` stored the literal `"test -f ok.txt"` (quotes included). `bash -c` then looked for a
  command named `test -f ok.txt`, exited 127, and the task was judged
  `blocked/acceptance_command_unavailable` even though the file was written and verified.
  The same line with a flag after `--accept` also swallowed the flag into the command
  (`"test -f ok.txt" --max-turns 2` → 127); `--max-turns` never applied.
- `parseGoalCommandLine` now shares the quote-aware tokenizer used by `/run resume`: goals and
  acceptance commands are unquoted, flags may appear in any order (`--max-turns` / `--max-repairs`
  after `--accept` included), `--accept=<quoted cmd>` works, unquoted multi-word `--accept` keeps
  its backward-compatible meaning, and unknown flags, duplicate `--accept`, missing values or an
  empty goal are explicit usage errors instead of silently becoming part of the command.
- Real REPL regression with deepseek-flash: `/run "create ok.txt containing ok" --accept
"test -f ok.txt"` → `Task … PASS`, `phase: accepted`, timeline `Acceptance passed —
acceptance command exited 0` (previously the same run was blocked at exit 127).

### `/run --accept` 不再把引号当命令、也不再吞掉后面的 flag（B146）

- 真实交互运行发现验收命令被破坏：`/run "create ok.txt" --accept "test -f ok.txt"` 把带引号的
  `"test -f ok.txt"` 原样存下，`bash -c` 去找一个名为 `test -f ok.txt` 的命令，退出 127，任务被判
  `blocked/acceptance_command_unavailable`——尽管文件已写入且证据 PASS。`--accept` 后面再跟 flag 时
  也会被吞进命令（`"test -f ok.txt" --max-turns 2` → 127），`--max-turns` 从未生效。
- `parseGoalCommandLine` 改为复用 `/run resume` 的引号感知分词：目标与验收命令都去掉引号；flag 顺序
  自由（`--accept` 之后的 `--max-turns` / `--max-repairs` 也生效）；支持 `--accept=<带引号命令>`；
  不带引号的多词 `--accept` 保持向后兼容；未知 flag、重复 `--accept`、缺值或空目标都是明确的用法错误，
  而不是被悄悄并进命令。
- 真实 REPL 回归（deepseek-flash）：`/run "create ok.txt containing ok" --accept "test -f ok.txt"`
  → `Task … PASS`、`phase: accepted`、timeline `Acceptance passed — acceptance command exited 0`
  （修复前同一条运行在 exit 127 处 blocked）。

### The composer hint refreshes after every run (B145)

- B144 computed the empty-composer hint only at boot, so a finished run left a stale
  `Resume with …` (or a stale `/init`) in the input box. A chat turn, a task run, a resume and
  an interrupt now recompute it from the ledger when they settle, so the hint names the run
  that actually needs attention next.

### 每次运行结束后刷新输入框提示（B145）

- B144 只在启动/配置完成时计算空输入框提示，运行结束后仍显示旧内容（旧的 `继续：…` 或 `/init`）。
  现在聊天回合、任务运行、resume 与中断在收尾时都会重新读账本并刷新提示，指向上一次真正需要处理的运行。

### The empty composer suggests the next step (B144)

- The TUI composer placeholder used to be the same prompt in every workspace. It now reads
  the unified ledger and AGENTS.md: when the newest run is not completed it offers
  `Resume with <that run's next command>` (e.g. `moss task resume <id>`), and a fresh workspace
  with no runs and no AGENTS.md offers `Try "/init" (detect this project, write AGENTS.md)`.
  Completed runs, or a workspace that already has AGENTS.md, fall back to the board/code/general
  prompt as before.

### 空输入框会建议下一步（B144）

- TUI 输入框的占位提示过去在每个工作区都是同一句话。现在它读统一账本与 AGENTS.md：最新一次运行未完成时
  提示 `继续：moss task resume <id>`（即该运行记录的 next 命令）；全新目录且没有 AGENTS.md 时提示
  `试试 “/init”（检测项目、写 AGENTS.md）`；最新运行已完成或已有 AGENTS.md 时仍回退到 board/code/general
  的旧提示。

### `moss runs export` for PRs and CI (B143)

- `moss runs export [<run_id>|latest] [--format md|json] [--out <file>]` renders one unified-run
  record: id/status/kind/goal/timing/exit code/counts/acceptance/reason/`next`/artifact paths.
  Markdown is the default (English, pasteable into a PR or CI summary), `--format json` emits the
  record itself, and `--out` writes a file (parents created). Unknown ids and formats exit 2.

### `moss runs export` 给 PR/CI（B143）

- `moss runs export [<run_id>|latest] [--format md|json] [--out <文件>]` 导出单条统一运行记录：
  id/状态/kind/目标/时间/退出码/计数/验收命令/原因/`next`/工件路径。默认 Markdown（英文，可直接贴进 PR
  或 CI summary），`--format json` 输出记录本身，`--out` 写文件（自动建父目录）；未知 id/格式 exit 2。

### The interactive run command is `/run` (`/goal` stays as an alias) (B142)

- With the CLI now exposing `moss run` (start / `--until` / `--workflow` / `--resume`), the
  interactive surface had a different name for the same idea. `/run <condition>` is now the
  canonical command (`/run resume`, `/run clear`), and `/goal …` keeps working as an exact alias,
  so existing muscle memory and scripts are unaffected. Help, the TUI palette/keys, the pause and
  interrupt notices, resume hints, `moss task list` hints and the structured run note all name
  `/run`; alias help still lists `/goal alias of /run`.
- TUI: the help key row and slash dispatch use `/run`; the composer command palette resolves the
  alias.

### 交互式运行命令改为 `/run`（`/goal` 保留为等价别名）（B142）

- CLI 已经有 `moss run`（开始 / `--until` / `--workflow` / `--resume`），交互面却还叫 `/goal`。
  现在 `/run <条件>` 是规范命令（`/run resume`、`/run clear`），`/goal …` 继续作为完全等价的别名，
  老的肌肉记忆与脚本不受影响。帮助、TUI 命令面板/按键、暂停与中断提示、续跑提示、
  `moss task list` 提示与结构化运行备注都改成 `/run`；别名帮助仍列出 `/goal alias of /run`。
- TUI：帮助按键行与 slash 分发使用 `/run`；输入框命令面板能解析该别名。

### Verification gate back under budget (B141)

- `npm run verify` dropped from 51.0s to 43.0s without removing a single stage:
  the tiny-window TUI probe now breaks as soon as the notice is painted (ANSI
  cursor moves split the phrase, so it used to wait out its full 12s deadline:
  13s → 1.3s), the three independent `repl-interrupt` PTY boots run concurrently
  (9.6s → 3.9s), and the exclusive `startup-timing` stage is deferred until no
  ordinary stage is pending so the pool never idles behind it.
- The summary now prints a `slowest stages:` line, so the next regression is
  visible in the gate output instead of discovered as a budget failure.

### 验证门回到预算内（B141）

- `npm run verify` 从 51.0s 降到 43.0s，没有删掉任何一个 stage：tiny-window TUI 探针在
  提示真正绘制后立即退出（ANSI 光标移动会拆开短语，旧逻辑因此总是等满 12s：13s → 1.3s）；
  `repl-interrupt` 的三次独立 PTY 启动改为并发（9.6s → 3.9s）；排他的 `startup-timing`
  被推迟到没有普通 stage 待跑时，池子不再为它空转。
- summary 之后新增 `slowest stages:` 行，下一次回归会直接出现在门禁输出里，而不是以
  预算失败的形式被发现。

### One run verb, three modifiers (B140)

- `moss run` now hosts the loop and workflow engines too: `moss run "<intent>" --until "<cmd>"`
  repeats run→check→fix until the command passes (loop engine), and `moss run --workflow
<plan.json>` runs a declarative dependent-step plan (workflow engine). Together with
  `--accept` and `--resume` (B139) the six engines collapse into one verb plus a modifier.
  Conflicting modifiers and missing values are explicit exit-2 usage errors; `--workflow` is
  used instead of `--plan` because `--plan` is the global plan-mode override.

### 一个 run 动词 + 三个修饰符（B140）

- `moss run` 现在也承载 loop 与 workflow 引擎：`moss run "<意图>" --until "<命令>"` 反复执行
  run→check→fix 直到命令通过（loop 引擎）；`moss run --workflow <plan.json>` 跑声明式依赖步骤
  （workflow 引擎）。加上 `--accept` 与 `--resume`（B139），六个引擎收敛成一个动词 + 修饰符。
  互斥修饰符与缺失值都是明确的 exit 2 用法错误；修饰符用 `--workflow` 而不是 `--plan`，
  因为 `--plan` 是全局 plan 模式开关。

### `moss run --resume [<id>]` (B139)

- The hero command now has a resume form: `moss run --resume` continues the newest resumable task in
  the workspace, `moss run --resume <task_id>` continues that one, and `--accept` / `--max-repairs` /
  `--max-turns` pass through exactly like `moss task resume`. An empty workspace exits 2 with a
  start-a-run hint instead of a stack trace.
- Completed run records no longer carry the snapshot's historical failure reason: a PASS row says
  nothing about an old failure.

### `moss run --resume [<id>]`（B139）

- 英雄命令有了续跑形式：`moss run --resume` 续跑本工作区最新可恢复任务，`moss run --resume <task_id>`
  续跑指定任务，`--accept` / `--max-repairs` / `--max-turns` 与 `moss task resume` 完全一致；
  没有可恢复任务时 exit 2 并提示先启动一次运行。
- 完成的运行记录不再携带快照里的历史失败原因：PASS 行不再显示旧的 failure。

### Workflow runs join the unified ledger (B138)

- `moss workflow run` now writes the same `.moss/runs/<runId>/run.json` row: all steps passed ->
  `completed`, any step failed -> `verify_failed` with per-status counts, blocked steps -> `blocked`,
  and leftover pending/running -> `incomplete`; the step state file is the artifact and a failed
  workflow points at `moss workflow resume <runId>`.
- Workflow child `-p` steps no longer add their own chat rows (internal `MOSS_NO_RUN_LEDGER`), so one
  workflow appears as one ledger row instead of one row per step.

### workflow 运行进入统一账本（B138）

- `moss workflow run` 现在写同一条 `.moss/runs/<runId>/run.json`：全部步骤通过 → `completed`，
  任一步失败 → `verify_failed`（reason 带各状态计数），有 blocked → `blocked`，仍有 pending/running
  → `incomplete`；步骤状态文件作为工件，失败工作流给出 `moss workflow resume <runId>`。
- workflow 的子 `-p` 步骤不再各写一条 chat 记录（内部 `MOSS_NO_RUN_LEDGER`），一次 workflow
  只出现一行账本，而不是每步一行。

### TUI first screen matches the REPL (B137)

- The TUI banner now carries the same context as the REPL welcome: a `last run: <status> · <age> ·
<kind> <id> — <goal>` row and a `Next:` line that can be the ledger's resume command (or
  `moss runs` / `moss init` / the verified-run command). Both surfaces read one helper, so the story
  cannot drift; the post-setup TUI path uses it too.
- A PTY probe boots the real TUI against a seeded failed run and asserts the first frame contains
  `last run: verify_failed`, the goal, and `Next: moss task resume …`.

### TUI 首屏与 REPL 对齐（B137）

- TUI banner 现在带上与 REPL 欢迎屏相同的上下文：`last run: <状态> · <多久前> · <kind> <id> — <目标>`
  一行，以及 `Next:` 行（可以是账本里的续跑命令，或 `moss runs` / `moss init` / 验证式运行命令）。
  两个界面读同一个 helper，不会漂移；setup 完成后的 TUI 路径也用它。
- 新增 PTY 探针：用预置的失败运行启动真实 TUI，断言首帧包含 `last run: verify_failed`、目标与
  `Next: moss task resume …`。

### First screen answers last-run / next-step (B136)

- The REPL welcome now reads the unified run ledger and AGENTS.md: it prints the newest run
  (`last run: unverified · 9m ago · chat … — <goal>`) and a `Next` line that is a command, not a
  greeting — a failed/paused run surfaces its recorded resume command, otherwise `moss runs`, and a
  brand-new project points at `moss init` (or the verified-run command once AGENTS.md exists).

### 首屏回答"上次跑得怎样 / 下一步做什么"（B136）

- REPL 欢迎屏现在读统一运行账本与 AGENTS.md：打印最近一次运行（`last run: unverified · 9m ago ·
chat … — <目标>`），`Next` 行给出的是命令而不是寒暄——失败/暂停运行直接给账本里记录的续跑命令，
  否则给 `moss runs`；全新项目指向 `moss init`（已有 AGENTS.md 时给验证式运行命令）。

### `moss init`: onboarding to the first verified result (B135)

- Detects the entry points a project actually has (`package.json` scripts, `Makefile` test target,
  `go.mod`, `pyproject.toml`/`requirements.txt`), reuses the `/goal` acceptance proposal so the
  suggested check comes from real files, writes a minimal `AGENTS.md` (Commands / Verification /
  Notes) only when the user has none, and prints the exact `moss run "<intent>" --accept "<cmd>"`
  plus `moss capabilities` as next steps. `--dry-run` prints the file; no model configuration needed.
- The missing-config guidance now mentions `moss init` right after `moss setup`, so first-run has a
  concrete second step instead of a dead end.

### `moss init`：onboarding 到第一个被验证的结果（B135）

- 检测项目真实存在的入口（`package.json` scripts、`Makefile` test 目标、`go.mod`、
  `pyproject.toml`/`requirements.txt`），复用 `/goal` 的验收命令提议（只从真实文件来），
  在用户还没有 `AGENTS.md` 时写一份最小版本（Commands / Verification / Notes），并打印
  `moss run "<意图>" --accept "<命令>"` 与 `moss capabilities` 两条下一步。`--dry-run` 只打印；
  不需要模型配置。
- 缺模型配置的引导在 `moss setup` 之后新增 `moss init` 一行，首次运行不再停在死路上。

### Headless `-p` runs join the unified ledger (B134)

- A headless `moss -p "…"` run now records the same `.moss/runs/<runId>/run.json` row, using the
  completion gate's own outcome (`completed` / `incomplete` / `verify_failed` / `blocked` /
  `unverified`) so the printed last line and `moss runs` can never disagree. Non-completed rows carry
  the gate reason and an actionable `next` step; the session transcript is the artifact. Interactive
  REPL turns deliberately write nothing — a conversation is not an auditable run.

### headless `-p` 运行进入统一账本（B134）

- `moss -p "…"` 现在写同一条 `.moss/runs/<runId>/run.json`，状态直接来自完成门裁决
  （`completed` / `incomplete` / `verify_failed` / `blocked` / `unverified`），所以终端最后一行与
  `moss runs` 不会互相矛盾。非通过行带裁决原因与可执行的 `next` 步骤，会话转录作为工件。
  交互式 REPL 回合刻意不写记录——对话不是可审计运行。

### `moss capabilities`: one screen for the capability surface (B133)

- Tools, built-in slash commands, skills (workspace/user), custom commands, project sub-agents
  (only in a trusted folder), hooks by event, MCP servers and registered devices in one read-only
  view. `--json` exposes the same snapshot; the command is a workspace command, so it works with no
  model configuration. Answers "what can this install do" without visiting `/skills`, `/agents`,
  `moss device`, `moss mcp` and `moss skill` separately.

### `moss capabilities`：一屏看清能力面（B133）

- 工具、内置斜杠命令、技能（工作区/用户）、自定义命令、项目子代理（仅信任文件夹加载）、
  按事件统计的钩子、MCP 服务器、已注册设备，一屏只读总览；`--json` 给同一份快照。
  它是 WorkspaceReady 命令，不需要模型配置——不用分别去 `/skills`、`/agents`、`moss device`、
  `moss mcp`、`moss skill` 查。

### Loop runs join the unified ledger (B132)

- `moss loop` now writes the same `.moss/runs/<runId>/run.json` record as the task engine:
  `passed` -> `completed`, exhausted attempts / wall-clock budget -> `verify_failed` with the check's
  exit code, and a hung check (`--until-timeout`) or silent `--watch` (`--watch-timeout`) ->
  `incomplete` with an explanatory reason instead of looking like a failed repair. `moss runs` shows
  task and loop runs in one newest-first list, with the loop ledger path as an artifact.

### loop 运行进入统一账本（B132）

- `moss loop` 现在写与任务引擎相同的 `.moss/runs/<runId>/run.json`：`passed` → `completed`；
  轮次用尽 / 墙钟预算用尽 → `verify_failed` 并带检查命令退出码；检查命令挂起（`--until-timeout`）
  或 `--watch` 无变化（`--watch-timeout`）→ `incomplete` 并给出原因，不再看起来像修复失败。
  `moss runs` 把 task 与 loop 运行放在同一个最新在前的列表里，loop 账本路径作为工件记录。

### `moss artifacts`: one read-only inspection verb (B131)

- `moss tasks <kind>` was a top-level command one letter away from `moss task`, with its own help and
  usage. It is now `moss artifacts [contracts|tasks|history|evidence|deployments|acceptance|device|failures]`,
  a workspace command that needs no model configuration (CI can inspect evidence and verdicts on a
  machine that never configured a provider). `contracts` is the default and preserves the old
  `tasks list` output; `moss tasks …` keeps working as an alias. `moss task artifacts …` delegates to
  the same implementation.

### `moss artifacts`：一个只读巡检动词（B131）

- `moss tasks <kind>` 原是与 `moss task` 只差一个字母的顶层命令，自带帮助与用法。现在折叠为
  `moss artifacts [contracts|tasks|history|evidence|deployments|acceptance|device|failures]`，
  是 WorkspaceReady 命令、不需要模型配置（CI 在没配 provider 的机器上也能查证据与裁决）。
  默认 `contracts` 保留原 `tasks list` 输出；`moss tasks …` 继续作为等价别名；
  `moss task artifacts …` 委托同一实现。

### One run ledger: `moss runs` (B130)

- Every `moss run` / `moss task run|resume` now also writes
  `.moss/runs/<runId>/run.json` with the completion-gate status vocabulary
  (`completed` / `incomplete` / `verify_failed` / `blocked` / `unverified`) plus
  `interrupted` for a paused, resumable run — the same record shape every future
  engine (loop, workflow, superagent) will write.
- `moss runs [list] [--limit N] [--status <s>] [--json]`, `moss runs show
[<id>|latest] [--json]` and `moss runs prune [--keep N] [--dry-run] [--json]` are
  the single read path: status, reason, `next:` command, counts, artifacts.
  Malformed records are skipped instead of breaking the list, ids cannot escape
  `.moss/runs/`, and pruning keeps the newest N.

### 统一运行账本：`moss runs`（B130）

- 每次 `moss run` / `moss task run|resume` 现在同时写 `.moss/runs/<runId>/run.json`，
  状态复用完成门词汇（`completed` / `incomplete` / `verify_failed` / `blocked` /
  `unverified`），另加 `interrupted` 表示暂停可续；这也是后续 loop / workflow /
  superagent 共用的记录形状。
- `moss runs [list] [--limit N] [--status <s>] [--json]`、`moss runs show
[<id>|latest] [--json]`、`moss runs prune [--keep N] [--dry-run] [--json]` 是唯一读路径：
  状态、原因、`next:` 命令、计数与工件。坏记录跳过不影响列表，id 不能逃出
  `.moss/runs/`，prune 保留最新 N 条。

### Product page and the `moss run` shortcut (B127, B128)

- `README.md` / `README.en.md` are now product pages instead of install manuals: hero with a real
  `moss run` transcript, one install command, "how done is defined", four surfaces, handfeel
  (interrupt / resume / rewind / failure paths), comparison with the best products, safety summary,
  known limits, and a docs map. Install, safety details and the command reference moved to
  `docs/install.md`, `docs/safety.md` and `docs/cli-reference.md`; the two READMEs are 1:1 and a new
  `readme-parity` gate fails when they drift (sections, links, advertised tool counts, internal ids).
- `moss run "<intent>" [--accept "<cmd>"]` is the hero command: a shortcut for `moss task run` that
  shares the same loop, cancellation bridge (Ctrl+C pauses, exit 130) and exit codes, so the product's
  one-line promise and the long form can never drift.

### 产品页与 `moss run` 快捷命令（B127、B128）

- `README.md` / `README.en.md` 从安装手册改为产品页：首屏 real `moss run` 实录、一行安装、
  "完成如何定义"、四种交互面、手感（中断/续跑/撤回/失败三条路）、与最佳产品对比、安全摘要、
  已知边界与文档地图。安装、安全细节与命令参考移到 `docs/install.md`、`docs/safety.md`、
  `docs/cli-reference.md`；中英保持 1:1，新增 `readme-parity` 门禁在节数/链接/宣称的工具数/
  内部单号漂移时直接红。
- `moss run "<意图>" [--accept "<命令>"]` 成为英雄命令：`moss task run` 的快捷方式，共享同一
  状态机、Ctrl+C 暂停语义与退出码，产品的一行承诺与长命令不会漂移。

### Studio 0.30 compatibility snapshot

- Commit `f64aa259cbbdc3548c8f6ebf3fa2c22ac10da2b3`, based on the Studio-pinned
  `3dfb85509c6530dad66fd765075ca3c3f5b35d68`, backports the explicit installation
  prohibition fix while retaining the 0.30.0 API and RSI surface. Its nudge
  implementation matches main; recording this ancestry keeps that compatibility
  snapshot available without downgrading main or restoring its retired spec suite.

### Device safety: root sessions classify `~` by the real home (G4)

- RDK boards default to the root SSH user, whose home is the protected `/root` tree. `~`, `$HOME`, and `${HOME}` in device commands, write paths, and deploy targets now expand against the session's real user before classification, so `rm -rf ~/data` on a root session is judged destructive instead of reversible. Callers that do not provide a user keep the legacy `/home/_user` placeholder behavior.
- The destructive/sensitive confirmation prompt now states when the session logs into the board as root (zh + en).

### 设备安全：root 会话按真实家目录分级（G4）

- RDK 板默认以 root 登录，其家目录是受保护的 `/root` 树。设备命令、写路径与部署目标里的 `~` / `$HOME` / `${HOME}` 现在按会话真实用户展开后再分级：root 会话的 `rm -rf ~/data` 判为毁灭性而非可逆。未提供用户的调用保持 `/home/_user` 占位符旧行为。
- 毁灭性/敏感确认提示现在会注明会话以 root 登录这块板（中英双语）。

### Benchmark hygiene and lifecycle enforcement

- Zero-turn `error_during_execution` samples with no model usage and no tool calls are classified as `harness_flake`, retried up to twice, and excluded from scored denominators when the retries are exhausted. Retried samples keep their diagnostic attempts; summaries publish protocol IDs, task-set hashes, scored denominators, and separate flake counts.
- `--baseline` and `--capability-gate` now require at least three samples; diagnostic single-sample runs say so explicitly. See `docs/bench/coding-agent-evaluation.md` for the Claude Code/Codex same-protocol comparison rule and the privileged/cgroup hold on DeepSWE/Terminal-Bench publication.
- Foreground shell backgrounding that bypasses the registry (`&`, `nohup`, `disown`, `start /b`, `Start-Job`) is rejected with a pointer to the tracked background tools. `exec_stop` waits for process-group termination confirmation; agent close and CLI shutdown also wait instead of reporting a merely sent SIGTERM.
- A completion gate now names live background ids/pids and requires stop/wait evidence before a final claim (one block, then an honest live-process report is allowed). Spec-authority requests receive a one-shot audit nudge toward `SPEC-AUDIT.md`; headless ambiguity correction no longer tells the model to ask a user.

### Benchmark 污染与生命周期强制

- 无模型用量、无工具调用且 ≤1 轮的 `error_during_execution` 样本会标记 `harness_flake`，最多自动重跑 2 次；重试耗尽的样本退出计分分母并单列。恢复样本保留尝试诊断；summary 发布协议 ID、任务集哈希、计分分母与 flake 计数。
- `--baseline` / `--capability-gate` 至少 3 样本；单样本运行显式标记为诊断。Claude Code/Codex 同协议对照与 DeepSWE/Terminal-Bench privileged/cgroup 暂缓口径见 `docs/bench/coding-agent-evaluation.md`。
- 前台 shell 用 `&` / `nohup` / `disown` / `start /b` / `Start-Job` 绕过后台注册表会被拒绝，并指回 tracked 后台工具。`exec_stop` 等待进程组终止确认；agent close 与 CLI 退出也等待确认，不再把“已发送 SIGTERM”当成“已停止”。
- 完成门会列出仍在运行的后台 id/pid，并要求停止或等待证据后才允许最终声明（只拦截一次，之后允许诚实报告仍在运行）。spec/文档权威请求获得一次性 `SPEC-AUDIT.md` 审计提示；headless 歧义修正不再要求询问用户。

### SDK and context surface cleanup (0.31 breaking cleanup)

- **0.x breaking change:** removed the no-op `MossAgentConfig` knobs
  `enableContextPruning`, `enableCompaction`, `enableMicrocompact`,
  `microcompactConfig`, `enableTailToolSnip`, `tailToolSnipConfig`,
  `enableStaleReadInvalidation`, and `enableToolOutputTruncation`. Runtime
  behavior is configured through the existing pruning/compaction settings and
  the context-budget planner; setting these removed knobs never changed
  behavior.
- **0.x breaking change:** tool input validation honors only the declared
  `inputSchema`. An undeclared runtime `inputZodSchema` property is no longer
  an implicit validation or coercion contract.
- **0.x breaking change:** removed the frozen plugin/group registry surface:
  `ToolGroup`, `ToolRegistryOptions`, `registerScoped`, `registerGroup`,
  `removeGroup`, `getGroups`, and `getGroupForTool`. Direct `register` keeps its
  existing replace-on-name behavior and explicit `replace` remains the
  lifecycle-transfer path.
- **0.x breaking change:** removed the SDK-only `compactSubagentSummaryForParent`
  export and the context `hybridCompact` deep path. Remote compaction now has
  one fallback chain — remote, then the normal LLM summary, then the
  deterministic summary; `RemoteCompactResponse` exposes only the summary.
- Added `npm run test:parallel` and `npm run verify:quick`. The package version
  is bumped to 0.31.0 for this narrowed public surface.

### SDK 与上下文面清理（0.31 破坏性清理）

- **0.x 破坏性变更：**移除从未被运行时读取的 `MossAgentConfig` 开关
  `enableContextPruning`、`enableCompaction`、`enableMicrocompact`、
  `microcompactConfig`、`enableTailToolSnip`、`tailToolSnipConfig`、
  `enableStaleReadInvalidation` 和 `enableToolOutputTruncation`。实际行为仍由
  pruning/compaction settings 与上下文预算 planner 控制；设置这些旧开关原本不会改变行为。
- **0.x 破坏性变更：**工具输入校验只认声明的 `inputSchema`。未写入 `Tool`
  契约的运行时 `inputZodSchema` 属性不再是隐式校验或转换契约。
- **0.x 破坏性变更：**移除冻结的插件/分组注册面：`ToolGroup`、
  `ToolRegistryOptions`、`registerScoped`、`registerGroup`、`removeGroup`、
  `getGroups` 和 `getGroupForTool`。直接 `register` 维持既有同名替换语义，
  显式 `replace` 仍是生命周期转移路径。
- **0.x 破坏性变更：**移除仅存在于 SDK 的 `compactSubagentSummaryForParent`
  导出以及 context 的 `hybridCompact` 深路径。远程压缩只保留一条降级链：
  远端 → 常规 LLM 摘要 → 确定性摘要；`RemoteCompactResponse` 只暴露摘要。
- 新增 `npm run test:parallel` 与 `npm run verify:quick`。本次收窄公共面，
  包版本升至 0.31.0。

### Super-agent recovery after native task refinement (0.30.1)

Recovery now validates the original native task creation event and fixed acceptance command. A model's later `task_define` refinement no longer invalidates a legitimate ticket binding; older or ambiguous rounds still require inspection. The complex operations benchmark adds three durable business modules, external HTTP acceptance and a bounded real-model fault drill. See the [evaluation spec](docs/specs/superagent-complex-evaluation.md).

恢复改为核对原生任务首次创建事件与固定验收命令，避免模型用 `task_define` 细化描述后无法续跑；旧轮次和不明确绑定仍会阻塞。新增三工单业务与真实 HTTP 验收、限额模型演练脚本。

### Optional native Super-agent coordination (0.30 capability)

Moss can host the pinned MIT-licensed DeepSeek Super-agent core through local CLI/SDK admission, durable SQLite tickets and isolated native Moss workers. Mandates retain their original acceptance command; ready requires native Task Runtime acceptance and independent controller verification. Pause, stop, retry, input deduplication and explicit crash recovery are supported. No DSH, Web UI or external source/reply adapter is included. See the [guide](docs/superagent.md), [spec](docs/specs/moss-superagent.md) and [acceptance evidence](docs/specs/moss-superagent-acceptance.md).

Moss 可通过本地 CLI/SDK 使用固定版本的 DeepSeek Super-agent 官方核心，提供 SQLite 工单持久化和独立原生 Moss worker。授权范围与验收命令固定；完成须同时通过原生 Task Runtime 和控制进程复验。支持暂停、停止、重试、输入去重和显式崩溃恢复。本次不含 DSH、Web UI、外部消息来源或发送适配器。

### Live interaction permissions

- Switching interaction modes now changes the actual approval policy even when the
  session started in full access. `/permissions` shows the current mode separately
  from the startup configuration; deny rules and the read-only ceiling still apply.
- Explicit ask rules always prompt and cannot create a hidden future grant. Ordinary
  device approvals no longer create a blanket allow rule for the device tool; dangerous
  calls retain their scoped warning. The approval UI maps numbered answers to the
  options actually displayed, including two-option dialogs.
- CLI session grants are visible and removable in `/permissions`; removing one does not
  remove an already-saved user or workspace rule. File-based tools whose names conflict
  with existing tools are skipped with a warning instead of replacing the existing tool.
  Hosts that explicitly replace SDK tools remain responsible for their own approval policy.

### 实时交互权限

- 即使会话以全开模式启动，切换交互模式后也会按新模式执行审批。`/permissions`
  区分当前模式与启动时配置；deny 规则和只读上限仍然生效。
- 显式 ask 规则始终要求确认，不会暗中创建后续授权。普通设备审批不再生成覆盖整个
  设备工具的 allow 规则，危险操作仍显示限定范围的提示；数字选项按实际显示的按钮解析。
- CLI 会话授权可通过 `/permissions` 查看和移除；移除会话规则不会删除已保存的用户或
  工作区规则。与已有工具同名的文件工具会被跳过并提示，不再替换已有工具。主动替换
  SDK 工具的宿主仍须自行负责审批策略。

### Contract acceptance and evidence history

- Contract-based acceptance no longer turns missing observations, invalid numeric values,
  or known conflicting evidence verdicts into a pass. Raw observations can still be
  evaluated against the task's own criterion. Newly recorded evidence preserves the
  explicit verdict, automatic result and whether the observation was redacted when
  available; these are optional additions to the SDK evidence record. Old records can
  lack this provenance; ambiguous historical conflicts cannot always be reconstructed
  and should be re-measured. Existing accepted tasks are not retroactively revoked.
- Contract evaluation reads the selected task's evidence without allowing other tasks'
  history to hide it. The existing task-list limit remains unchanged. A passing
  configured acceptance command retains its existing authority.

### 契约验收与证据历史

- 契约验收不再将缺失观测、无效数值或已知冲突的证据判为通过。原始观测仍可按
  任务自己的标准重新判断；新证据会在适用时保存显式裁决、自动比较结果及观测是否
  被脱敏，均为 SDK 证据记录的可选字段。旧记录可能缺少来源，无法完全还原历史冲突，遇到不确定情况应重新测量；
  已验收的历史任务不会被自动撤销。
- 契约验收按所选任务读取证据，不再被其他任务的历史记录遮挡；既有任务列表数量限制
  不变。已配置的验收命令通过时仍保留原有裁决优先级。

### Explicit no-change and no-install requests

- Read-only requests that say not to edit files no longer receive a false incomplete
  outcome. Explicitly prohibiting dependency installation no longer injects a reminder
  claiming that the user requested it. Separate positive edit / install instructions
  still retain their normal completion and verification checks.

### 明确要求不修改与不安装

- 用户要求只读且明确禁止修改时，不再错误显示未完成；明确禁止安装依赖时，也不再向
  模型注入“用户要求安装”的相反提示。其他独立的正向修改或安装指令仍保留原有检查。

### Structured tool results and SDK compatibility

- **SDK behavior change in 0.x:** a post-tool or post-failure hook returning
  `{ result }` now discards the prior structured blocks, even when `result` is
  unchanged. This prevents those blocks from bypassing a replacement or redaction.
  Observation-only hooks should return `null` (JavaScript hooks may return
  `undefined`) to keep structured blocks.
- On the MossAgent model path, an existing tool-result `content` string is
  authoritative, including `''`; old structured text is not appended. Some
  older sessions that relied on structured text alongside empty or different
  content may therefore expose less text to the model. The original records
  are not changed by this projection. To recover intended text, rerun the tool
  in a new session, or copy the history to a new session and have the host
  inspect and sanitize the intended text before placing it in `content`; remove
  stale structured data from the copy. A record without a `content` field still
  falls back to structured text, so hosts must inspect such legacy records before
  resuming them.
- Non-text structured results that exceed the existing cap still replace
  `structuredContent` with a text truncation notice. Newly persisted results
  also carry an optional `_structuredContentTruncated` number on the tool-result
  block, letting the model receive a safe generated notice after resume without
  changing SDK `content` or the already-capped `structuredContent`. An older
  unmarked result cannot safely recover that notice.
- The separate `PiAiLLMProvider` entry point can still append supplied structured
  text to `content`, and optional remote compaction sends stored structured
  content. Hosts need to inspect and remove or sanitize old structured data
  before using these paths when it must not be sent.

### 结构化工具结果与 SDK 兼容性

- **0.x SDK 行为变更：**后置工具或失败 hook 返回 `{ result }` 时，即使文本
  不变，也会丢弃原结构化块，避免替换或脱敏后旧块绕过处理。只观察结果的
  hook 应返回 `null`（JavaScript 运行时也可返回 `undefined`）以保留结构化块。
- MossAgent 向模型投影工具结果时，已有的 `content` 字符串（包括 `''`）为准，
  不追加旧结构化文本。因此依赖空内容或不同内容旁的结构化文本的旧会话，模型
  可能看到更少文本；此投影不会修改原记录。需要恢复时，可在新会话重新执行
  工具，或将历史复制到新会话，由宿主检查、脱敏后把所需文本写入 `content`，
  并从副本移除过时的结构化数据。完全没有 `content` 字段的旧记录仍会回退到
  结构化文本，宿主应在恢复前检查此类记录。
- 非文本结构化结果超限时，`structuredContent` 仍按原有上限替换为文本截断
  提示。新写入的工具结果还带可选数字字段 `_structuredContentTruncated`，供恢复
  后安全生成模型侧提示；该字段不改变 SDK 的 `content` 或已截断的
  `structuredContent`。旧记录没有该标记时无法安全恢复这一提示。
- 独立调用 `PiAiLLMProvider` 仍可能将提供的结构化文本追加到 `content`；可选
  远程压缩也会发送记录中的结构化内容。宿主将旧消息交给这些入口前，需要检查
  并移除或脱敏不应发送的结构化数据。

### Product experience, task verdicts, and configuration change detection

- The terminal experience has a shorter help view, more reliable in-flight input,
  attributable concurrent tool results, and a model picker that follows the selection.
- Command-based task acceptance can now attribute a verdict when `task_id` is omitted.
  **SDK compatibility:** in that case, `taskAcceptanceTool.execute()` now prefixes its
  command detail with `Task acceptance (<task ID>): PASS|FAIL`. Consumers matching the
  complete result or its former first line must account for the new header. Calls with
  an explicit `task_id` keep their previous command detail format.
- Executed commands are checked for changes to selected Moss configuration and
  credential files. This is post-execution detection, not prevention or automatic
  recovery; delayed writes and results of background subagents that are never collected
  remain outside this guarantee. Subagent `writePaths` are coordination hints, not an
  enforced security boundary.

### 产品体验、任务验收与配置变更检测

- 精简终端帮助，改善运行中输入、并发工具结果归属，以及长模型列表的选择体验。
- 命令验收省略 `task_id` 时，结果现在包含实际任务标识。**SDK 兼容性：**此时
  `taskAcceptanceTool.execute()` 会在原有命令详情前增加
  `Task acceptance (<task ID>): PASS|FAIL`；按完整内容或原首行匹配的调用方需要适配。
  显式提供 `task_id` 的命令验收输出格式保持不变。
- 命令执行后会检查选定的 Moss 配置与凭据文件是否发生变化。这是事后检测，不是
  执行前拦截或自动恢复；延迟写入和从未收集结果的后台子代理仍不在保证范围内。
  子代理的 `writePaths` 是协作提示，并非强制执行的安全边界。

### O148 — PowerShell nesting deeper than one level is analyzed (else fail-closed)

The pwsh write-target scanner analyzed only one level of nested execution
(`& { … }`, `iex "…"`, `pwsh -c "…"`). A write hidden two or more wrappers
deep — `iex "& { Set-Content <config> … }"`, `& { & { & { & { … } } } }` —
was silently ignored: no resolved target, no unresolved marker, no gate hit.
Nested bodies are now scanned recursively up to three levels and anything
deeper is reported as unresolved (fail-closed), so a wrapper chain can no
longer hide a write from the prompt/refusal path.

pwsh 写目标扫描器以前只分析一层嵌套（`& { … }`、`iex "…"`、`pwsh -c "…"`）。
藏在两层及以上包装里的写入——`iex "& { Set-Content <config> … }"`、
`& { & { & { & { … } } } }`——会被静默忽略：既没有解析出目标，也没有
unresolved 标记，门禁完全不命中。现在嵌套体递归扫描至三层，更深的按
unresolved 失败关闭，包装链再也藏不住写入。

### O170 — shell-exec env assignments and tmux/screen spawn forms are blocked

`BASH_ENV=<file> bash -c ':'` sources the file, `ENV=` does the same for POSIX
sh/dash, `PROMPT_COMMAND=` runs before every prompt of an interactive bash,
`ZDOTDIR` moves zsh's `.zshenv`, an exported `BASH_FUNC_name%%=() { … }` body
is code, and `tmux new-session/run-shell/send-keys` / `screen -dmS` run a
command outside Moss's process tree — none of them tripped the exec-capable
gate on main; a probe planted in BASH_ENV ran. The env assignments are now
reported when a POSIX shell head runs on the same line (`ENV=production npm
start` is not flagged — the name collision is common), in every assignment
shape (prefix, `env`, `export`/`declare`, `set`, bare statement, pwsh
`$env:`), and the tmux/screen forms are reported when they carry a command
(`tmux ls`, `tmux attach`, `screen -ls` stay green).

`BASH_ENV=<file> bash -c ':'` 会让 bash source 该文件，`ENV=` 对 POSIX sh/dash
同理，`PROMPT_COMMAND=` 在交互 bash 每个提示符前运行，`ZDOTDIR` 改写 zsh 的
`.zshenv` 位置，导出的 `BASH_FUNC_name%%=() { … }` 函数体本身就是代码；
`tmux new-session/run-shell/send-keys` 与 `screen -dmS` 在 Moss 进程树之外运行
命令——这些在 main 上都不会触发「可执行读取」拦截，BASH_ENV 里放的探针真的
跑了起来。现在：环境变量赋值在**同一行内有 POSIX shell 头**时报为可执行
（`ENV=production npm start` 不误拦——这个名字常被应用配置占用），覆盖前缀、
`env`、`export`/`declare`、`set`、裸赋值、pwsh `$env:` 各种形态；tmux/screen
仅在其携带命令时报（`tmux ls`、`tmux attach`、`screen -ls` 不受影响）。

### O169 — `git --upload-pack` / `--receive-pack` literal commands are blocked

`git clone --upload-pack='<cmd>'`, `git fetch --upload-pack=…`, `git push
--receive-pack=…` (glued, `--upload-pack cmd`, or clone's short `-u`) make git
run the given command to speak the pack protocol — arbitrary execution that
looks like a plain clone/fetch/push. The flags were not in the exec-capable
table, so the pre-exec block (O152) never fired. They now are, in the
subcommand position and the global one; `git push -u origin main`
(--set-upstream) is unaffected.

`git clone --upload-pack='<cmd>'`、`git fetch --upload-pack=…`、`git push
--receive-pack=…`（连写、空格分开、或 clone 的短旗标 `-u`）会让 git 执行给定命令来
讲 pack 协议——表面是普通 clone/fetch/push，实际是任意执行。此前这些旗标不在
「可执行读取」表里，O152 的执行前拦截从未触发；现已加入（子命令位与全局位都识别）。
`git push -u origin main`（--set-upstream）不受影响。

### O168 — a script's arguments are not deletions

The write-target rules blocked normal commands: an interpreter run is
"uncertain" (a script can write anything), and every absolute mention then
went through the delete-ancestor rule — `python3 x.py $HOME`,
`node x.js "$PWD"`, `python3 x.py /tmp`, `. venv/bin/activate && python -V`
were reported as deleting home / the workspace root, and a NON-git directory's
`$PWD` was labeled "git repository internals". Arguments of an invoked script
(the interpreter script form, `sh x.sh`, the `.`/`source` operand and the bare
`.`) are mentions, not deletions: the ancestor rule now skips them — like the
cd exemption, only while the path is named nowhere else in the command
(`source ./evil.sh; ls <root>` still hits). Arguments naming a protected path
directly (`python3 x.py $HOME/.ssh`, `.git/config`), the interpreter inline
forms, and real deletes (`rm -rf $HOME`, `mv $HOME /tmp`, `rm -rf "$PWD"`)
are unchanged; actual writes stay covered by the script scan (layer 2) and
the post-run snapshot (layer 3).

写目标规则曾误拦正常命令：解释器运行是「不确定」的（脚本可能写任何东西），
于是每个绝对路径提及都过了一遍「删除受保护祖先」规则——`python3 x.py
$HOME`、`node x.js "$PWD"`、`python3 x.py /tmp`、`. venv/bin/activate &&
python -V` 被报成删除 home / 工作区根目录，非 git 目录下的 `$PWD` 还被说成
「git 仓库内部文件」。被调用脚本的参数（解释器脚本形式、`sh x.sh`、
`.`/`source` 的操作数与裸 `.`）只是提及、不是删除：祖先规则现在跳过它们——
与 cd 豁免一样，仅当该路径未在命令其他位置出现（`source ./evil.sh; ls
<root>` 仍会命中）。直接点名受保护路径的参数（`python3 x.py $HOME/.ssh`、
`.git/config`）、解释器内联形式、真正的删除（`rm -rf $HOME`、`mv $HOME
/tmp`、`rm -rf "$PWD"`）行为不变；实际写入仍由脚本扫描（第 2 层）与运行后
快照（第 3 层）兜底。

### O165 — a hook that throws blocks; Stop ends Incomplete; a rejected prompt exits 9

Anything thrown while handling a hook on a blocking event now fails closed
with a visible `[hooks]` notice: PreToolUse blocks the call, PermissionRequest
denies, UserPromptSubmit rejects the prompt, and a throwing Stop hook is a
**terminal veto** — `runStopHooks` used to catch the exception and return
"not blocked", silently approving the stop. A fatal Stop veto carries
`fatal: true`: the REPL skips its forced continuation turn (no further model
call) and the headless run ends Incomplete (exit 9). `-p` with a blocked
UserPromptSubmit hook used to exit 8 (TOOL_EXECUTION); it is
INPUT_GUARDRAIL_DENIED → Incomplete (9) with the stable 「被拦」/`Blocked`
last line instead of a rethrown error with a stack.

处理 hook 时抛出的任何异常现在都按拦截失败关闭，并给出可见的 `[hooks]` 提示：
PreToolUse 拦下调用、PermissionRequest 拒绝、UserPromptSubmit 拒绝提示词；
抛异常的 Stop hook 是**终局否决**——以前 `runStopHooks` 捕获异常后返回「未拦
截」，异常悄悄放行了结束。终局否决带 `fatal: true`：REPL 不再强制续一轮（不再
调用模型），headless 以未完成（exit 9）结束。`-p` 下 UserPromptSubmit 被拦以前
exit 8（TOOL_EXECUTION）；现在是 INPUT_GUARDRAIL_DENIED → Incomplete（9），
末行是稳定的「被拦」/`Blocked` 结论线，不再抛带堆栈的错误。

### O162 — hook output over the capture limit blocks

Each hook's stdout and stderr are captured up to 10 MiB per stream; the verdict
is the last JSON line of stdout. When a hook printed more than the capture
holds, the cut text hid the verdict and every blocking gate read only the
truncated remains: a moss `block` and a Claude `permissionDecision: "deny"`
printed after 12 MiB of junk were invisible, and a moss `allow` was
unverifiable — the run exited 0 and the write went through. Any cut stream is
now the outcome `output_too_large`: PreToolUse, UserPromptSubmit,
PermissionRequest and Stop all fail closed on it, whatever the exit code said,
and the notice names the hook, the limit and the stream that was cut. The cut
detection is exact — the flag is set only when output was actually discarded,
so multi-byte text that still fits the capture limit is never a false positive.
A `blocking: false` hook cannot restrict a call, so its oversized output does
not block either.

每个 hook 的 stdout / stderr 各捕获最多 10 MiB，判定取 stdout 最后一行 JSON。
以前 hook 输出超过捕获上限时，截断的文本把判定藏住了：12 MiB 垃圾之后再打印的
moss `block`、Claude `permissionDecision: "deny"` 都看不见，moss `allow` 也无从
验证——run 照样 exit 0、文件照样写入。现在任何被截断的流都记为
`output_too_large`：PreToolUse、UserPromptSubmit、PermissionRequest、Stop
四个阻塞门一律失败关闭，退出码说了什么都不算数，提示里点名 hook、上限与被截断
的流。截断检测是精确的——只有真的丢弃了输出才置标志，多字节文本只要装得进
捕获上限就不会误报。`blocking: false` 的 hook 不能收紧任何调用，其输出超限同样
不拦截。

### O157 — PreToolUse hook `ask` now asks the user; `-p` treats it as deny

A PreToolUse hook that exits 0 with `ask` (Claude `hookSpecificOutput.permissionDecision:
"ask"`, or moss/legacy top-level `decision: "ask"`) previously fell through to
"approved": the call ran without anyone confirming. An `ask` is now recognized
(case-insensitive) and every matching hook runs, so a deny after an ask still
blocks (merge order: deny > ask > allow). Interactive sessions show Moss's y/a/n
confirmation naming the hook, its config file and its reason; `y` and `a`
approve only that call and grant nothing (the hook asks again next time), `n`
refuses. The prompt appears in every mode, full included — trusted workspace,
plan-allow and session allow rules do not skip it. `-p` and runs without a
terminal cannot confirm and treat the ask as deny: the run ends 「被拦」/`Blocked
by` with exit 9. A host that ignores the `hookAsks` field fails closed.

`PreToolUse` hook 以 exit 0 输出 `ask`（Claude 的
`hookSpecificOutput.permissionDecision: "ask"`，或 moss/旧格式的 `decision: "ask"`）
以前会落成「已批准」：调用直接运行，没有人确认过。现在 `ask` 被识别（不区分大小写），
且所有匹配的 hook 都会运行——ask 之后再出现 deny 仍然拦截（合并顺序：deny > ask >
allow）。交互会话弹出 y/a/n 确认，点名 hook、配置文件与理由；`y`/`a` 只批准这一次、
不授予任何信任（下次钩子还会再问），`n` 拒绝。任何模式（包括 full）都会弹确认——
受信任工作区、plan 放行、会话 allow 规则都不能跳过它。`-p` 与无终端的运行无法确认，
按拒绝处理：末行「被拦」，exit 9。不理解 `hookAsks` 字段的宿主按拦截失败关闭。

### O156 — Windows PowerShell 5.1: a missing hook command is "failed to start"

A hook run through Windows PowerShell 5.1 (`powershell -Command <missing>`)
prints `X : The term 'X' is not recognized … operable program` (space before
the colon, wrapped at console width) and exits 1. Moss did not recognize it,
so Claude-format `UserPromptSubmit`, `Stop` and `PermissionRequest` hooks let
the action through. It is now "failed to start; treated as deny" on every
event, like pwsh 7 and cmd. Detection does not rely on English: 5.1's error
record ends with an untranslated `CategoryInfo … CommandNotFoundException`
line, and the Chinese texts of pwsh 7 and 5.1 are recognized too.

Windows PowerShell 5.1 下 hook 命令不存在（`X : The term 'X' … operable
program`，冒号前有空格、按控制台宽度折行，exit 1）以前识别不出来，Claude 格式的
UserPromptSubmit、Stop、PermissionRequest 会放行；现在所有事件都按「未能启动，
已按拒绝处理」拦截。识别不依赖英文：5.1 错误记录末尾的
`CategoryInfo … CommandNotFoundException` 不随语言变化，pwsh 7 和 5.1 的中文
文本也能识别。

The detector no longer builds a regular expression from stderr text. A hook
whose stderr started with a token of 32759+ characters followed by `:` made
it throw ("Regular expression too large"); a Stop hook was then allowed and
the other events crashed. The name is now read with a fixed pattern and
capped, and any detection error makes the hook fail closed.

识别不再用 stderr 内容拼正则。以前 stderr 开头是 32759 字符以上的一个词再接
`:` 时会抛「Regular expression too large」，Stop hook 因此被放行，其他事件直接
报错。现在用固定正则取名并限制长度，识别过程出任何异常都按拦截处理。

The English PowerShell text is matched at least as loosely as before this
change: no space after the colon (`X:The term 'X' …`) and no article
(`… recognized as name of …`) are still a missing command, so those hooks
block exactly as they did.

英文 PowerShell 文本的识别不比改动前更严：冒号后没有空格（`X:The term 'X' …`）、
省略冠词（`… recognized as name of …`）仍算命令不存在，这些 hook 照旧拦截。

### O135 — PreToolUse hooks: any non-zero exit blocks

A `PreToolUse` hook that exits non-zero now blocks the tool call in both Moss
and Claude formats, whatever its output says: `{"decision":"allow"}`,
`{"decision":"approve"}` and `hookSpecificOutput.permissionDecision: "allow"`
from a process that failed are ignored. The run ends 「被拦」/`Blocked by` with
exit 9, and the reason names the hook and says its allow was ignored. This is
deliberately stricter than Claude Code, which treats non-zero exits other than
2 as non-blocking errors. On Windows a hook whose command is missing (cmd or
pwsh) is treated as "failed to start" and blocks.

`PreToolUse` hook 非 0 退出一律拦截，Moss 和 Claude 两种格式都一样，输出里的
allow / approve / `permissionDecision: "allow"` 都不算数；末行「被拦」，exit 9，
提示里点名 hook 并说明已忽略其 allow。这比 Claude Code 更严（它对 2 以外的非 0
只当非阻塞错误）。Windows 上 hook 命令不存在（cmd 或 pwsh）按「未能启动」拦截。

## 0.26.1 (2026-10-11)

First npm release of the package (`@rdk-moss/agent`). Version 0.26.0 was tagged
in-repo but never published; npm `latest` was 0.6.0 before this release.

### TUI — OSC 11 replies no longer leak into the composer

On startup Moss asks the terminal for its background colour (OSC 11). When the
reply arrives split across stdin chunks — as real terminals do — neither piece
matched the old single-chunk check and the reply text (`]11;rgb:…`) landed in
the composer as if typed. A small state machine (`src/cli/tui/osc-reply-filter.ts`)
now reassembles OSC 11 replies across arbitrary chunk boundaries (BEL and ST
terminators), holds a bounded tail for split heads, and flushes as plain text
when no reply materialises. Theme detection still works; ordinary typing and
pastes are untouched. Verified with a PTY harness: split-reply repro shows a
clean composer after the fix.

### O88 — hooks fail closed

A blocking hook that cannot start or times out now blocks instead of silently allowing. Exit codes 126/127 (and 9009 on Windows) are treated as "failed to start" and block too, so hooks that intentionally exit with these codes are now blocked.

### O90 — hooks timeoutMs clamped to Node timer max

Moss-format `timeoutMs` values above the Node.js timer maximum (~2^31-1 ms) are
clamped to the maximum with a one-time warning instead of firing immediately.

### O86 — read-after-edit honesty

A file read is no longer answered with a "content unchanged, see the earlier
read" stub after the file was edited by a write/patch/move, after the earlier
read left the model context (compaction/elision), or when the on-disk bytes no
longer hash-match the last recorded read. Failed writes no longer invalidate
the earlier read. Files larger than 2 MiB skip the pre-stub hash (always real
content). Placeholder wording is bilingual; the pre-O86 placeholder is still
recognised in resumed sessions but never re-emitted.

## Unreleased

### O43 / O58 — npm one-line install

Recommended install is one command after Node ≥ 22.16:

```bash
npm install -g @rdk-moss/agent@latest
```

`package.json` is no longer `"private": true` (publishConfig stays `access: public`).
`scripts/check-node-version.cjs` runs from both `preinstall` and `prepare`, so a Node
older than 22.16 exits immediately with copyable upgrade commands for macOS (brew /
nvm / fnm), Ubuntu/Debian (NodeSource / nvm / fnm), and Windows (`winget`), plus the
success-path `npm install -g @rdk-moss/agent@latest`. A failing
`npm install -g --install-links .` does not leave a broken global `moss` shim.
`MOSS_TEST_FAKE_NODE_VERSION` lets tests exercise the failure path without an old
Node binary. README
(en + zh) leads with the npm one-liner; source clone remains the optional developer
path. No curl native-binary installer in this phase.

### O60 — custom OpenAI-compatible gateway docs

README (zh + en) documents `provider openai-compatible` with `model` / `baseUrl` /
`apiKeyEnv`. A trailing `/v1` on `baseUrl` is optional; Moss appends
`/v1/chat/completions` and never produces `/v1/v1`. `moss config --help` and the
invalid-`baseUrl` hint say `/v1` is optional. `test/api-v1-url.spec.mjs` locks
`buildApiV1Url` for bare hosts, trailing slash, `/v1`, and the d-robotics preset.

### O59 — doctor binary path and PATH duplicates

`moss doctor` prints `version` (with build stamp) and `binary` (realpath of the
running entry + package root), and warns when several distinct `moss` executables
are on PATH (PATH order, which one wins, whether it is the running one; PATHEXT on
Windows, symlinks deduped). Scanner lives in `src/cli/moss-binary-path.ts`.

### Install follow-ups

`npm ci` runs `scripts/check-node-version.cjs` as `preinstall`. The script is
listed in `files`, so the packed global copy can run it. npm installs
dependencies before that hook; on Node older than 22.16 the script prints the
upgrade steps and exits 1, with those packages already on disk. The README
says not to follow
npm's notice to upgrade to npm 12 on Node 22.16. macOS git needs
`xcode-select --install`. `moss update` looks only in the current directory
and `./moss` unless you pass `--dir <clone>` or set `MOSS_SOURCE_DIR`.
`moss --version` appends `+dirty` when the worktree had uncommitted changes
at build time. The uninstall notes include `~/.cache/node-gyp` and an empty
`@rdk-moss` directory under the npm prefix.

### Folder trust asks once per folder

After upgrading, Moss asks once per folder — including an empty project —
before it loads that folder's settings. Yes is remembered in the user trust
store. The next launch in that folder does not ask. `-p` and CI do not ask
unless `--trust-workspace` or real-environment `MOSS_TRUST_WORKSPACE=1` is
set. After a folder is trusted, execution stays in full mode: Moss does not
stop for a per-command approval. An ancestor `.env` still does not apply
routing keys; Moss prints those key names and the directory that contained
them, even when this folder is trusted. `MOSS_WORKSPACE` in a project `.env`
is ignored (any letter case), so it cannot move the workspace or the trust
decision. Model tiers (`MOSS_MODEL_CHEAP`, `MOSS_MODEL_BALANCED`,
`MOSS_MODEL_STRONG`) from a project `.env` wait for trust, as do
`PGSSLROOTCERT`, `HF_HUB_DISABLE_SSL_VERIFY`, `GLOBAL_AGENT_HTTP_PROXY`, and
`FTP_PROXY`. A trusted project that names the user's key variable
(`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, and the other preset key names) on a
foreign base URL does not receive that key. A fallback provider that would
send the primary key to another host is dropped with a warning instead of
exiting. `PIP_TRUSTED_HOST`, `UV_INSECURE_HOST`, and `DENO_CERT` from a
project `.env` stay deferred with the other routing variables.

### A `.env` file cannot change approval or other safety controls

`MOSS_AUTO_APPROVE`, `MOSS_PROFILE`, `MOSS_CONFIG_PROFILE`,
`MOSS_GOAL_VERIFY_LOOP`, `MOSS_GOAL_VERIFY_CMD`, and the other approval, trust,
redaction, and tool-permission variables (26 keys) are ignored when they come
from any `.env` file: a project `.env`, an ancestor directory's `.env`,
`~/.env`, or the install directory's `.env`, whether or not that folder is
trusted. They still work from the real process environment and from CLI flags.
Moss prints one line naming the ignored keys and the `.env` path (`-p` and the
REPL on stderr; the fullscreen TUI in the transcript, because the alternate
screen hides earlier stderr). `MOSS_DEVICE_HOST`, `MOSS_DEVICE_PORT`,
`MOSS_DEVICE_USER`, `MOSS_DEVICE_ID`, `MOSS_DEVICE_KIND`, and `MOSS_DEVICE_KEY`
wait for folder trust with the other routing variables, so an untrusted project
cannot point the user's `MOSS_DEVICE_PASSWORD` at another host. `~/.env` and
the install directory's `.env` still apply those device fields. That is the
documented way to name a board.

When a project `.env` (even in a trusted folder) sets `MOSS_DEVICE_HOST`, Moss
sends that host only a `MOSS_DEVICE_PASSWORD` written in the same `.env`. Your
own password from the real environment, `~/.env`, or the install `.env` is not
sent, and Moss prints a line saying so. A project's `.moss/devices.json` is
ignored until the folder is trusted (the untrusted-folder line lists it), and a
registry entry whose `passwordEnvVar` or `passphraseEnvVar` names an API key,
token, secret, credential, or auth variable loses its auth. `VISUAL`, `EDITOR`,
and `BASH_FUNC_*` join the variables a project `.env` cannot set. The trust
prompt now says a trusted project can change the device target.

### Install and upgrade from a clone

`npm install -g github:D-Robotics/moss` fails on a clean machine (npm 10.9.2 and
11.21.0) because a git dependency's prepare inherits global npm config. Install
from a clone. `npm ci` runs `prepare` (`npm run build`), so the documented
commands do not build a second time:

```bash
git clone https://github.com/D-Robotics/moss.git
cd moss
npm ci
npm install -g --install-links .
```

Upgrade an existing clone (this reinstalls the global copy, not only the checkout):

```bash
cd moss && git pull && npm ci && npm install -g --install-links .
```

`moss update` prints that line when the running package, the working directory,
or `./moss` is a checkout. Otherwise it prints the clone commands. It does not
run them. `moss --version` appends the short commit and the UTC build date
recorded in `dist/utils/build-stamp.json`, for example
`moss v0.26.0 (e8dc2e3, 2026-10-10)`. With no commit available the parenthetical
is omitted.

`--install-links` puts a standalone copy in the prefix. If an older unscoped `moss`
package is installed, run `npm uninstall -g moss` first; npm otherwise stops with
EEXIST on the shared bin. Do not pass `--force`: both packages stay installed, and
a later `npm uninstall -g moss` removes the `moss` command. That uninstall leaves
`@rdk-moss/agent` in place when `--force` was not used.
`npm install -g @rdk-moss/agent@latest` is the recommended install path.

### `workspace-write` copy no longer implies an OS sandbox

`workspace-write` confines Moss's own file tools. Shell commands run normally
without an OS sandbox. `/permissions`, `config show`, help, the README (en and
zh), and the startup full-mode notice say so. Behaviour is unchanged. An
opt-in OS sandbox (default off) is specified in `docs/design/os-sandbox.md`.

### Legacy loop scheduler removed

`LoopScheduler`, its acceptance-failure prompt, and the loop TUI event bridge are gone.
`/goal`, `/task`, `moss task`, and `MOSS_GOAL_VERIFY_LOOP` behave as before. `/loop` does not
start a run: it prints a localized line (`/loop` is now `/goal`, with an example) and leaves
a `/goal` command in the composer to confirm or edit. Acceptance commands run from `core/task/acceptance-command.ts`. A token
or tool-call budget stop ends the task (`run budget exceeded (…)`) instead of opening another
turn. `.moss/loop-state.json` and `.moss/loop-journal.jsonl` are no longer read or written;
files already in a workspace are left in place. `MOSS_DISABLE_NUDGES=goal-acceptance` is an
unknown id and is ignored.

### Workspace trust and Claude hook compatibility

Project hooks from `.moss/config.json` now keep every event (`Stop`, `SubagentStop`,
`PreCompact`, `PostCompact`, `SessionEnd`, `Notification`, `UserPromptSubmit`,
`PermissionRequest`), not only `PreToolUse` / `PostToolUse` / `SessionStart`.
`UserPromptSubmit` runs as the input guardrail: exit code 2 or `{decision:"block"}`
rejects the prompt and the reason is shown. Stdout is extra context only when the
hook exits 0; it is redacted and wrapped in `<hook-output source="UserPromptSubmit">`.
`PermissionRequest` runs before the approval prompt and can deny; an allow decision
does not skip the prompt. Moss-native hooks still block on any non-zero exit.
Claude-format hooks (`.claude/settings.json`) block only on exit code 2, and
`PreToolUse` also honors `hookSpecificOutput.permissionDecision: "deny"`. Matchers
follow Claude Code: `*` matches all, and `Bash, Edit` / `Edit|Write` are exact
lists. Payloads include Claude `tool_input` names such as `command` and `file_path`.
Tool names map as `Bash` → `exec`, `Edit` → `edit_file`, `Write` → `write_file`,
`Read` → `read_file`, `Grep` / `Glob` → the search tools.

Reading `.claude/` (`settings.json`, `settings.local.json`, or `agents`) and
`.mcp.json` waits for a one-time yes/no (中文 or English) remembered per workspace.
Project hooks, project MCP servers (stdio and HTTP, `.moss/mcp.json` included),
a project `statusLine` command, project agents with write tools, and plugins need
a one-time trust confirmation per workspace path. Untrusted HTTP servers are not
loaded, so `${VAR}` in a project URL is not expanded. That decision is passed to
the agent loader as `projectTrust` (`trusted` and `claudeOptIn` stay independent:
declining Claude compatibility with nothing else project-level is still
`trusted: true` and `claudeOptIn: false`, so `.claude/agents` write agents stay
blocked). The built-in rdk-docs server is exempt because Moss injects it, not
because of its name. A project server named `rdk-docs`, and a project
`rdkDocs.package`, do not replace that builtin until the workspace is trusted;
project config cannot set the package. The user's own config
(`~/.config/moss` and `~/.moss`) does not ask. `MOSS_TRUST_WORKSPACE`,
`MOSS_CONFIG_DIR`, `MOSS_CONFIG_FILE`, `MOSS_CONFIG_PATH`,
`MOSS_RDK_DOCS_PACKAGE`, `XDG_CONFIG_HOME`, `HOME`, `APPDATA`, and
`USERPROFILE` are read from the process environment captured before `.env`
is loaded, and from CLI flags. A project `.env` cannot set them, and cannot
set interpreter or loader variables (`NODE_OPTIONS`, `NODE_PATH`,
`NODE_EXTRA_CA_CERTS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_*`,
`BASH_ENV`, `ENV`, `ZDOTDIR`, `PYTHON*`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`,
`RUBYLIB`, `GIT_*` (`GIT_DIR`, `GIT_CONFIG`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`,
`GIT_OBJECT_DIRECTORY`, and the rest), `npm_config_*`, `PATH`, `SHELL`, `IFS`,
`TMPDIR`, `TMP`, `TEMP`).
Child processes keep the user's own values of those variables and drop ones the
project file added. The built-in rdk-docs `npx` child inherits only the
pre-`.env` environment. It runs in a Moss cache directory under the pre-`.env`
home (`~/.moss/cache/npx`), not `TMPDIR`. It does not pass `--registry`, so a
mirror in the user's `~/.npmrc` or pre-`.env` `npm_config_registry` is used.
`npm_config_userconfig` stays the user's own `~/.npmrc`, and
`npm_config_globalconfig` is not changed, so a project `.npmrc` `registry=` is
not used. Every git child passes `-c core.fsmonitor=` and
`-c core.hooksPath=/dev/null` (`NUL` on Windows). Read-only git also clears
`core.sshCommand`, `diff.external`, and `credential.helper`, forces
`core.pager=cat` with `GIT_PAGER=cat`, passes `--no-ext-diff` and
`--no-textconv` on `diff`, and blanks `local` and `worktree`
`filter.*.clean|smudge|process` and `diff.*.textconv|command` (with
`filter.<name>.required=false`), including keys from `include.path`,
`includeIf`, and `extensions.worktreeConfig`. System and global git config
are still read and are not overridden. Git children take `GIT_*` from the
environment captured before the project `.env`. Startup `git status` and
`/diff` do not run a program named in a copied repo's `.git/config` or
`.gitattributes`. If listing that config fails for any reason other than
no matches (exit 1), the read-only git command is refused. A session JSON
line keeps the per-value redaction when a whole-line pass would still parse
but drop a later tool result. Device bench removes the temporary provider
config directory that holds the API key on finish, process exit, and
SIGINT / SIGTERM / SIGHUP.
Headless `-p` stays untrusted and
prints one line naming what was skipped. Enable it for that process with
`--trust-workspace` or `MOSS_TRUST_WORKSPACE=1`.

### Slash commands follow Claude Code / Codex

The everyday menu shows `/model` `/compact` `/goal` `/plan` `/review` `/doctor` `/diff` `/resume`
`/permissions` `/clear` `/help` (plus `/theme` in the TUI); other commands stay typeable but hidden. `/plan [description]`
enters plan mode. `/goal` is the "work until" entry (`/loop` migrates to it) and, without
`--accept`, proposes acceptance commands from test entry points that exist in the workspace.
`/resume` restores a conversation (`/sessions` migrates to it). `/tasks` (aliases `/ps`,
`/bashes`) lists background shells and sub-agents. `/stop` (alias `/abort`) stops background
processes this session started; Esc interrupts the run. A message typed during a run steers it
and falls back to the queue above the composer; `/steer` and `/queue` are hidden aliases for one
version. The hidden `/task` gains `verify`, which takes one verdict without a model turn.

### Real-terminal checks (TUI P7)

`scripts/tui-feel/real-terminals.py` drives tmux (mouse off and on), GNU screen, and
Terminal.app, and skips terminals that are not installed. `npm test` runs it only when
`MOSS_REAL_TERMINALS=1`. Manual checklists for iTerm2, VS Code, Windows Terminal, and IME
candidate windows are in `docs/cli-parity/tui-real-terminals.md`.

### Benchmarks

- `npm run bench:device` scores RDK board tasks in `bench/device-tasks/` (`--dry`, `--target sim`,
  `--target real`). A row passes only when the verdict passes and an independent probe matches
  the evidence; `falseSuccess` is reported separately. See `docs/bench/device-bench.md`.
- `npm run bench:deepswe` runs Moss on DeepSWE v1.1 through Pier with the model held fixed, for
  comparison with `bench/boards/deepswe-v1.1-harness.json`.
- `moss task run` prints an `llm_usage` JSON line when the agent reports tokens.

### RDK knowledge

Board manuals come from the built-in rdk-docs MCP, defaulting to the pinned
`rdk-docs-mcp@0.3.0`. Search stays BM25 with title fusion, `noGoodMatch`, and board filtering.
`search_docs` accepts `alt_queries` and returns compact hits (title, url, anchor, snippet) unless
`verbose` is set. `get_page` returns the matching section unless `full` is set. `search_skills`
and `get_skill` read the skill catalog. `MOSS_RDK_DOCS_PIN_CHECK=1` makes `moss doctor` ask npm
whether a newer `rdk-docs-mcp` is published; the check is off by default and does not run at
startup. Moss connects it in the background when a device target is configured
(`MOSS_DEVICE_HOST` or `.moss/devices.json`) or when `rdkDocs` is true. `rdkDocs.package` and
`MOSS_RDK_DOCS_PACKAGE` accept a trusted npm spec, local directory, or tarball for unpublished
server builds. Opt out with `MOSS_NO_RDK_DOCS=1` or `"rdkDocs": false`. A same-named `mcp.json`
entry replaces the builtin. Connect timeout is 45s and each request 20s for this server only; the
timeout does not delay the interactive shell. A failed connect prints
`[mcp] rdk-docs unreachable (<reason>) — RDK manual lookup is off this session.` and the system
prompt tells the agent the manual could not be checked. There is no cache and no offline copy.
When the server is up, the prompt points only at the registered `mcp__rdk-docs__search` tool and
treats version-specific search/ranking/section features as optional. A short `rdk-docs` skill is
indexed and follows the compact hit and section-read shape. The robotics fallback verifies `<installation>/setup.bash` before sourcing it; probe
scripts, connection steps, and device safety rules stay. See
`docs/superpowers/plans/2026-10-09-rdk-knowledge-via-mcp.md`.

### 工作区信任与 Claude hooks

`.moss/config.json` 里的项目 hooks 会合并全部事件，不再丢掉 `Stop` 等类型。
`UserPromptSubmit` 在输入护栏上拦截（退出码 2 或 `{decision:"block"}`，原因展示给用户）。stdout 只在退出码 0 时作为额外上下文，先脱敏再包进 `<hook-output source="UserPromptSubmit">`。
`PermissionRequest` 在询问用户之前运行，只接受拒绝。Claude 格式的 hooks 只在退出码 2 时阻断，`PreToolUse` 同时接受 `permissionDecision: "deny"`；`*` 与逗号/管道列表按 Claude Code 匹配，`tool_input` 带上 `command` / `file_path`。
读取 `.claude/`（settings 或 agents）和 `.mcp.json` 需要一次性确认。项目 hooks、项目 MCP（stdio 与 HTTP，含 `.moss/mcp.json`）、项目 `statusLine` 命令、带写工具的项目 agent 和插件也需要按路径一次性信任。未信任的 HTTP 服务器不会加载，因此不会展开项目 URL 里的 `${VAR}`。
信任结果传给 agent loader（`trusted` 与 `claudeOptIn` 分开：拒绝 Claude 兼容且没有其他项目内容时仍是 `trusted: true`、`claudeOptIn: false`，`.claude/agents` 里的写代理继续被挡住）。
内置 rdk-docs 因来源是 Moss 自己注入而免询问；同名的项目服务器和项目 `rdkDocs.package` 不能替换它。用户自己的配置（`~/.config/moss` 与 `~/.moss`）不会询问。
`MOSS_TRUST_WORKSPACE`、`MOSS_CONFIG_DIR`、`MOSS_CONFIG_FILE`、`MOSS_CONFIG_PATH`、`MOSS_RDK_DOCS_PACKAGE`、`XDG_CONFIG_HOME`、`HOME`、`APPDATA`、`USERPROFILE` 只认加载 `.env` 之前的进程环境和命令行，项目 `.env` 不能设置。项目 `.env` 也不能设置解释器/加载器变量（`NODE_OPTIONS`、`LD_PRELOAD`、`DYLD_*`、`BASH_ENV`、`PYTHON*`、`PERL5*`、`RUBY*`、`GIT_*`（含 `GIT_DIR`、`GIT_CONFIG`、`GIT_WORK_TREE`、`GIT_COMMON_DIR`、`GIT_OBJECT_DIRECTORY`）、`npm_config_*`、`PATH`、`SHELL`、`IFS`、`TMPDIR`、`TMP`、`TEMP` 等）。子进程保留用户自己设的值，丢掉项目文件加进来的值。内置 rdk-docs 的 `npx` 子进程只继承加载 `.env` 之前的环境，工作目录是加载 `.env` 之前的用户主目录下的 `~/.moss/cache/npx`，不用 `TMPDIR`，也不传 `--registry`，因此用户 `~/.npmrc` 或进程环境里的镜像源仍然有效；`npm_config_userconfig` 保持用户自己的 `~/.npmrc`，不改 `npm_config_globalconfig`，项目 `.npmrc` 的 `registry=` 不会被用到。Moss 启动的每个 git 子进程都带 `-c core.fsmonitor=` 和 `-c core.hooksPath=/dev/null`（Windows 为 `NUL`）。只读 git 另外清空 `core.sshCommand`、`diff.external`、`credential.helper`，把 `core.pager` 与 `GIT_PAGER` 设为 `cat`，对 `diff` 加上 `--no-ext-diff` 和 `--no-textconv`，并清空 local 与 worktree 作用域的 `filter.*.clean|smudge|process` 与 `diff.*.textconv|command`（含 `include.path`、`includeIf`、`extensions.worktreeConfig` 引入的键，同时 `filter.<name>.required=false`）。系统级和 global git 配置仍会读取且不会被覆盖。git 子进程的 `GIT_*` 取自加载项目 `.env` 之前的环境。启动时的 `git status` 和 `/diff` 不会执行拷贝来的仓库 `.git/config` 或 `.gitattributes` 里指定的程序。列出这些配置时，除了没有匹配（退出码 1）以外的失败都会拒绝这次只读 git。会话 JSON 行在整行脱敏仍能解析、但会丢掉后面的 tool result 时，保留按值脱敏的结果。设备基准在结束、进程退出和 SIGINT / SIGTERM / SIGHUP 时删除存放 API key 的临时 provider 配置目录。
无头 `-p` 默认不信任，并打印一行说明跳过了什么；用 `--trust-workspace` 或 `MOSS_TRUST_WORKSPACE=1` 启用。

### 斜杠命令、真实终端与基准

日常菜单与 Claude Code / Codex 对齐，其余命令隐藏但仍可输入。`/plan` 直接进入 plan 模式；
`/goal` 是"做到为止"的入口（`/loop` 迁移到它），没带 `--accept` 时从工作区已有的测试入口给出验收命令候选；
`/resume` 恢复会话；`/tasks`（别名 `/ps`）列后台任务；`/stop` 只停本会话的后台进程，打断用 Esc；
运行中发消息默认 steer，不能 steer 时排队。隐藏的 `/task` 新增 `verify`。
真实终端核对用 `MOSS_REAL_TERMINALS=1` 打开。新增 `npm run bench:device`（板卡任务成功率）与
`npm run bench:deepswe`（同模型 DeepSWE 对比）。RDK 手册由内置 rdk-docs MCP 供给，默认钉在 `rdk-docs-mcp@0.3.0`（设备会话默认连接，
`MOSS_NO_RDK_DOCS=1` 或 `rdkDocs: false` 关闭；连不上只报一行错误，不缓存）。

### Device safety policy

Full mode still runs read-only probes and reversible device changes without asking
(deploys under `/home`, `/opt`, `/tmp`, `/usr/local`, package installs, `systemctl restart`).
Destructive or lockout-risk device operations — reboot and poweroff, flashing and `mkfs`,
writes to `/boot` or `/etc`, firewall and network changes, system package removal,
`systemctl stop` / `disable` / `mask`, ssh and account edits — now require a TTY confirmation.
Headless runs refuse that tier unless the operator opts in.

Opt in with `--trust-device` (this process), `MOSS_DEVICE_TRUST=full`,
`permissions.deviceTrust=full`, `permissions.trustedDevices` or `MOSS_DEVICE_TRUST_DEVICES`
for one board, or an allow rule that matches the call. Deny rules still win.
Answering `a` trusts only the scope named in the prompt (power commands, `systemctl restart` or
`stop` of that unit, or the same command prefix) for the rest of the session.
Secret reads (`/etc/shadow`, private keys, `sshd_config`, `authorized_keys`) are a `sensitive`
tier: they still confirm, and evidence records `sensitive:` rather than `destructive:`.
Grants are bound to the tool call id. Flash-like script names escalate to destructive.
`systemctl daemon-reload` and stop/disable/mask of non-critical units are reversible; ssh,
networking, and dbus stay destructive. zh-CN locales get Chinese approval copy.

Each decision is appended to `.moss/evidence.jsonl` (`metric: device_policy`) and, when a
task is in progress, to its timeline as a `note`. Host `exec` hard blocks are unchanged.
See `docs/superpowers/plans/2026-10-09-device-safety-policy.md`.

### 设备安全策略

full 模式仍自动执行只读探测和可逆设备变更。重启、刷机、系统路径写入、网络变更、卸载系统包、
停用 ssh 等毁灭性操作改为 TTY 确认；无终端时拒绝，除非显式信任（`--trust-device`、
`MOSS_DEVICE_TRUST=full`、`permissions.deviceTrust`、按设备名单或 allow 规则）。
选 `a` 只信任提示里的范围。读密钥是 `sensitive` 档。grant 绑定 tool call id。
刷机/OTA 脚本名升为毁灭性。非关键 unit 的 systemctl stop 可逆。中文 locale 使用中文确认文案。
每次决定写入任务证据与时间线。本机 `exec` 硬拦截不变。### O170 — shell-exec env assignments and tmux/screen spawn forms are blocked

`BASH_ENV=<file> bash -c ':'` sources the file, `ENV=` does the same for POSIX
sh/dash, `PROMPT_COMMAND=` runs before every prompt of an interactive bash,
`ZDOTDIR` moves zsh's `.zshenv`, an exported `BASH_FUNC_name%%=() { … }` body
is code, and `tmux new-session/run-shell/send-keys` / `screen -dmS` run a
command outside Moss's process tree — none of them tripped the exec-capable
gate on main; a probe planted in BASH_ENV ran. The env assignments are now
reported when a POSIX shell head runs on the same line (`ENV=production npm
start` is not flagged — the name collision is common), in every assignment
shape (prefix, `env`, `export`/`declare`, `set`, bare statement, pwsh
`$env:`), and the tmux/screen forms are reported when they carry a command
(`tmux ls`, `tmux attach`, `screen -ls` stay green).

`BASH_ENV=<file> bash -c ':'` 会让 bash source 该文件，`ENV=` 对 POSIX sh/dash
同理，`PROMPT_COMMAND=` 在交互 bash 每个提示符前运行，`ZDOTDIR` 改写 zsh 的
`.zshenv` 位置，导出的 `BASH_FUNC_name%%=() { … }` 函数体本身就是代码；
`tmux new-session/run-shell/send-keys` 与 `screen -dmS` 在 Moss 进程树之外运行
命令——这些在 main 上都不会触发「可执行读取」拦截，BASH_ENV 里放的探针真的
跑了起来。现在：环境变量赋值在**同一行内有 POSIX shell 头**时报为可执行
（`ENV=production npm start` 不误拦——这个名字常被应用配置占用），覆盖前缀、
`env`、`export`/`declare`、`set`、裸赋值、pwsh `$env:` 各种形态；tmux/screen
仅在其携带命令时报（`tmux ls`、`tmux attach`、`screen -ls` 不受影响）。

### O157 — PreToolUse hook `ask` now asks the user; `-p` treats it as deny

A PreToolUse hook that exits 0 with `ask` (Claude `hookSpecificOutput.permissionDecision:
"ask"`, or moss/legacy top-level `decision: "ask"`) previously fell through to
"approved": the call ran without anyone confirming. An `ask` is now recognized
(case-insensitive) and every matching hook runs, so a deny after an ask still
blocks (merge order: deny > ask > allow). Interactive sessions show Moss's y/a/n
confirmation naming the hook, its config file and its reason; `y` and `a`
approve only that call and grant nothing (the hook asks again next time), `n`
refuses. The prompt appears in every mode, full included — trusted workspace,
plan-allow and session allow rules do not skip it. `-p` and runs without a
terminal cannot confirm and treat the ask as deny: the run ends 「被拦」/`Blocked
by` with exit 9. A host that ignores the `hookAsks` field fails closed.

`PreToolUse` hook 以 exit 0 输出 `ask`（Claude 的
`hookSpecificOutput.permissionDecision: "ask"`，或 moss/旧格式的 `decision: "ask"`）
以前会落成「已批准」：调用直接运行，没有人确认过。现在 `ask` 被识别（不区分大小写），
且所有匹配的 hook 都会运行——ask 之后再出现 deny 仍然拦截（合并顺序：deny > ask >
allow）。交互会话弹出 y/a/n 确认，点名 hook、配置文件与理由；`y`/`a` 只批准这一次、
不授予任何信任（下次钩子还会再问），`n` 拒绝。任何模式（包括 full）都会弹确认——
受信任工作区、plan 放行、会话 allow 规则都不能跳过它。`-p` 与无终端的运行无法确认，
按拒绝处理：末行「被拦」，exit 9。不理解 `hookAsks` 字段的宿主按拦截失败关闭。

### O156 — Windows PowerShell 5.1: a missing hook command is "failed to start"

A hook run through Windows PowerShell 5.1 (`powershell -Command <missing>`)
prints `X : The term 'X' is not recognized … operable program` (space before
the colon, wrapped at console width) and exits 1. Moss did not recognize it,
so Claude-format `UserPromptSubmit`, `Stop` and `PermissionRequest` hooks let
the action through. It is now "failed to start; treated as deny" on every
event, like pwsh 7 and cmd. Detection does not rely on English: 5.1's error
record ends with an untranslated `CategoryInfo … CommandNotFoundException`
line, and the Chinese texts of pwsh 7 and 5.1 are recognized too.

Windows PowerShell 5.1 下 hook 命令不存在（`X : The term 'X' … operable
program`，冒号前有空格、按控制台宽度折行，exit 1）以前识别不出来，Claude 格式的
UserPromptSubmit、Stop、PermissionRequest 会放行；现在所有事件都按「未能启动，
已按拒绝处理」拦截。识别不依赖英文：5.1 错误记录末尾的
`CategoryInfo … CommandNotFoundException` 不随语言变化，pwsh 7 和 5.1 的中文
文本也能识别。

The detector no longer builds a regular expression from stderr text. A hook
whose stderr started with a token of 32759+ characters followed by `:` made
it throw ("Regular expression too large"); a Stop hook was then allowed and
the other events crashed. The name is now read with a fixed pattern and
capped, and any detection error makes the hook fail closed.

识别不再用 stderr 内容拼正则。以前 stderr 开头是 32759 字符以上的一个词再接
`:` 时会抛「Regular expression too large」，Stop hook 因此被放行，其他事件直接
报错。现在用固定正则取名并限制长度，识别过程出任何异常都按拦截处理。

The English PowerShell text is matched at least as loosely as before this
change: no space after the colon (`X:The term 'X' …`) and no article
(`… recognized as name of …`) are still a missing command, so those hooks
block exactly as they did.

英文 PowerShell 文本的识别不比改动前更严：冒号后没有空格（`X:The term 'X' …`）、
省略冠词（`… recognized as name of …`）仍算命令不存在，这些 hook 照旧拦截。

### O135 — PreToolUse hooks: any non-zero exit blocks

A `PreToolUse` hook that exits non-zero now blocks the tool call in both Moss
and Claude formats, whatever its output says: `{"decision":"allow"}`,
`{"decision":"approve"}` and `hookSpecificOutput.permissionDecision: "allow"`
from a process that failed are ignored. The run ends 「被拦」/`Blocked by` with
exit 9, and the reason names the hook and says its allow was ignored. This is
deliberately stricter than Claude Code, which treats non-zero exits other than
2 as non-blocking errors. On Windows a hook whose command is missing (cmd or
pwsh) is treated as "failed to start" and blocks.

`PreToolUse` hook 非 0 退出一律拦截，Moss 和 Claude 两种格式都一样，输出里的
allow / approve / `permissionDecision: "allow"` 都不算数；末行「被拦」，exit 9，
提示里点名 hook 并说明已忽略其 allow。这比 Claude Code 更严（它对 2 以外的非 0
只当非阻塞错误）。Windows 上 hook 命令不存在（cmd 或 pwsh）按「未能启动」拦截。

## 0.26.1 (2026-10-11)

First npm release of the package (`@rdk-moss/agent`). Version 0.26.0 was tagged
in-repo but never published; npm `latest` was 0.6.0 before this release.

### TUI — OSC 11 replies no longer leak into the composer

On startup Moss asks the terminal for its background colour (OSC 11). When the
reply arrives split across stdin chunks — as real terminals do — neither piece
matched the old single-chunk check and the reply text (`]11;rgb:…`) landed in
the composer as if typed. A small state machine (`src/cli/tui/osc-reply-filter.ts`)
now reassembles OSC 11 replies across arbitrary chunk boundaries (BEL and ST
terminators), holds a bounded tail for split heads, and flushes as plain text
when no reply materialises. Theme detection still works; ordinary typing and
pastes are untouched. Verified with a PTY harness: split-reply repro shows a
clean composer after the fix.

### O88 — hooks fail closed

A blocking hook that cannot start or times out now blocks instead of silently allowing. Exit codes 126/127 (and 9009 on Windows) are treated as "failed to start" and block too, so hooks that intentionally exit with these codes are now blocked.

### O90 — hooks timeoutMs clamped to Node timer max

Moss-format `timeoutMs` values above the Node.js timer maximum (~2^31-1 ms) are
clamped to the maximum with a one-time warning instead of firing immediately.

### O86 — read-after-edit honesty

A file read is no longer answered with a "content unchanged, see the earlier
read" stub after the file was edited by a write/patch/move, after the earlier
read left the model context (compaction/elision), or when the on-disk bytes no
longer hash-match the last recorded read. Failed writes no longer invalidate
the earlier read. Files larger than 2 MiB skip the pre-stub hash (always real
content). Placeholder wording is bilingual; the pre-O86 placeholder is still
recognised in resumed sessions but never re-emitted.

## Unreleased

### O43 / O58 — npm one-line install

Recommended install is one command after Node ≥ 22.16:

```bash
npm install -g @rdk-moss/agent@latest
```

`package.json` is no longer `"private": true` (publishConfig stays `access: public`).
`scripts/check-node-version.cjs` runs from both `preinstall` and `prepare`, so a Node
older than 22.16 exits immediately with copyable upgrade commands for macOS (brew /
nvm / fnm), Ubuntu/Debian (NodeSource / nvm / fnm), and Windows (`winget`), plus the
success-path `npm install -g @rdk-moss/agent@latest`. A failing
`npm install -g --install-links .` does not leave a broken global `moss` shim.
`MOSS_TEST_FAKE_NODE_VERSION` lets tests exercise the failure path without an old
Node binary. README
(en + zh) leads with the npm one-liner; source clone remains the optional developer
path. No curl native-binary installer in this phase.

### O60 — custom OpenAI-compatible gateway docs

README (zh + en) documents `provider openai-compatible` with `model` / `baseUrl` /
`apiKeyEnv`. A trailing `/v1` on `baseUrl` is optional; Moss appends
`/v1/chat/completions` and never produces `/v1/v1`. `moss config --help` and the
invalid-`baseUrl` hint say `/v1` is optional. `test/api-v1-url.spec.mjs` locks
`buildApiV1Url` for bare hosts, trailing slash, `/v1`, and the d-robotics preset.

### O59 — doctor binary path and PATH duplicates

`moss doctor` prints `version` (with build stamp) and `binary` (realpath of the
running entry + package root), and warns when several distinct `moss` executables
are on PATH (PATH order, which one wins, whether it is the running one; PATHEXT on
Windows, symlinks deduped). Scanner lives in `src/cli/moss-binary-path.ts`.

### Install follow-ups

`npm ci` runs `scripts/check-node-version.cjs` as `preinstall`. The script is
listed in `files`, so the packed global copy can run it. npm installs
dependencies before that hook; on Node older than 22.16 the script prints the
upgrade steps and exits 1, with those packages already on disk. The README
says not to follow
npm's notice to upgrade to npm 12 on Node 22.16. macOS git needs
`xcode-select --install`. `moss update` looks only in the current directory
and `./moss` unless you pass `--dir <clone>` or set `MOSS_SOURCE_DIR`.
`moss --version` appends `+dirty` when the worktree had uncommitted changes
at build time. The uninstall notes include `~/.cache/node-gyp` and an empty
`@rdk-moss` directory under the npm prefix.

### Folder trust asks once per folder

After upgrading, Moss asks once per folder — including an empty project —
before it loads that folder's settings. Yes is remembered in the user trust
store. The next launch in that folder does not ask. `-p` and CI do not ask
unless `--trust-workspace` or real-environment `MOSS_TRUST_WORKSPACE=1` is
set. After a folder is trusted, execution stays in full mode: Moss does not
stop for a per-command approval. An ancestor `.env` still does not apply
routing keys; Moss prints those key names and the directory that contained
them, even when this folder is trusted. `MOSS_WORKSPACE` in a project `.env`
is ignored (any letter case), so it cannot move the workspace or the trust
decision. Model tiers (`MOSS_MODEL_CHEAP`, `MOSS_MODEL_BALANCED`,
`MOSS_MODEL_STRONG`) from a project `.env` wait for trust, as do
`PGSSLROOTCERT`, `HF_HUB_DISABLE_SSL_VERIFY`, `GLOBAL_AGENT_HTTP_PROXY`, and
`FTP_PROXY`. A trusted project that names the user's key variable
(`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, and the other preset key names) on a
foreign base URL does not receive that key. A fallback provider that would
send the primary key to another host is dropped with a warning instead of
exiting. `PIP_TRUSTED_HOST`, `UV_INSECURE_HOST`, and `DENO_CERT` from a
project `.env` stay deferred with the other routing variables.

### A `.env` file cannot change approval or other safety controls

`MOSS_AUTO_APPROVE`, `MOSS_PROFILE`, `MOSS_CONFIG_PROFILE`,
`MOSS_GOAL_VERIFY_LOOP`, `MOSS_GOAL_VERIFY_CMD`, and the other approval, trust,
redaction, and tool-permission variables (26 keys) are ignored when they come
from any `.env` file: a project `.env`, an ancestor directory's `.env`,
`~/.env`, or the install directory's `.env`, whether or not that folder is
trusted. They still work from the real process environment and from CLI flags.
Moss prints one line naming the ignored keys and the `.env` path (`-p` and the
REPL on stderr; the fullscreen TUI in the transcript, because the alternate
screen hides earlier stderr). `MOSS_DEVICE_HOST`, `MOSS_DEVICE_PORT`,
`MOSS_DEVICE_USER`, `MOSS_DEVICE_ID`, `MOSS_DEVICE_KIND`, and `MOSS_DEVICE_KEY`
wait for folder trust with the other routing variables, so an untrusted project
cannot point the user's `MOSS_DEVICE_PASSWORD` at another host. `~/.env` and
the install directory's `.env` still apply those device fields. That is the
documented way to name a board.

When a project `.env` (even in a trusted folder) sets `MOSS_DEVICE_HOST`, Moss
sends that host only a `MOSS_DEVICE_PASSWORD` written in the same `.env`. Your
own password from the real environment, `~/.env`, or the install `.env` is not
sent, and Moss prints a line saying so. A project's `.moss/devices.json` is
ignored until the folder is trusted (the untrusted-folder line lists it), and a
registry entry whose `passwordEnvVar` or `passphraseEnvVar` names an API key,
token, secret, credential, or auth variable loses its auth. `VISUAL`, `EDITOR`,
and `BASH_FUNC_*` join the variables a project `.env` cannot set. The trust
prompt now says a trusted project can change the device target.

### Install and upgrade from a clone

`npm install -g github:D-Robotics/moss` fails on a clean machine (npm 10.9.2 and
11.21.0) because a git dependency's prepare inherits global npm config. Install
from a clone. `npm ci` runs `prepare` (`npm run build`), so the documented
commands do not build a second time:

```bash
git clone https://github.com/D-Robotics/moss.git
cd moss
npm ci
npm install -g --install-links .
```

Upgrade an existing clone (this reinstalls the global copy, not only the checkout):

```bash
cd moss && git pull && npm ci && npm install -g --install-links .
```

`moss update` prints that line when the running package, the working directory,
or `./moss` is a checkout. Otherwise it prints the clone commands. It does not
run them. `moss --version` appends the short commit and the UTC build date
recorded in `dist/utils/build-stamp.json`, for example
`moss v0.26.0 (e8dc2e3, 2026-10-10)`. With no commit available the parenthetical
is omitted.

`--install-links` puts a standalone copy in the prefix. If an older unscoped `moss`
package is installed, run `npm uninstall -g moss` first; npm otherwise stops with
EEXIST on the shared bin. Do not pass `--force`: both packages stay installed, and
a later `npm uninstall -g moss` removes the `moss` command. That uninstall leaves
`@rdk-moss/agent` in place when `--force` was not used.
`npm install -g @rdk-moss/agent@latest` is the recommended install path.

### `workspace-write` copy no longer implies an OS sandbox

`workspace-write` confines Moss's own file tools. Shell commands run normally
without an OS sandbox. `/permissions`, `config show`, help, the README (en and
zh), and the startup full-mode notice say so. Behaviour is unchanged. An
opt-in OS sandbox (default off) is specified in `docs/design/os-sandbox.md`.

### Legacy loop scheduler removed

`LoopScheduler`, its acceptance-failure prompt, and the loop TUI event bridge are gone.
`/goal`, `/task`, `moss task`, and `MOSS_GOAL_VERIFY_LOOP` behave as before. `/loop` does not
start a run: it prints a localized line (`/loop` is now `/goal`, with an example) and leaves
a `/goal` command in the composer to confirm or edit. Acceptance commands run from `core/task/acceptance-command.ts`. A token
or tool-call budget stop ends the task (`run budget exceeded (…)`) instead of opening another
turn. `.moss/loop-state.json` and `.moss/loop-journal.jsonl` are no longer read or written;
files already in a workspace are left in place. `MOSS_DISABLE_NUDGES=goal-acceptance` is an
unknown id and is ignored.

### Workspace trust and Claude hook compatibility

Project hooks from `.moss/config.json` now keep every event (`Stop`, `SubagentStop`,
`PreCompact`, `PostCompact`, `SessionEnd`, `Notification`, `UserPromptSubmit`,
`PermissionRequest`), not only `PreToolUse` / `PostToolUse` / `SessionStart`.
`UserPromptSubmit` runs as the input guardrail: exit code 2 or `{decision:"block"}`
rejects the prompt and the reason is shown. Stdout is extra context only when the
hook exits 0; it is redacted and wrapped in `<hook-output source="UserPromptSubmit">`.
`PermissionRequest` runs before the approval prompt and can deny; an allow decision
does not skip the prompt. Moss-native hooks still block on any non-zero exit.
Claude-format hooks (`.claude/settings.json`) block only on exit code 2, and
`PreToolUse` also honors `hookSpecificOutput.permissionDecision: "deny"`. Matchers
follow Claude Code: `*` matches all, and `Bash, Edit` / `Edit|Write` are exact
lists. Payloads include Claude `tool_input` names such as `command` and `file_path`.
Tool names map as `Bash` → `exec`, `Edit` → `edit_file`, `Write` → `write_file`,
`Read` → `read_file`, `Grep` / `Glob` → the search tools.

Reading `.claude/` (`settings.json`, `settings.local.json`, or `agents`) and
`.mcp.json` waits for a one-time yes/no (中文 or English) remembered per workspace.
Project hooks, project MCP servers (stdio and HTTP, `.moss/mcp.json` included),
a project `statusLine` command, project agents with write tools, and plugins need
a one-time trust confirmation per workspace path. Untrusted HTTP servers are not
loaded, so `${VAR}` in a project URL is not expanded. That decision is passed to
the agent loader as `projectTrust` (`trusted` and `claudeOptIn` stay independent:
declining Claude compatibility with nothing else project-level is still
`trusted: true` and `claudeOptIn: false`, so `.claude/agents` write agents stay
blocked). The built-in rdk-docs server is exempt because Moss injects it, not
because of its name. A project server named `rdk-docs`, and a project
`rdkDocs.package`, do not replace that builtin until the workspace is trusted;
project config cannot set the package. The user's own config
(`~/.config/moss` and `~/.moss`) does not ask. `MOSS_TRUST_WORKSPACE`,
`MOSS_CONFIG_DIR`, `MOSS_CONFIG_FILE`, `MOSS_CONFIG_PATH`,
`MOSS_RDK_DOCS_PACKAGE`, `XDG_CONFIG_HOME`, `HOME`, `APPDATA`, and
`USERPROFILE` are read from the process environment captured before `.env`
is loaded, and from CLI flags. A project `.env` cannot set them, and cannot
set interpreter or loader variables (`NODE_OPTIONS`, `NODE_PATH`,
`NODE_EXTRA_CA_CERTS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_*`,
`BASH_ENV`, `ENV`, `ZDOTDIR`, `PYTHON*`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`,
`RUBYLIB`, `GIT_*` (`GIT_DIR`, `GIT_CONFIG`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`,
`GIT_OBJECT_DIRECTORY`, and the rest), `npm_config_*`, `PATH`, `SHELL`, `IFS`,
`TMPDIR`, `TMP`, `TEMP`).
Child processes keep the user's own values of those variables and drop ones the
project file added. The built-in rdk-docs `npx` child inherits only the
pre-`.env` environment. It runs in a Moss cache directory under the pre-`.env`
home (`~/.moss/cache/npx`), not `TMPDIR`. It does not pass `--registry`, so a
mirror in the user's `~/.npmrc` or pre-`.env` `npm_config_registry` is used.
`npm_config_userconfig` stays the user's own `~/.npmrc`, and
`npm_config_globalconfig` is not changed, so a project `.npmrc` `registry=` is
not used. Every git child passes `-c core.fsmonitor=` and
`-c core.hooksPath=/dev/null` (`NUL` on Windows). Read-only git also clears
`core.sshCommand`, `diff.external`, and `credential.helper`, forces
`core.pager=cat` with `GIT_PAGER=cat`, passes `--no-ext-diff` and
`--no-textconv` on `diff`, and blanks `local` and `worktree`
`filter.*.clean|smudge|process` and `diff.*.textconv|command` (with
`filter.<name>.required=false`), including keys from `include.path`,
`includeIf`, and `extensions.worktreeConfig`. System and global git config
are still read and are not overridden. Git children take `GIT_*` from the
environment captured before the project `.env`. Startup `git status` and
`/diff` do not run a program named in a copied repo's `.git/config` or
`.gitattributes`. If listing that config fails for any reason other than
no matches (exit 1), the read-only git command is refused. A session JSON
line keeps the per-value redaction when a whole-line pass would still parse
but drop a later tool result. Device bench removes the temporary provider
config directory that holds the API key on finish, process exit, and
SIGINT / SIGTERM / SIGHUP.
Headless `-p` stays untrusted and
prints one line naming what was skipped. Enable it for that process with
`--trust-workspace` or `MOSS_TRUST_WORKSPACE=1`.

### Slash commands follow Claude Code / Codex

The everyday menu shows `/model` `/compact` `/goal` `/plan` `/review` `/doctor` `/diff` `/resume`
`/permissions` `/clear` `/help` (plus `/theme` in the TUI); other commands stay typeable but hidden. `/plan [description]`
enters plan mode. `/goal` is the "work until" entry (`/loop` migrates to it) and, without
`--accept`, proposes acceptance commands from test entry points that exist in the workspace.
`/resume` restores a conversation (`/sessions` migrates to it). `/tasks` (aliases `/ps`,
`/bashes`) lists background shells and sub-agents. `/stop` (alias `/abort`) stops background
processes this session started; Esc interrupts the run. A message typed during a run steers it
and falls back to the queue above the composer; `/steer` and `/queue` are hidden aliases for one
version. The hidden `/task` gains `verify`, which takes one verdict without a model turn.

### Real-terminal checks (TUI P7)

`scripts/tui-feel/real-terminals.py` drives tmux (mouse off and on), GNU screen, and
Terminal.app, and skips terminals that are not installed. `npm test` runs it only when
`MOSS_REAL_TERMINALS=1`. Manual checklists for iTerm2, VS Code, Windows Terminal, and IME
candidate windows are in `docs/cli-parity/tui-real-terminals.md`.

### Benchmarks

- `npm run bench:device` scores RDK board tasks in `bench/device-tasks/` (`--dry`, `--target sim`,
  `--target real`). A row passes only when the verdict passes and an independent probe matches
  the evidence; `falseSuccess` is reported separately. See `docs/bench/device-bench.md`.
- `npm run bench:deepswe` runs Moss on DeepSWE v1.1 through Pier with the model held fixed, for
  comparison with `bench/boards/deepswe-v1.1-harness.json`.
- `moss task run` prints an `llm_usage` JSON line when the agent reports tokens.

### RDK knowledge

Board manuals come from the built-in rdk-docs MCP, defaulting to the pinned
`rdk-docs-mcp@0.3.0`. Search stays BM25 with title fusion, `noGoodMatch`, and board filtering.
`search_docs` accepts `alt_queries` and returns compact hits (title, url, anchor, snippet) unless
`verbose` is set. `get_page` returns the matching section unless `full` is set. `search_skills`
and `get_skill` read the skill catalog. `MOSS_RDK_DOCS_PIN_CHECK=1` makes `moss doctor` ask npm
whether a newer `rdk-docs-mcp` is published; the check is off by default and does not run at
startup. Moss connects it in the background when a device target is configured
(`MOSS_DEVICE_HOST` or `.moss/devices.json`) or when `rdkDocs` is true. `rdkDocs.package` and
`MOSS_RDK_DOCS_PACKAGE` accept a trusted npm spec, local directory, or tarball for unpublished
server builds. Opt out with `MOSS_NO_RDK_DOCS=1` or `"rdkDocs": false`. A same-named `mcp.json`
entry replaces the builtin. Connect timeout is 45s and each request 20s for this server only; the
timeout does not delay the interactive shell. A failed connect prints
`[mcp] rdk-docs unreachable (<reason>) — RDK manual lookup is off this session.` and the system
prompt tells the agent the manual could not be checked. There is no cache and no offline copy.
When the server is up, the prompt points only at the registered `mcp__rdk-docs__search` tool and
treats version-specific search/ranking/section features as optional. A short `rdk-docs` skill is
indexed and follows the compact hit and section-read shape. The robotics fallback verifies `<installation>/setup.bash` before sourcing it; probe
scripts, connection steps, and device safety rules stay. See
`docs/superpowers/plans/2026-10-09-rdk-knowledge-via-mcp.md`.

### 工作区信任与 Claude hooks

`.moss/config.json` 里的项目 hooks 会合并全部事件，不再丢掉 `Stop` 等类型。
`UserPromptSubmit` 在输入护栏上拦截（退出码 2 或 `{decision:"block"}`，原因展示给用户）。stdout 只在退出码 0 时作为额外上下文，先脱敏再包进 `<hook-output source="UserPromptSubmit">`。
`PermissionRequest` 在询问用户之前运行，只接受拒绝。Claude 格式的 hooks 只在退出码 2 时阻断，`PreToolUse` 同时接受 `permissionDecision: "deny"`；`*` 与逗号/管道列表按 Claude Code 匹配，`tool_input` 带上 `command` / `file_path`。
读取 `.claude/`（settings 或 agents）和 `.mcp.json` 需要一次性确认。项目 hooks、项目 MCP（stdio 与 HTTP，含 `.moss/mcp.json`）、项目 `statusLine` 命令、带写工具的项目 agent 和插件也需要按路径一次性信任。未信任的 HTTP 服务器不会加载，因此不会展开项目 URL 里的 `${VAR}`。
信任结果传给 agent loader（`trusted` 与 `claudeOptIn` 分开：拒绝 Claude 兼容且没有其他项目内容时仍是 `trusted: true`、`claudeOptIn: false`，`.claude/agents` 里的写代理继续被挡住）。
内置 rdk-docs 因来源是 Moss 自己注入而免询问；同名的项目服务器和项目 `rdkDocs.package` 不能替换它。用户自己的配置（`~/.config/moss` 与 `~/.moss`）不会询问。
`MOSS_TRUST_WORKSPACE`、`MOSS_CONFIG_DIR`、`MOSS_CONFIG_FILE`、`MOSS_CONFIG_PATH`、`MOSS_RDK_DOCS_PACKAGE`、`XDG_CONFIG_HOME`、`HOME`、`APPDATA`、`USERPROFILE` 只认加载 `.env` 之前的进程环境和命令行，项目 `.env` 不能设置。项目 `.env` 也不能设置解释器/加载器变量（`NODE_OPTIONS`、`LD_PRELOAD`、`DYLD_*`、`BASH_ENV`、`PYTHON*`、`PERL5*`、`RUBY*`、`GIT_*`（含 `GIT_DIR`、`GIT_CONFIG`、`GIT_WORK_TREE`、`GIT_COMMON_DIR`、`GIT_OBJECT_DIRECTORY`）、`npm_config_*`、`PATH`、`SHELL`、`IFS`、`TMPDIR`、`TMP`、`TEMP` 等）。子进程保留用户自己设的值，丢掉项目文件加进来的值。内置 rdk-docs 的 `npx` 子进程只继承加载 `.env` 之前的环境，工作目录是加载 `.env` 之前的用户主目录下的 `~/.moss/cache/npx`，不用 `TMPDIR`，也不传 `--registry`，因此用户 `~/.npmrc` 或进程环境里的镜像源仍然有效；`npm_config_userconfig` 保持用户自己的 `~/.npmrc`，不改 `npm_config_globalconfig`，项目 `.npmrc` 的 `registry=` 不会被用到。Moss 启动的每个 git 子进程都带 `-c core.fsmonitor=` 和 `-c core.hooksPath=/dev/null`（Windows 为 `NUL`）。只读 git 另外清空 `core.sshCommand`、`diff.external`、`credential.helper`，把 `core.pager` 与 `GIT_PAGER` 设为 `cat`，对 `diff` 加上 `--no-ext-diff` 和 `--no-textconv`，并清空 local 与 worktree 作用域的 `filter.*.clean|smudge|process` 与 `diff.*.textconv|command`（含 `include.path`、`includeIf`、`extensions.worktreeConfig` 引入的键，同时 `filter.<name>.required=false`）。系统级和 global git 配置仍会读取且不会被覆盖。git 子进程的 `GIT_*` 取自加载项目 `.env` 之前的环境。启动时的 `git status` 和 `/diff` 不会执行拷贝来的仓库 `.git/config` 或 `.gitattributes` 里指定的程序。列出这些配置时，除了没有匹配（退出码 1）以外的失败都会拒绝这次只读 git。会话 JSON 行在整行脱敏仍能解析、但会丢掉后面的 tool result 时，保留按值脱敏的结果。设备基准在结束、进程退出和 SIGINT / SIGTERM / SIGHUP 时删除存放 API key 的临时 provider 配置目录。
无头 `-p` 默认不信任，并打印一行说明跳过了什么；用 `--trust-workspace` 或 `MOSS_TRUST_WORKSPACE=1` 启用。

### 斜杠命令、真实终端与基准

日常菜单与 Claude Code / Codex 对齐，其余命令隐藏但仍可输入。`/plan` 直接进入 plan 模式；
`/goal` 是"做到为止"的入口（`/loop` 迁移到它），没带 `--accept` 时从工作区已有的测试入口给出验收命令候选；
`/resume` 恢复会话；`/tasks`（别名 `/ps`）列后台任务；`/stop` 只停本会话的后台进程，打断用 Esc；
运行中发消息默认 steer，不能 steer 时排队。隐藏的 `/task` 新增 `verify`。
真实终端核对用 `MOSS_REAL_TERMINALS=1` 打开。新增 `npm run bench:device`（板卡任务成功率）与
`npm run bench:deepswe`（同模型 DeepSWE 对比）。RDK 手册由内置 rdk-docs MCP 供给，默认钉在 `rdk-docs-mcp@0.3.0`（设备会话默认连接，
`MOSS_NO_RDK_DOCS=1` 或 `rdkDocs: false` 关闭；连不上只报一行错误，不缓存）。

### Device safety policy

Full mode still runs read-only probes and reversible device changes without asking
(deploys under `/home`, `/opt`, `/tmp`, `/usr/local`, package installs, `systemctl restart`).
Destructive or lockout-risk device operations — reboot and poweroff, flashing and `mkfs`,
writes to `/boot` or `/etc`, firewall and network changes, system package removal,
`systemctl stop` / `disable` / `mask`, ssh and account edits — now require a TTY confirmation.
Headless runs refuse that tier unless the operator opts in.

Opt in with `--trust-device` (this process), `MOSS_DEVICE_TRUST=full`,
`permissions.deviceTrust=full`, `permissions.trustedDevices` or `MOSS_DEVICE_TRUST_DEVICES`
for one board, or an allow rule that matches the call. Deny rules still win.
Answering `a` trusts only the scope named in the prompt (power commands, `systemctl restart` or
`stop` of that unit, or the same command prefix) for the rest of the session.
Secret reads (`/etc/shadow`, private keys, `sshd_config`, `authorized_keys`) are a `sensitive`
tier: they still confirm, and evidence records `sensitive:` rather than `destructive:`.
Grants are bound to the tool call id. Flash-like script names escalate to destructive.
`systemctl daemon-reload` and stop/disable/mask of non-critical units are reversible; ssh,
networking, and dbus stay destructive. zh-CN locales get Chinese approval copy.

Each decision is appended to `.moss/evidence.jsonl` (`metric: device_policy`) and, when a
task is in progress, to its timeline as a `note`. Host `exec` hard blocks are unchanged.
See `docs/superpowers/plans/2026-10-09-device-safety-policy.md`.

### 设备安全策略

full 模式仍自动执行只读探测和可逆设备变更。重启、刷机、系统路径写入、网络变更、卸载系统包、
停用 ssh 等毁灭性操作改为 TTY 确认；无终端时拒绝，除非显式信任（`--trust-device`、
`MOSS_DEVICE_TRUST=full`、`permissions.deviceTrust`、按设备名单或 allow 规则）。
选 `a` 只信任提示里的范围。读密钥是 `sensitive` 档。grant 绑定 tool call id。
刷机/OTA 脚本名升为毁灭性。非关键 unit 的 systemctl stop 可逆。中文 locale 使用中文确认文案。
每次决定写入任务证据与时间线。本机 `exec` 硬拦截不变。
