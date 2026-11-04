# Hooks

Hooks run a shell command at lifecycle points so an installation can enforce
rules the model cannot override. Configuration lives in the user config
(`~/.config/moss/config.json`) or a project `.moss/config.json`:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "write_file", "command": "node scripts/deny-prod.mjs" }],
    "Stop": [{ "command": "node docs/hooks/stop-verified-completion.mjs" }]
  }
}
```

Each entry is `{ command, matcher?, if?, timeoutMs?, blocking?, format? }`, or
`{ type: "http", url, headers?, … }` for a webhook handler.
`matcher` narrows tool events to a tool name: `*`, an empty value, or an omitted
matcher matches every tool; a plain name (`exec`) is an **exact** tool name, and
`|`/`,` separates alternatives (`exec|exec_logs`); anything containing another
character is an unanchored JavaScript regex (`^exec`, `mcp__memory__.*` — note
`mcp__memory` alone is an exact name that matches no tool). `blocking: false`
makes a hook advisory (it runs, but cannot block). `format: "claude"` switches to
Claude Code's exit-code convention (block only on exit 2) and also accepts
Claude's tool names (`Bash`, `Edit`, …) in the matcher.

Two handler types: `command` (default) spawns a shell command and writes the JSON
payload to stdin; `http` POSTs the same JSON to `url` (extra `headers` allowed)
and treats the response body exactly like command stdout. A 2xx response is a
success, so `{ "decision": "block" }` in the body blocks; any other status counts
as a non-zero exit, which for a blocking event denies (fail-closed) and for an
advisory event is only reported. A webhook hook has no `command` and the `format`
field only applies to command hooks.

`if` narrows further with permission-rule syntax (`"exec(git *)"`,
`"read_file(.env)"`), evaluated against the tool name and its primary operand
(command for `exec`/`device_exec`, path for file tools). It only applies to tool
events: on `SessionStart`/`Stop`/… a hook with `if` is removed with a notice, and
a malformed spec skips the hook (again with a notice) instead of matching every
call.

## Events

| Event                | Fires                                             | Blocking semantics                                              |
| -------------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| `PreToolUse`         | before a tool runs                                | non-zero exit blocks; exit 0 may return `updatedInput`          |
| `PostToolUse`        | after a tool runs (success or failure)            | advisory (reported, cannot undo the call)                       |
| `PostToolUseFailure` | after a tool call that failed (`isError`)         | advisory; same payload as `PostToolUse` with `isError: true`    |
| `UserPromptSubmit`   | after the user submits, before the run            | non-zero exit (or `{decision:"block"}`) rejects the prompt      |
| `PermissionRequest`  | when an approval prompt would be shown            | `deny` is honored; `allow` is ignored so the user still decides |
| `PermissionDenied`   | a tool call was denied                            | advisory                                                        |
| `SessionStart`       | session opens                                     | advisory                                                        |
| `Stop`               | after every completed run, before it ends         | non-zero exit vetoes the stop → headless exits 9 (Incomplete)   |
| `SubagentStart`      | before a subagent starts                          | advisory                                                        |
| `SubagentStop`       | a subagent finished                               | advisory                                                        |
| `PreCompact`         | before compaction splices the transcript          | advisory                                                        |
| `PostCompact`        | after compaction                                  | advisory                                                        |
| `SessionEnd`         | CLI exits                                         | advisory                                                        |
| `Notification`       | the CLI needs attention (e.g. an approval prompt) | advisory                                                        |

Hook payloads are JSON on stdin with `event` plus event-specific fields; tool
events add `toolName`/`toolInput`, and `Stop` adds `stopReason` and the last
4,000 characters of `response`. Hook `stdout` is shown to the model as context
for blocking events; hook `stderr` becomes the block reason.

**Fail-closed:** a hook that cannot start, times out, or throws is treated as a
deny, and `Stop` ignores non-JSON noise on stdout — a broken hook cannot quietly
approve a run.

## Recipe: do not end a run over an unverified change

[`docs/hooks/stop-verified-completion.mjs`](hooks/stop-verified-completion.mjs)
reads the latest `.moss/review.jsonl` record and exits 2 unless the verdict is
`pass`. Combine it with `review.mode: "auto"` so the review actually happens:

```json
{
  "review": { "mode": "auto" },
  "hooks": {
    "Stop": [{ "command": "node docs/hooks/stop-verified-completion.mjs", "timeoutMs": 5000 }]
  }
}
```

Real behavior (verified in this repo): with a FAIL review on record, a headless
run that edits files ends with exit code 9 and `[hooks] review gate: …` on
stderr; with a PASS review on record the same run exits 0. Interactive sessions
render the same veto and offer one continuation turn instead of exiting.

For a CI-shaped gate that needs no agent run at all, use `moss review check`
(exit 0 pass / 1 unresolved findings / 2 unreviewed) — see AGENTS.md.
