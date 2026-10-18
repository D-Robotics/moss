<div align="center">

# Moss

**One Intent → One Task → One Agent Loop → One Verified Result.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22.16%2B-339933.svg)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey.svg)](#support-matrix)

**English** · [中文](https://github.com/D-Robotics/moss/blob/main/README.md)

</div>

Moss is a minimal, cross-platform coding agent harness **and** an Agent Task OS for robot
development. It turns a sentence of intent into a state-machine task with machine-checkable
acceptance criteria, runs it through one agent loop, and **refuses to call it done without a
verdict backed by recorded evidence**. It talks to RDK / Linux robots over SSH, so "done" can
mean _the board actually did it_.

- TypeScript / ESM single package · Node ≥ 22.16.0 · Linux / macOS / Windows
- No account, no cloud service, no telemetry — providers are plain HTTP endpoints
- Four surfaces: full-screen TUI · readline REPL · headless CLI · embeddable SDK

## Prerequisites

Check Node first (**hard requirement: Node ≥ 22.16.0**):

```bash
node -v
```

If Node is missing or too old, install it first (copyable):

- **macOS:** `brew install node@22`, or `nvm install 22 && nvm use 22` / `fnm install 22 && fnm use 22`
- **Ubuntu / Debian:** NodeSource ([nodesource/distributions](https://github.com/nodesource/distributions)) or the same nvm / fnm commands
- **Windows (PowerShell):** `winget install OpenJS.NodeJS.LTS`
- **In China:** `npm config set registry https://registry.npmmirror.com`. For nvm's Node downloads, set `NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node`

On Node older than 22.16, `npm install -g @rdk-moss/agent@latest` (and the source-path `preinstall` / `prepare` hooks) **exits non-zero immediately**, prints the detected Node version and copyable upgrade commands (including the success-path `npm install -g @rdk-moss/agent@latest`), and **does not** leave a broken global `moss`. Node 22.16 ships with npm 10. Do not follow npm's notice to upgrade to npm 12: Node 22.16 does not support npm 12.

### macOS

Git requires the Xcode Command Line Tools. If `git` is missing, run `xcode-select --install`. Moss itself does not need a C compiler, and a failed optional native build of `cpu-features` still leaves a working `moss`. If the global prefix is not writable, use the user-level prefix below.

### Windows

Install Git for Windows. PowerShell's execution policy can block `moss.ps1`. Allow scripts for the current user only:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Put `%APPDATA%\npm` on PATH. That is npm's default global bin directory on Windows.

## Quick start

**Recommended (one line)** when Node ≥ 22.16 is already installed:

```bash
npm install -g @rdk-moss/agent@latest
moss --version
moss
```

If an older unscoped `moss` package is already installed, run `npm uninstall -g moss` first. The two packages use the same `moss` bin, and npm stops with EEXIST. Do not pass `--force`. It leaves both the old package and `@rdk-moss/agent` installed, and a later `npm uninstall -g moss` removes the `moss` command.

If npm reports EACCES on the global prefix, point prefix at your home directory, or use nvm (Node then lives under your home directory):

```bash
npm config set prefix ~/.npm-global
```

Add `~/.npm-global/bin` to PATH and open a new terminal.

<details>
<summary>Develop from source (optional)</summary>

For contributors. `npm ci` runs `prepare` (Node check, then `npm run build`), so there is no separate build step:

```bash
git clone https://github.com/D-Robotics/moss.git
cd moss
npm ci
npm install -g --install-links .
moss
```

npm 11 may print `npm warn install-scripts`. `npm ci` may name `ssh2` and `cpu-features`. The following `npm install -g --install-links .` may also name `@rdk-moss/agent` (its `preinstall` and `prepare` scripts). The warning is harmless: ssh2 works without its optional native addon, and the global copy already contains `dist/`. Do not run `npm audit fix --force`. It changes dependency versions and breaks the install.

</details>

With no usable config, `moss` sets itself up in that screen (press a number to pick a provider, or Enter to use a key already in the environment; the value is not shown). The D-Robotics gateway is listed first and preselected (`https://ai-api.d-robotics.cc/v1`, default model `deepseek-flash`, key only). To keep the key out of the file, set the provider and then the variable name: `moss config set provider d-robotics`, then `moss config set apiKeyEnv <VAR>`. A file that names only `apiKeyEnv` is not configured: setup asks which provider, and the key is not sent to the default DeepSeek endpoint. Then, in the same session:

```text
look around this folder and tell me what it is
```

### Custom OpenAI-compatible gateway

For a gateway that is not a built-in preset, use `openai-compatible`. These four commands set the provider, model, address, and the key variable name (`apiKeyEnv` stores the name, not the secret):

```bash
moss config set provider openai-compatible
moss config set model your-model-name
moss config set baseUrl https://gw.example
moss config set apiKeyEnv MY_GATEWAY_API_KEY
export MY_GATEWAY_API_KEY=your-key
moss doctor
```

A trailing `/v1` on `baseUrl` is optional. Both `https://gw.example` and `https://gw.example/v1` work. Moss appends `/v1/chat/completions` itself and never produces `/v1/v1`. Do not include `/chat/completions`; it is not needed, and Moss strips it if it is present. `moss doctor` checks the provider, model, address, and whether the key variable is set.

Inside Moss: give it a job (`@` to reference files, `!` for shell), `Shift+Tab` to cycle modes
(`plan` = read-only planning), `Ctrl+V` to attach a clipboard image / Finder file / local path
(macOS; Linux: wl-paste/xclip; Windows: PowerShell), `/help` for keys and commands.

<details>
<summary>Run the build output directly · one-shot mode · resume</summary>

```bash
node dist/cli.js --help                       # run the build output
moss "check disk usage"                       # one-shot (or pipe: echo "list files" | moss)
moss resume --last                            # continue the latest session
moss --no-tty                                 # force the readline REPL
```

</details>

## Upgrade

If the `moss` command still comes from an older unscoped install, including `npm link`, run `npm uninstall -g moss` first. Otherwise a new global install stops with EEXIST even when `moss --version` already looks new.

**npm global install** (recommended path):

```bash
npm install -g @rdk-moss/agent@latest
```

**From an existing source clone**, in the parent of that clone:

```bash
cd moss && git pull && npm ci && npm install -g --install-links .
```

`npm ci` rebuilds. `--install-links` installs that new copy into the global prefix, instead of only rebuilding the clone. `moss --version` includes the short commit and the build date, for example `moss v0.26.0 (e8dc2e3, 2026-10-10)`. A worktree with uncommitted changes at build time is marked `e8dc2e3+dirty`. The before and after strings differ.

`moss update` prints the matching command: `@latest` for an npm global install, the clone upgrade line when it finds a checkout, and `git clone` only when neither applies. A global install only looks for a checkout in the current directory and in `./moss`. Point it somewhere else with `moss update --dir <clone>` or `MOSS_SOURCE_DIR`. It prints the commands and does not run them.

## Uninstall

```bash
npm uninstall -g @rdk-moss/agent
```

That removes the command. These stay behind:

- Config: `~/.config/moss` on Linux and macOS (`$XDG_CONFIG_HOME/moss` when that variable is set), or `%APPDATA%\moss` on Windows. Also check `~/.moss`
- The npx cache: `~/.moss/cache/npx`
- Per-project `.moss/` directories (tasks, sessions, project config)
- The source clone
- The npm cache, usually `~/.npm`
- The native-build cache: `~/.cache/node-gyp`
- An empty `@rdk-moss` directory left under the prefix: `$(npm prefix -g)/lib/node_modules/@rdk-moss` on Linux and macOS, or `%APPDATA%\npm\node_modules\@rdk-moss` on Windows

Safe to delete: `~/.moss/cache/npx`, `~/.cache/node-gyp`, the npm cache (`npm cache clean --force`), that empty `@rdk-moss` directory, and the clone once you no longer need the source. Deleting `~/.config/moss`, `~/.moss`, or a project's `.moss/` also removes keys, settings, and task history. Delete those only when you want that data gone.

## Board has no outbound network / proxy setup

Lab and classroom RDK boards often **cannot** reach GitHub, npm, Node mirrors, or the model gateway directly (TCP timeouts). The first `git clone` hangs.

**Required environment variables (official recommendation — these only):**

```bash
export HTTPS_PROXY=http://127.0.0.1:1080
export HTTP_PROXY=http://127.0.0.1:1080
export NO_PROXY=localhost,127.0.0.1,::1
# Current Moss main (O83 / #81 onward) routes Node fetch through these proxies
# automatically. Do NOT set NODE_USE_ENV_PROXY — that was a temporary workaround
# on older tips and is not needed now.
```

Port and whether you need an `ssh -R` tunnel depend on your site.

**First install on a board:**

1. **git clone:** use `git clone --depth 1 https://github.com/D-Robotics/moss.git`. A full clone often fails with GnuTLS / early EOF on slow or proxied links.
2. **npm:** in China you may `npm config set registry https://registry.npmmirror.com`. A registry mirror **does not replace** `HTTPS_PROXY` when the board still needs a proxy to leave the LAN.
3. **Node:** many RDK images already ship Node ≥ 22.16. nvm’s install script needs `raw.githubusercontent.com` and will time out offline — prefer the system Node, or install via the proxy.
4. **User-level prefix:** `npm i -g` as root writes under `/usr`. Prefer `npm config set prefix "$HOME/.npm-global"` and put that `bin` on PATH.

**How to confirm the proxy works (both required):**

1. The proxy log shows `CONNECT` to the model / gateway host; and
2. End-to-end you get a **successful answer** (`moss -p "…"` exits 0 — not “network connection failed”).

**CONNECT alone with a network failure is a FAIL.** For triage you can temporarily set `MOSS_NO_RDK_DOCS=1`. Root-cause work for “CONNECT without an answer” is backlog **O87**; this README does not replace that item. Treat connection errors as proxy / firewall issues — **not** “switch to a faster model”.

## Why Moss

A normal coding agent's definition of done is the model saying so. Moss makes that judgement an
auditable machine process:

```text
task_define (goal + machine-checkable acceptance criteria)
  → device_deploy / device_exec / run_tests (real execution)
  → record_evidence (structured Expected / Observed / Result)
  → task_acceptance (evaluate against the latest evidence per metric)
```

- **PASS can only come from a verdict provider** (command verdict > contract verdict) — model
  prose is never an event.
- Missing evidence = not done; `latest-wins` supports re-verification after a repair.
- Every task runs the same event-sourced state machine:
  `draft → planning → executing → verifying → diagnosing → repairing → reverifying → accepted | failed`.
- The acceptance gate is built in: a run that defined a task but produced no verdict gets its
  final answer intercepted once and corrected — it does not hijack indefinitely.

Artifacts land in the workspace `.moss/`: `tasks.jsonl` · `task-events.jsonl` · `evidence.jsonl` ·
`deployments.jsonl` · `acceptance.jsonl` · `task-failures.jsonl` · `task-repairs.jsonl`.

## Capabilities

**Coding.** Turn control, context compaction and budgets, nudges, loop guards, and **45 built-in
tools** (incl. **12 SSH device tools**) covering files and patches, code search, processes and
background jobs, web, diagnostics, tests, sub-agents, and the task contract; mutating tools go
through approval. Sessions are saved, searchable, exportable, forkable; `/compact`, `/rewind`,
`/diff`, `/review`.

**Sub-agents.** `create_subagent` with scoped children (explore / plan / verify / full),
background runs, `fan_out_subagents` with aggregated summaries, and worktree-isolated writers
merged back via 3-way patch.

**Robots (RDK first).** Read-only `device_info` · `device_processes` · `device_resources` ·
`device_temperature` · `device_network` · `device_cameras` · `device_robotics_status` ·
`device_file_read` · `device_file_list`; approved mutations `device_exec` · `device_file_write` ·
`device_deploy`. Register a fleet and fan out:

```bash
export MOSS_DEVICE_HOST=<board> MOSS_DEVICE_PORT=22 MOSS_DEVICE_USER=root MOSS_DEVICE_PASSWORD=...

moss device add rdk-01 192.168.1.10 --user root --kind rdk
moss device fleet info --devices rdk-01,rdk-02,rdk-03 --concurrency 4
moss --print "define a task: camera pipeline keeps 30 FPS for 60s; deploy, run, record evidence, accept"
```

Board manuals (flashing, pinouts, TROS / hobot_dnn, specs) come from the built-in rdk-docs MCP,
defaulting to the pinned `rdk-docs-mcp@0.3.0` (BM25 + title fusion, `noGoodMatch`, `alt_queries`,
and board filtering; default hits are title, url, anchor, and snippet, with scores only when
`verbose`; `get_page` returns the matching section unless `full`). Moss connects it in the background by default, with or
without a device target (`MOSS_DEVICE_HOST` or `.moss/devices.json` is not required),
so a cold npx download does not block the interactive shell. To test an unpublished build, set
`"rdkDocs": {"package": "../rdk-docs-mcp"}` or `MOSS_RDK_DOCS_PACKAGE` to an npm spec, local
directory, or tarball. Overrides execute code; use only trusted sources. `MOSS_NO_RDK_DOCS=1`,
`"rdkDocs": false`, or `"rdkDocs": {"enabled": false}` turns it off. A same-named `mcp.json` entry
replaces the builtin. Tool features vary by package version, so Moss discovers names and schemas
before use. If the server cannot be reached, this session does not look up manuals — there is no
cache or offline copy. See [`docs/superpowers/plans/2026-10-09-rdk-knowledge-via-mcp.md`](docs/superpowers/plans/2026-10-09-rdk-knowledge-via-mcp.md).

**Extensibility.** MCP client (stdio + streamable HTTP, lazy tool loading), lightweight skills
(`.moss/skills/<name>/SKILL.md`, `$ARGUMENTS` interpolation), custom slash commands
(`.moss/commands/<name>.md`), persona (`.moss/soul.md`), lifecycle hooks.

**Embedding.** Headless output is a stable contract for scripts and CI; a task's exit code is 0
**only when accepted**. A `-p` last line of `Unverified:` / 「未验证：」 (claimed checks passed but none ran this session) exits **9** (`ExitCode.INCOMPLETE`), distinct from honest success (0). Unverified shares exit 9 with incomplete; scripts tell them apart by the last line (`Unverified:` / 「未验证：」 vs `Incomplete:` / 「未完成：」):

```bash
moss --print "summarize this repository"
moss --output-format json "..."     # or stream-json (system/init → assistant → user → result)

moss task run --goal "create hello.txt containing MOSS_OK and verify its content" --accept "grep -q MOSS_OK hello.txt"
moss task status && moss task timeline
moss tasks list                     # read-only robotics artifacts
```

The `src/index.ts` export surface is a semver-protected contract, snapshotted by
`test/sdk-contract.spec.mjs`; three runnable integrations live in `examples/` (`npm run examples`).

## Board-side inference dependencies (RDK)

> **Do not** use `http://sdk.d-robotics.cc:8080/simple/` (offline; connection refused).  
> **Do not** use `http(s)://archive.d-robotics.cc/simple/` (not a working pip index; HTTPS returns 404).

### Pick the interface by OS / board

| Board / scenario                                      | Use                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| RDK X5, RDK OS ≥ 3.5.0 (`rdk_x5`)                     | Board-bundled **`hbm_runtime`**; **never** `pip install hbm_runtime` |
| RDK X5 legacy demos (`rdk_x5_legacy` / OS &lt; 3.5.0) | Verified X5 1.0.3 whl below, or board `hobot_dnn`                    |
| RDK X3                                                | Verified X3 1.0.3 whl below, or board `hobot_dnn`                    |
| RDK S series                                          | Board `hbm_runtime`; do not install X5 `hobot_dnn`                   |

Official reference: [Model Zoo infer API](https://developer.d-robotics.cc/model_zoo_doc/infer_api_ref).

### Legacy whl only (verified HTTP 200)

Only these two direct URLs appear in Moss docs. Moss **will not** auto-install packages.

```bash
# X5 legacy
wget -nc https://archive.d-robotics.cc/downloads/rdk_model_zoo/rdk_x5/bpu_infer_lib_x5-1.0.3-py3-none-any.whl
pip install bpu_infer_lib_x5-1.0.3-py3-none-any.whl

# X3
wget -nc https://archive.d-robotics.cc/downloads/rdk_model_zoo/rdk_x3/bpu_infer_lib_x3-1.0.3-py3-none-any.whl
pip install bpu_infer_lib_x3-1.0.3-py3-none-any.whl
```

### Missing libhbucp.so

Usually a pip overlay of system hobot / hbm packages, or OS &lt; 3.5.0 running a new Model Zoo. **Do not** `pip install hbm_runtime`. Prefer an image ≥ 3.5.0 with the board-bundled runtime; if pip overwrote packages, uninstall the pip copies, reinstall `hobot-dnn` via apt, and run `ldconfig`. `moss doctor` warns on deprecated pip indexes and can optionally probe the whl URLs above.

## Command reference

| Subcommand                                                                 | Purpose                                                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `moss` (or `moss "prompt"`)                                                | Interactive shell / one-shot                                                        |
| `moss setup` · `moss auth status\|logout`                                  | Setup wizard · check or clear stored credentials                                    |
| `moss doctor` (alias `moss status`)                                        | Health-check config / credentials / workspace / runtime                             |
| `moss config show\|env\|init\|set\|unset\|validate`                        | Config I/O; `moss config --help` lists every key, `moss config env` is the env list |
| `moss resume` · `moss fork` · `moss sessions list\|delete\|search\|export` | Resume / fork / manage sessions                                                     |
| `moss task run\|resume\|status\|timeline`                                  | Unified task runtime (intent in → verified result out)                              |
| `moss tasks list\|evidence\|deployments\|acceptance\|device`               | Read-only robotics artifacts                                                        |
| `moss device add\|list\|remove\|test\|fleet`                               | Device registry + read-only fleet probe                                             |
| `moss mcp add\|list\|remove\|test`                                         | MCP server management                                                               |
| `moss skill create\|list`                                                  | Skill management                                                                    |
| `moss update`                                                              | Print the upgrade command (npm global or git clone); it does not run it             |

> `plugins` / `migrate` / `web` / `agent` belong to removed subsystems and fail loudly
> in this build rather than silently falling back to chat. `moss <command> --help` is that
> command's own usage.

Everyday slash commands: `/model` `/compact` `/goal` `/plan` `/review` `/doctor` `/diff`
`/permissions` `/clear` `/help`. Shift+Tab cycles modes; `/plan` enters plan mode; `/goal <condition>`
works until the condition is met and `/goal clear` cancels it. `/resume` restores a saved
conversation; `/tasks` lists background shell jobs and sub-agents. Esc interrupts the current
reply; a message typed during a run steers it, and queues above the composer when steering is
refused (Up edits that queue). `/mode` `/steer` `/queue` `/loop` stay as hidden aliases for one
version (`/loop` is now `/goal`). Without `--accept`, `/goal` proposes acceptance commands from
test entry points that exist in the workspace (`package.json` test, Makefile, pytest, `go.mod`)
and says so when it finds none. `/stop` (alias `/abort`) stops only background processes this
session started. The hidden `/task` is the Task OS entry (status / timeline / resume / view /
verify); `/task verify` takes one verdict without a model turn. A PASS still comes only from the
verdict provider.

Key flags: `-m/--model`, `--provider`, `--base-url`, `-C/--cd`, `-c/--config k=v`,
`--read-only` · `--workspace-write` · `--full-access` (workspace-write confines Moss's own file tools; shell commands run normally without an OS sandbox), `--trust-device`, `--accept-edits`,
`--ask-for-approval <p>`, `-p/--print`, `--json`, `--output-format <f>`.

Key env vars (full list: `moss config env`): `MOSS_PROFILE` · `MOSS_WORKSPACE` ·
`MOSS_SAFETY_MODE` · `MOSS_APPROVAL_POLICY` · `MOSS_MAX_AGENT_TURNS` · `MOSS_CONTEXT_TOKENS` ·
`MOSS_BUDGET_MAX_*` · `MOSS_DEVICE_*` · `MOSS_NO_RDK_DOCS`.

> **Gotcha:** model settings are config-only. `MOSS_MODEL` / `MOSS_PROVIDER` / `MOSS_BASE_URL` /
> `MOSS_API_KEY` are read but ignored — use `moss setup` or `moss config set`.

Without an explicit file, Moss reads the user config and merges `.moss/config.json` from the
workspace as project defaults (the user file wins). `--config-file` or `MOSS_CONFIG_FILE` loads
only that file, so the project `.moss/config.json` layer is not part of the run.

## UI language

**English is the default UI language.** Chinese is a complete, optional UI language. It covers
chrome, help, errors, and setup text. Assistant replies still follow the language of the user's
message.

```bash
moss --lang zh                         # this run only
MOSS_LANG=zh moss                      # process env (a project .env cannot set this)
moss config set language zh            # user config ~/.config/moss/config.json
moss config set language auto          # default: Chinese only when the locale starts with zh
```

Precedence: `--lang` > `MOSS_LANG` > user config `language` > system locale. Neutral tags
(`C`, `POSIX`, `C.UTF-8`) are not a language and fall through to the next of `LC_ALL`,
`LC_MESSAGES`, and `LANG`. If none names a language, the UI stays English. A project
`.moss/config.json` and a project `.env` cannot set the UI language.

In the shell, `/language` (alias `/lang`) switches the session. `/language zh save` writes the
user config. On a Chinese system locale that has not chosen yet, the first `moss setup` offers
one line: press `e` to switch to English.

## Safety and privacy

- **Full by default since v0.26**: local writes and **reversible** device changes skip the
  prompt. Destructive device operations (reboot, flashing, writes to `/boot` or `/etc`, network
  changes, removing system packages, stopping ssh) still confirm. Full matches Claude Code's
  "ask less by default", not `--dangerously-skip-permissions` against a robot board.
- **Four interaction modes** (Shift+Tab cycles, or `/plan` to enter plan mode; `/mode` remains for one version):

  | Mode             | Behavior                                                                                                                                                                |
  | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `manual`         | mutations and device changes ask one by one                                                                                                                             |
  | `acceptEdits`    | workspace file-tool edits auto-approve; shell and device changes still ask                                                                                              |
  | `plan`           | read-only planning; mutations and device changes blocked                                                                                                                |
  | `full` (default) | local writes and reversible device work skip the prompt; destructive device work confirms on a TTY and is refused headless. Deny rules and host hard blocks still apply |

- **`workspace-write` is not an OS sandbox.** workspace-write confines Moss's own file tools. Shell commands run normally without an OS sandbox. `write_file`, `edit_file`, `multi_edit`, `move_file`, and `apply_patch` stay inside the workspace. `exec` is not wrapped in Landlock, bubblewrap, or seatbelt. A static scan rejects some out-of-workspace shell writes it can see (redirections, `cp`, `mv`); a child `node` or `python` process can still write outside, for example under `/tmp`. Shell safety is output redaction and write-back guards. An opt-in OS sandbox is specified in [`docs/design/os-sandbox.md`](docs/design/os-sandbox.md) and stays off.
- **Permission rules** (`/permissions`, effective in any mode, deny beats everything incl. full):
  - three levels `allow` / `ask` / `deny`, priority deny > ask > allow;
  - syntax `ToolName(pattern)` with moss-native tool names:
    `/permissions add deny "read_file(./.env)"`, `/permissions add allow "exec(npm run *)"`;
  - session rules take effect on the next tool call; `/permissions persist` writes the user config
    and survives restarts;
  - `--read-only` / `MOSS_SAFETY_MODE=read-only` is a read-only ceiling that compresses any mode
    including full.
- **Host hard blocks never lift**: destructive host `exec` commands (`rm -rf /` …) and path
  escapes stay blocked in full mode — full skips the asking, not the checking. The same shapes on
  the device are not a permanent hard block: a TTY confirmation, an allow rule, or explicit trust
  runs them for real.
- **A PreToolUse hook that returns `ask` (O157)**: when a hook exits 0 with
  `hookSpecificOutput.permissionDecision: "ask"` (claude format) or `decision: "ask"` (moss
  format, the equivalent field), an interactive session shows Moss's confirmation (y/a/n), naming
  the hook and the reason it gave, in every mode including full. `y` / `a` allow this one call
  (`a` remembers nothing; the hook asks again next time); `n` is treated as a block. `-p` and runs
  without an interactive terminal cannot confirm, so the call is treated as deny: the last line
  says `Blocked by`, exit 9. Across hooks deny > ask > allow; deny rules and host hard blocks still
  win. A `blocking: false` hook cannot restrict a call, so its `ask` is ignored like its `deny`.
  Like Claude Code, an ask shows a confirmation. Moss differs in that `-p` treats it as deny, `a`
  allows only this call and adds no trust, and a hook that exits non-zero is denied even if it
  printed ask (O135).
- **Protected paths (O94 + O101) are best-effort interception, not a sandbox**: direct writes, deletes or
  moves of a protected path (e.g. `~/.ssh`, files inside `.git/`) by file tools or shell commands
  need one confirmation even in full mode; `git`'s own writes to `.git/` do not. Shell detection
  parses the command line (O97/O94) and, with O101, scans inline `-c`/`-e` code and workspace
  scripts before run. Anything that still slips through is caught after the command by a metadata
  snapshot (mtime/size/hash only — never file contents): the run is marked incomplete ("modified",
  not "intercepted"), exit non-zero, no auto-restore. `exec_background` runs the same layer-3
  check when the background process fully exits. Still not an OS sandbox; `&` / `nohup` delayed
  writes inside a foreground command, and writes after the Moss process itself exits, remain known
  limits.
- **Trust a device** (any one; deny rules still win): `--trust-device` (this process only),
  `MOSS_DEVICE_TRUST=full`, `permissions.deviceTrust=full`, or `permissions.trustedDevices` /
  `MOSS_DEVICE_TRUST_DEVICES` (comma-separated host or device id). Answering `a` trusts only the
  scope named in the prompt (for example `systemctl restart` or `stop` of that unit, or the same
  command prefix) until the session ends. Reading `/etc/shadow`, private keys, `sshd_config`, or
  `authorized_keys` is a `sensitive` tier: it still confirms, and the copy does not call it
  destructive. Prompts and refusals follow the UI language (`--lang`, `MOSS_LANG`, or the user
  config `language`; otherwise Simplified Chinese when the system locale starts with `zh`).
  Every decision is appended to `.moss/evidence.jsonl`
  (`metric: device_policy`) and, when a task is in progress, to its timeline as a `note`.
  Policy: [`docs/superpowers/plans/2026-10-09-device-safety-policy.md`](docs/superpowers/plans/2026-10-09-device-safety-policy.md).
- **Legacy keys** (one release of grace): `profile` / `trustedTools` / `deniedTools` /
  `safetyMode` / `approvalPolicy` are translated on read (cautious→manual+read-only ceiling,
  balanced→manual, autonomous→full, trustedTools→allow rules, deniedTools→deny rules); writing
  them prints a deprecation notice — use the `permissions.*` block for new config.
- **Programs Moss starts never come from the workspace (O158)**: startup probes, shell
  resolution, git probes, a hook's launch command and MCP servers are resolved to an absolute
  path from absolute PATH entries only, skipping empty entries, `.`, relative entries and
  directories inside the workspace; Windows children get `NoDefaultCurrentDirectoryInExePath=1`.
  **Known limitation**: when moss starts with a PATH that holds a workspace directory (e.g.
  `node_modules/.bin` from `npx` / `npm run`), the model's exec commands and programs a hook
  script calls itself use that PATH, so they get the project's tool of that name.
- **What a hook's launch command gets resolved (O164)**: Moss applies the rule above only to the
  program name at the start of a hook command. With an env prefix (`FOO=1 git`), `exec` / `env` /
  `command`, quotes, a subshell, `;` or a redirect, the normal shell lookup applies, and a launch
  through `npx` / `npm run` uses `node_modules/.bin` on PATH. Write user-level hooks as
  `program args` or with an absolute path. Project hooks (`.moss/config.json`) run only after you
  trust the folder; trusting a folder means trusting its code, including project hooks and the
  programs in `node_modules/.bin`.
- **`.env` cannot move system locations (O164)**: like `PATH`, `PATHEXT`, `ComSpec` and
  `TEMP`/`TMP`, a `.env` cannot set `SystemRoot`, `windir`, `SystemDrive`, `ProgramFiles` (also
  `(x86)` and `ProgramW6432`), `PSModulePath` or `NoDefaultCurrentDirectoryInExePath`. Moss builds
  paths to system programs (such as the background job's `powershell.exe`) from the environment
  before `.env` was loaded. A child PATH left with no usable entry (only `.` or empty entries)
  becomes a directory that does not exist, never an empty string.
- **Hook output over the capture limit blocks (O162)**: each hook's stdout and stderr are captured
  up to 10 MiB per stream. Once anything is cut, the verdict (the last JSON line) cannot be
  trusted, so every blocking event (`PreToolUse`, `UserPromptSubmit`, `PermissionRequest`, `Stop`)
  fails closed — the run ends blocked / the call is denied whatever the exit code or the readable
  part of the output said. A `blocking: false` hook cannot restrict a call, so its oversized
  output does not block either.
- **A script's arguments are not deletions (O168)**: arguments of an invoked script (the
  interpreter script form `python3 x.py $HOME`, `node x.js \"$PWD\"`, `sh x.sh`, the
  `.`/`source` operand and the bare `.`) no longer trip the delete-ancestor rule — normal
  commands stop being blocked and a non-git directory is no longer labeled git internals.
  Like the cd exemption it applies only while the path is named nowhere else in the command;
  directly protected arguments (`$HOME/.ssh`, `.git/config`), inline forms and real deletes
  are unchanged, and actual writes stay covered by the script scan and the post-run snapshot.
- **git pack flags are exec-capable (O169)**: `git clone --upload-pack=<cmd>`,
  `git fetch`/`git push` with `--upload-pack` / `--receive-pack=<cmd>` (glued, split, or
  clone's short `-u`) make git run that command; they are pre-blocked like `git -c` and
  `--ext-diff`. `git push -u origin main` (--set-upstream) is unaffected.
- **A hook that throws blocks (O165)**: any exception while handling a hook on a blocking
  event fails closed with a visible notice (PreToolUse blocks the call, PermissionRequest
  denies, UserPromptSubmit rejects the prompt); a throwing Stop hook is a terminal veto —
  no forced continuation turn, no further model call, and headless ends Incomplete
  (exit 9). In `-p`, a blocked UserPromptSubmit hook ends 「被拦」/`Blocked` with exit 9
  (was exit 8).
- Credentials come only from `.env` or the environment: never hardcoded, never logged, never
  passed to child processes, never written to the device registry. No account, no cloud, no
  telemetry.

## Quality gates and benchmarks

```bash
npm run check    # prettier + eslint (0 warning) + typecheck
npm run test     # build + every test/*.spec.mjs (235 specs, run against dist/)
npm run smoke    # CLI smoke: --version / --help / PTY startup
npm run verify   # check + test + smoke — required before any release

# Real terminals (tmux / GNU screen / Terminal.app); off by default, missing terminals are skipped
npm run build && MOSS_REAL_TERMINALS=1 npm run test:filter -- --filter tui-real-terminals
```

Benchmarks stay out of git in `bench/results/`:

- `npm run bench` · `npm run bench:ab -- reasoning-high` · `npm run bench:noise`: agent capability, A/B, noise band
- `npm run bench:swe` · `npm run bench:tb`: locked SWE-bench Verified subset · Terminal-Bench
- `npm run bench:deepswe`: DeepSWE v1.1 with the model held fixed against other harnesses (runs
  through Pier; published scores in `bench/boards/deepswe-v1.1-harness.json`)
- `npm run bench:device -- --dry` (or `--target sim` / `--target real`): RDK board-task success
  rate. A row passes only when Moss's verdict passes and an independent probe matches the
  evidence — see [`docs/bench/device-bench.md`](docs/bench/device-bench.md)
- `npm run bench:tui-feel`: TUI feel · `node scripts/task-os-metrics.mjs`: Task OS metrics
  (turns / tools / success rate)

A version number states the **current capability level**: `main` is the rolling line, tags are cut
only after `verify` is green and `examples/` pass for real — see
[`docs/release-policy.md`](docs/release-policy.md).

## Support matrix

| Dimension | Supported                                                                | Verified by                         |
| --------- | ------------------------------------------------------------------------ | ----------------------------------- |
| Node      | ≥ 22.16.0                                                                | CI matrix (22.16 / 24)              |
| Platform  | Linux / macOS / Windows                                                  | CI matrix (no PTY smoke on Windows) |
| Providers | deepseek / qwen / openai / anthropic / openai-compatible                 | unit tests + smoke                  |
| Surfaces  | TTY: full-screen TUI; non-TTY / `MOSS_NO_TUI=1` / Windows: readline REPL | TUI specs + PTY smoke               |

## Documentation

[`AGENTS.md`](AGENTS.md) (architecture and conventions) ·
[`docs/release-policy.md`](docs/release-policy.md) ·
[`docs/capability-layer.md`](docs/capability-layer.md) ·
[`docs/design/os-sandbox.md`](docs/design/os-sandbox.md) (opt-in OS sandbox for `exec`, default off) ·
[`docs/cli-parity/`](docs/cli-parity/) (real-terminal checklist:
[`tui-real-terminals.md`](docs/cli-parity/tui-real-terminals.md)) ·
[`docs/bench/device-bench.md`](docs/bench/device-bench.md) ·
[`CHANGELOG.md`](CHANGELOG.md) ·
[`docs/superpowers/plans/`](docs/superpowers/plans/).

## License

MIT — see [`LICENSE`](LICENSE).
