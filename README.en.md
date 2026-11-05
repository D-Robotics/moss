<div align="center">

# Moss

**One intent → one task → one verified result.**
Not "the model says it is done" — "the acceptance command says it is done". For code, and for real robots.

[![npm](https://img.shields.io/npm/v/@rdk-moss/agent.svg)](https://www.npmjs.com/package/@rdk-moss/agent)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22.16%2B-339933.svg)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey.svg)](#support-matrix)

[中文](README.md) · **English**

</div>

```bash
npm install -g @rdk-moss/agent@latest
moss setup
moss run "create hello.txt containing MOSS_OK, then verify it" --accept "grep -qx MOSS_OK hello.txt"
```

A real run (deepseek-flash, local machine; 10.7s measured this time):

```text
◇ Working out the steps
◇ Checks passed
Task task_mw3vvoef_0f83qm — PASS
phase: accepted · attempts: 1 · repairs: 0 · failures: 0 · turns: 1
```

`PASS` does not come from the model's own prose. It comes from the acceptance command exiting 0.
That is the difference: **no evidence, no completion.**

- **Machine-checkable completion** — intent compiles into a task state machine with an acceptance command; only the verdict provider can pass it
- **Real hardware in the loop** — SSH into RDK / Linux boards so deploy → run → measure → verify all leave evidence
- **Four surfaces, one semantics** — TUI · REPL · headless (scripts/CI) · SDK (semver-protected)

## Why Moss

A normal coding agent's "done" is the model claiming it is done. Moss turns that judgement into an
auditable machine flow:

```text
task_define (goal + machine-checkable acceptance)
  → execute (edit files / run tests / SSH to the board)
  → record_evidence (structured Expected / Observed / Result)
  → task_acceptance (verdict matched against the latest evidence)
```

- **Only a verdict provider can pass** (acceptance command > task contract); model prose is never an event
- No evidence means incomplete; `latest-wins` re-checks after repairs; an exhausted repair budget is an honest FAIL with a resume command
- Every task runs the same event-driven state machine: `planning → executing → verifying → diagnosing → repairing → accepted | failed | blocked`
- All artifacts land in `.moss/`: reproducible, auditable, readable by CI

The same core lets "done" happen on **real hardware**: SSH into RDK / Linux boards so deploy, run,
measure and verify stay inside the loop — something IDE-only agents cannot do.

## Get started

**1. Install (one line, Node ≥ 22.16):**

```bash
npm install -g @rdk-moss/agent@latest && moss setup
```

Prerequisites, upgrade/uninstall, proxies, Windows and custom gateways: [Install & runtime](docs/install.md).

**2. Pick a surface:**

| What you are doing                      | Use this                                       |
| --------------------------------------- | ---------------------------------------------- |
| Chat and watch edits stream             | `moss` (full-screen TUI; REPL without a TTY)   |
| Ask once                                | `moss "summarize this repo's architecture"`    |
| Need a **verified result**              | `moss run "<intent>" --accept "<cmd>"`         |
| Hand it to a script / CI                | `moss -p "..."` · `moss run ... --json`        |
| Repeat until an external command passes | `moss loop --until "npm test" "fix the tests"` |

**3. Your first verified completion:**

```bash
moss run "create hello.txt containing MOSS_OK" --accept "grep -qx MOSS_OK hello.txt"
moss runs                              # one ledger for every autonomous run: status / reason / next
moss task status --json                # the same facts, for scripts and CI
```

## Handfeel

The interaction goal is: **safe to let it run, always interruptible, resumable after a stop, reversible when wrong.**
A run's lifecycle is five predictable stages — `understand → plan → execute → verify → repair`. Any stage can be
stopped; the state lives on disk and `resume` continues from the breakpoint instead of re-running.

| You want to                  | Do this                                                             | What you get                                                                     |
| ---------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Change permission mode (TUI) | `Shift+Tab` (status bar shows `manual / acceptEdits / plan / full`) | From ask-everything to ask-less, back to strict at any time                      |
| Stop the current action      | `Esc`                                                               | Completed work is kept; `Ctrl+C` in a task run **pauses, never discards**        |
| Resume a paused task         | `/goal resume` / `moss task resume <id>`                            | Continues from disk state, no re-run of finished turns; budget optional          |
| Undo this turn               | `/rewind`                                                           | Files return to the checkpoint and this turn leaves the context too              |
| See/review changes           | `/diff` · `/review`                                                 | Working-tree diff · independent review with critical/important/suggestion        |
| Manage context               | `/compact` · `/todos` · `/context`                                  | Compress history, watch the plan, inspect the window                             |
| After a long run             | just ask                                                            | The next chat turn carries the task id, failure reason and resume command (once) |

Failures print a reason **and** the next command; `moss doctor` checks the install and
`MOSS_STARTUP_TIMING=1` shows which startup phase is slow.

## Capabilities

**Write code.** The agent loop handles turns, compaction, nudges and loop guards; **51 built-in
tools** cover read/write/patch/search, processes and background jobs, web fetch/search, type and
lint diagnostics, test running, sub-agents and task contracts. Write tools go through approvals;
sessions can be saved / searched / exported / forked. **13 device tools** bring SSH hardware work
into the same evidence and acceptance model; `moss device fleet` inspects many boards in one command.

**Long runs.** `/goal` and `moss run` share one task state machine; `moss loop` repeats
"run → check with your command → feed failures back"; `moss task status|timeline|list` are the
offline read paths; a resumed task verifies the workspace first and only then spends execution
turns. Write sub-agents can run in isolated git worktrees and merge back as three-way patches.

**Extend.** MCP client (stdio + streamable HTTP, lazy-loaded tools), lightweight skills (progressive
disclosure), custom slash commands, file-defined sub-agents, lifecycle hooks, local capability packs
(plugins); board manuals come from the bundled rdk-docs MCP.

**Embed & automate.** The last line of `-p` is a contract: only `accepted` exits 0, and
"unverified" vs "incomplete" are distinguishable (exit 9). `--output-format json|stream-json` feeds
CI; the `src/index.ts` export surface is semver-protected, and `examples/` are runnable integrations.

## Real hardware

```bash
moss device add rdk-01 192.168.1.10 --user root --kind rdk
moss device test rdk-01
moss device fleet info --devices rdk-01,rdk-02 --concurrency 4

# swap `--accept` for your own checker: exit 0 passes, anything else is incomplete
moss run "hold the camera pipeline at 30 FPS for 60s: deploy, run, record evidence, verify" \
  --accept "python3 bench/check_fps.py --min 30"
```

Board-side inference dependencies (hobot_dnn / TROS): [RDK board deps](docs/rdk-board-deps.md).

## Compared to the best products

|              | Moss                                  | Claude Code              | Cursor           |
| ------------ | ------------------------------------- | ------------------------ | ---------------- |
| Form         | terminal TUI / REPL / headless / SDK  | terminal + IDE plugin    | IDE-first        |
| Completion   | **acceptance command / evidence**     | model judgement + hooks  | model judgement  |
| Long runs    | task state machine + ledger + resume  | conversation context     | agent panel      |
| Real robots  | **native SSH deploy-measure-verify**  | none                     | none             |
| Account/data | local-first, no account, no telemetry | account required         | account required |
| Embeddable   | semver-protected SDK                  | headless output contract | none             |

Moss is not trying to be an IDE. It is a **runtime for verifiable execution**, which is why it works
as an everyday coding agent and as the verdict layer inside a robotics loop.

## Quality

```bash
npm run check    # prettier + eslint(0 warnings) + typecheck
npm run verify   # delivery gate: static + build + smoke + examples, budget ≤60s
npm run bench    # capability baseline (DeepSeek base model); bench:swe / bench:deepswe / bench:device
```

Behaviour is not "looks right in review": key user-visible behaviours have re-runnable probes
(`scripts/verify/stages/*`, including PTY terminal behaviour and offline task-engine scenarios), so a
regression turns `npm run verify` red. Model-level regressions are covered by `npm run bench` and the
nightly matrix; see [release policy](docs/release-policy.md).

## Support matrix

| Dimension | Supported                                                    | Verified by                                   |
| --------- | ------------------------------------------------------------ | --------------------------------------------- |
| Node      | ≥ 22.16.0                                                    | fast gate 22.16 + deep matrix (3 OS, Node 24) |
| Platforms | Linux / macOS / Windows                                      | same verify command; Windows has no PTY smoke |
| Providers | deepseek / qwen / openai / anthropic / openai-compatible     | smoke + examples                              |
| Surfaces  | TTY: TUI; non-TTY / `MOSS_NO_TUI=1` / Windows: readline REPL | PTY smoke (macOS/Linux) + TUI bench           |

## Safety & privacy

Default `full` means "ask less", not "check less": deny rules and hard local blocks always win, destructive device
operations still ask, and `--read-only` is a ceiling over every mode. No account, no cloud, no telemetry; the
provider is a plain HTTP endpoint; credentials come only from `.env` or the environment. The shell has no OS
sandbox by default (optional seatbelt / bubblewrap) — see [Safety & privacy](docs/safety.md).

## Known limits

- "Unverified" and "incomplete" both exit 9; scripts must read the last line to tell them apart
- `workspace-write` constrains Moss's own file tools, not shell subprocesses
- Edits made by sub-agents and background jobs do not enter `/rewind` checkpoints
- Board-side inference dependencies are not installed automatically ([RDK board deps](docs/rdk-board-deps.md))
- No PTY smoke on Windows; version/tag policy in [release policy](docs/release-policy.md)

## Documentation

- [Install & runtime](docs/install.md) · [Safety & privacy](docs/safety.md) · [CLI & config reference](docs/cli-reference.md)
- [RDK board deps](docs/rdk-board-deps.md) · [Capability layer (MCP / device / skill)](docs/capability-layer.md)
- [AGENTS.md](AGENTS.md) (engineering contract) · [CHANGELOG](CHANGELOG.md) · [Release policy](docs/release-policy.md)
- [CLI parity baseline vs Claude Code / codex](docs/cli-parity/) · [Design records](docs/superpowers/plans/)

## License

MIT — see [LICENSE](LICENSE).
