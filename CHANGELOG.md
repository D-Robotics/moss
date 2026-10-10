# Changelog

## Unreleased

### Install follow-ups

`npm ci` runs `scripts/check-node-version.cjs` as `preinstall`. The script is
listed in `files`, so the packed global copy can run it. npm installs
dependencies before that hook; on Node older than 22.16 the script prints the
upgrade steps and exits 1, with those packages already on disk. The README
says not to follow
npm's notice to upgrade to npm 12 on Node 22.16. macOS git needs
`xcode-select --install`. `moss update` looks only in the current directory
and `./moss` unless you pass `--dir <clone>` or set `MOSS_SOURCE_DIR`.
`moss --version` appends `+dirty` when the worktree had uncommitted changes
at build time. The uninstall notes include `~/.cache/node-gyp` and an empty
`@rdk-moss` directory under the npm prefix.

### Folder trust asks once per folder

After upgrading, Moss asks once per folder — including an empty project —
before it loads that folder's settings. Yes is remembered in the user trust
store. The next launch in that folder does not ask. `-p` and CI do not ask
unless `--trust-workspace` or real-environment `MOSS_TRUST_WORKSPACE=1` is
set. After a folder is trusted, execution stays in full mode: Moss does not
stop for a per-command approval. An ancestor `.env` still does not apply
routing keys; Moss prints those key names and the directory that contained
them, even when this folder is trusted. `MOSS_WORKSPACE` in a project `.env`
is ignored (any letter case), so it cannot move the workspace or the trust
decision. Model tiers (`MOSS_MODEL_CHEAP`, `MOSS_MODEL_BALANCED`,
`MOSS_MODEL_STRONG`) from a project `.env` wait for trust, as do
`PGSSLROOTCERT`, `HF_HUB_DISABLE_SSL_VERIFY`, `GLOBAL_AGENT_HTTP_PROXY`, and
`FTP_PROXY`. A trusted project that names the user's key variable
(`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, and the other preset key names) on a
foreign base URL does not receive that key. A fallback provider that would
send the primary key to another host is dropped with a warning instead of
exiting. `PIP_TRUSTED_HOST`, `UV_INSECURE_HOST`, and `DENO_CERT` from a
project `.env` stay deferred with the other routing variables.

### Project `.env` cannot change approval or other safety controls

`MOSS_AUTO_APPROVE`, `MOSS_PROFILE`, `MOSS_CONFIG_PROFILE`,
`MOSS_GOAL_VERIFY_LOOP`, `MOSS_GOAL_VERIFY_CMD`, and the other approval, trust,
redaction, and tool-permission variables are ignored when they come from a
project `.env` or an ancestor directory's `.env`, whether or not that folder is
trusted. They still work from the real process environment and from CLI flags.
Moss prints one line naming the ignored keys and the `.env` path (`-p` and the
REPL on stderr; the fullscreen TUI in the transcript, because the alternate
screen hides earlier stderr). `MOSS_DEVICE_HOST`, `MOSS_DEVICE_PORT`,
`MOSS_DEVICE_USER`, `MOSS_DEVICE_ID`, `MOSS_DEVICE_KIND`, and `MOSS_DEVICE_KEY`
wait for folder trust with the other routing variables, so an untrusted project
cannot point the user's `MOSS_DEVICE_PASSWORD` at another host. `~/.env` and
the install directory's `.env` still apply those device fields. That is the
documented way to name a board.

### Install and upgrade from a clone

`npm install -g github:D-Robotics/moss` fails on a clean machine (npm 10.9.2 and
11.21.0) because a git dependency's prepare inherits global npm config. Install
from a clone. `npm ci` runs `prepare` (`npm run build`), so the documented
commands do not build a second time:

```bash
git clone https://github.com/D-Robotics/moss.git
cd moss
npm ci
npm install -g --install-links .
```

Upgrade an existing clone (this reinstalls the global copy, not only the checkout):

```bash
cd moss && git pull && npm ci && npm install -g --install-links .
```

`moss update` prints that line when the running package, the working directory,
or `./moss` is a checkout. Otherwise it prints the clone commands. It does not
run them. `moss --version` appends the short commit and the UTC build date
recorded in `dist/utils/build-stamp.json`, for example
`moss v0.26.0 (e8dc2e3, 2026-10-10)`. With no commit available the parenthetical
is omitted.

`--install-links` puts a standalone copy in the prefix. If an older unscoped `moss`
package is installed, run `npm uninstall -g moss` first; npm otherwise stops with
EEXIST on the shared bin. Do not pass `--force`: both packages stay installed, and
a later `npm uninstall -g moss` removes the `moss` command. That uninstall leaves
`@rdk-moss/agent` in place when `--force` was not used.
`npm install -g @rdk-moss/agent` is coming soon.

### `workspace-write` copy no longer implies an OS sandbox

`workspace-write` confines Moss's own file tools. Shell commands run normally
without an OS sandbox. `/permissions`, `config show`, help, the README (en and
zh), and the startup full-mode notice say so. Behaviour is unchanged. An
opt-in OS sandbox (default off) is specified in `docs/design/os-sandbox.md`.

### Legacy loop scheduler removed

`LoopScheduler`, its acceptance-failure prompt, and the loop TUI event bridge are gone.
`/goal`, `/task`, `moss task`, and `MOSS_GOAL_VERIFY_LOOP` behave as before. `/loop` does not
start a run: it prints a localized line (`/loop` is now `/goal`, with an example) and leaves
a `/goal` command in the composer to confirm or edit. Acceptance commands run from `core/task/acceptance-command.ts`. A token
or tool-call budget stop ends the task (`run budget exceeded (…)`) instead of opening another
turn. `.moss/loop-state.json` and `.moss/loop-journal.jsonl` are no longer read or written;
files already in a workspace are left in place. `MOSS_DISABLE_NUDGES=goal-acceptance` is an
unknown id and is ignored.

### Workspace trust and Claude hook compatibility

Project hooks from `.moss/config.json` now keep every event (`Stop`, `SubagentStop`,
`PreCompact`, `PostCompact`, `SessionEnd`, `Notification`, `UserPromptSubmit`,
`PermissionRequest`), not only `PreToolUse` / `PostToolUse` / `SessionStart`.
`UserPromptSubmit` runs as the input guardrail: exit code 2 or `{decision:"block"}`
rejects the prompt and the reason is shown. Stdout is extra context only when the
hook exits 0; it is redacted and wrapped in `<hook-output source="UserPromptSubmit">`.
`PermissionRequest` runs before the approval prompt and can deny; an allow decision
does not skip the prompt. Moss-native hooks still block on any non-zero exit.
Claude-format hooks (`.claude/settings.json`) block only on exit code 2, and
`PreToolUse` also honors `hookSpecificOutput.permissionDecision: "deny"`. Matchers
follow Claude Code: `*` matches all, and `Bash, Edit` / `Edit|Write` are exact
lists. Payloads include Claude `tool_input` names such as `command` and `file_path`.
Tool names map as `Bash` → `exec`, `Edit` → `edit_file`, `Write` → `write_file`,
`Read` → `read_file`, `Grep` / `Glob` → the search tools.

Reading `.claude/` (`settings.json`, `settings.local.json`, or `agents`) and
`.mcp.json` waits for a one-time yes/no (中文 or English) remembered per workspace.
Project hooks, project MCP servers (stdio and HTTP, `.moss/mcp.json` included),
a project `statusLine` command, project agents with write tools, and plugins need
a one-time trust confirmation per workspace path. Untrusted HTTP servers are not
loaded, so `${VAR}` in a project URL is not expanded. That decision is passed to
the agent loader as `projectTrust` (`trusted` and `claudeOptIn` stay independent:
declining Claude compatibility with nothing else project-level is still
`trusted: true` and `claudeOptIn: false`, so `.claude/agents` write agents stay
blocked). The built-in rdk-docs server is exempt because Moss injects it, not
because of its name. A project server named `rdk-docs`, and a project
`rdkDocs.package`, do not replace that builtin until the workspace is trusted;
project config cannot set the package. The user's own config
(`~/.config/moss` and `~/.moss`) does not ask. `MOSS_TRUST_WORKSPACE`,
`MOSS_CONFIG_DIR`, `MOSS_CONFIG_FILE`, `MOSS_CONFIG_PATH`,
`MOSS_RDK_DOCS_PACKAGE`, `XDG_CONFIG_HOME`, `HOME`, `APPDATA`, and
`USERPROFILE` are read from the process environment captured before `.env`
is loaded, and from CLI flags. A project `.env` cannot set them, and cannot
set interpreter or loader variables (`NODE_OPTIONS`, `NODE_PATH`,
`NODE_EXTRA_CA_CERTS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_*`,
`BASH_ENV`, `ENV`, `ZDOTDIR`, `PYTHON*`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`,
`RUBYLIB`, `GIT_*` (`GIT_DIR`, `GIT_CONFIG`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`,
`GIT_OBJECT_DIRECTORY`, and the rest), `npm_config_*`, `PATH`, `SHELL`, `IFS`,
`TMPDIR`, `TMP`, `TEMP`).
Child processes keep the user's own values of those variables and drop ones the
project file added. The built-in rdk-docs `npx` child inherits only the
pre-`.env` environment. It runs in a Moss cache directory under the pre-`.env`
home (`~/.moss/cache/npx`), not `TMPDIR`. It does not pass `--registry`, so a
mirror in the user's `~/.npmrc` or pre-`.env` `npm_config_registry` is used.
`npm_config_userconfig` stays the user's own `~/.npmrc`, and
`npm_config_globalconfig` is not changed, so a project `.npmrc` `registry=` is
not used. Every git child passes `-c core.fsmonitor=` and
`-c core.hooksPath=/dev/null` (`NUL` on Windows). Read-only git also clears
`core.sshCommand`, `diff.external`, and `credential.helper`, forces
`core.pager=cat` with `GIT_PAGER=cat`, passes `--no-ext-diff` and
`--no-textconv` on `diff`, and blanks `local` and `worktree`
`filter.*.clean|smudge|process` and `diff.*.textconv|command` (with
`filter.<name>.required=false`), including keys from `include.path`,
`includeIf`, and `extensions.worktreeConfig`. System and global git config
are still read and are not overridden. Git children take `GIT_*` from the
environment captured before the project `.env`. Startup `git status` and
`/diff` do not run a program named in a copied repo's `.git/config` or
`.gitattributes`. If listing that config fails for any reason other than
no matches (exit 1), the read-only git command is refused. A session JSON
line keeps the per-value redaction when a whole-line pass would still parse
but drop a later tool result. Device bench removes the temporary provider
config directory that holds the API key on finish, process exit, and
SIGINT / SIGTERM / SIGHUP.
Headless `-p` stays untrusted and
prints one line naming what was skipped. Enable it for that process with
`--trust-workspace` or `MOSS_TRUST_WORKSPACE=1`.

### Slash commands follow Claude Code / Codex

The everyday menu shows `/model` `/compact` `/goal` `/plan` `/review` `/doctor` `/diff` `/resume`
`/permissions` `/clear` `/help` (plus `/theme` in the TUI); other commands stay typeable but hidden. `/plan [description]`
enters plan mode. `/goal` is the "work until" entry (`/loop` migrates to it) and, without
`--accept`, proposes acceptance commands from test entry points that exist in the workspace.
`/resume` restores a conversation (`/sessions` migrates to it). `/tasks` (aliases `/ps`,
`/bashes`) lists background shells and sub-agents. `/stop` (alias `/abort`) stops background
processes this session started; Esc interrupts the run. A message typed during a run steers it
and falls back to the queue above the composer; `/steer` and `/queue` are hidden aliases for one
version. The hidden `/task` gains `verify`, which takes one verdict without a model turn.

### Real-terminal checks (TUI P7)

`scripts/tui-feel/real-terminals.py` drives tmux (mouse off and on), GNU screen, and
Terminal.app, and skips terminals that are not installed. `npm test` runs it only when
`MOSS_REAL_TERMINALS=1`. Manual checklists for iTerm2, VS Code, Windows Terminal, and IME
candidate windows are in `docs/cli-parity/tui-real-terminals.md`.

### Benchmarks

- `npm run bench:device` scores RDK board tasks in `bench/device-tasks/` (`--dry`, `--target sim`,
  `--target real`). A row passes only when the verdict passes and an independent probe matches
  the evidence; `falseSuccess` is reported separately. See `docs/bench/device-bench.md`.
- `npm run bench:deepswe` runs Moss on DeepSWE v1.1 through Pier with the model held fixed, for
  comparison with `bench/boards/deepswe-v1.1-harness.json`.
- `moss task run` prints an `llm_usage` JSON line when the agent reports tokens.

### RDK knowledge

Board manuals come from the built-in rdk-docs MCP, defaulting to the pinned
`rdk-docs-mcp@0.3.0`. Search stays BM25 with title fusion, `noGoodMatch`, and board filtering.
`search_docs` accepts `alt_queries` and returns compact hits (title, url, anchor, snippet) unless
`verbose` is set. `get_page` returns the matching section unless `full` is set. `search_skills`
and `get_skill` read the skill catalog. `MOSS_RDK_DOCS_PIN_CHECK=1` makes `moss doctor` ask npm
whether a newer `rdk-docs-mcp` is published; the check is off by default and does not run at
startup. Moss connects it in the background when a device target is configured
(`MOSS_DEVICE_HOST` or `.moss/devices.json`) or when `rdkDocs` is true. `rdkDocs.package` and
`MOSS_RDK_DOCS_PACKAGE` accept a trusted npm spec, local directory, or tarball for unpublished
server builds. Opt out with `MOSS_NO_RDK_DOCS=1` or `"rdkDocs": false`. A same-named `mcp.json`
entry replaces the builtin. Connect timeout is 45s and each request 20s for this server only; the
timeout does not delay the interactive shell. A failed connect prints
`[mcp] rdk-docs unreachable (<reason>) — RDK manual lookup is off this session.` and the system
prompt tells the agent the manual could not be checked. There is no cache and no offline copy.
When the server is up, the prompt points only at the registered `mcp__rdk-docs__search` tool and
treats version-specific search/ranking/section features as optional. A short `rdk-docs` skill is
indexed and follows the compact hit and section-read shape. The robotics fallback verifies `<installation>/setup.bash` before sourcing it; probe
scripts, connection steps, and device safety rules stay. See
`docs/superpowers/plans/2026-10-09-rdk-knowledge-via-mcp.md`.

### 工作区信任与 Claude hooks

`.moss/config.json` 里的项目 hooks 会合并全部事件，不再丢掉 `Stop` 等类型。
`UserPromptSubmit` 在输入护栏上拦截（退出码 2 或 `{decision:"block"}`，原因展示给用户）。stdout 只在退出码 0 时作为额外上下文，先脱敏再包进 `<hook-output source="UserPromptSubmit">`。
`PermissionRequest` 在询问用户之前运行，只接受拒绝。Claude 格式的 hooks 只在退出码 2 时阻断，`PreToolUse` 同时接受 `permissionDecision: "deny"`；`*` 与逗号/管道列表按 Claude Code 匹配，`tool_input` 带上 `command` / `file_path`。
读取 `.claude/`（settings 或 agents）和 `.mcp.json` 需要一次性确认。项目 hooks、项目 MCP（stdio 与 HTTP，含 `.moss/mcp.json`）、项目 `statusLine` 命令、带写工具的项目 agent 和插件也需要按路径一次性信任。未信任的 HTTP 服务器不会加载，因此不会展开项目 URL 里的 `${VAR}`。
信任结果传给 agent loader（`trusted` 与 `claudeOptIn` 分开：拒绝 Claude 兼容且没有其他项目内容时仍是 `trusted: true`、`claudeOptIn: false`，`.claude/agents` 里的写代理继续被挡住）。
内置 rdk-docs 因来源是 Moss 自己注入而免询问；同名的项目服务器和项目 `rdkDocs.package` 不能替换它。用户自己的配置（`~/.config/moss` 与 `~/.moss`）不会询问。
`MOSS_TRUST_WORKSPACE`、`MOSS_CONFIG_DIR`、`MOSS_CONFIG_FILE`、`MOSS_CONFIG_PATH`、`MOSS_RDK_DOCS_PACKAGE`、`XDG_CONFIG_HOME`、`HOME`、`APPDATA`、`USERPROFILE` 只认加载 `.env` 之前的进程环境和命令行，项目 `.env` 不能设置。项目 `.env` 也不能设置解释器/加载器变量（`NODE_OPTIONS`、`LD_PRELOAD`、`DYLD_*`、`BASH_ENV`、`PYTHON*`、`PERL5*`、`RUBY*`、`GIT_*`（含 `GIT_DIR`、`GIT_CONFIG`、`GIT_WORK_TREE`、`GIT_COMMON_DIR`、`GIT_OBJECT_DIRECTORY`）、`npm_config_*`、`PATH`、`SHELL`、`IFS`、`TMPDIR`、`TMP`、`TEMP` 等）。子进程保留用户自己设的值，丢掉项目文件加进来的值。内置 rdk-docs 的 `npx` 子进程只继承加载 `.env` 之前的环境，工作目录是加载 `.env` 之前的用户主目录下的 `~/.moss/cache/npx`，不用 `TMPDIR`，也不传 `--registry`，因此用户 `~/.npmrc` 或进程环境里的镜像源仍然有效；`npm_config_userconfig` 保持用户自己的 `~/.npmrc`，不改 `npm_config_globalconfig`，项目 `.npmrc` 的 `registry=` 不会被用到。Moss 启动的每个 git 子进程都带 `-c core.fsmonitor=` 和 `-c core.hooksPath=/dev/null`（Windows 为 `NUL`）。只读 git 另外清空 `core.sshCommand`、`diff.external`、`credential.helper`，把 `core.pager` 与 `GIT_PAGER` 设为 `cat`，对 `diff` 加上 `--no-ext-diff` 和 `--no-textconv`，并清空 local 与 worktree 作用域的 `filter.*.clean|smudge|process` 与 `diff.*.textconv|command`（含 `include.path`、`includeIf`、`extensions.worktreeConfig` 引入的键，同时 `filter.<name>.required=false`）。系统级和 global git 配置仍会读取且不会被覆盖。git 子进程的 `GIT_*` 取自加载项目 `.env` 之前的环境。启动时的 `git status` 和 `/diff` 不会执行拷贝来的仓库 `.git/config` 或 `.gitattributes` 里指定的程序。列出这些配置时，除了没有匹配（退出码 1）以外的失败都会拒绝这次只读 git。会话 JSON 行在整行脱敏仍能解析、但会丢掉后面的 tool result 时，保留按值脱敏的结果。设备基准在结束、进程退出和 SIGINT / SIGTERM / SIGHUP 时删除存放 API key 的临时 provider 配置目录。
无头 `-p` 默认不信任，并打印一行说明跳过了什么；用 `--trust-workspace` 或 `MOSS_TRUST_WORKSPACE=1` 启用。

### 斜杠命令、真实终端与基准

日常菜单与 Claude Code / Codex 对齐，其余命令隐藏但仍可输入。`/plan` 直接进入 plan 模式；
`/goal` 是"做到为止"的入口（`/loop` 迁移到它），没带 `--accept` 时从工作区已有的测试入口给出验收命令候选；
`/resume` 恢复会话；`/tasks`（别名 `/ps`）列后台任务；`/stop` 只停本会话的后台进程，打断用 Esc；
运行中发消息默认 steer，不能 steer 时排队。隐藏的 `/task` 新增 `verify`。
真实终端核对用 `MOSS_REAL_TERMINALS=1` 打开。新增 `npm run bench:device`（板卡任务成功率）与
`npm run bench:deepswe`（同模型 DeepSWE 对比）。RDK 手册由内置 rdk-docs MCP 供给，默认钉在 `rdk-docs-mcp@0.3.0`（设备会话默认连接，
`MOSS_NO_RDK_DOCS=1` 或 `rdkDocs: false` 关闭；连不上只报一行错误，不缓存）。

### Device safety policy

Full mode still runs read-only probes and reversible device changes without asking
(deploys under `/home`, `/opt`, `/tmp`, `/usr/local`, package installs, `systemctl restart`).
Destructive or lockout-risk device operations — reboot and poweroff, flashing and `mkfs`,
writes to `/boot` or `/etc`, firewall and network changes, system package removal,
`systemctl stop` / `disable` / `mask`, ssh and account edits — now require a TTY confirmation.
Headless runs refuse that tier unless the operator opts in.

Opt in with `--trust-device` (this process), `MOSS_DEVICE_TRUST=full`,
`permissions.deviceTrust=full`, `permissions.trustedDevices` or `MOSS_DEVICE_TRUST_DEVICES`
for one board, or an allow rule that matches the call. Deny rules still win.
Answering `a` trusts only the scope named in the prompt (power commands, `systemctl restart` or
`stop` of that unit, or the same command prefix) for the rest of the session.
Secret reads (`/etc/shadow`, private keys, `sshd_config`, `authorized_keys`) are a `sensitive`
tier: they still confirm, and evidence records `sensitive:` rather than `destructive:`.
Grants are bound to the tool call id. Flash-like script names escalate to destructive.
`systemctl daemon-reload` and stop/disable/mask of non-critical units are reversible; ssh,
networking, and dbus stay destructive. zh-CN locales get Chinese approval copy.

Each decision is appended to `.moss/evidence.jsonl` (`metric: device_policy`) and, when a
task is in progress, to its timeline as a `note`. Host `exec` hard blocks are unchanged.
See `docs/superpowers/plans/2026-10-09-device-safety-policy.md`.

### 设备安全策略

full 模式仍自动执行只读探测和可逆设备变更。重启、刷机、系统路径写入、网络变更、卸载系统包、
停用 ssh 等毁灭性操作改为 TTY 确认；无终端时拒绝，除非显式信任（`--trust-device`、
`MOSS_DEVICE_TRUST=full`、`permissions.deviceTrust`、按设备名单或 allow 规则）。
选 `a` 只信任提示里的范围。读密钥是 `sensitive` 档。grant 绑定 tool call id。
刷机/OTA 脚本名升为毁灭性。非关键 unit 的 systemctl stop 可逆。中文 locale 使用中文确认文案。
每次决定写入任务证据与时间线。本机 `exec` 硬拦截不变。
