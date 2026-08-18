# Moss Web workspace

The Web workspace is the lowest-friction way to use a configured Moss runtime while keeping model
credentials in the local Node.js process.

## Start

```bash
moss setup
moss web
```

Open `http://127.0.0.1:3080`. To select another port, run `moss web 4080`.

The React workbench uses one responsive three-column layout: sessions on the left, conversation in
the center, and runtime/tool details on the right. Narrow desktop and tablet widths collapse the
detail rail and then the session rail instead of switching to a separately styled interface. Light
and dark themes share the same `--moss-*` design tokens, focus treatment, state colors, and reduced
motion behavior.

## What the screen proves

- **Timeline** streams the assistant response instead of waiting for the whole turn.
- **Tool cards** show tool start, completion, result, and failure state.
- **Stop** aborts the active model/tool turn.
- **Capabilities** comes from the live tool registry and redacted plugin inspector; it is not a
  hard-coded marketing list.
- **Recent runs** comes from an ordered task ledger. It distinguishes execution status, evidence
  count, and verification instead of treating a fluent model answer as proof.
- Selecting a recent run opens its durable event timeline. The list is keyboard accessible, and the
  detail endpoint supports sequence cursors for incremental recovery.
- **Settings** exposes Runtime, Models, Permissions, and Plugins using the same controls and density
  as the conversation surface. Credential values are process-owned and are never returned.
- **Sessions** can be searched, resumed, renamed, exported, explicitly deleted, forked, or rewound
  into a new non-destructive branch. Draft, scroll, details, and panel state are retained per task.
- **Interaction controls** present approval and user questions in the composer, and expose the same
  plan/default/accept-edits policy, Goal, Todo, queue, steering, workflow, job, model, Skill, and
  sub-agent inventories owned by the configured runtime.
- **Attachments** upload bounded UTF-8 text or signature-checked images into an instance-local
  store. Generated workspace files are copied through a realpath-contained artifact endpoint before
  download; a browser-supplied path is never opened as an arbitrary host path.
- **Plugins** can be installed, diagnosed, configured, enabled, disabled, and removed without
  restarting the Web server. UI modules receive typed slot ownership and the Moss controlled
  component entry instead of defining a parallel theme.

The server binds to loopback by default. Every mutation requires the exact Host, same Origin, and a
random per-server CSRF token obtained by the bootstrapped same-origin client. It sets a restrictive
Content Security Policy and never sends provider configuration or credential values to the browser.
API keys and plugin secrets are write/delete-only; status responses reveal only whether a value is
configured.

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
If the browser loses its connection, Moss announces the offline state, retains the durable timeline,
and retries the local runtime connection. This is browser-to-local-runtime recovery; remote hosting
still requires a separate authentication and tenancy threat model.

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

- Remote binding and multi-user authentication are intentionally absent from this local-first slice.
- Third-party JavaScript plugins are explicitly trusted code. Worker containment makes a stuck
  import/setup/call terminable, but it is not a permissions sandbox; a plugin can still use its Node
  process authority and an advanced browser module runs in the same page origin.
- Native DeepSeek Harness Cordis runtime/client modules are not ABI-compatible with Moss. Moss can
  import only an audited package's declarative `SKILL.md` or explicit Moss adapter data; unsupported
  client slots fail closed.
- The previous compact Web surface remains available at `/?legacy=1` for one release cycle as a
  rollback path. It uses the current CSRF/session APIs and will be removed after that window.
