# Slash Commands

Type `/` in the prompt to access commands. Each command runs an action
immediately and autocompletes as you type. Moss's `/help` shows the in-session
command list; this guide adds examples and notes.

Commands are grouped by purpose: **Work**, **Inspect**, **Configure**,
**Control**.

---

## Work

### `/status`

View model, workspace, device, and tool state for this session.

```
/status
```

### `/model`

Choose or switch the active model for this session. No argument opens a
picker; pass a name to switch directly.

```
/model
/model deepseek-v4-flash
/model config base_url=<url> key=<key> model_name=<model>   # add a custom model
```

> The `config` form persists to disk, including the API key. Prefer `moss setup`
> for a guided, hidden-key entry.

### `/mode`

Show or set the interaction mode. `plan` = read-only planning (no file/exec
mutations); `default` = normal coding under the current approval policy;
`accept-edits` = auto-approve workspace file edits (shell/device mutations
still prompt). `Shift+Tab` cycles modes too.

```
/mode
/mode plan
/mode default
```

### `/goal`

Show goal status, or set an objective and keep Moss working toward it until
you mark it done. The goal persists across turns and the agent auto-advances
toward it.

Subcommands: `set <objective>`, `status`, `pause`, `resume`, `complete`,
`block [reason]`, `clear`. A bare `/goal <objective>` also sets. `/goal block`
marks the goal blocked (e.g. waiting on a user decision); `/goal resume`
unblocks.

```
/goal add OAuth login with tests
/goal set add OAuth login with tests
/goal status
/goal complete
/goal block waiting on the API key from ops
```

> `/goal` creates a persistent objective the agent keeps working toward.
> `/loop` (below) starts a separate autonomous loop you can stop/resume —
> use `/goal` for "keep after X", `/loop` for "run an unattended loop".

### `/compact`

Compress older conversation history into a summary to free context. Optional
instructions focus the summary.

```
/compact
/compact keep the auth implementation details
```

### `/btw`

Ask a side question on an isolated session that does not pollute the main
task context; runs concurrently with an active run.

```
/btw what does this config key do?
/btw stop
```

### `/steer`

Change the active task at its next safe model/tool boundary — unlike a
normal prompt, it does not queue a separate task.

```
/steer also add a regression test for that edge case
```

### `/queue`

Pause or resume the in-memory queue of follow-up prompts queued for this
session (not a persistent task queue).

```
/queue pause
/queue resume
```

### `/loop`

Autonomous loop: Moss works until it judges the goal done. Set
`MOSS_LOOP_MAX` for an optional iteration cap. `/loop stop` waits for the
current step to finish.

```
/loop make all tests pass on the login branch
/loop stop
/loop resume
```

### `/skill`

Enable or disable a skill for this session (in-memory, not persisted).
Re-enables auto-injection and `/<name>` dispatch.

```
/skill enable tdd
/skill disable mutation-fuzz
```

### `/context`

Show current context-window usage and a categorical breakdown.

```
/context
```

### `/connect`

Connect an RDK board over persistent SSH. Interactive TUI sessions ask for the
SSH account and a masked password before connecting. Set `MOSS_DEVICE_HOST` to
use bare `/connect`, or pass the host explicitly. Key-based automation remains
available with explicit `--key`. Other flags: `--user --port --password
--no-verify --hybrid`.

```
/connect 192.168.1.100
/connect 192.168.1.100 --key ~/.ssh/id_rsa
```

### `/disconnect`

Leave board mode and restore local tools. `Ctrl+D` on an empty prompt also
works.

```
/disconnect
```

### `/review`

Review the working-tree diff for bugs, security, and simplification. Pass a
PR number to review a GitHub pull request via `gh pr diff`.

```
/review
/review 123
```

---

## Inspect

### `/sessions`

List saved conversations. Use `/resume` to switch into one.

```
/sessions
```

### `/history`

List this session's prompt history (newest first), optionally narrowed by a
case-insensitive substring. `↑`/`↓` on an empty prompt recalls recent prompts.

```
/history
/history login
```

### `/resume`

Switch this session to a saved conversation. No argument opens a picker.

```
/resume
/resume --last
/resume cli-20260718-abc
```

### `/mcp`

Show configured MCP servers, connection status, and tool counts.

```
/mcp
```

### `/doctor`

Health-check model, egress, board, MCP, and config in this session.

```
/doctor
```

### `/cost`

Show recorded token usage and estimated cost.

```
/cost
```

### `/diff`

Show git working-tree changes.

```
/diff
```

### `/rewind`

Restore files to a checkpoint and rewind the conversation (LLM context) to
before the rewound turn — the agent does not repeat the bad path. Files you
changed or deleted outside moss after the agent wrote them are kept, not
overwritten. No argument lists checkpoints.

```
/rewind
/rewind 3
```

### `/memory`

Show project memory (`AGENTS.md`) and learned memories.

```
/memory
```

---

## Configure

### `/soul`

Show the active persona and where to edit `soul.md`. Subcommands: `list`
(SkillHub personas), `use <CODE>` (install + switch), `default`, `init`,
`global init`.

```
/soul
/soul list
/soul use CODE
/soul init
```

### `/auth`

Link a D-Robotics developer community account (optional). `--manual` is a
browserless flow.

```
/auth login
/auth login --manual
```

### `/logout`

Log out of the D-Robotics developer community.

```
/logout
```

### `/quickstart`

Show a quick-start checklist: current model, workspace, board state, and a
few suggested first tasks. It's a status snapshot, not an interactive wizard
— to configure a provider/model/API key, run `moss setup`.

```
/quickstart
```

### `/permissions`

Show safety, approvals, and how to grant full access.

```
/permissions
```

---

## Control

### `/stop`

Stop the active run.

```
/stop
```

### `/clear`

Start a new conversation — clears the context window. Aliases: `/new`,
`/reset`.

```
/clear
```

### `/init`

Create an `AGENTS.md` project memory file.

```
/init
```

### `/help`

Show the in-session command reference.

```
/help
```

### `/quit`

Exit Moss.

```
/quit
```

---

## Command-line equivalents

Several slash commands also have CLI subcommands for scripting:

| In-session  | CLI                                         |
| ----------- | ------------------------------------------- |
| `/sessions` | `moss sessions list`                        |
| `/resume`   | `moss resume [--last]`                      |
| —           | `moss sessions search <text>`               |
| —           | `moss sessions export <key> [--out <file>]` |
| —           | `moss sessions delete <key>`                |
| `/doctor`   | `moss doctor`                               |
| `/mcp`      | `moss mcp list`                             |
| `/context`  | (session-only)                              |

Run `moss --help --all` for the complete CLI reference.
