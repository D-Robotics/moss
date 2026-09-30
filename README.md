# Moss

**A minimal, cross-platform coding agent harness — and an Agent Task OS for robot development.**

> One Intent → One Task → One Agent Loop → One Verified Result.

Moss turns a sentence of intent into a state-machine task with machine-checkable
acceptance criteria, runs it through one agent loop, and refuses to call it done
without a verdict backed by recorded evidence. It talks to RDK / Linux robots over
SSH, so "done" can mean _the board actually did it_.

- TypeScript / ESM single package, Node ≥ 22.16.0, Linux / macOS / Windows
- No account, no cloud service, no telemetry — providers are plain HTTP endpoints

## What is in the box

| Area          | What you get                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent loop    | turn control, context compaction + budgets, nudges, loop guards, best-of-n / cross-review switches                                                                        |
| Tools         | 43 built-in tools: files, search, patches, processes, web, diagnostics, tests, sub-agents                                                                                 |
| Devices       | 12 SSH device tools (`device_info/processes/resources/temperature/network/cameras/robotics_status/file_read/file_list/exec/file_write/deploy`) against RDK / Linux boards |
| Task OS       | event-sourced task runtime (``.moss/*.jsonl`): draft → planning → executing → verifying → diagnosing → repairing → reverifying → accepted/failed                          |
| Acceptance    | `task_define` → `record_evidence` → `task_acceptance`; PASS can only come from a verdict provider, never from prose                                                       |
| Sub-agents    | scoped children, background + fan-out, worktree isolation with 3-way patch merge                                                                                          |
| Extensibility | MCP client (stdio + streamable HTTP, lazy tool loading), lightweight skills (`SKILL.md`)                                                                                  |
| Providers     | deepseek / qwen / openai / anthropic / openai-compatible                                                                                                                  |
| Interfaces    | full-screen TUI (Mission Control), readline REPL, headless CLI, embeddable SDK                                                                                            |

## Quick start

```bash
git clone https://github.com/D-Robotics/moss && cd moss
npm install
npm run build

node dist/cli.js --help          # CLI surface
node dist/cli.js                 # TTY: Mission Control TUI; non-TTY: readline REPL
node dist/cli.js --no-tty        # force the REPL
```

Provider credentials come from the environment or a local `.env` (never committed):

```bash
echo 'DEEPSEEK_API_KEY=...' > .env
```

## Headless and scripted use

```bash
# One-shot prompt
node dist/cli.js --print "summarize this repository"

# Run one task to a verdict (exit 0 only when accepted)
node dist/cli.js task run --goal "create hello.txt containing MOSS_OK and verify its content"

# Inspect the task timeline / acceptance trail
node dist/cli.js task status
node dist/cli.js task timeline
node dist/cli.js tasks
```

## Robot closed loop (RDK first)

```bash
export MOSS_DEVICE_HOST=<board> MOSS_DEVICE_PORT=22 MOSS_DEVICE_USER=root MOSS_DEVICE_PASSWORD=...
node dist/cli.js --print "define a task: camera pipeline keeps 30 FPS for 60s; deploy, run, record evidence, accept"
```

The agent picks device tools from the goal (capability discovery), records
Expected/Observed/Result evidence per criterion, and the acceptance gate blocks a
final answer that claims success without a verdict. Work products land in
`.moss/`: `tasks.jsonl`, `task-events.jsonl`, `evidence.jsonl`,
`deployments.jsonl`, `acceptance.jsonl`, `task-failures.jsonl`, `task-repairs.jsonl`.

## Embedding (SDK)

The export surface of `src/index.ts` is a semver-protected contract, locked by
`test/sdk-contract.spec.mjs`. See `examples/` for three runnable integrations:

```bash
npm run examples
```

## Quality gates

```bash
npm run check      # prettier + eslint + typecheck
npm run test       # build + every test/*.spec.mjs
npm run verify     # check + test + PTY smoke  ← required before any release
npm run smoke      # CLI smoke: --version / --help / PTY startup
```

Benchmarks (results stay out of git, in `bench/results/`):

```bash
npm run bench                                  # capability suite (bench/tasks/)
npm run bench:ab -- reasoning-high             # hard-tier A/B
npm run bench:swe -- --samples 3 --label base  # SWE-bench Verified subset
npm run bench:tb                               # Terminal-Bench board
node scripts/task-os-metrics.mjs               # Task OS product metrics (turns/tools/success)
```

## Documentation

- [`AGENTS.md`](AGENTS.md) — architecture, layering rules, subsystem map, conventions (the working contract)
- [`docs/release-policy.md`](docs/release-policy.md) — what a version/tag claims, and what it does not
- [`docs/superpowers/plans/`](docs/superpowers/plans/) — design and roadmap records

## License

See [`LICENSE`](LICENSE).
