# R3 — moss baseline: reusable machinery, integration points, and gaps

Scope: what the moss implementation line already has for an interactive CLI, so the parity work
**reuses** it instead of rebuilding it. Written by reading current source, not git history.

Evidence policy: every claim carries a `file:line` reference. Anything I could not confirm from
source is marked **unconfirmed** (§14) and is never asserted.

> **Snapshot warning (important).** The v0.22 shell was being **rewritten while this audit ran**:
> `src/cli/tui/composer.ts` appeared at 01:30:32 and changed again at 01:36:01, `app.ts` and
> `transcript.ts` changed at 01:32:45/01:29:29, and `dist/cli/tui/` was rebuilt at 01:32:50 (all
> 2026-10-01). This document was rebased onto the last revision I could verify. Line numbers for
> `src/cli/tui/**` and `src/cli/terminal-text.ts` are pinned to the SHA-256 values below — **if those
> hashes changed, re-verify the citations before acting on them.** `src/cli-main.ts`,
> `src/cli/approval*.ts`, `src/cli/repl.ts`, `src/cli/commands/**` and `src/core/**` were unchanged
> during the audit.
>
> | file                           | sha256 (first 16)  |
> | ------------------------------ | ------------------ |
> | `src/cli/tui/app.ts`           | `6053426cadb3222a` |
> | `src/cli/tui/composer.ts`      | `527d847f872e8193` |
> | `src/cli/tui/transcript.ts`    | `c1a2e49b391ed99d` |
> | `src/cli/tui/render-bridge.ts` | `b26bbaec6a1e35be` |
> | `src/cli/tui/help.ts`          | `32e391fa728dd3ef` |
> | `src/cli/tui/text.ts`          | `09054fc2bcd3252b` |
> | `src/cli/tui/input-box.ts`     | `d030e798c886e033` |
> | `src/cli/terminal-text.ts`     | `e8d89c1bf374ec08` |

Tooling facts: `package.json` version `0.21.0`, ink `7.1.1` installed, `dist/` is built from `src/`
(`dist/cli/tui/composer.js` exists as of 01:32:50).

Package/entry facts: single ESM package, bin `dist/cli.js`, `src/cli-main.ts` is `main()`
(`package.json` `bin`; `src/cli-main.ts:243`). The v0.22 shell lives in `src/cli/tui/` and is the
only directory allowed to import ink/react statically (`src/cli/tui/app.ts:11-13`, dynamic import at
`src/cli-main.ts:979`). Prior art for the v0.22 rewrite decision: `docs/tui-ux-audit-2026-10-01.md`
(Mission Control rejected in favour of the Claude-Code form, `docs/tui-ux-audit-2026-10-01.md:11`).

---

## 1. Agent event stream

### 1.1 What exists

`MossAgentEvent` is a 13-member discriminated union (`src/core/agent/moss-agent-types.ts:256-327`):

| kind             | payload (exact fields)                                                                                                                                                                      | line       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `text_delta`     | `delta`                                                                                                                                                                                     | `:257`     |
| `thinking_delta` | `delta`                                                                                                                                                                                     | `:258`     |
| `tool_start`     | `toolName`, `toolCallId`, `input`                                                                                                                                                           | `:259`     |
| `tool_end`       | `toolName`, `toolCallId`, `result`, `isError`, `outcome?`, `durationMs?`, `aborted?{by:'user'\|'timeout'}`, `structuredContent?`, `error?{code,message,hint?,recoverable?,cause?,context?}` | `:260-271` |
| `turn_start`     | `turn`                                                                                                                                                                                      | `:272`     |
| `turn_end`       | `turn`, `stopReason`, `totalToolCalls?`                                                                                                                                                     | `:273`     |
| `retry`          | `attempt`, `error`                                                                                                                                                                          | `:274`     |
| `error`          | `error`, `retriable`, `errorDetails?` (MossErrorOutcome), `errorSurface?`                                                                                                                   | `:275-282` |
| `compaction`     | `summaryChars`, `droppedMessages`, `checkpointOutline?`, `tokensBefore?`, `tokensAfter?`, `keptToolNames?`                                                                                  | `:283-294` |
| `microcompact`   | `compressedCount`, `savedChars`, `savedTokens`                                                                                                                                              | `:295`     |
| `llm_usage`      | `inputTokens`, `outputTokens`, `cacheReadTokens?`, `cacheCreationTokens?`, `contextTokens?`, `ttftMs?`, `generationMs?`, `turnGapMs?`, `model?`                                             | `:296-308` |
| `cache_metrics`  | prompt-cache stability metrics + cache token counts                                                                                                                                         | `:309-326` |
| `done`           | `result: ChatResult` (`response`, `toolCalls`, `toolResults`, `usage?`, `thinking?`, `compactions?`, `stopReason?`; `:238-254`)                                                             | `:327`     |

`llm_usage.contextTokens` is populated from `this.config.contextTokens` on every call
(`src/core/agent/moss-agent.ts:826`), which is what makes a provider-reported context snapshot
possible (§6). `tool_end.outcome` is `'ok'|'error'|'denied'|'blocked'|'replayed'|'suppressed'`
(`src/contracts/messages.ts:7`).

### 1.2 Producer/consumer map (facts the parity work must respect)

- **Shell (v0.22 TUI)** consumes 6 of 13 kinds: `text_delta`, `thinking_delta`, `tool_start`,
  `tool_end`, `error`, `llm_usage` (`src/cli/tui/render-bridge.ts:102-143`, `default: break` at
  `:140-142`). It **ignores** `turn_start`, `turn_end`, `retry`, `compaction`, `microcompact`,
  `cache_metrics`, `done`. From `tool_end` it uses only `result` + `isError`
  (`src/cli/tui/render-bridge.ts:120-127`); `durationMs`, `outcome`, `aborted`, `error`,
  `structuredContent` are dropped. Elapsed time in the shell is measured by the shell itself
  (`runStartedAtRef`, `src/cli/tui/app.ts:314`, used at `:350`).
- **REPL/headless renderer** consumes all 13: `createCliRunRenderer` →
  `turn_start` `src/cli/output.ts:493`, `thinking_delta` `:510`, `text_delta` `:525`,
  `tool_start` `:550`, `tool_end` `:590`, `compaction` `:824`, `microcompact` `:833`,
  `turn_end` `:841`, `retry` `:850`, `error` `:864`, `done` `:871`, `llm_usage`/`cache_metrics`
  `:904-905`. It also measures per-tool duration locally (`toolStartTimes`,
  `src/cli/output.ts:290`, `:607`), prints exit codes (`:707-712`), command failure previews
  (`:640-660`) and verification summaries (`:624-635`).
- **Task runtime** consumes `tool_start`/`tool_end`/`error` only
  (`src/core/task-runtime/runtime.ts:330-373`).
- `done` handling in the shell is a fallback: if the streamed text is empty it prints
  `result.response` (`src/cli/tui/app.ts:324-333`).

**Reuse consequence**: for any richer event rendering (spinner verbs, compaction notices, retry
notices, duration/outcome badges), copy semantics from `src/cli/output.ts` rather than inventing a
second interpretation. `render-bridge.ts` is deliberately ink-free so specs can drive it
(`src/cli/tui/render-bridge.ts:1-5`).

---

## 2. Tool metadata, side-effect classes, and the approval decision

### 2.1 Declaration surface

`ToolSideEffectClass` has 8 members (`src/core/tools/tool-types.ts:115-123`): `readonly`,
`local_write`, `device_mutation`, `credential`, `external_message`, `memory_write`,
`runtime_state`, `subagent`. `ToolMetadata` carries `permissionBoundary?`, `sideEffectClass?`,
`planMode?('allow'|'audit'|'requires_user_confirmation')`, `requiresApproval?`,
`ui?.surface`, `timeoutMs?`, `transientRetry?` (`src/core/tools/tool-types.ts:125-140`).

Where the classes actually are declared (representative):

- file tools: `read_file` `readonly` `src/tools/file-tools.ts:157`; `write_file` `:231`;
  `edit_file` `:419`; `multi_edit` `:510`; `move_file` `:632`; `list_directory`/outline `:771`.
- exec: `exec` = `local_write` + `planMode:'requires_user_confirmation'`
  (`src/tools/builtin.ts:62-68`); `exec_background` `local_write`
  (`src/tools/background-exec.ts:32`), `exec_logs`/`exec_stop` `readonly` (`:230`, `:299`).
- device: `device_info`/`processes`/`resources`/`temperature`/`network`/`cameras`/`robotics_status`/
  `file_read`/`file_list` = `readonly` + `transientRetry` (`src/tools/device-tools.ts:84, 183, 218,
321, 346, 371, 493, 518, 543`); `device_exec`/`device_file_write`/`device_deploy` =
  `device_mutation` (`:111, 251, 399`).
- task OS bookkeeping: `task_define`/`task_plan_update`/`task_acceptance` = `runtime_state`,
  `planMode:'allow'` (`src/tools/task-tools.ts:73`, `:204+`); `todo_write` = `runtime_state`,
  `planMode:'allow'` (`src/tools/todo-tool.ts:51-54`); `ask_user_question` `runtime_state`
  (`src/tools/ask-user-question.ts:76`); `record_evidence` `runtime_state`
  (`src/tools/evidence-tools.ts:70`).
- subagents: `create_subagent`/`fan_out_subagents`/`subagent_stop` = `subagent`
  (`src/tools/create-subagent.ts:130, 515, 817`); `subagent_status` `readonly` (`:744`).
- `skill` tool: `readonly` + `planMode:'allow'` + `requiresApproval:false`
  (`src/tools/skill-tool.ts:16`).
- Full registry = `builtinTools` (`src/tools/builtin.ts:223-250`), registered by
  `registerBuiltinTools` (`src/tools/builtin.ts:252-256`, called `src/cli-main.ts:622`).
- File-based custom tools take their class from JSON `def.sideEffect ?? 'runtime_state'`
  (`src/tools/file-based-tools.ts:100`).

**Default is fail-closed**: a tool with no explicit `metadata.sideEffectClass` is treated as
`local_write`, not `readonly` (`src/cli/approval.ts:111-117`).

### 2.2 Where the decision is made

`createCliToolApprovalHook` (`src/cli/approval.ts:810-989`) returns an
`AgentHooks['onBeforeToolExec']` (`src/core/agent/agent-hooks.ts:4-13`, `:44`). Decision order
(verbatim from source):

1. dangerous-command hard block (`isCommandDangerous`) → deny (`:739-742`, `:848-850`);
2. `deniedTools` globs → deny (`:851-856`);
3. interaction mode `plan`: `device_mutation` always denied, `readonly` always allowed, else needs
   `metadata.planMode === 'allow'` (`:309-313`, `:862-877`);
4. safety-mode gate `isAllowedInMode` (`:315-334`, `:878-885`);
5. `requiresApproval` (`:346-360`) — `exec` with a detected readonly command is auto-allowed
   (`:259-286`, `:288-298`, `:350`), `runtime_state` never prompts (`:356`);
6. trusted/board/auto-approve/full-power/acceptEdits short-circuits (`:888-910`);
7. otherwise the asker is called (`:912-973`); non-TTY with no asker → deny with an explicit reason
   (`:913-926`);
8. `a`/`always` adds session trust — workspace-level for file mutations, tool-level for
   `memory_write`/`runtime_state`/`subagent` (`:961-969`, `:414-418`).

The live asker is a module-level port: `setCliApprovalAsker` (`src/cli/approval.ts:82-85`), installed
by the TUI at mount and cleared on unmount (`src/cli/tui/app.ts:252-270`) and by the REPL
(`src/cli/repl.ts:180-193`).

### 2.3 Exact data available at approval time

`CliToolApprovalPreview` (`src/cli/approval.ts:60-80`) — **structured, but only inside the hook**:
`toolName`, `sideEffect` (`ToolSideEffectClass`), `safetyMode` (`'read-only'|'workspace-write'|
'full-access'`, `:26`), `inputPreview` (secret-sanitized JSON, 1200-char cap, `:420-423`),
`decisionContext` (human reason string, `:753-769`), `requiresApproval`, `trusted`,
`trustedPattern?`, `denied`, `deniedPattern?`, `autoApproved`, `boardAutoApproved`,
`workspaceFileMutation` (`write_file|edit_file|apply_patch|move_file` with `local_write`,
`:366-375`), `acceptEditsEligible`, `hardBlockReason?`.

Built by `describeCliToolApproval(request, mode, env, options)`
(`src/cli/approval.ts:718-788`); the raw request is `{tool, input, sessionKey, runId, toolCallId,
abortSignal}` (`src/core/agent/agent-hooks.ts:4-11`).

**The prompt is flattened to a string before it reaches any UI.** The asker signature is
`(question: string, abortSignal?: AbortSignal) => Promise<string>` (`src/cli/approval.ts:28`), and
the prompt text is assembled by `renderCliApprovalPrompt` (`src/cli/approval.ts:653-691`):
`Background:` line, `Moss wants to <verb>` + target, `Details:` block, optional Task-context block
(`buildTaskApprovalBlock`, `:597-651`), `Scope:` line, and the y/a/n prompt. The shell then
re-parses that string with `describeApproval` to recover title/subject/preview
(`src/cli/tui/app.ts:135-168`, called at `:260`).

Answer vocabulary accepted by the hook: `y`/`yes`, `a`/`always`, anything else = deny
(`src/cli/approval.ts:961-973`). The shell maps keys 1/2/3 and y/a/n and Esc onto those
(`src/cli/tui/transcript.ts:249-253`, `src/cli/tui/app.ts:644-660`, `:681-708`).

**Integration point for a structured approval UI**: extend the asker port
(`setCliApprovalAsker`, `src/cli/approval.ts:82`) or add a second, preview-carrying port next to it;
`describeCliToolApproval` already computes everything a rich dialog needs. Letting the UI call it
directly is possible because it is exported and pure except for env/options.

---

## 3. Diff / edit preview — yes, a real diff exists today

`diffLinesForApproval(oldText, newText): string[] | null` computes a real LCS unified-diff-style
output (`src/cli/approval-detail.ts:54-95`): `- ` deletions, `+ ` additions, collapsed context runs
(`  … (N unchanged lines)`), `null` when either side exceeds 400 lines
(`src/cli/approval-detail.ts:11`, `:57`). It is already used in two production paths:

- **Approval prompt**: `buildApprovalDetailLines` (`src/cli/approval-detail.ts:222-245`) dispatches
  per tool — `edit_file` → old/new diff (`:97-105`), `write_file` → real file-on-disk diff when the
  file exists inside `ctx.workspaceDir`, else `new file:` + all `+` lines, else a summary for >400-line
  files (`:114-167`), `apply_patch` → patch body (`:169-174`), `device_mutation` → target/command/
  timeout (`:180-200`). Every line is secret-sanitized (`cleanLine`, `:14-22`) and the block is capped
  at 18 lines (`MAX_DETAIL_LINES`, `:10`, `capLines` `:28-35`). The workspace context is supplied from
  the approval hook (`src/cli/approval.ts:949-957`), which gets `workspaceDir` from `cli-main`
  (`src/cli-main.ts:537`).
- **REPL tool rendering**: `tool_end` prints a colored diff for `edit_file`
  (`src/cli/output.ts:712-731`), `+` lines for `write_file` (`:732-742`), tone-marked patch lines for
  `apply_patch` (`:743-760`), per-edit diffs for `multi_edit` (`:761-775`).

**Answer to the task question**: yes — an approval dialog can show a real diff _today_, but only as
pre-rendered plain-text lines inside the question string (≤18 lines, ≤200 chars/line,
`src/cli/approval-detail.ts:10-12`). The shell already surfaces those lines as `preview`
(`src/cli/tui/app.ts:154-167`, rendered at
`src/cli/tui/transcript.ts:259-265`). What is missing is (a) colored diff rows in the transcript
(`render-bridge` drops the diff entirely: `src/cli/tui/render-bridge.ts:120-127`) and (b) a
structured diff payload rather than string scraping.

`FileCheckpointStore` is the other half of edit safety (see §9/§11):
`checkpointTargetPaths(toolName, input, workspaceDir, parsePatchPaths)`
(`src/cli/file-checkpoint.ts:168-192`) resolves the paths `write_file`/`move_file`/`apply_patch`
touch; the REPL and `cli-main` both register pre/post hooks that call
`trackBeforeWrite`/`noteAfterWrite` (`src/cli/repl.ts:145-164`, `src/cli-main.ts:993-1010`).

---

## 4. Slash-command surface: REPL vs the v0.22 shell

There are **two completely separate dispatchers**. The shell does not import the command registry
(verified: `grep runRegistryCommand src/cli/tui/**` → only `src/cli-main.ts:806`, `:911` for
oneshot/piped). The shell routes commands in one `if`-chain inside `submit`
(`src/cli/tui/app.ts:479-642`) and the advertised list is `HELP_COMMANDS`
(`src/cli/tui/help.ts:50-67`, 16 entries; honesty enforced by `test/tui-command-surface.spec.mjs`).

### 4.1 Shell-only (v0.22 TUI)

`/tasks` (`app.ts:505`), `/history` (`:509`), `/evidence` (`:513`), `/deployments` (`:517`),
`/failures` (`:521`), `/sessions` + `/mcp` + `/subs` + `/bg` (`:525-528`), `/resume [id]`
(`:529-538`), `/rewind`/`/undo` (`:539-562`), `/queue pause|resume|drop|clear` (`:563-590`),
`/steer <constraint>` (`:591-604`), plus `/quit`/`/exit` (`:488`) and `/help`/`?` (`:492`).
`/usage` exists in both (`:501`). Ctrl-chords: tasks/history/evidence/deployments/failures/clear
(`src/cli/tui/help.ts:11-18`, dispatched `src/cli/tui/app.ts:784-812`).

### 4.2 REPL-only

`CommandSpec` registry (`src/cli/commands/registry.ts:439-449`): `/quickstart` (`:65`), `/status`
(`:74`), `/doctor` (`:85`), `/permissions` (`:93`), `/mode` + alias `/plan` (`:101`), `/context`
(`:159`), `/review` (`:252`), `/usage` (`:350`), `/export` (`:410`). Hand-written in `repl.ts`:
`/rewind`|`/undo` (`src/cli/repl.ts:314-389` — also shell), `/compact [instructions]` (`:391`),
`/sessions`|`/session` (`:405`), `/diff` (`:416`), `/model [config|name]` (`:445-489`),
`/loop` (`:648`), `/goal` (`:577`), `/task` (`:538`), `/help` (`:302`),
`/stop`|`/abort`|`/clear`|`/init` return "not available here" (`:114-123`, `:439-443`).
Plus file-based custom commands `.moss/commands/*.md` (`src/cli/commands/custom-commands.ts:111-151`,
loaded `src/cli/repl.ts:166-173`).

So: **`/model`, `/mode`, `/compact`, `/status`, `/diff`, `/context`, `/export`, `/doctor`,
`/permissions`, `/review`, `/goal`, `/loop`, `/task`, `/quickstart` and every custom command are
unreachable from the v0.22 shell** — typing them hits
`unknown command "…" — try /help` (`src/cli/tui/app.ts:605-608`).

### 4.3 Both

`/help`, `/quit`, `/usage`, `/sessions`, `/rewind` (+`/undo`).

### 4.4 Discovery surfaces that already exist

- Sections + descriptions: `INTERACTIVE_COMMAND_SECTIONS` (`src/cli/interactive-commands.ts:14-136`).
- Flat menu (hidden commands ranked last, never removed): `SLASH_MENU_ROWS` (`:138-161`), 21 rows.
- Completion list incl. aliases: `INTERACTIVE_COMPLETION_COMMANDS` (`:167-172`), 25 entries.
- **Fuzzy subsequence ranking** `/cmp`→`/compact`, `/rsm`→`/resume`: `commandRowsForSlashInput`
  (`src/cli/interactive-commands.ts:182-234`).
- Did-you-mean: `commandSuggestion` + `editDistance` (`src/cli/command-completion.ts:5-49`),
  rendered by `unknownSlashCommandLines` (`src/cli/commands/registry.ts:490-508`).
- readline prefix completion in the REPL: `completeInteractiveCommand` (`src/cli/repl.ts:109-112`),
  wired at `:178`.

De-surfaced-but-still-dispatching commands are documented inline at
`src/cli/interactive-commands.ts:115-119` (`/config`→`/permissions`, `/tools`, `/models`, `/yolo`)
and `:127-130` (`/thinking`, `/detail`, `/version`, `/upgrade`); `/subagents`, `/attach`, `/history`,
`/resume`, `/clear` are deliberately absent from the REPL list (`:19-21`, `:66-67`, `:87-88`,
`:125-126`). Note `/config`, `/skills`, `/tools`, `/models`, `/yolo` have **no handler at all** in
either surface today (only `/skills` is name-reserved, `src/cli/commands/custom-commands.ts:17`) — the
back-compat claim in those comments is **unconfirmed** for `/config`, `/tools`, `/models`, `/yolo`.

---

## 5. Input handling (composer)

The composer is a **real multi-line editor** as of the revision in the snapshot header. Model:
`ComposerState { value, caret }` (`src/cli/tui/composer.ts:13-17`), a pure module with no ink imports
(`composer.ts:1-11`), driven from the single `useInput` handler
(`src/cli/tui/app.ts:671-832`) and projected by `renderComposerEditor`
(`src/cli/tui/composer.ts:275-338`), rendered with a real inverted caret cell
(`src/cli/tui/app.ts:878-885`, `:913-923`). A plain-text projection of the _same_ engine exists for
specs/previews: `renderComposer` (`src/cli/tui/transcript.ts:289-300`).

Supported:

- Insert **at the caret** (`composerInsert`, `composer.ts:63-68`; dispatch `app.ts:831`) and
  code-point-safe stepping so emoji are never split (`composer.ts:45-58`, word classes `:60-61`).
- Newlines: Shift/Alt+Enter (`app.ts:712-717`), trailing `\` + Enter (`app.ts:718-721`),
  Ctrl+J / bare LF (`app.ts:725-729`), `composerNewline` (`composer.ts:70-72`).
- Caret motion: ←/→ and Ctrl/Alt+←/→ word motion (`composerMove`, `composer.ts:192-231`;
  dispatch `app.ts:730-735`), Ctrl+A line start (`app.ts:788-791`).
- Deletion: Backspace/Delete backward/forward (`app.ts:780-783`), Ctrl+W word-backward,
  Ctrl+U to line start, Ctrl+K to line end (`app.ts:792-803`) — all in `composerDelete`
  (`composer.ts:81-106`), logical-line bounds at `composer.ts:74-79`.
- Visual-row ↑/↓ through the soft wrap once the draft is multi-line
  (`composerMove` 'up'/'down' `composer.ts:219-227`; dispatch `app.ts:753-761`); on a single-line
  draft ↑/↓ walks the last 100 submissions (`app.ts:218`, `:485`, `:762-777`).
- Esc discards a staged paste, else aborts the run (`app.ts:736-745`).
- Bracketed paste: `feedChunk` captures `ESC[200~ … ESC[201~` into ONE pending message
  (`src/cli/tui/input-box.ts:7-54`), staged with a visible `[paste: N lines …]` chip
  (`app.ts:834-852`, submitted at `:610-618`).
- Soft wrap + a 6-row window that keeps the caret row visible, with `…` head elision
  (`wrapSpans` `composer.ts:120-143`, `composerRows` `:146-156`, `caretAt` `:159-177`,
  `COMPOSER_MAX_ROWS = 6` `:236`, windowing `:295-304`); widths are terminal cells via `displayWidth`
  (`composer.ts:11`, `composer.ts:348-369`).
- An explicit guard must **not** filter on `key.shift` because ink reports shift=true for every
  uppercase letter (`app.ts:813-817`) and an escape-sequence filter (`:818-819`).
- Bulk edits (history recall, staged `/resume` prompt, paste) go through the `setInput` shim, which
  parks the caret at the end (`app.ts:207-214`).
- Placeholder text `PLACEHOLDER_TEXT` (`src/cli/tui/transcript.ts:302`, used `app.ts:881`).

Still missing (verified against the current tree):

- slash autocomplete/menu while typing — no call to `commandRowsForSlashInput` anywhere in
  `src/cli/tui/` (grep); typing `/` + text shows no candidates (`app.ts:605-608` is the
  unknown-command path);
- reverse history search — `Ctrl+R` is bound to the _task-runtime_ history block
  (`src/cli/tui/help.ts:13` → `app.ts:804-811` → `showBlock('history')` `app.ts:446-458`), not
  input-history search;
- Tab completion — Tab is explicitly ignored (`app.ts:818`);
- `Shift+Tab` mode cycling is advertised (`src/cli/commands/registry.ts:118`,
  `src/cli/approval.ts:868`) but implemented **nowhere** (grep: only those two strings);
- `Ctrl+H` is documented as unreachable (`src/cli/tui/help.ts:5-9`);
- mouse/selection/clipboard integration and undo/redo — no handlers (grep over `src/cli/tui/`);
- the paste path is hand-rolled although ink 7.1.1 ships `usePaste` (verified via `import('ink')`);
  likewise `useWindowSize` is available while `stdout.columns` is read directly
  (`app.ts:203`, `:950-954`).

---

## 6. Context / token accounting

- Estimation: `estimateTokensForText` (CJK-aware, `src/context/tokens.ts:20-32`),
  `estimateMessageTokens` in the same module.
- Provider report: `llm_usage.contextTokens` + `inputTokens`/`cacheReadTokens`/`cacheCreationTokens`
  (`src/core/agent/moss-agent-types.ts:296-308`), where `contextTokens` = the configured window
  (`src/core/agent/moss-agent.ts:826`).
- Prompt-token total: `totalPromptTokens` = input + cache read + cache creation
  (`src/core/llm/usage.ts:10-12`).
- **Status-line-ready snapshot**: `ContextUsageSnapshot {used, total, source, inputTokens?,
cacheReadTokens?, cacheCreationTokens?}` and `contextUsageFromAgentEvent`
  (`src/cli/usage-display.ts:4-25`) — returns `null` unless `event.contextTokens > 0`, so a status
  line must fall back to an estimate (`source:'estimated'`).
- **Session accumulator already exists**: `createSessionUsageAccumulator()` records usage,
  compactions, TTFT/turn-gap/tokens-per-second and the latest context snapshot
  (`src/cli/session-usage.ts:46-117`); consumed by the REPL (`src/cli/repl.ts:131`, `:271-273`).
- **Percent math already written**: `pct = Math.min(100, Math.round((usage.used / usage.total) * 100))`
  and the `~` estimated prefix (`src/cli/commands/registry.ts:176-177`); `/context` prints
  messages/usage/pct and the last 5 compactions with before→after ratios (`:187-215`).
- Window resolution: `resolveContextTokensForModel` (provider API probe → conservative unprobed
  default, `src/cli/model-catalog.ts:470-494`); guard constants in
  `src/context/context-window-guard.ts:1-2`.
- Compaction events carry `tokensBefore`/`tokensAfter`/`droppedMessages`/`keptToolNames`
  (`src/core/agent/moss-agent-types.ts:283-294`, emitted `src/core/loop/agent-loop-compaction.ts:170-178`)
  and `microcompact.savedTokens` (`:295`).

**What the shell shows today**: model + `sessionTokens` only — no percentage, no remaining, no
window (`StatusView` `src/cli/tui/transcript.ts:304-311`, `renderStatusRight` `:313-323`, fed by
`store.usage.tokensIn + tokensOut` at `src/cli/tui/app.ts:874`). `/usage` in the shell prints only
`formatUsage` (run/session tokens, `src/cli/tui/render-bridge.ts:152-157`, dispatched
`src/cli/tui/app.ts:501-504`). Compaction and microcompact events are ignored by the shell
(`src/cli/tui/render-bridge.ts:140-142`) → **no compaction notice exists in the shell**.

---

## 7. Session persistence and resume

- Store interface: `SessionStore` + `SessionMeta {sessionKey, createdAt, updatedAt, title?,
messageCount}` (`src/core/session/session.ts:3-22`); disk implementation `JsonlSessionStore`
  (`src/core/session/jsonl-session-store.ts:226`), one file per session at
  `<encodeURIComponent(key)>.jsonl` (`:256-258`) inside `<workspace>/.moss/sessions`
  (`src/utils/workspace-paths.ts:36`), with a write lock and optimistic content-version checks
  (`:229-232`, `:264-266`). Messages also support `thinking[]` and structured content blocks
  (`src/core/session/session-jsonl.ts`, used by `toSessionMessages`
  `src/core/agent/moss-agent-types.ts:353-360`).
- Data a **resume picker** can show today: everything in `SessionMeta` (key, title, messageCount,
  createdAt/updatedAt) plus full-text search over stored messages via `searchSessions`
  (`src/cli/command-dispatcher.ts:136-173`) and markdown export via `renderSessionMarkdown`
  (`:46-92`). CLI: `moss sessions list|delete|search|export` (`:394-549`); `resume`/`fork` fall
  through to AgentReady (`:552-554`) with flags `--continue` (`src/cli/args.ts:518`), `--last`
  (`:514`), `--session` (`:508`), `--fork-from` (`:522`).
- Shell `/sessions` prints the 15 most recent sessions (`src/cli-main.ts:1018-1030`,
  sorted by `updatedAt`) and renders `* key — title (N messages)` (`src/cli/tui/app.ts:372-383`) —
  `updatedAt` is fetched but **not displayed**, and there is no interactive picker.
- **Resume replay machinery is complete but unwired**: `buildResumeReplay` +
  `RESUME_REPLAY_MAX = 24` + `resumedMessageText`/`resumedToolLines`
  (`src/cli/resume-replay.ts:53-86`) produce transcript rows `{kind:'user'|'assistant'|'system'}`.
  `TuiAppOptions.replayRows` exists and is consumed at boot
  (`src/cli/tui/app.ts:89-90`, `:302-305`) — but the production host never passes it: grep shows
  `replayRows` only in `src/cli/tui/app.ts` and `test/tui-app.spec.mjs:299-303`. So a resumed
  TUI session shows the banner and an empty transcript while the model still has the history.
- Conversation-level rewind: `MossAgent.rewindConversation(sessionKey, toMessageCount)`
  (`src/core/agent/moss-agent.ts:696-708`) and `RewindResult.messageCount`
  (`src/cli/file-checkpoint.ts:36-46`) exist, but **no production caller** (grep: only
  `test/rewind-conversation.spec.mjs`).
- `/rewind` in the shell: `listCheckpoints` is never wired by the host
  (`src/cli-main.ts:1013-1046` passes only `rewindTo`), so bare `/rewind` always prints an empty list
  (`src/cli/tui/app.ts:539-562`).

---

## 8. Startup surfaces: AGENTS.md, skills, MCP, custom commands, soul

Startup wiring is all in `src/cli-main.ts`:

- **Environment prompt layer**: `buildEnvironmentContextLayer(workspace)` — cwd/platform/date,
  top-level entries, git branch/status/recent commits (`src/context/environment.ts:43-91`), pushed
  at `src/cli-main.ts:514-516`.
- **Runtime capability layer** with the registered tool list
  (`buildRuntimeCapabilitiesPrompt`, pushed `src/cli-main.ts:747-751`) and an explicit
  "your context window is Nk tokens" layer (`:752-761`).
- **soul/persona**: `.moss/soul.md` → `<configDir>/soul.md` → default identity
  (`resolveSoulIdentity`, `src/core/agent/soul.ts:70+`, called `src/cli-main.ts:590-596`).
- **MCP** (v0.16): `.moss/mcp.json` + `<configDir>/mcp.json`
  (`loadMcpConfigs`, `src/cli/mcp-config.ts:120-134`); connect via
  `McpToolRegistry.connectAll` (`src/cli-main.ts:623-661`), lazy, one `mcp__<server>__search`
  meta-tool per connected server (`src/core/mcp/registry.ts:146-157`), index layer into the prompt
  (`buildMcpPromptLayer`, `:315-326`). Statuses are `{name,state,toolCount?,error?}`
  (`src/core/mcp/registry.ts:33-38`).
- **Skills** (v0.16): `loadSkills(['<ws>/.moss/skills', '<configDir>/skills'])`, body via the
  `readonly` `skill` tool, index layer into the prompt (`src/cli-main.ts:663-675`).
- **Custom tools**: `.moss/tools/*.tool.json` (`src/cli-main.ts:659-661`).
- **Custom commands**: `.moss/commands/*.md` + `<configDir>/commands` — **REPL only**
  (`src/cli/commands/custom-commands.ts:111-151`, `src/cli/repl.ts:166-173`).
- **Hooks**: config hooks, lifecycle (SessionStart/Stop/SubagentStop/Notification) and the approval
  composition (`src/cli-main.ts:519-560`, `:763`).
- **Device target** from env for the banner (`resolveDefaultDeviceTarget`, `src/cli-main.ts:529`,
  used `src/cli/tui/app.ts:276`).

**What is exposed to the UI today**: only MCP statuses, through `TuiMcpServerStatus[]`
(`src/cli/tui/app.ts:76-81`) wired at `src/cli-main.ts:1031-1038` and printed by `/mcp`
(`src/cli/tui/app.ts:384-393`) — one line per server with a lazy tool count. Skills, custom
commands, custom tools, hooks and the environment layer have **no UI surface** in the shell; the
REPL exposes counts only inside `/status` (`skillCount`, `memoryCount`,
`src/cli/onboarding.ts:276-286`).

**AGENTS.md**: documented as auto-loaded (`src/cli/help.ts:186`,
`src/cli/onboarding.ts:266`) but **no loader exists in the tree** —
`grep -rni "agents\.md|claude\.md" src/` returns only prose strings and `/init` help text
(`src/context/default-workflow.ts:5`, `src/contracts/prompts/*.ts`,
`src/cli/interactive-commands.ts:131`). There is no code path that reads an `AGENTS.md` from the
workspace into `extraPromptLayers` (the only producers are `src/cli-main.ts:514-516`, `:653`,
`:674`, `:747`, `:759`). Treat "AGENTS.md is auto-loaded" as **documentation that is not backed by
code** until proven otherwise (`AGENTS_MD_TEMPLATE` exists, `src/cli/tui-utils.ts:33-48`, and
`OnboardingState.hasAgentsMdInWorkspace` exists, `src/cli/onboarding.ts:521` — neither implies
loading). Status: **unconfirmed / likely gap**.

---

## 9. Todo / plan state available for a live checklist

Two independent sources already exist:

1. **`todo_write`** tool — stateless full-list replace, `TodoStatus = 'pending'|'in_progress'|
'completed'`, glyphs `○ ◐ ✓` (`src/tools/todo-tool.ts:19-42`), formatted by `formatTodos`
   (`:30-40`). The REPL renderer already compresses it to `done/total · <focus>` for the headline
   (`src/cli/output.ts:242-260`). The shell only shows the generic tool line + 3-line result preview
   (`src/cli/tui/render-bridge.ts:112-127`) — **no checklist rendering**.
2. **Unified Task Runtime plan** — `TaskPlanStep {stepId, title, status:
'pending'|'in_progress'|'done'|'failed'|'skipped', detail?}`
   (`src/contracts/task-runtime.ts:76-81`), part of `TaskStateSnapshot.plan` (`:136`), written by
   `task_plan_update` (`src/tools/task-tools.ts:204-270`, statuses validated at `:252`), driven by
   `task_define` → `task_plan_update` (`src/core/task/task-engine.ts:73`), persisted as events and
   reconstructed by `planFromEvents` (`src/core/task/task-store.ts:269-274`).
3. **Task-runtime projections for the UI** (already ink-free): `TaskRuntime.taskSummaries()`
   returns `{taskId, goal, kind, state, result?, criteriaMet, criteriaTotal, updatedAt,
targetDeviceId?}` (`src/core/task-runtime/runtime.ts:23-34`, `:427-431`); `TaskDetail` adds
   `plan`, `progress: CriterionVerdict[]`, `failure.items`, `repair[]`, `verification[]`,
   `acceptance`, `history[]`, `device` (`:74-90`); live state `{running, sawToolCall, currentAction,
approvalPending, halted, lastError}` (`:92-100`, `:322-324`). Artifacts come from
   `.moss/{tasks,evidence,deployments,acceptance}.jsonl` (`src/core/task-runtime/artifacts.ts:36-40`,
   `:89-97`).

The shell already renders task/evidence/deployment/failure/history **blocks on demand**
(`src/cli/tui/app.ts:407-477`) and a task count in the hint (`src/cli/tui/transcript.ts:325-332`),
and re-renders on `runtime.onChange` (`src/cli/tui/app.ts:236`) — but there is no persistent
in-transcript checklist; `TaskDetail.plan` is never rendered anywhere in `src/cli/`.

---

## 10. Terminal constraints and available ink APIs

- **TTY decision**: `useTui = process.stdout.isTTY && MOSS_NO_TUI !== '1' && !parsedArgs.print`
  (`src/cli-main.ts:975-977`); REPL fallback at `:1052`. Non-TTY piped input path is handled before
  it (`:861`, `:935-950`).
- **`--no-tty` is not a real flag** — it appears only in the `app.ts` docstring
  (`src/cli/tui/app.ts:13`); the parser has no such flag (`src/cli/args.ts:433` shows the sibling
  `--read-only` branch; the full flag set is `--print`, `--json`, `--output-format`, `--session`,
  `--last`, `--continue`, `--fork-from`, `--model`, `--provider`, `--base-url`, `--max-turns`,
  `--detail`, `--verbose`, `--quiet`, `--debug`, `--no-color`, `--plan`, `--accept-edits`,
  `--read-only`, `--workspace-write`, `--full-access`, `--ask-for-approval`, `--cd`, `--config`,
  `--mock`, `--setup`, `--all`, `--log-level`, `--help`, `--version`).
  **`MOSS_NO_TUI=1` is the only escape hatch.**
- **Windows**: no `win32` exclusion in the `useTui` condition (verified by reading
  `src/cli-main.ts:975-977`); the only Windows handling is
  `configureWindowsUtf8Console()` (`src/cli-main.ts:245-251`) and the `WIN_POSIX_HINT` in exec
  (`src/tools/builtin.ts:55-57`). The support matrix in `AGENTS.md` claims "Windows → readline REPL"
  — that is **not enforced by code** (unconfirmed; the smoke suite may set `MOSS_NO_TUI`, but
  `grep MOSS_NO_TUI scripts/ test/` found nothing).
- **Width**: `useStdout()` + `stdout.columns || 80` (`src/cli/tui/app.ts:203`, `:950-954`), read on
  every render. All layout math uses **terminal cells**, not `String.length`:
  `displayWidth`/`truncateTerminalText` (string-width, `src/cli/terminal-text.ts:74-78`) re-exported
  as `clip`/`wrap`/`rule`/`padStartTo` (`src/cli/tui/text.ts:22-73`); the composer re-measures cells
  per code point (`src/cli/tui/composer.ts:120-143`, `:341-349`).
- **Scrollback model**: committed rows go through ink `<Static>` with `items: store.rows.slice()`
  (the copy is required because Static memoizes on array identity) (`src/cli/tui/app.ts:928-942`);
  live region / composer / chrome are ordinary `<Box>`/`<Text>` (`:943-946`), with the caret as an
  inverted `<Text inverse>` run (`:913-923`). This is why terminal
  selection/copy and native scrolling keep working (docstring `:4-9`).
- **ink**: installed `7.1.1`, declared `^7.1.1` (`package.json` dependencies; verified in
  `node_modules/ink/package.json`). Static imports only in `src/cli/tui/**`
  (`src/cli/tui/app.ts:15-16`), dynamic import at the entry point (`src/cli-main.ts:979`).
  Verified exported API: `render, Box, Text, Static, Newline, Spacer, Transform, measureElement,
useInput, usePaste, useStdin, useStdout, useStderr, useApp, useCursor, useFocus,
useFocusManager, useAnimation, useBoxMetrics, useWindowSize, useIsScreenReaderEnabled,
renderToString, kittyFlags, kittyModifiers`.
- **Colour/theme**: the shell uses ink `color`/`bold`/`dimColor`/`inverse` only
  (`src/cli/tui/app.ts`); the REPL has a single self-contained ANSI colour layer
  (`src/cli/ui.ts:6-9`) honouring `--no-color` (`src/cli/args.ts:376`) and `NO_COLOR`
  (`src/cli/ui.ts:9`). The former `src/cli/theme/` module (colour tokens + terminal-background
  probing) was unreferenced and has been removed, along with `MOSS_THEME` / `MOSS_TUI_THEME` /
  `MOSS_NO_TERM_QUERY`.
- **SIGINT**: `render(..., { exitOnCtrlC: false })` and explicit Ctrl+C semantics ("interrupt the
  run · press again to quit", `src/cli/tui/app.ts:672-676`, `:960-962`;
  `src/cli/tui/help.ts:43`).

---

## 11. Production-dead wiring found while inventorying (fix before building on top)

These are the highest-leverage _fixes_, not features — each is a small change that restores
already-written machinery:

| #   | finding                                                                                                                                                                                                                                                                                                                | evidence                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| D1  | TUI `/rewind` cannot work: `FileCheckpointStore.open()` is never called on the TUI path, so no backup is recorded; `trackBeforeWrite` finds no current checkpoint (`src/cli/file-checkpoint.ts:80-83`). `rewindTo` then returns `{found:false}`, but the host wrapper reports `{ok:true, detail:'0 file(s) restored'}` | `src/cli-main.ts:983-1010` (hooks only), `:1039-1045` (unconditional ok); `open()` callers only at `src/cli/repl.ts:283`, `:696` |
| D2  | Resume replay never reaches the shell: `replayRows` is consumed (`src/cli/tui/app.ts:302`) but never passed by the host                                                                                                                                                                                                | `grep -rn replayRows src/` → only `src/cli/tui/app.ts:90,302,303`; tests pass it (`test/tui-app.spec.mjs:299-303`)               |
| D3  | `/rewind` list is always empty in the shell: `listCheckpoints` is never passed                                                                                                                                                                                                                                         | `src/cli-main.ts:1013-1046`; `src/cli/tui/app.ts:97`, `:546`                                                                     |
| D4  | File rewind does not rewind the conversation, although the agent API and `messageCount` exist                                                                                                                                                                                                                          | `src/core/agent/moss-agent.ts:696`; `src/cli/file-checkpoint.ts:36-46`; no production caller (grep)                              |
| D5  | Attachments are unwired: `preparePromptAttachments` has no caller in `src/` (only its helpers are tested), yet `@` mentions are documented as the primary attach path                                                                                                                                                  | `src/cli/attachments.ts:152`; `src/cli/attachment-refs.ts:3`; `src/cli/interactive-commands.ts:66-67`; grep callers → tests only |
| D6  | AGENTS.md auto-load documented, no loader in source                                                                                                                                                                                                                                                                    | `src/cli/help.ts:186`, `src/cli/onboarding.ts:266`; grep for a reader → none                                                     |

---

## 12. GAP TABLE

Reference-CLI column = "does Claude Code / codex surface it". Those cells are **expected** surface
facts from the parity brief (R1/R2 own the evidence); the moss columns are source-verified.

Sizes: **S** ≈ one focused change in one module (hours); **M** ≈ a few days / new state + tests;
**L** ≈ cross-cutting (new subsystem or a week+).

| capability                                                                                                                                                        | reference CLIs have it?          | moss today (file:line)                                                                                                                                                                                                         | reuse hook (exact module/function)                                                                                                                                                                                                                            | size |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Rich composer: multi-line draft, caret movement, mid-line edit                                                                                                    | yes (expected)                   | **landed mid-audit** — real editor in `src/cli/tui/composer.ts` (caret, word/line motion, Ctrl+A/W/U/K, Shift/Alt+Enter, Ctrl+J, soft-wrap windowing): `composer.ts:63-106`, `:192-231`, `:275-338`; dispatch `app.ts:711-832` | residual work only: mouse/selection/clipboard, undo/redo, and reusing ink 7.1.1 `usePaste` instead of the hand-rolled capture (`src/cli/tui/input-box.ts:32-54`)                                                                                              | S    |
| Slash-command autocomplete + menu while typing                                                                                                                    | yes (expected)                   | none in shell; REPL has readline prefix completion (`src/cli/repl.ts:109-112`, `:178`)                                                                                                                                         | `commandRowsForSlashInput` (`src/cli/interactive-commands.ts:209-234`), `SLASH_MENU_ROWS` (`:161`), `commandSuggestion` (`src/cli/command-completion.ts:5`)                                                                                                   | S    |
| Shell parity for control commands (`/model`, `/mode`, `/compact`, `/status`, `/diff`, `/context`, `/export`, `/doctor`, `/permissions`, `/review`, `/quickstart`) | yes (expected)                   | registry exists, shell never calls it: unknown-command path (`src/cli/tui/app.ts:605-608`); registry `src/cli/commands/registry.ts:439-449`                                                                                    | `runRegistryCommand` + `CommandContext` (`src/cli/commands/registry.ts:33-62`, `:479-488`), `ctx.say` → `printBlock` (`src/cli/tui/app.ts:239-248`), `getContextUsage`/`getSessionUsage` from `createSessionUsageAccumulator` (`src/cli/session-usage.ts:46`) | M    |
| Custom command files usable from the shell                                                                                                                        | yes (expected)                   | REPL only (`src/cli/repl.ts:166-173`; `src/cli/commands/custom-commands.ts:111-151`)                                                                                                                                           | `loadCustomCommands` + `expandCommandBody` (`src/cli/commands/custom-commands.ts:64-78`, `:111`); feed into the same palette as §4                                                                                                                            | S    |
| `/goal`, `/loop`, `/task` control from the shell                                                                                                                  | yes (expected)                   | REPL only (`src/cli/repl.ts:538-681`); `moss task/g` headless (`src/cli/command-dispatcher.ts:249-271`)                                                                                                                        | `LoopScheduler` + `parseGoalCommandLine` (`src/cli/repl.ts:7`, `:618-643`), `runTaskCommand` (`src/cli/task-run.ts`)                                                                                                                                          | M    |
| Structured approval payload (side effect, scope, mode) instead of a text blob                                                                                     | yes (expected)                   | string-only asker (`src/cli/approval.ts:28`, `:653-691`); shell re-parses the string (`src/cli/tui/app.ts:135-168`)                                                                                                            | `describeCliToolApproval` (`src/cli/approval.ts:718-788`) + `CliToolApprovalPreview` (`:60-80`); add a preview-carrying port beside `setCliApprovalAsker` (`:82`)                                                                                             | M    |
| Diff shown in the transcript for edits                                                                                                                            | yes (expected)                   | computed for approval (≤18 lines, `src/cli/approval-detail.ts:222-245`) and printed by the REPL renderer (`src/cli/output.ts:712-775`); shell drops it (`src/cli/tui/render-bridge.ts:120-127`)                                | `diffLinesForApproval` (`src/cli/approval-detail.ts:54`); render as `TuiLine`s with colour support already in `renderTranscriptRow` (`src/cli/tui/transcript.ts:73-150`)                                                                                      | S    |
| Per-tool duration / outcome / abort badge                                                                                                                         | yes (expected, CC shows elapsed) | `durationMs`/`outcome`/`aborted`/`error` exist (`src/core/agent/moss-agent-types.ts:260-271`); shell ignores them and times the whole run instead (`src/cli/tui/app.ts:314`, `:350`)                                           | `TuiRunState` (`src/cli/tui/render-bridge.ts:36-49`); tool timing pattern in `src/cli/output.ts:290`, `:607`                                                                                                                                                  | S    |
| Context % / tokens-remaining in the status line                                                                                                                   | yes (expected, CC shows context) | model + cumulative tokens only (`src/cli/tui/transcript.ts:304-323`); `/context` exists in the REPL (`src/cli/commands/registry.ts:159-221`)                                                                                   | `ContextUsageSnapshot` + `contextUsageFromAgentEvent` (`src/cli/usage-display.ts:4-25`), `createSessionUsageAccumulator` (`src/cli/session-usage.ts:46`), pct math (`src/cli/commands/registry.ts:176`)                                                       | S    |
| Compaction / microcompact notice in the transcript                                                                                                                | yes (expected)                   | events exist (`src/core/agent/moss-agent-types.ts:283-295`), REPL prints them (`src/cli/output.ts:824-840`); shell ignores them                                                                                                | `CompactionRecord` + `compactionHistory()` (`src/cli/session-usage.ts:29-36`, `:113-115`), `renderTranscriptRow` `summary`/`system` kinds (`src/cli/tui/transcript.ts:92-129`)                                                                                | S    |
| Resume: replay the prior conversation visually                                                                                                                    | yes (expected)                   | machinery complete but never wired (`src/cli/resume-replay.ts:53-86`; `src/cli/tui/app.ts:89-90`, `:302-305`; host omits it `src/cli-main.ts:1013-1046`)                                                                       | `buildResumeReplay` + `resumedMessageText` (`src/cli/resume-replay.ts:19-30`, `:67`)                                                                                                                                                                          | S    |
| Resume picker (choose a session interactively)                                                                                                                    | yes (expected)                   | `/sessions` prints a list in both surfaces (`src/cli/tui/app.ts:372-383`, `src/cli/repl.ts:405-414`); `moss sessions list/search` (`src/cli/command-dispatcher.ts:407-500`)                                                    | `sessionStore.listSessions()` + `SessionMeta` (`src/core/session/session.ts:3-22`), search via `searchSessions` (`src/cli/command-dispatcher.ts:136`); arrow-key select patterns already exist for approvals (`src/cli/tui/app.ts:686-696`)                   | M    |
| File rewind works end-to-end from the shell                                                                                                                       | yes (expected)                   | broken (D1): no checkpoint opened, success reported unconditionally (`src/cli-main.ts:983-1010`, `:1039-1045`)                                                                                                                 | `FileCheckpointStore.open/trackBeforeWrite/rewindTo` (`src/cli/file-checkpoint.ts:65`, `:80`, `:131`), `checkpointTargetPaths` (`:168`)                                                                                                                       | S    |
| `/rewind` also rewinds the conversation                                                                                                                           | yes (expected)                   | file-only; `rewindConversation` uncalled (`src/core/agent/moss-agent.ts:696`)                                                                                                                                                  | `RewindResult.messageCount` (`src/cli/file-checkpoint.ts:36-46`) → `agent.rewindConversation`                                                                                                                                                                 | S    |
| AGENTS.md / project instructions loaded into the prompt                                                                                                           | yes (expected)                   | documented but no loader found (D6)                                                                                                                                                                                            | `extraPromptLayers` (`src/cli-main.ts:514-516`, `:600`), `buildEnvironmentContextLayer` (`src/context/environment.ts:43`)                                                                                                                                     | M    |
| Skills / MCP / custom tools exposed in the UI                                                                                                                     | yes (MCP/skills lists)           | MCP statuses only, via `/mcp` (`src/cli-main.ts:1031-1038`; `src/cli/tui/app.ts:384-393`); skills invisible (`src/cli-main.ts:663-675`; `/status` counts only, `src/cli/onboarding.ts:276-286`)                                | `loadSkills` (`src/core/skills/skill-registry.ts:81`), `McpToolRegistry.getStatuses()` (`src/core/mcp/registry.ts:146`), `printBlock` (`src/cli/tui/app.ts:239`)                                                                                              | S    |
| Live todo/plan checklist                                                                                                                                          | yes (expected, CC TodoWrite)     | tool + formatter exist (`src/tools/todo-tool.ts:30-42`), REPL compresses to `d/t · focus` (`src/cli/output.ts:242-260`); `TaskDetail.plan` never rendered (`src/core/task-runtime/runtime.ts:74-90`)                           | `formatTodos` + `TODO_STATUS_GLYPH` (`src/tools/todo-tool.ts:19-30`); `TaskRuntime.taskDetail()`/`onChange` (`src/core/task-runtime/runtime.ts:510`, `:258`)                                                                                                  | S    |
| Markdown rendering (code blocks, lists, tables)                                                                                                                   | yes (expected)                   | none — plain `wrap` of raw text (`src/cli/tui/transcript.ts:77-85`); the streaming comment records that whole-answer markdown re-render was removed (`src/cli/output.ts:531-537`)                                              | `wrap`/`clip` (`src/cli/tui/text.ts:36-68`, `:22`), `renderTranscriptRow` (`src/cli/tui/transcript.ts:73`)                                                                                                                                                    | L    |
| `@`-file / image attachments                                                                                                                                      | yes (expected)                   | parser + preparer exist but unwired (D5)                                                                                                                                                                                       | `extractAttachmentRefs` (`src/cli/attachment-refs.ts:3`), `preparePromptAttachments` (`src/cli/attachments.ts:152`), passthrough `ChatOptions.attachments` (`src/core/agent/moss-agent-types.ts:201-204`)                                                     | M    |
| Reverse input-history search                                                                                                                                      | yes (expected)                   | ↑/↓ only, and only for a single-line draft (`src/cli/tui/app.ts:753-779`); Ctrl+R prints task history (`src/cli/tui/help.ts:13`)                                                                                               | history array already kept (`src/cli/tui/app.ts:218`, `:485`)                                                                                                                                                                                                 | S    |
| Shift+Tab mode cycling + mode indicator                                                                                                                           | yes (expected)                   | advertised, implemented nowhere (`src/cli/commands/registry.ts:118`, `src/cli/approval.ts:868`; grep)                                                                                                                          | `getCliInteractionMode`/`setCliInteractionMode`/`subscribeCliInteractionMode` (`src/cli/interaction-mode.ts:1-27`)                                                                                                                                            | S    |
| Safety mode / cwd / device in the chrome                                                                                                                          | yes (partial)                    | banner has model/device/cwd (`src/cli/tui/app.ts:285-301`, `src/cli/tui/transcript.ts:165-173`); status right has model+tokens only (`:313-323`)                                                                               | `StatusView` (`src/cli/tui/transcript.ts:304-311`), `CliRuntimeStatus` (`src/cli/onboarding.ts:21`)                                                                                                                                                           | S    |
| Live sub-agent / background-task status                                                                                                                           | yes (expected)                   | `/subs` and `/bg` print snapshots on demand (`src/cli/tui/app.ts:394-401`); no live indicator                                                                                                                                  | `agent.asyncTasks.list()` (`src/core/agent/moss-agent.ts:117`), `listBackgroundProcessSnapshots` (`src/core/tools/background-process-registry.ts`), background notices (`src/cli/background-completion-ui.ts`)                                                | S    |
| Queueing input mid-run                                                                                                                                            | yes (expected)                   | shell-only, already implemented (`src/cli/tui/app.ts:360-370`, `:563-590`, `:622-626`)                                                                                                                                         | done — expose the REPL side instead (REPL has none, `src/cli/interactive-commands.ts:35-36`)                                                                                                                                                                  | S    |
| `/steer` mid-run constraint injection                                                                                                                             | yes (expected)                   | shell-only (`src/cli/tui/app.ts:591-604`)                                                                                                                                                                                      | `MossAgent.steer` (`src/core/agent/moss-agent.ts:358`), `SteeringEngine` (`src/core/loop/steering.ts`)                                                                                                                                                        | S    |
| `--no-tty` explicit fallback flag                                                                                                                                 | yes (expected, `--no-tui`-like)  | not a real flag; only `MOSS_NO_TUI=1` (`src/cli-main.ts:977`; `app.ts:13` docstring claims `--no-tty`)                                                                                                                         | `src/cli/args.ts:376` (the `--no-color` branch is the shape a new boolean flag follows)                                                                                                                                                                       | S    |
| Windows-safe interactive path                                                                                                                                     | yes (expected)                   | no `win32` branch in `useTui` (`src/cli-main.ts:975-977`); only UTF-8 console setup (`:245-251`)                                                                                                                               | same `useTui` condition                                                                                                                                                                                                                                       | S    |

---

## 13. Do NOT reimplement — the REPL/engine already has it

Build on these; a parallel implementation is a defect waiting to happen.

1. **Approval policy engine** — `createCliToolApprovalHook`, safety modes, plan mode, trusted/denied
   globs, dangerous-command blocking, session trust (`src/cli/approval.ts:810-989`, `:309-360`,
   `:693-716`). The UI only needs to _render_ and _answer_.
2. **Tool side-effect metadata + fail-closed default** — `ToolSideEffectClass`/`ToolMetadata`
   (`src/core/tools/tool-types.ts:115-140`), `inferSideEffectClass` defaulting to `local_write`
   (`src/cli/approval.ts:111-117`), the builtin registry (`src/tools/builtin.ts:223-256`).
3. **Diff computation and approval detail** — `diffLinesForApproval`
   (`src/cli/approval-detail.ts:54`), `buildApprovalDetailLines` (`:222`). Already secret-sanitized
   and width-capped; do not write a second differ.
4. **File checkpoints / rewind store** — `FileCheckpointStore`, `checkpointTargetPaths`
   (`src/cli/file-checkpoint.ts:56-192`). Fix the wiring (D1), not the store.
5. **Tool-call labelling** — `toolLabel` (`src/cli/tui/transcript.ts:39-57`) and the REPL's
   `extractToolTarget` (`src/cli/output.ts:193`) / `toolHeadline` (`src/cli/tool-headline.ts:25`);
   `describeToolCall` for device/task phrasing (`src/core/task-runtime/runtime.ts:161-208`).
6. **Cell-width text primitives** — `displayWidth`/`truncateTerminalText`/`sanitizeRenderableText`
   (`src/cli/terminal-text.ts:54-78`) and `wrap`/`clip`/`rule`/`padStartTo`
   (`src/cli/tui/text.ts:22-73`). Any new panel must measure CJK with these.
7. **Token/context accounting** — `estimateTokensForText` (`src/context/tokens.ts:20`),
   `totalPromptTokens` (`src/core/llm/usage.ts:10`), `ContextUsageSnapshot`
   (`src/cli/usage-display.ts:4-25`), `createSessionUsageAccumulator`
   (`src/cli/session-usage.ts:46`), `resolveContextTokensForModel` (`src/cli/model-catalog.ts:470`).
8. **Session persistence** — `JsonlSessionStore` (`src/core/session/jsonl-session-store.ts:226`),
   `searchSessions`/`renderSessionMarkdown` (`src/cli/command-dispatcher.ts:136`, `:46`),
   `buildResumeReplay` (`src/cli/resume-replay.ts:67`), `MossAgent.rewindConversation`
   (`src/core/agent/moss-agent.ts:696`).
9. **Command registry, palette data and fuzzy matching** — `CommandSpec`/`COMMANDS`
   (`src/cli/commands/registry.ts:55-62`, `:439-449`), `INTERACTIVE_COMMAND_SECTIONS`/
   `SLASH_MENU_ROWS`/`commandRowsForSlashInput` (`src/cli/interactive-commands.ts:14-234`),
   `commandSuggestion`/`editDistance` (`src/cli/command-completion.ts:5-49`),
   `loadCustomCommands`/`expandCommandBody` (`src/cli/commands/custom-commands.ts:64-151`).
10. **Task/plan state** — `TaskRuntime` projections and `onChange`
    (`src/core/task-runtime/runtime.ts:229-431`), task-store snapshot/`planFromEvents`
    (`src/core/task/task-store.ts:269`), `TaskStateSnapshot.plan` (`src/contracts/task-runtime.ts:136`),
    `todo_write` + `formatTodos` (`src/tools/todo-tool.ts:19-42`).
11. **MCP and skills loaders** — `loadMcpConfigs` (`src/cli/mcp-config.ts:120`),
    `McpToolRegistry.connectAll`/`getStatuses`/`buildMcpPromptLayer`
    (`src/core/mcp/registry.ts:146`, `:315`), `loadSkills`/`buildSkillsPromptLayer`/
    `createSkillTool` (`src/core/skills/skill-registry.ts`, wired `src/cli-main.ts:663-675`).
12. **Background work registries** — `listBackgroundProcessSnapshots`
    (`src/core/tools/background-process-registry.ts`), `agent.asyncTasks`
    (`src/core/agent/moss-agent.ts:117`), completion notices
    (`src/cli/background-completion-ui.ts`).
13. **Bracketed-paste capture** — `createPasteCapture`/`feedChunk` (`src/cli/tui/input-box.ts:17-54`),
    already handles the "one paste = one message" failure mode; consider switching to ink's built-in
    `usePaste` (available in 7.1.1) rather than writing a third capture path.
14. **Shell scrollback/rendering grammar** — `<Static>` + transcript marks and row grammar
    (`src/cli/tui/app.ts:925-947`, `src/cli/tui/transcript.ts:19-150`). Add row kinds; do not add a
    second renderer.
15. **Device target resolution and the event→task projection** — `resolveDefaultDeviceTarget`
    (`src/device/device-target.ts`, used `src/cli/tui/app.ts:276`) and `TaskRuntime.applyEvent`
    (`src/core/task-runtime/runtime.ts:330-373`).
16. **Composer editor (new mid-audit)** — `src/cli/tui/composer.ts` is now the single input model:
    `createComposer`/`composerInsert`/`composerDelete`/`composerMove`/`composerNewline`
    (`:37-231`), soft wrap and caret projection `wrapSpans`/`composerRows`/`caretAt`/
    `renderComposerEditor` (`:120-338`), plus the spec-facing plain projection
    `renderComposer` (`src/cli/tui/transcript.ts:289-300`). Extend this module (slash palette
    rendering, history search) instead of adding a second line editor.

---

## 14. Unconfirmed / cannot assert

1. **AGENTS.md auto-load**: no loader in `src/`; help/onboarding text claims it. I only proved the
   _absence_ of a reader in this tree (grep over `src/` and `dist/`), not that some dependency does
   it.
2. **Reference-CLI cells** in §12: taken as expectations from the parity brief; R1/R2 own the
   PTY evidence for Claude Code and codex.
3. **Windows interactive behaviour**: `AGENTS.md` claims the readline REPL on Windows, but the
   `useTui` condition has no `win32` check. I did not run on Windows.
4. **Resize behaviour of committed `<Static>` rows**: the shell reads `stdout.columns` each render,
   but ink `Static` does not re-render already-emitted items. Whether ink 7.1.1 re-emits on resize is
   **unconfirmed**; `docs/tui-ux-audit-2026-10-01.md:744-775` treats some resize artifacts as
   false positives.
5. **De-surfaced commands still dispatching**: `src/cli/interactive-commands.ts:115-119` claims
   `/config`, `/tools`, `/models`, `/yolo` still dispatch for back-compat; I found no handler for
   any of them in `src/cli/commands/registry.ts` or `src/cli/repl.ts`. Unconfirmed.
6. **`/skills` command**: name-reserved (`src/cli/commands/custom-commands.ts:17`) and referenced in
   a comment (`src/cli-main.ts:783`) but no handler found — unconfirmed whether it is meant to exist.
7. Line numbers are from the current working tree (moss `0.21.0`); the brief calls the shell "v0.22"
   (docstrings at `src/cli/tui/app.ts:2`, `src/cli-main.ts:973`). No behavioural claim here depends
   on the version string.
