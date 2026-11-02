# Moss Super-agent acceptance

Date: 2026-11-02. Branch: `codex/moss-superagent`.
Base: `7e6673de2738cb08296d3184720c4f55bed0a910` (Moss main 0.28.0).
Result: PASS for the specified local CLI/SDK scope. All A1–A8 criteria accepted.

Environment: macOS Darwin 25.6.0 arm64, Node 24.21.0. QA uses a temporary Python venv (pyte 0.8.2), the real Git 2.50.1 binary from CommandLineTools, and temporary cc/gcc launchers selecting the installed MacOSX15.4 SDK. These launchers invoke real Clang; a compiled C program ran and printed MOSS_REAL_C_OK. The default MacOSX27 SDK is incompatible with this machine's linker, and renaming `/usr/bin/git` renames Apple's launcher rather than a real Git executable. No system settings or benchmark result data were edited to address those host issues.

## What was exercised

All execution fixtures used disposable committed Git repositories and local scripted providers. The HTTP fixture implements the normal OpenAI-compatible protocol and drives actual CLI bootstrap, a separate Node worker, native `read_file`/`write_file`, the native inbox/session store, Task Runtime and two independent acceptance executions. No external service, user checkout, real device or paid model was used for acceptance.

| Spec | Evidence                                                                                                                                                                                                                                                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | Real pinned upstream Engine creates a mandate/ticket. Stable event IDs deduplicate across reopening; altered contents under an existing ID are rejected.                                                                                                                                                                                                                                           |
| A2   | Unlisted actors, bots/context-only requests and unknown sources launch no worker. Observe records would-accept; auto requires matching configured rule IDs. Invalid assessment fails closed.                                                                                                                                                                                                       |
| A3   | Actual CLI worker changes answer.txt from 0 to 42 in its own Git worktree; parent remains 0 and its full Git status stays clean, including private controller state. Native task events include acceptance_pass and status exposes the session/task binding.                                                                                                                                       |
| A4   | Invented native task/ready summary is blocked. An accepted native task whose file changes before controller verification is blocked. Existing mandates retain their original command across policy replacement.                                                                                                                                                                                    |
| A5   | Two real native child processes run independently: stopping one cancels it while the other completes. Pause survives a second connection. Follow-ups replay idempotently through the native inbox; late unread input blocks completion. A completed ticket resumes in the same worktree/session with another verified native task.                                                                 |
| A6   | Reopened state retains policy, local replies and bindings. A fault-injected persisted running marker is blocked without replay; explicit retry reuses its workspace/session. A lost acknowledgement that leaves the controller pointing at an older native round is refused without another model call. This is deterministic recovery fault injection, not a power-loss durability certification. |
| A7   | Help/uninitialized status run without model credentials. Invalid commands, extra arguments and inappropriate flags fail. Manual approval requirements prevent an unattended native write; no policy override file remains after normal shutdown.                                                                                                                                                   |
| A8   | Vendored file checksums, dependency closure and upstream notice checked. Full package verification, CLI/PTY smoke and all three SDK examples passed, with 19 focused integration/provenance scenarios.                                                                                                                                                                                             |

## Commands

- `npm ci --ignore-scripts --no-audit --no-fund` — passed; no new runtime dependency.
- `npm run build` — passed, including the unmodified baseline before implementation.
- `node scripts/run-package-tests.mjs --filter superagent` — PASS: 3 files, 19 scenarios; includes real worker cancellation, scheduler ownership, private state Git exclusion and native-round recovery.
- `npm run verify` — PASS, exit 0: formatting, ESLint (zero warnings), typecheck, build, 440 package spec files and CLI/PTY smoke.
- Final verification environment: `PATH="/tmp/moss-superagent-qa-bin:/tmp/moss-superagent-qa-venv/bin:/Library/Developer/CommandLineTools/usr/bin:$PATH" npm run verify`.
- `npm run examples` — PASS, exit 0: headless-run, repl-host and custom-tool-approval (ALLOW/DENY audit).

## Limits and recovery

Acceptance runs on macOS with the installed Node runtime. The suite retains its existing expected TODO and opt-in terminal skips; MOSS_REAL_TERMINALS was not enabled, so live tmux/GNU screen/Terminal.app checks were not run. Python layout checks were run with pyte and were not skipped. Linux/Windows and the minimum Node 22.16 build are delegated to the existing CI matrix and are not claimed as locally tested. No live DeepSeek/other remote-model performance, robotics acceptance, GitHub/Feishu connector or Web UI is claimed.

Workers use Moss workspace-write/manual safety plus operator allow/deny rules and a read-only ceiling when applicable. A Git worktree is not an OS sandbox. The trusted acceptance command can execute arbitrary operator-selected shell code and must be repeatable; model prose never supplies or replaces it. The SQLite store is a local single-user host, not a multi-tenant service. No automatic merge, push, device action or external reply transmission occurs in this feature's controller.

One scheduler owns the database. Stop/cancellation cooperates through IPC, with a bounded termination fallback. Uncertain execution requires explicit retry. A crash during worktree creation can leave an unbound directory: the runtime refuses to adopt it automatically; inspect Git worktree state and preserve any work before retrying. Completed worktrees are retained for manual review/integration. Controller state has its own create-once .gitignore; existing user ignore files and Git metadata are never rewritten.

Rollback removes/disables the optional entry points; preserve `.moss/superagent/` and ticket worktrees to retain evidence and user changes. Existing Moss task/chat data is unchanged.
