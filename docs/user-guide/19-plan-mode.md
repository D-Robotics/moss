# Plan Mode

Plan mode is a read-only planning state: moss explores the codebase and
produces a clear implementation plan (steps, files, verification) without
modifying files or running side-effecting commands. Use it to scope a change
before committing to it.

## Enter and leave plan mode

```sh
/mode plan          # enter plan mode
/mode default       # leave (normal coding under the current approval policy)
Shift+Tab           # cycle modes (plan → default → accept-edits → plan)
```

You can also start moss in plan mode: `moss --plan`.

## What's allowed in plan mode

Planning tools run normally: `todo_write`, `ask_user_question`, `plan`,
`plan_step`. Read-only exploration (`read_file`, `search_code`,
`search_files`, `list_directory`) runs. **File/exec mutations are blocked**
until you leave plan mode.

## Approving a structured plan

The agent can produce a structured plan and call `plan action=approve` to
signal it's ready. Approving (or `/plan approve` for a structured plan)
**automatically drops to `default` mode** so coding tools unblock — you don't
have to hunt for Shift+Tab after approving.

## When to use it

- **Before a multi-file change**: `/mode plan`, let moss map the call chain and
  propose steps + files + verification, approve, then implement.
- **When the request is ambiguous**: plan mode forces moss to ask
  clarifying questions (`ask_user_question`) before touching code.
- **To scope a refactor**: plan read-only, review the proposal, redirect or
  approve.

## Interaction mode reference

| Mode | Behavior |
|---|---|
| `plan` | read-only; planning tools allowed; mutations blocked |
| `default` | normal coding under the current approval policy |
| `accept-edits` | auto-approve workspace file edits; shell/device mutations still prompt |

`Shift+Tab` cycles through them. See `/permissions` for the approval policy
in effect, and [Configuration](05-configuration.md) for how to set it.

See the [user-guide index](README.md) for other topics.
