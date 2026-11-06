# Changelog

## Unreleased

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
