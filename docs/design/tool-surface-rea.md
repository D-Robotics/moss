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
| `exit_plan`                                                                                                           | keep, env-gated                      | Qoder `ExitPlanMode`                                                                                                                                            | —                                                                                                      |
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
| Serialized declaration payload | 25,052 bytes | 23,573 bytes (−5.9%) |

"Registered" counts the `builtinTools` modules; `registerBuiltinTools` installs 44 of them, and 43
when the plan gate is off (it skips `exit_plan`).

The payload shrink is smaller than the name count shrink because `edit_file` now carries the
`edits[]` batch schema that `multi_edit` used to hold, and the two schemas cost about the same. The
saving is in the removed modules (`repo_outline`, `code_diagnostics`) and the duplicate shell entry.

Measured with the same harness as the baseline (`test/builtin-tool-surface.spec.mjs` asserts the
counts and the payload ceiling so the next addition has to update this table).
