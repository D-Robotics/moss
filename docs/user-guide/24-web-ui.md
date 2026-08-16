# Moss Web workspace

The Web workspace is the lowest-friction way to use a configured Moss runtime while keeping model
credentials in the local Node.js process.

## Start

```bash
moss setup
moss web
```

Open `http://127.0.0.1:3080`. To select another port, run `moss web 4080`.

## What the screen proves

- **Timeline** streams the assistant response instead of waiting for the whole turn.
- **Tool cards** show tool start, completion, result, and failure state.
- **Stop** aborts the active model/tool turn.
- **Capabilities** comes from the live tool registry and redacted plugin inspector; it is not a
  hard-coded marketing list.
- **Recent runs** comes from an ordered task ledger. It distinguishes execution status, evidence
  count, and verification instead of treating a fluent model answer as proof.

The server binds to loopback by default, rejects non-local mutation origins, sets a restrictive
Content Security Policy, and never sends provider configuration or credentials to the browser.

## Long tasks

State the desired artifact and verification condition in the first prompt. Keep the timeline open to
inspect tool evidence, and use Stop when the direction is wrong. Moss's goal, background-task,
sub-agent, completion-gate, and session systems remain the same runtime used by the CLI; the Web
workspace is a presentation adapter, not a second agent implementation.

Each submitted task receives a durable run ID when a workspace directory is configured. Moss
records model execution, tool start/result evidence, cancellation, and terminal status in
`.moss/task-runs.jsonl`. If the host stops during active work, the next start records the run as
`interrupted`; it never rewrites it as completed. `completed / unverified` is an honest state: the
agent produced an answer, but no trusted completion verifier supplied a verdict.
The ledger keeps tool identity and outcome metadata, not tool inputs or result bodies.

## Capability showcase

From a repository checkout, run:

```bash
npm run demo:capabilities
```

The deterministic built-artifact showcase installs a runtime plugin, loads its inline Skill, calls
its evidence tool, delegates an independent review to a host-trusted read-only expert, executes the
workflow through the Web HTTP/NDJSON transport, and then reads the ordered task ledger. It exits
non-zero if any contribution was not used or if the final answer was not grounded in both results.

## Current limits

- Durable session browsing and fork/rewind controls are planned rather than silently approximated.
- Plugin hot reload is not exposed until active tool-call leases and quiescent unload are complete.
- Remote binding and multi-user authentication are intentionally absent from this local-first slice.
