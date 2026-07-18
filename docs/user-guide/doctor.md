# Doctor

`moss doctor` is a health check — the first thing to run when something feels
off. It inspects config, auth, workspace, runtime, the search backend, MCP,
skills, and update state, and prints an `ok` / `warn` / `fail` line per check.

```sh
moss doctor
```

In-session, `/doctor` runs the same check.

## What it checks

| Check | What it reports |
|---|---|
| `node` | Node version meets the minimum (≥ 22.16) |
| `version` / `auth` / `provider` / `model` | current config + where each came from |
| `context window` / `max output` | probed or pinned token budget (warns if unprobed) |
| `base url` / `workspace` / `runtime` / `config` | resolved paths + writability |
| `search` | whether ripgrep (rg) is on PATH (warns if absent — `search_code` falls back to a slower in-process walk) |
| `approval policy` | the active safety + approval policy (warns on full-access + auto-approve both on) |
| `skills` | how many skills are loadable |
| `mcp` | configured MCP servers + connection status |
| sessions | integrity of saved JSONL sessions |

## Reading the output

Each line is one of:

- `  ok    <label>  <detail>` — fine.
- `  warn  <label>  <detail>` — works, but you should know (e.g. rg not found; context window unprobed; full-access enabled).
- `  fail  <label>  <detail>` — blocks normal use (e.g. missing API key with no built-in default; unwritable workspace).

A `fail` line means moss cannot run normally until you fix it; a `warn` means
degraded but functional. Run `moss doctor --verbose` for per-file detail on
session-integrity warnings.

## Common warnings and fixes

- **`warn  search: ripgrep (rg) not found on PATH`** — install `rg` (`brew
  install ripgrep` / `apt install ripgrep`) for fast, `.gitignore`-aware
  search. Without it, `search_code`/`search_files` use a slower in-process
  walk.
- **`warn  context window: not yet probed`** — run `/model` to auto-probe, or
  pin `agent.contextTokens` in config.
- **`warn  approval policy: full-access and auto-approval both enabled`** —
  prefer `workspace-write` or `prompt` unless the workspace is fully trusted.
- **`fail  auth: missing API key`** — run `moss setup`, or use the built-in
  model (no key needed).

See the [user-guide index](README.md) for other topics.
