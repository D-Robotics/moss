# Opt-in OS sandbox for `exec`

Status: design only. Default stays **off**. This document does not change
`exec`, file tools, or device SSH.

workspace-write confines Moss's own file tools. Shell commands run normally without an OS sandbox.
Users who know Codex (Landlock / bubblewrap) or Claude
Code (bubblewrap / seatbelt) will read the mode name as a kernel boundary.
It is not one. Copy in `/permissions`, `config show`, help, the README, and
the startup notice says so. This note is the later, opt-in boundary.

## Product principle

Moss does not block shell commands. Safety for shell output is redaction
(`src/safety/tool-output-redact.ts`) and the write-back guard that refuses to
persist a redaction placeholder (`src/safety/redacted-writeback.ts`). Host
hard blocks (`src/safety/channel-safety.ts`) still refuse a small set of
destructive shapes (`rm -rf /`, credential paths, download-and-execute). Those
are denylists, not a sandbox.

An OS sandbox may be turned on by the user. It must not become the default,
and a missing sandbox tool must not be described as if the boundary were up.

## What is true today

| Surface                                                             | Boundary                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write_file`, `edit_file`, `multi_edit`, `move_file`, `apply_patch` | `safePath` → `assertSandboxPath`. A path outside the workspace, including through a symlink, is rejected.                                                                                                                                                                          |
| `read_file`                                                         | May read outside the workspace. Secret-like bytes are redacted.                                                                                                                                                                                                                    |
| `exec` / background `exec` when safety mode is not `full-access`    | `execWriteRoots` is the workspace. `assertShellWritesWithinRoots` (`src/safety/shell-write-sandbox.ts`) rejects write targets it can see: redirections, `tee` / `dd` / `cp` / `mv` / `install` / `rsync`, `mkdir` / `rm`, `sed -i`, `truncate`, one level of process substitution. |
| `exec` child interpreters                                           | Not visible to the static scan. `node -e`, `python -c`, and a script those run can write `/tmp` or anywhere else the OS user can write.                                                                                                                                            |
| `exec` when safety mode is `full-access`                            | `execWriteRoots` is unset. The static scan does not run.                                                                                                                                                                                                                           |
| Device tools                                                        | SSH/SFTP from the Moss process (`device_exec`, `device_file_write`, `device_deploy`, and the read-only probes). Not a child of `exec`. Not path-jailed on the device. Gated by `src/safety/device-risk.ts`.                                                                        |

The static scan is a best-effort filter on the command string. It is not
Landlock, bubblewrap, seatbelt, or a restricted Windows token. A command that
passes it runs as the user, with the user's network and the user's files.

## Proposal

One opt-in, default off:

- Config: `permissions.osSandbox: true` (or `false`, the default).
- Env, process only: `MOSS_OS_SANDBOX=1`.
- Applies only to local `exec` and background `exec`, and only when the
  derived safety mode is `workspace-write` or `read-only`.
- `full-access` / interaction mode `full` does not enter the sandbox. The
  flag is a no-op there, and `config show` says so.
- File tools stay on `assertSandboxPath`. The OS sandbox does not replace
  them and does not wrap MCP servers, hooks, or the Moss process itself.
- The static scan stays. It is cheap and it still catches the obvious
  command when the opt-in is off.

No new subsystem. A wrapper beside `runProcess` that the two exec call sites
use when the flag is on.

## Platforms

### macOS — `sandbox-exec` / seatbelt

`sandbox-exec` is on the system. Generate a profile per invocation:

- Default deny writes.
- Allow writes under the workspace root (realpath, not the symlink).
- Allow reads the toolchain needs (`/usr`, `/bin`, `/opt`, `/Library`,
  `/System`, `/dev`, `/tmp` read, the user's home read). Writes to `~` stay
  denied except the workspace.
- `/tmp` and `$TMPDIR` are **not** writable. Codex and Claude Code allow a
  temp dir; that is the hole people hit with `printf > /tmp`. Moss's opt-in
  should not copy it unless a later config key asks for it.
- `.git/hooks` and `.git/config` inside the workspace stay write-denied, same
  reason Claude Code denies them: a sandboxed command must not install a hook
  the next unsandboxed run will execute.

Seatbelt applies to the `exec` child and to every process it spawns, which is
the point. `node` and `python` cannot write outside.

### Linux — bubblewrap, Landlock as fallback

Prefer **bubblewrap** (`bwrap`), matching current Codex (bubblewrap is the
default; Landlock is the legacy path behind `features.use_legacy_landlock`)
and Claude Code (bubblewrap on Linux and WSL2).

- `--ro-bind / /` then `--bind` the workspace read-write.
- `--unshare-user --unshare-pid`.
- No `--bind` of `/tmp` or `$TMPDIR` as writable.
- Do not bundle a `bwrap` binary. Use the one on `PATH`. Shipping a setuid
  helper is a supply-chain decision this design does not take.

**Landlock** (plus a seccomp network filter) is the fallback when `bwrap` is
absent and the kernel supports Landlock ABI v3 or newer:

- Read everywhere, write only the workspace.
- Landlock cannot express "writable root, with a nested path denied" the way
  bubblewrap bind mounts can. `.git/hooks` carve-outs are weaker. If the
  policy needs those carve-outs, do not silently use Landlock; refuse and
  name `bwrap` (Codex keeps split deny policies on bubblewrap for this reason).
- WSL1 cannot create the user namespaces bubblewrap needs. Treat it as
  "tool cannot enforce", not as success. WSL2 follows the Linux path.

### Windows — no kernel sandbox in the first slice

Native Windows has no seatbelt and no bubblewrap. Codex's native backend is a
restricted token (elevated, or unelevated ACL fallback) and it **refuses**
when that backend cannot enforce the policy, rather than running unsandboxed.
Claude Code does not sandbox native Windows; the documented path is WSL2.

Moss v1 of this opt-in does not implement a restricted token. On win32, with
the opt-in on, `exec` is refused with a message that names WSL2 and says the
flag is off by leaving it unset. A restricted-token backend is a later slice:
it is ACL-fragile (Codex's unelevated token already fails closed on split
writable roots such as workspace + temp), and it is a different trust story
from "we have no sandbox".

## How Codex does it

Sources: `codex-rs/linux-sandbox` and the Windows sandbox notes in Codex's
own docs (behaviour as of 2026; pin a revision when implementing).

- Modes: `read-only`, `workspace-write`, `danger-full-access`. The first two
  are OS-enforced. `workspace-write` means the kernel allows writes under the
  writable roots and denies the rest.
- macOS: Seatbelt profile. Writes under the writable roots; `.git` and
  `.codex` stay read-only. Network comes from `SandboxPolicy`.
- Linux: bubblewrap by default (`--unshare-user`, `--unshare-pid`, and
  `--unshare-net` when the network is restricted). Seccomp filter on the
  network. If `bwrap` is missing, Codex falls back to a bundled
  `codex-resources/bwrap` and warns. Landlock is explicit legacy
  (`features.use_legacy_landlock=true`) and only when the policy round-trips
  through the old model. Split deny carve-outs stay on bubblewrap.
- Network: denied inside the sandbox unless the user approves. Proxy mode
  uses a TCP → Unix-socket → TCP bridge so only configured endpoints are
  reachable. Managed proxy plus seccomp, not "the process may call
  `connect`".
- Windows: native sandbox is opt-in (`[windows] sandbox = "elevated"` or
  `"unelevated"`). Unelevated is a restricted token plus ACLs and is weaker
  on network. When the backend cannot enforce the policy, Codex refuses the
  command. It does not pretend.

## How Claude Code does it

Source: Claude Code's sandboxing docs (Bash tool sandbox).

- The sandbox wraps **shell commands only**. File tools, MCP servers, and
  hooks run outside it. Same split Moss should keep.
- macOS: Seatbelt, nothing to install.
- Linux and WSL2: `bubblewrap` plus `socat` (the relay into a local proxy).
  An optional seccomp filter blocks Unix sockets that would launch Windows
  binaries from WSL.
- Native Windows: commands run unsandboxed. WSL2 is the supported way to get
  the sandbox.
- Filesystem: writes allowed in the working directory, extra directories, and
  a per-user temp (`$TMPDIR` is redirected there). Settings files, hooks, and
  `.git/hooks` / `.git/config` stay write-denied inside an otherwise writable
  tree.
- Network: no direct route. Linux uses a network namespace; traffic that is
  allowed goes through a proxy on the host. Allowed domains start empty.
  The first new host is an approval (or a classifier decision in auto mode).
  SSH often fails inside this proxy; that is a known sharp edge, not a
  reason for Moss to MITM TLS in v1.
- If the sandbox cannot start, Claude Code **warns and runs the command
  unsandboxed** unless `sandbox.failIfUnavailable` is true. A second escape
  hatch, `dangerouslyDisableSandbox`, retries a failed command outside the
  sandbox unless `allowUnsandboxedCommands` is false.

Moss should not copy the fail-open default. See failure modes below.

## Network policy

For the opt-in, v1 is **no network**:

- macOS: seatbelt `(deny network*)`.
- Linux bubblewrap: `--unshare-net`.
- Linux Landlock fallback: seccomp filter that blocks `socket`, `connect`,
  `bind`, `sendto`, `recvfrom` (the same family Codex installs). Unix sockets
  for local tooling are the hard part; start with "no AF_INET / AF_INET6" and
  test `git` against a local repo before allowing AF_UNIX.

No domain allowlist and no TLS-terminating proxy in v1. Claude Code's proxy
is also a credential-injection path; that is a product of its own and out of
scope. A later key `permissions.osSandboxNetwork: "open" | "off"` (default
`off` when the sandbox is on) is enough for `npm` / `pip` / `curl`. "Open"
means the sandbox still confines the filesystem and the network is the
user's. It does not mean a proxy.

`git fetch` and `npm install` inside `exec` will fail while the sandbox is on
and the network is off. The error must say that, and name the config key.
Do not auto-retry the command unsandboxed.

## Failure modes when the tool is missing

The opt-in means the user asked for a boundary. Missing enforcement is a
failed command, not a warning plus a normal shell.

| Condition                                                                                                   | Result                                                                                                              |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Flag off (default)                                                                                          | Today's behaviour. No probe for `bwrap` or `sandbox-exec`.                                                          |
| Flag on, macOS, `sandbox-exec` missing or the profile is rejected                                           | `exec` returns an error. No unsandboxed retry.                                                                      |
| Flag on, Linux, `bwrap` missing, Landlock available and the policy fits Landlock                            | Use Landlock. Say so in the tool result (`sandbox: landlock`).                                                      |
| Flag on, Linux, `bwrap` missing and Landlock cannot enforce (old kernel, or a nested deny the policy needs) | `exec` returns an error naming `bwrap`.                                                                             |
| Flag on, container or WSL1, user namespaces unavailable                                                     | `exec` returns the kernel error. Do not fall through.                                                               |
| Flag on, native Windows                                                                                     | `exec` returns an error: no OS sandbox backend; use WSL2 or turn the flag off.                                      |
| Flag on, `full-access`                                                                                      | Sandbox not entered. `config show` says the flag does not apply in this mode.                                       |
| `sandbox-exec` / `bwrap` exists but the child still escapes (profile bug)                                   | A test that runs `python -c "open('/tmp/...')"` must fail the build. Do not treat a zero exit from `true` as proof. |

Claude Code's default (warn and run unsandboxed) is the behaviour this design
rejects for the opt-in. Codex's "refuse rather than run unsandboxed" is the
one to follow. There is no `dangerouslyDisableSandbox` parameter for the model
to set. Leaving the flag off is the supported way to run a normal shell.

## Device SSH tools

`device_exec`, `device_file_read`, `device_file_write`, `device_file_list`,
`device_deploy`, and the read-only probes (`device_info`, `device_processes`,
`device_resources`, `device_temperature`, `device_network`, …) open SSH from
the Moss process via `ssh2`. They are not children of `exec`.

- The opt-in wrapper is called only from the exec tools. Device tools do not
  import it.
- A host sandbox around the whole Moss process would break device SSH or
  force an allowlist of device hosts into the seatbelt/bubblewrap profile.
  Do not wrap the parent.
- `ssh user@board` **inside** `exec` is a shell command. With the network
  off, it fails. That is intended. Device work goes through the device tools,
  which keep the existing risk classes (reversible vs destructive vs
  sensitive), TTY confirmation, and trust flags. The OS sandbox must not
  become a second approval path for the robot.
- Read-only device probes keep working with the opt-in on, because they never
  enter the sandbox.

## Estimate

This is one slice, not a new subsystem. No calendar guess.

In scope:

- A small runner next to `src/utils/run-process.ts` (or under `src/safety/`)
  that takes the command, the workspace root, and a platform, and returns
  either a spawn spec or a `MossError`.
- One seatbelt profile builder, one bubblewrap argv builder, one Landlock
  fallback. Windows is the refusal string above, not a token implementation.
- Two call sites: `src/tools/builtin.ts` (`exec`) and
  `src/tools/background-exec.ts`. Both already call `runProcess` and the
  static scan.
- One config field and the `MOSS_OS_SANDBOX` env row in `moss config env`.
- Tests that do not need a real `bwrap`: the refusal paths (missing binary,
  win32, flag off leaves `runProcess` args unchanged) and, when `bwrap` or
  `sandbox-exec` is present, one python write to a temp dir outside the
  workspace that must fail. CI without the binary skips the positive case
  and still runs the refusal cases.
- A device-tool test that a `device_exec` call does not go through the
  wrapper.

Out of scope for the slice:

- Restricted Windows tokens.
- Domain allowlists, `socat` proxies, TLS termination, credential injection.
- Sandboxing MCP, hooks, or file tools.
- Bundling `bwrap`.
- Changing the default. With the flag unset, `exec` stays as it is today,
  including the static scan and the absence of an OS sandbox.

The risky part is the profile, not the flag. A seatbelt or bubblewrap rule
that hides `/usr` or the workspace's `node_modules` makes every command fail;
a rule that bind-mounts `/tmp` writable recreates the hole this design is
for. The python-write test is the acceptance check, not a successful `true`.

## Copy while the flag is off

Until the opt-in exists and is on, user-facing text keeps the current
sentence: workspace-write confines Moss's own file tools, and shell commands
run normally without an OS sandbox. Turning the flag on is the only change
that may revise that sentence, and only for sessions where the flag is on.
