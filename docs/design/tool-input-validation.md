# Tool input validation at the execution boundary

Tool arguments are checked against the declared JSON Schema before execution,
including after global hooks, per-tool hooks, approval rewrites and derived task
observation inputs. Nested properties, array elements, string and numeric bounds,
composition keywords and document-local references are enforced. Draft-07 is the
default dialect; an explicit `$schema` can select draft-2019-09 or draft-2020-12.
Invalid, unsupported, asynchronous or unresolved schemas block the call. Schema
validation never downloads referenced documents.

Existing parameter-name compatibility runs first: for example `timeout_ms` can
satisfy a declared `timeoutMs`, and `file_path` can satisfy a declared `path`.
Validation does not apply JSON Schema defaults, coerce types or remove extra
properties. Extra fields remain accepted unless the tool schema rejects them.
This keeps approval inputs and third-party MCP payloads intact.

SDK `Tool` accepts an optional `inputZodSchema` with a structural synchronous
`safeParse(input)` interface; Moss does not depend on Zod. A successful result
must be `{ success: true, data }`; a rejected result has `success: false`.
Explicit parser normalization such as trimming or coercion is allowed, but the
normalized object must still satisfy the full JSON Schema. A parser must be pure
and idempotent because each execution boundary rechecks input. Moss verifies
idempotence on an isolated copy and blocks a transform that changes a second
time. A thrown or asynchronous parser blocks the call. Parser output that is not
an object also blocks the call.

Errors identify schema rules without copying rejected values, dynamic object
keys, arbitrary parser messages or compiler exception text. Tool implementations
still own device availability, permission checks, state-dependent constraints and
post-condition verification; JSON Schema success does not prove a device action
succeeded.

Run `node scripts/verify/cli.mjs --stage tool-input-schema` for the offline
execution-boundary probe. It is also included in `npm run verify`. The probe uses
no-op implementations and performs no provider requests or device operations.

SDK change: `Tool.inputZodSchema` is an additive optional field. Inputs that
violate previously declared but unenforced JSON Schema constraints now fail
before execution; this is an intentional validation tightening.
