# Sandbox and Permissions

Moss gates what the agent can do through a safety mode (what actions are
even considered) and an approval policy (which of those ask before running).
A separate hard-blocklist stops a few genuinely dangerous command patterns
regardless of policy.

## Safety mode

The safety mode is the ceiling — it determines what tool classes moss will
run at all.

```sh
MOSS_SAFETY_MODE=read-only          # or workspace-write | full-access
moss --workspace-write              # restrict writes/exec to workspace boundaries
moss --full-access                  # allow device/external tools (default ceiling)
```

| Mode              | What's allowed                                            |
| ----------------- | --------------------------------------------------------- |
| `read-only`       | only read-only actions; everything else blocked           |
| `workspace-write` | workspace file writes + exec inside the workspace         |
| `full-access`     | everything, including device/external tools (the ceiling) |

## Approval policy

Within the safety mode, the approval policy decides whether moss asks before
each mutating action.

```sh
moss --ask-for-approval workspace-write
moss config set profile cautious        # cautious | balanced | autonomous
```

| Policy            | Behavior                                                  |
| ----------------- | --------------------------------------------------------- |
| `never`           | never prompt                                              |
| `read-only`       | only read-only actions run                                |
| `on-request`      | ask only when the agent requests                          |
| `prompt`          | ask before each mutating action                           |
| `workspace-write` | allow workspace file writes; ask for shell/device         |
| `full-access`     | auto-approve everything (`/yolo` toggles this in-session) |

In-session, `/permissions` shows the resolved safety mode, approval policy,
and how to grant full access.

## Tool allow / deny lists

```sh
moss config set trustedTools "read_file,search_code"    # auto-approve after safety checks
moss config set deniedTools "device_exec"                # always block
```

`trustedTools` short-circuits the approval prompt for named tools (still
after safety checks); `deniedTools` blocks them outright.

## Hard-blocked command patterns

A small blocklist rejects genuinely dangerous shell patterns regardless of
policy — e.g. `curl|wget | interpreter` (download + execute), reverse shells
(`/dev/tcp`, `nc`/`socat`), `find -exec` injection, reading `/etc/shadow`
or `~/.ssh` keys, `chown`/`useradd`, `crontab` edits, and editors with shell
escape (`vim`/`nano`).

### What is NOT hard-blocked

Interpreter `-e` / `-c` (e.g. `node -e "…"`, `python -c "…"`) is **not**
blocked — these are legitimate, common coding invocations, and blocking them
was security theater (moss can always write a file and run `node file.mjs`).
They run through the normal approval flow, consistent with file-based
execution.

> grok-build contains the agent process at the OS level (Landlock/Seatbelt)
> instead of per-invocation blocks. moss's analog is the approval policy +
> safety mode + sandbox-path workspace confinement; OS-level sandboxing is a
> future direction.

## Path confinement

Workspace file operations are confined to the workspace root — attempts to
read or write paths outside it are rejected by the sandbox-path check
(sensitive locations like `/.ssh`, `/.env`, `/credentials`, `/node_modules`
are protected).

See [Configuration](05-configuration.md) for the safety profile settings and
the [user-guide index](README.md) for other topics.
