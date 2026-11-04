# Moss tool surface: Qoder / Cursor REA and the keep-merge-remove map

Status: 2026-11-04. Decides which builtin tools Moss offers the model, based on how Qoder and
Cursor shape their own agent tool surfaces. Every removal in this change has a row here.

## Method and limits

Two independent evidence sources, because neither product documents its internal tool list in full:

1. **Public docs** (per-claim URLs in the tables below). Qoder publishes tool taxonomy pages for
   the CLI and the IDE; Cursor publishes a category-level tool list for Agent.
2. **REA of the shipped artifacts** running on this machine. Qoder CLI's agent runtime
   (`/Applications/Qoder CN.app/.../qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs`)
   carries a flat constant table of tool names and their input-field names; Cursor's desktop bundle
   (`/Applications/Cursor.app/Contents/Resources/app/out/main.js`) carries the protobuf `oneof`
   that enumerates every tool-call parameter message. Both are minified but not encrypted, and the
   name tables survive minification verbatim. These give per-tool names where the docs only give
   categories.

Limits, stated so later readers do not over-read the table:

- Cursor's per-tool description text and schemas are server-side; only the parameter names and the
  category-level docs are observable locally. The Cursor column is therefore name-level, not
  description-level.
- Qoder's table was read from the CN build (v as shipped 2026-11-03). Feature-flagged tools
  (goals, cron, worktrees) exist in the runtime but may be off for a given account.
- `web_search` failed in this environment; all doc evidence came from `web_fetch` on the official
  pages listed below.

## Qoder CLI

Sources: <https://docs.qoder.com/cli/tools.md> (taxonomy, background/monitor, tool visibility),
local runtime constant table (tool names and input fields).

| Category (doc)       | Observed tool names (runtime)                                                                                                                      | Input fields observed                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Search / explore     | `Glob`, `Grep`                                                                                                                                     | `pattern`, `path`, `glob`, `output_mode`, `-A/-B/-C`, `head_limit`, `multiline`, `respect_git_ignore`    |
| Read project context | `Read`                                                                                                                                             | `file_path`, `offset`, `limit`, `pages` (PDF)                                                            |
| Edit files           | `Write`, `Edit`, `NotebookEdit`                                                                                                                    | `Write`: `content`; `Edit`: `old_string`, `new_string`, `allow_multiple`                                 |
| Execute commands     | `Bash`, `PowerShell`, `BashInput`, `BashOutput`, `BashResize`, `Monitor`, `TaskStop`                                                               | `Bash`: `command`, `run_in_background`                                                                   |
| Web                  | `WebSearch`, `WebFetch`, `ImageSearch`                                                                                                             | `WebSearch`: `query`, `allowed_domains`, `blocked_domains`; `WebFetch`: `url`, `prompt`                  |
| Manage context       | `TodoWrite`, `Skill`, `AskUserQuestion`, `UpdateTopic`                                                                                             | `TodoWrite`: `todos` (`description`, `status`); `AskUserQuestion`: `questions`, `multiSelect`, `options` |
| Plan work            | `EnterPlanMode`, `ExitPlanMode`                                                                                                                    | `ExitPlanMode`: `plan_filename`, `reason`                                                                |
| Delegate / automate  | `Agent`, `SendMessage`, `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`, `CompleteTask`, `CodebaseInvestigator`, `EnterWorktree`, `ExitWorktree` | —                                                                                                        |
| Goals / schedule     | `GetGoal`, `CreateGoal`, `UpdateGoal`, `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`                                                    | —                                                                                                        |
| Media                | `ImageGen`, `VideoGen`, `VideoGenRetrieve`                                                                                                         | —                                                                                                        |
| MCP                  | configured servers share the same list and permission system (doc)                                                                                 | —                                                                                                        |

What the CLI design says about the questions this change had to settle:

- **One edit surface.** `Edit` takes `old_string` / `new_string` plus `allow_multiple`; there is no
  separate multi-edit tool in the runtime (`MultiEdit` appears 0 times). Several replacements are a
  flag on the one canonical edit tool.
- **One foreground shell.** `Bash` carries `run_in_background` itself; there is no separate
  "background shell" tool name. Background control is separate handles (`BashOutput`, `BashResize`,
  `TaskStop`) plus an event `Monitor` whose whole-line output becomes events
  (<https://docs.qoder.com/cli/tools.md>, "Background Commands and Event Monitoring").
- **No diagnostics tool.** The CLI has no lint/typecheck tool; verification runs through `Bash`.
  The IDE has a "Get code problems" tool, but it is backed by an LSP the IDE owns
  (<https://docs.qoder.com/user-guide/chat/tools.md>, "Find problems").
- **Visibility is a separate axis from registration.** `--tools`, `tools.exclude` and permission
  rules filter what is visible without deleting the tool
  (<https://docs.qoder.com/cli/tools.md>, "Control Tool Usage"). Moss already has the same split
  (`toolVisibleForRun`, `DeferredToolOffer`).

## Qoder IDE

Source: <https://docs.qoder.com/user-guide/chat/tools.md>.

| Category        | Scope                                                         |
| --------------- | ------------------------------------------------------------- |
| Search          | codebase (semantic), files, code, directory, web, web content |
| Edit            | modify files, view files                                      |
| Execute         | run a command, get terminal output                            |
| Find problems   | project diagnostics from the Problems window                  |
| Update memories | persistent memory                                             |
| MCP             | configured servers                                            |

The IDE set is the same shape as the CLI set plus LSP diagnostics and semantic codebase search,
minus the shell-background handles. Moss has no LSP and no embedding index, so the IDE column is
informative only.

## Cursor

Sources: <https://cursor.com/docs/agent/overview> (categories), local protobuf `oneof`
(tool-call parameter names).

| Category (doc)           | Observed tool-call names (protobuf)                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Search files and folders | `ripgrep_search`, `ripgrep_raw_search`, `file_search`, `glob_file_search`, `semantic_search_full`, `deep_search`, `search_symbols`, `gotodef` |
| Read files               | `read_file`, `read_file_v2`, `read_semsearch_files`, `list_dir`, `list_dir_v2`, `read_lints`, `read_project`                                  |
| Edit files               | `edit_file`, `edit_file_v2`, `search_replace`, `delete_file`, `reapply`, `apply_agent_diff`, `fix_lints`                                      |
| Run shell commands       | `run_terminal_command_v2`, `write_shell_stdin`                                                                                                |
| Long-running work        | `task`, `task_v2`, `await_task`                                                                                                               |
| Plan / context           | `todo_read`, `todo_write`, `create_plan`, `switch_mode`                                                                                       |
| Ask questions            | `ask_question`                                                                                                                                |
| Web                      | `web_search`, `web_fetch`                                                                                                                     |
| Rules                    | `fetch_rules`                                                                                                                                 |
| MCP                      | `mcp`, `call_mcp_tool`, `get_mcp_tools`, `list_mcp_resources`, `read_mcp_resource`, `mcp_auth`                                                |
| Other                    | `create_diagram`, `knowledge_base`, `fetch_pull_request`, `computer_use`, `record_screen`, `connect_scm`, `report_bugfix_results`             |

Cursor ships many more names than Qoder because it keeps versioned aliases (`edit_file` /
`edit_file_v2`, `list_dir` / `list_dir_v2`, `task` / `task_v2`) and per-surface specializations
(`fix_lints`, `read_lints`, `apply_agent_diff`). It also keeps a second edit path (`search_replace`)
next to `edit_file`. Both are wire-level compatibility: old conversations and old client versions
keep working. Moss has the same two pressures and should handle them the same way — keep the alias
registered, stop advertising it.

## Cross-product invariants

Three rules hold in both products and drive the Moss changes:

1. One canonical tool per action family; extra names survive only as compatibility aliases.
2. Background work is a flag on the shell tool plus its own control handles, never a second shell
   entry point.
3. Tool visibility is filtered per run; registration is not visibility.

## Moss baseline (before this change)

Measured from the shipped `dist/` on this working tree with the plan gate off, a device configured,
task flow on, and one sub-agent offer in effect (`buildProviderToolDeclarations` over
`toolVisibleForRun` + `DeferredToolOffer`):

| Figure                         | Value                                                       |
| ------------------------------ | ----------------------------------------------------------- |
| Registered builtin tools       | 45                                                          |
| Model-facing declarations      | 39                                                          |
| Serialized declaration payload | 25,052 bytes (25,009 chars, ≈ 6.3k tokens at 4 chars/token) |

Problems the baseline exposed:

- `code_diagnostics` is exported from `src/index.ts` and unit-tested, but never registered: no run
  can reach it while four modules still branch on its name.
- `verify_fix` was deleted from `harness-tools` but is still named by nudge sets, TUI summaries and
  one `task_define` message.
- `repo_outline` and `multi_edit` each duplicate a capability the model already has through
  `list_directory`/`search_*` and `edit_file`.
- `exec_background` is a second entry point for exactly what `exec` with
  `run_in_background: true` does.
- Phantom names in family sets (`memory_read`, `docker_exec`, `web_browser_fetch`, `load_skill`)
  make those sets describe tools that do not exist.

## Keep / merge / remove

Legend: **keep** = stays model-facing, **hide** = stays registered for hosts and old transcripts,
removed from the model list, **remove** = module and export deleted.

| Moss tool                                                                                                             | Decision                             | Reason                                                                                                                                                          | Former callers updated                                                                                 |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `read_file`, `write_file`                                                                                             | keep                                 | Cursor `read_file`/`Write`; Qoder `Read`/`Write`                                                                                                                | —                                                                                                      |
| `edit_file`                                                                                                           | keep, canonical                      | Qoder `Edit` is the only edit tool                                                                                                                              | now also accepts `edits[]`                                                                             |
| `multi_edit`                                                                                                          | hide                                 | Qoder folds multiple replacements into `Edit.allow_multiple`; Cursor keeps `search_replace` as a compatibility name only                                        | `edit_file` gains `edits[]`; nudge/TUI edit sets read the catalog                                      |
| `apply_patch`                                                                                                         | keep (documented compatibility path) | cross-file patches have no Cursor/Qoder equivalent, and hosts use it                                                                                            | —                                                                                                      |
| `move_file`                                                                                                           | keep                                 | carries prior-read + overwrite protection that `mv` via `exec` lacks                                                                                            | —                                                                                                      |
| `list_directory`, `search_files`, `search_code`                                                                       | keep                                 | Qoder `Glob`/`Grep`, Cursor file/ripgrep search: one find surface, one code-search surface                                                                      | —                                                                                                      |
| `repo_outline`                                                                                                        | remove                               | no Cursor or Qoder equivalent; `list_directory` + `search_files` cover it; 157 lines of schema for one niche call                                               | `builtin.ts`, `agent-file-loader.ts` allow-list, TUI preview list, `test/repo-outline.spec.mjs`        |
| `exec`                                                                                                                | keep, canonical                      | Qoder `Bash` carries `run_in_background`                                                                                                                        | description drops the separate background tool                                                         |
| `exec_background`                                                                                                     | hide                                 | duplicate of `exec` + `run_in_background`; Qoder has no such name                                                                                               | `exec` description, nudge exec sets, TUI/CLI exec sets                                                 |
| `exec_logs`, `exec_stop`, `exec_wait`                                                                                 | keep                                 | Qoder `BashOutput`/`TaskStop`, Cursor `await_task` are separate handles                                                                                         | —                                                                                                      |
| `run_tests`                                                                                                           | keep                                 | the only structured verification surface Moss has (Qoder has none; it relies on `Bash`) and the task-contract evidence source                                   | dead `verify_fix` branches removed                                                                     |
| `code_diagnostics`                                                                                                    | remove                               | thin wrapper over a shell command — `exec` covers it; Qoder's diagnostics tool needs an LSP Moss does not have; it was exported and tested but never registered | `src/index.ts`, `harness-tools.ts`, nudge verify sets, `cli/output.ts`, TUI lists, SDK snapshot, specs |
| `web_fetch`, `web_search`                                                                                             | keep                                 | both products                                                                                                                                                   | —                                                                                                      |
| `todo_write`                                                                                                          | keep                                 | Qoder `TodoWrite`, Cursor `todo_write`                                                                                                                          | —                                                                                                      |
| `ask_user_question`                                                                                                   | keep                                 | Qoder `AskUserQuestion`, Cursor `ask_question`                                                                                                                  | —                                                                                                      |
| `exit_plan`                                                                                                           | keep, mode-gated                     | Qoder/Claude Code `ExitPlanMode` exists only in plan mode; the mode is the flag, not an env var                                                                 | `MOSS_PLAN_GATE` env A/B hack removed; `PLAN_ONLY_TOOL_NAMES` + `toolVisibleForRun({planMode})`        |
| `tool_search`                                                                                                         | keep                                 | Qoder/Cursor both do lazy tool exposure; `tool_search` is where the deferred sub-agent group is revealed                                                        | —                                                                                                      |
| sub-agent family (`create_subagent`, `fan_out_subagents`, `subagent_status`, `subagent_stop`, `merge_subagent_patch`) | keep, deferred                       | Qoder `Agent`/`SendMessage`/`Task*`                                                                                                                             | —                                                                                                      |
| `device_*` (12)                                                                                                       | keep                                 | robotics closed-loop P0 contract (`AGENTS.md`), out of scope for removal                                                                                        | —                                                                                                      |
| `task_*`, `record_evidence`, `record_failure`, `record_repair`                                                        | keep                                 | task contract / evidence P0                                                                                                                                     | `plan_step` message wording                                                                            |

Names that were referenced but never existed are cleaned out of the family sets instead of being
kept as fiction: `memory_read` (memory is frozen), `docker_exec`, `web_browser_fetch`, and the
`skillhub_*` / `install_skill` / `load_skill` group. Hosts that register those names still extend a
scope through `registerSpawnToolExtensions`; the built-in sets stop pretending they exist.

## Result

| Figure                         | Before       | After                |
| ------------------------------ | ------------ | -------------------- |
| Registered builtin tools       | 45           | 44                   |
| Model-facing declarations      | 39           | 36                   |
| Serialized declaration payload | 25,052 bytes | 23,923 bytes (−4.5%) |

"Registered" counts the `builtinTools` modules; `registerBuiltinTools` now installs all of them in
every mode. `exit_plan` stays registered and is offered to the model only while the interaction mode
is `plan` (`PLAN_ONLY_TOOL_NAMES` + `toolVisibleForRun({ planMode })`), the same split Cursor and
Claude Code use between "registered capability" and "offered tool".

The payload shrink is smaller than the name count shrink because `edit_file` now carries the
`edits[]` batch schema that `multi_edit` used to hold, and the two schemas cost about the same. The
saving is in the removed modules (`repo_outline`, `code_diagnostics`) and the duplicate shell entry.

Measured with the same harness as the baseline (`test/builtin-tool-surface.spec.mjs` asserts the
counts and the payload ceiling so the next addition has to update this table). The addendum below
adds the `exec.event` parameter (350 bytes), the `exec_input` tool (401 bytes) and the
`exec_logs.wait_for` parameters (~110 bytes), so the current surface is 37 model-facing
declarations at 24,482 bytes (−2.3% against the baseline). The ceiling moved from 24,000 to 24,500
on purpose: `exec_input` is a new capability and its schema is already at the floor for four
properties. It moved again to 24,600 when `search_code.fixed_strings` landed, and to 24,700 when
`search_code.max_matches_per_file` landed (24,523 measured).

## Addendum 2026-11-04: mechanics still unlearned

The 620a7e63 pass settled which tools Moss offers. Re-reading the same evidence for _mechanics_
(how a tool behaves once called) surfaced the items below. Each row names the evidence, what Moss
does today, and the decision. Adopted items were implemented in this change; deferred items are
listed so the next pass does not rediscover them as new.

| Mechanic                                                                                                                              | Evidence                                                                                                                                                                                                                                                                                                            | Moss today                                                                                                                                                                                                                                                                                                                                                                           | Decision                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whole-line event monitoring of a running command: each stdout line becomes an event the agent reacts to, instead of waiting for exit. | <https://docs.qoder.com/cli/tools.md> ("Background Commands and Event Monitoring"); Qoder runtime tool `Monitor` in the constant table of `/Applications/Qoder CN.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs`.                    | `exec` streams raw chunks to the UI through `ctx.onToolOutput`; the model receives one buffered result at exit, and background jobs are inspected later with `exec_logs`.                                                                                                                                                                                                            | **Adopt** as `exec.event: true`: one event per whole line, emitted live and listed as numbered events in the result.                                                                                                                                                                                                                   |
| Explicit multi-occurrence edit: the edit tool knows several sites match and either replaces all or asks a disambiguating question.    | Qoder `Edit.allow_multiple` (`https://docs.qoder.com/cli/tools.md`, Edit row of the runtime table); Cursor keeps `search_replace` next to `edit_file` (`/Applications/Cursor.app/Contents/Resources/app/out/main.js`, protobuf `oneof`).                                                                            | `replace_all` exists, but a non-`replace_all` call that matches twice returned `old_string is not unique (2 matches)` with no locations, no path forward, and it dropped the prior-read credit so the retry required an extra `read_file`.                                                                                                                                           | **Adopt**: the failure names the match count and line numbers and gives the three ways out (`replace_all: true`, more context, one `edits[]` entry per site), and keeps read credit because the file was not touched.                                                                                                                  |
| Writing to a running process's stdin (`BashInput`, `write_shell_stdin`), and resizing its terminal (`BashResize`).                    | Qoder runtime tool table (`BashInput`, `BashResize`) in `/Applications/Qoder CN.app/Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs`; Cursor protobuf `write_shell_stdin` (`/Applications/Cursor.app/Contents/Resources/app/out/main.js`). | `exec` runs a command to completion; background handles expose logs, stop, wait. There is no stdin channel or PTY resize.                                                                                                                                                                                                                                                            | **Adopt** the stdin half as `exec_input`: background children are spawned with a stdin pipe, and the tool writes text, appends a newline by default, and closes the pipe with `eof: true`. **Defer** PTY resize (`BashResize`): it needs a real PTY owner, which Moss does not have.                                                   |
| A standalone long-lived `Monitor` tool plus `TaskStop`, separate from the shell entry.                                                | Qoder runtime tool table (`Monitor`, `TaskStop`) in the same runtime bundle; <https://docs.qoder.com/cli/tools.md>.                                                                                                                                                                                                 | Background observation is `exec(run_in_background)` followed by `exec_logs`; stopping is `exec_stop`. Waiting for a readiness line meant polling `exec_logs` in a loop.                                                                                                                                                                                                              | **Adopt** the blocking half as `exec_logs.wait_for`: one call blocks until output matches a regex, the process exits, or `timeout_ms` elapses, and reports which of the three happened. **Defer** a standalone monitor tool: it needs cross-turn lifecycle state Moss does not keep.                                                   |
| Oversized command output spills to a file so the omitted middle can be read back.                                                     | Cursor `RunTerminalCommandV2Params.file_output_threshold_bytes` in `/Applications/Cursor.app/Contents/Resources/app/out/main.js`.                                                                                                                                                                                   | `exec` kept the head and tail and dropped the middle of stdout past 80,000 chars, with no way back: the command had already run.                                                                                                                                                                                                                                                     | **Adopt**: `exec` and `device_exec` put the full text in `.moss/runtime/tool-output/` (runtime-gitignored, 4 MB cap, 7-day prune) and the truncation note names the path. The copy carries the same secret filtering as the visible result, so the file cannot hold a value the model-facing text masks.                               |
| Telling the model whether a timed-out command had gone silent.                                                                        | Cursor `RunTerminalCommandV2Params.idle_timeout_seconds` and its `ai_finish_check_*` options in the same bundle.                                                                                                                                                                                                    | A timeout said only `timed out after 120000ms`, so a hung process and a slow-but-working one looked identical.                                                                                                                                                                                                                                                                       | **Adopt** the diagnostic half: `ProcessError` records when the child last wrote, and the timeout message says either `it printed nothing` or `last output Xs before the timeout`. No early kill: a quiet build is not a hung build.                                                                                                    |
| Bounding a model-supplied foreground timeout.                                                                                         | Claude Code `BashInput.timeout` ("max 600000") in `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts`; Cursor `command_run_timeout_ms`.                                                                                                                                                       | `timeout_ms` reached the process verbatim: a large value blocked the turn for an hour, and a negative one hit `runProcess`, where `<= 0` means no timeout at all.                                                                                                                                                                                                                    | **Adopt**: foreground requests above 600,000ms clamp to it and the timeout message says the request was capped; non-numeric, zero, and negative values take the default instead of disabling the timer.                                                                                                                                |
| Searching text that contains regex punctuation.                                                                                       | Qoder `Grep` field `fixed_strings` (runtime constant table, `https://docs.qoder.com/cli/tools.md`); ripgrep `-F`.                                                                                                                                                                                                   | `search_code` always compiled the pattern as a regex: `foo(`, `a.b`, or `split(unclosed` matched the wrong lines or returned `Invalid regex pattern` with no way forward.                                                                                                                                                                                                            | **Adopt** as `fixed_strings`: the pattern is escaped and rg runs with `-F`; an invalid regex now names that flag in its error.                                                                                                                                                                                                         |
| Disclosing that a search stopped at its result cap.                                                                                   | Qoder `Grep` fields include `head_limit` and `offset` (runtime constant table, `https://docs.qoder.com/cli/tools.md`); Claude Code `GrepInput.head_limit` (default 250) in `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts`.                                                               | `search_code` returned the first N matches with no marker; a capped list read as exhaustive, which turns "I found every call site" into a false claim. `list_directory` already said `(limit reached)`.                                                                                                                                                                              | **Adopt** the disclosure: the result names the cap it hit and how to see the rest. **Defer** `offset` paging until a real run needs page two.                                                                                                                                                                                          |
| One hot file taking the whole search budget, and a search scoped to a single file.                                                    | Qoder `Grep` fields `max_matches_per_file` and `total_max_matches` (runtime constant table, `https://docs.qoder.com/cli/tools.md`).                                                                                                                                                                                 | `--max-count min(limit,50)` let one bundled file spend the whole 50-line budget, so the three real call sites elsewhere never appeared. Separately, `path: 'src/x.ts'` returned "No matches found" for a file that matched: the child got a file as `cwd` (spawn ENOTDIR), and rg drops the path prefix when the target is one file, so the `path:line:` parser discarded every row. | **Adopt** both: when a content search overflows its budget, each file keeps at most a quarter of the cap (min 3, or `max_matches_per_file`), and the result names the files that stopped there; a result that fits stays complete. The single-file path is fixed at the same time, in the rg path, the JS fallback and `search_files`. |
| Editor-backed diagnostics (`read_lints`, `fix_lints`) and semantic codebase search (`semantic_search_full`, `deep_search`).           | Cursor protobuf `main.js`; Qoder IDE "Find problems" and "Search codebase" (<https://docs.qoder.com/user-guide/chat/tools.md>).                                                                                                                                                                                     | No LSP and no embedding index; `search_code` is ripgrep over the workspace and verification runs through `run_tests`/`exec`.                                                                                                                                                                                                                                                         | **Defer**: both need a server Moss does not run.                                                                                                                                                                                                                                                                                       |
| Parameter names that arrive in the other harness's spelling.                                                                          | Claude Code `AskUserQuestionInput` declares `multiSelect` (camelCase) in `sdk-tools.d.ts`; Qoder's runtime table uses `multiSelect` too, while Moss declares `multi_select`. Claude Code `FileReadInput`/`BashInput` use snake_case, so one model emits both.                                                       | `validateToolInputObject` checked declared parameters and dropped undeclared ones: `timeoutMs` or `multiSelect` vanished, so the call ran with the default and the model believed it had set a value.                                                                                                                                                                                | **Adopt**: an undeclared key that normalizes (case, `_`, `-`) onto a declared parameter is moved to it before the required and type checks, so the value is used and still type-checked.                                                                                                                                               |
| Per-request rule injection (`fetch_rules`).                                                                                           | Cursor protobuf `main.js`.                                                                                                                                                                                                                                                                                          | Rules come from `AGENTS.md`/`CLAUDE.md` and `.moss/` on disk at session start.                                                                                                                                                                                                                                                                                                       | **Defer**: no server-side rule store to fetch from.                                                                                                                                                                                                                                                                                    |

The two adopted rows are implemented in `src/tools/builtin.ts` (exec) and `src/tools/file-tools.ts`
(`applyPreciseEditToContent`), and locked by `test/exec-events.spec.mjs`,
`test/multi-edit.spec.mjs` and `test/builtin-tool-surface.spec.mjs`.
