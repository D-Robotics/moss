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

The server binds to loopback by default, rejects non-local mutation origins, sets a restrictive
Content Security Policy, and never sends provider configuration or credentials to the browser.

## Long tasks

State the desired artifact and verification condition in the first prompt. Keep the timeline open to
inspect tool evidence, and use Stop when the direction is wrong. Moss's goal, background-task,
sub-agent, completion-gate, and session systems remain the same runtime used by the CLI; the Web
workspace is a presentation adapter, not a second agent implementation.

## Current limits

- Durable session browsing and fork/rewind controls are planned rather than silently approximated.
- Plugin hot reload is not exposed until active tool-call leases and quiescent unload are complete.
- Remote binding and multi-user authentication are intentionally absent from this local-first slice.
