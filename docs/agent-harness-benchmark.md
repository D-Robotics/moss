# Moss Agent Harness Real-World Benchmark

`benchmarks/agent-harness-real-world.mjs` is the product acceptance backlog for Moss. It contains exactly 200 scenarios across 20 categories, distilled from recurring issue and support themes in OpenClaw, Hermes Agent, Claude Code, and Codex.

`benchmarks/agent-harness-source-index.mjs` records concrete, high-interaction issues used to ground those themes. `benchmarks/agent-harness-results.json` is the evidence ledger; fixture-only results are intentionally distinct from passes on real hardware or a real browser.

## What This Is

- A list of user outcomes and failure modes, not a checklist of framework features.
- A shared contract for CLI UX, agent behavior, tools, recovery, robotics, and the developer API.
- A source for manual PTY/device/browser runs and future automated fixtures.

Each case records its priority, required execution mode, source communities, expected evidence, forbidden behavior, and current run status.

## Categories

Installation, provider/auth, repository understanding, bug fixing/TDD, refactoring/review, Git/CI, web research, browser/visual work, long loops, BTW/steering/queueing, context/tokens/cost, MCP/skills/plugins, shell processes, permissions/security, robotics/device work, subagents/concurrency, recovery/network, TUI/accessibility, developer API, and artifacts/docs.

## Validation

```bash
node scripts/check-agent-harness-benchmark.mjs
```

The check fails unless there are exactly 200 unique cases, 20 categories with 10 cases each, valid priorities, source references, and explicit positive/negative acceptance signals.

## Execution Policy

1. Run P0 cases first.
2. Use a real PTY for TUI, queue, BTW, permission, and interruption behavior.
3. Use controlled fixtures for destructive, offline, timeout, and concurrency paths.
4. Use a real board for device cases; do not treat fake SSH as proof of camera, ROS, CAN, or accelerator behavior.
5. Record duration, tool count, outcome, failure class, and evidence before marking a case passed.
6. A passing unit test is supporting evidence, not a substitute for the user-visible workflow.

The benchmark intentionally starts with `status: not-run`. Moss should earn the pass state through repeatable execution rather than marking capabilities complete from source inspection alone.
