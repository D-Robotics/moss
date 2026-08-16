# Background Tasks

Moss runs long-lived processes (dev servers, test suites, watchers, builds)
without blocking the conversation. The agent starts a command in the
background, gets a handle id, and checks on it later.

## Start a background command

```text
exec_background  command="npm run dev"  label="vite"  settle_ms=1200
  → Started bg_1 (pid 12345). Still running after 1200ms.
```

Parameters: `command` (required), `label`, `settle_ms` (default 1200, max
10000), `progress_interval_ms` (optional — periodically broadcast recent
output + runtime to the conversation). The `settle_ms` window watches for an
immediate crash before returning — if the process exits within the window,
you see the exit code + output instead of a false "running".

## Check status and output

```text
exec_logs                       # list all background processes
exec_logs  id="bg_1"  tail=100   # status + last N output lines (default 100, max 1000)
```

A background process that finishes is surfaced to the user (a completion
notice in the TUI / a system line in one-shot) — you don't have to poll.

## Wait on multiple at once

```text
exec_wait  ids=["bg_1","bg_2"]  mode=wait_all  timeout_ms=30000
exec_wait  ids=["bg_1","bg_2"]  mode=wait_any  timeout_ms=30000
```

`wait_all` (default) resolves when every id finishes; `wait_any` resolves
when the first does. `timeout_ms` defaults to 30000 (clamped to min 1000,
max 120000); `ids` is capped at the first 20. Returns each id's status + a
fixed 20-line output tail (there's no `tail` parameter on `exec_wait` — use
`exec_logs` for more). Unknown IDs are reported (a typo doesn't hang the
wait). Use this to coordinate parallel dev servers / test suites / builds
instead of polling `exec_logs` one id at a time.

## Stop a background command

```text
exec_stop  id="bg_1"
```

Sends `SIGTERM`, then `SIGKILL` after a short grace period (terminates the
process group on POSIX).

## One-shot and exit

In one-shot / piped mode, Moss waits briefly (~1.5s) for background
processes to finish before exiting, so you don't miss a completion notice.
Long-running background processes still running at exit are listed (Moss
does not keep monitoring them after the process exits).

## Common use cases

- **Dev server**: `exec_background command="npm run dev"` — keep coding while
  it runs; `exec_logs id="bg_1"` to check the URL/output.
- **Test suite**: `exec_background command="npm test"` — get notified when it
  finishes; `exec_wait` to block on it.
- **Build**: `exec_background command="npm run build"` — `exec_wait` to
  coordinate build + tests together.

See the [user-guide index](README.md) for other topics.
