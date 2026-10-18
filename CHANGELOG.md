# Changelog

## Unreleased

### O169 — `git --upload-pack` / `--receive-pack` literal commands are blocked

`git clone --upload-pack='<cmd>'`, `git fetch --upload-pack=…`, `git push
--receive-pack=…` (glued, `--upload-pack cmd`, or clone's short `-u`) make git
run the given command to speak the pack protocol — arbitrary execution that
looks like a plain clone/fetch/push. The flags were not in the exec-capable
table, so the pre-exec block (O152) never fired. They now are, in the
subcommand position and the global one; `git push -u origin main`
(--set-upstream) is unaffected.

`git clone --upload-pack='<cmd>'`、`git fetch --upload-pack=…`、`git push
--receive-pack=…`（连写、空格分开、或 clone 的短旗标 `-u`）会让 git 执行给定命令来
讲 pack 协议——表面是普通 clone/fetch/push，实际是任意执行。此前这些旗标不在
「可执行读取」表里，O152 的执行前拦截从未触发；现已加入（子命令位与全局位都识别）。
`git push -u origin main`（--set-upstream）不受影响。

### O170 — shell-exec env assignments and tmux/screen spawn forms are blocked

`BASH_ENV=<file> bash -c ':'` sources the file, `ENV=` does the same for POSIX
sh/dash, `PROMPT_COMMAND=` runs before every prompt of an interactive bash,
`ZDOTDIR` moves zsh's `.zshenv`, an exported `BASH_FUNC_name%%=() { … }` body
is code, and `tmux new-session/run-shell/send-keys` / `screen -dmS` run a
command outside Moss's process tree — none of them tripped the exec-capable
gate on main; a probe planted in BASH_ENV ran. The env assignments are now
reported when a POSIX shell head runs on the same line (`ENV=production npm
start` is not flagged — the name collision is common), in every assignment
shape (prefix, `env`, `export`/`declare`, `set`, bare statement, pwsh
`$env:`), and the tmux/screen forms are reported when they carry a command
(`tmux ls`, `tmux attach`, `screen -ls` stay green).

`BASH_ENV=<file> bash -c ':'` 会让 bash source 该文件，`ENV=` 对 POSIX sh/dash
同理，`PROMPT_COMMAND=` 在交互 bash 每个提示符前运行，`ZDOTDIR` 改写 zsh 的
`.zshenv` 位置，导出的 `BASH_FUNC_name%%=() { … }` 函数体本身就是代码；
`tmux new-session/run-shell/send-keys` 与 `screen -dmS` 在 Moss 进程树之外运行
命令——这些在 main 上都不会触发「可执行读取」拦截，BASH_ENV 里放的探针真的
跑了起来。现在：环境变量赋值在**同一行内有 POSIX shell 头**时报为可执行
（`ENV=production npm start` 不误拦——这个名字常被应用配置占用），覆盖前缀、
`env`、`export`/`declare`、`set`、裸赋值、pwsh `$env:` 各种形态；tmux/screen
仅在其携带命令时报（`tmux ls`、`tmux attach`、`screen -ls` 不受影响）。

### O157 — PreToolUse hook `ask` now asks the user; `-p` treats it as deny

A PreToolUse hook that exits 0 with `ask` (Claude `hookSpecificOutput.permissionDecision:
"ask"`, or moss/legacy top-level `decision: "ask"`) previously fell through to
"approved": the call ran without anyone confirming. An `ask` is now recognized
(case-insensitive) and every matching hook runs, so a deny after an ask still
blocks (merge order: deny > ask > allow). Interactive sessions show Moss's y/a/n
confirmation naming the hook, its config file and its reason; `y` and `a`
approve only that call and grant nothing (the hook asks again next time), `n`
refuses. The prompt appears in every mode, full included — trusted workspace,
plan-allow and session allow rules do not skip it. `-p` and runs without a
terminal cannot confirm and treat the ask as deny: the run ends 「被拦」/`Blocked
by` with exit 9. A host that ignores the `hookAsks` field fails closed.

`PreToolUse` hook 以 exit 0 输出 `ask`（Claude 的
`hookSpecificOutput.permissionDecision: "ask"`，或 moss/旧格式的 `decision: "ask"`）
以前会落成「已批准」：调用直接运行，没有人确认过。现在 `ask` 被识别（不区分大小写），
且所有匹配的 hook 都会运行——ask 之后再出现 deny 仍然拦截（合并顺序：deny > ask >
allow）。交互会话弹出 y/a/n 确认，点名 hook、配置文件与理由；`y`/`a` 只批准这一次、
不授予任何信任（下次钩子还会再问），`n` 拒绝。任何模式（包括 full）都会弹确认——
受信任工作区、plan 放行、会话 allow 规则都不能跳过它。`-p` 与无终端的运行无法确认，
按拒绝处理：末行「被拦」，exit 9。不理解 `hookAsks` 字段的宿主按拦截失败关闭。

### O156 — Windows PowerShell 5.1: a missing hook command is "failed to start"

A hook run through Windows PowerShell 5.1 (`powershell -Command <missing>`)
prints `X : The term 'X' is not recognized … operable program` (space before
the colon, wrapped at console width) and exits 1. Moss did not recognize it,
so Claude-format `UserPromptSubmit`, `Stop` and `PermissionRequest` hooks let
the action through. It is now "failed to start; treated as deny" on every
event, like pwsh 7 and cmd. Detection does not rely on English: 5.1's error
record ends with an untranslated `CategoryInfo … CommandNotFoundException`
line, and the Chinese texts of pwsh 7 and 5.1 are recognized too.

Windows PowerShell 5.1 下 hook 命令不存在（`X : The term 'X' … operable
program`，冒号前有空格、按控制台宽度折行，exit 1）以前识别不出来，Claude 格式的
UserPromptSubmit、Stop、PermissionRequest 会放行；现在所有事件都按「未能启动，
已按拒绝处理」拦截。识别不依赖英文：5.1 错误记录末尾的
`CategoryInfo … CommandNotFoundException` 不随语言变化，pwsh 7 和 5.1 的中文
文本也能识别。

The detector no longer builds a regular expression from stderr text. A hook
whose stderr started with a token of 32759+ characters followed by `:` made
it throw ("Regular expression too large"); a Stop hook was then allowed and
the other events crashed. The name is now read with a fixed pattern and
capped, and any detection error makes the hook fail closed.

识别不再用 stderr 内容拼正则。以前 stderr 开头是 32759 字符以上的一个词再接
`:` 时会抛「Regular expression too large」，Stop hook 因此被放行，其他事件直接
报错。现在用固定正则取名并限制长度，识别过程出任何异常都按拦截处理。

The English PowerShell text is matched at least as loosely as before this
change: no space after the colon (`X:The term 'X' …`) and no article
(`… recognized as name of …`) are still a missing command, so those hooks
block exactly as they did.

英文 PowerShell 文本的识别不比改动前更严：冒号后没有空格（`X:The term 'X' …`）、
省略冠词（`… recognized as name of …`）仍算命令不存在，这些 hook 照旧拦截。

### O135 — PreToolUse hooks: any non-zero exit blocks

A `PreToolUse` hook that exits non-zero now blocks the tool call in both Moss
and Claude formats, whatever its output says: `{"decision":"allow"}`,
`{"decision":"approve"}` and `hookSpecificOutput.permissionDecision: "allow"`
from a process that failed are ignored. The run ends 「被拦」/`Blocked by` with
exit 9, and the reason names the hook and says its allow was ignored. This is
deliberately stricter than Claude Code, which treats non-zero exits other than
2 as non-blocking errors. On Windows a hook whose command is missing (cmd or
pwsh) is treated as "failed to start" and blocks.

`PreToolUse` hook 非 0 退出一律拦截，Moss 和 Claude 两种格式都一样，输出里的
allow / approve / `permissionDecision: "allow"` 都不算数；末行「被拦」，exit 9，
提示里点名 hook 并说明已忽略其 allow。这比 Claude Code 更严（它对 2 以外的非 0
只当非阻塞错误）。Windows 上 hook 命令不存在（cmd 或 pwsh）按「未能启动」拦截。

## 0.26.1 (2026-10-11)

First npm release of the package (`@rdk-moss/agent`). Version 0.26.0 was tagged
in-repo but never published; npm `latest` was 0.6.0 before this release.

### TUI — OSC 11 replies no longer leak into the composer

On startup Moss asks the terminal for its background colour (OSC 11). When the
reply arrives split across stdin chunks — as real terminals do — neither piece
matched the old single-chunk check and the reply text (`]11;rgb:…`) landed in
the composer as if typed. A small state machine (`src/cli/tui/osc-reply-filter.ts`)
now reassembles OSC 11 replies across arbitrary chunk boundaries (BEL and ST
terminators), holds a bounded tail for split heads, and flushes as plain text
when no reply materialises. Theme detection still works; ordinary typing and
pastes are untouched. Verified with a PTY harness: split-reply repro shows a
clean composer after the fix.

### O88 — hooks fail closed

A blocking hook that cannot start or times out now blocks instead of silently allowing. Exit codes 126/127 (and 9009 on Windows) are treated as "failed to start" and block too, so hooks that intentionally exit with these codes are now blocked.

### O90 — hooks timeoutMs clamped to Node timer max

Moss-format `timeoutMs` values above the Node.js timer maximum (~2^31-1 ms) are
clamped to the maximum with a one-time warning instead of firing immediately.

### O86 — read-after-edit honesty

A file read is no longer answered with a "content unchanged, see the earlier
read" stub after the file was edited by a write/patch/move, after the earlier
read left the model context (compaction/elision), or when the on-disk bytes no
longer hash-match the last recorded read. Failed writes no longer invalidate
the earlier read. Files larger than 2 MiB skip the pre-stub hash (always real
content). Placeholder wording is bilingual; the pre-O86 placeholder is still
recognised in resumed sessions but never re-emitted.

## Unreleased

### O43 / O58 — npm one-line install

Recommended install is one command after Node ≥ 22.16:

```bash
npm install -g @rdk-moss/agent@latest
```

`package.json` is no longer `"private": true` (publishConfig stays `access: public`).
`scripts/check-node-version.cjs` runs from both `preinstall` and `prepare`, so a Node
older than 22.16 exits immediately with copyable upgrade commands for macOS (brew /
nvm / fnm), Ubuntu/Debian (NodeSource / nvm / fnm), and Windows (`winget`), plus the
success-path `npm install -g @rdk-moss/agent@latest`. A failing
`npm install -g --install-links .` does not leave a broken global `moss` shim.
`MOSS_TEST_FAKE_NODE_VERSION` lets tests exercise the failure path without an old
Node binary. README
(en + zh) leads with the npm one-liner; source clone remains the optional developer
path. No curl native-binary installer in this phase.

### O60 — custom OpenAI-compatible gateway docs

README (zh + en) documents `provider openai-compatible` with `model` / `baseUrl` /
`apiKeyEnv`. A trailing `/v1` on `baseUrl` is optional; Moss appends
`/v1/chat/completions` and never produces `/v1/v1`. `moss config --help` and the
invalid-`baseUrl` hint say `/v1` is optional. `test/api-v1-url.spec.mjs` locks
`buildApiV1Url` for bare hosts, trailing slash, `/v1`, and the d-robotics preset.

### O59 — doctor binary path and PATH duplicates

`moss doctor` prints `version` (with build stamp) and `binary` (realpath of the
running entry + package root), and warns when several distinct `moss` executables
are on PATH (PATH order, which one wins, whether it is the running one; PATHEXT on
Windows, symlinks deduped). Scanner lives in `src/cli/moss-binary-path.ts`.

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

### A `.env` file cannot change approval or other safety controls

`MOSS_AUTO_APPROVE`, `MOSS_PROFILE`, `MOSS_CONFIG_PROFILE`,
`MOSS_GOAL_VERIFY_LOOP`, `MOSS_GOAL_VERIFY_CMD`, and the other approval, trust,
redaction, and tool-permission variables (26 keys) are ignored when they come
from any `.env` file: a project `.env`, an ancestor directory's `.env`,
`~/.env`, or the install directory's `.env`, whether or not that folder is
trusted. They still work from the real process environment and from CLI flags.
Moss prints one line naming the ignored keys and the `.env` path (`-p` and the
REPL on stderr; the fullscreen TUI in the transcript, because the alternate
screen hides earlier stderr). `MOSS_DEVICE_HOST`, `MOSS_DEVICE_PORT`,
`MOSS_DEVICE_USER`, `MOSS_DEVICE_ID`, `MOSS_DEVICE_KIND`, and `MOSS_DEVICE_KEY`
wait for folder trust with the other routing variables, so an untrusted project
cannot point the user's `MOSS_DEVICE_PASSWORD` at another host. `~/.env` and
the install directory's `.env` still apply those device fields. That is the
documented way to name a board.

When a project `.env` (even in a trusted folder) sets `MOSS_DEVICE_HOST`, Moss
sends that host only a `MOSS_DEVICE_PASSWORD` written in the same `.env`. Your
own password from the real environment, `~/.env`, or the install `.env` is not
sent, and Moss prints a line saying so. A project's `.moss/devices.json` is
ignored until the folder is trusted (the untrusted-folder line lists it), and a
registry entry whose `passwordEnvVar` or `passphraseEnvVar` names an API key,
token, secret, credential, or auth variable loses its auth. `VISUAL`, `EDITOR`,
and `BASH_FUNC_*` join the variables a project `.env` cannot set. The trust
prompt now says a trusted project can change the device target.

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
`npm install -g @rdk-moss/agent@latest` is the recommended install path.

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
每次决定写入任务证据与时间线。本机 `exec` 硬拦截不变。### O170 — shell-exec env assignments and tmux/screen spawn forms are blocked

`BASH_ENV=<file> bash -c ':'` sources the file, `ENV=` does the same for POSIX
sh/dash, `PROMPT_COMMAND=` runs before every prompt of an interactive bash,
`ZDOTDIR` moves zsh's `.zshenv`, an exported `BASH_FUNC_name%%=() { … }` body
is code, and `tmux new-session/run-shell/send-keys` / `screen -dmS` run a
command outside Moss's process tree — none of them tripped the exec-capable
gate on main; a probe planted in BASH_ENV ran. The env assignments are now
reported when a POSIX shell head runs on the same line (`ENV=production npm
start` is not flagged — the name collision is common), in every assignment
shape (prefix, `env`, `export`/`declare`, `set`, bare statement, pwsh
`$env:`), and the tmux/screen forms are reported when they carry a command
(`tmux ls`, `tmux attach`, `screen -ls` stay green).

`BASH_ENV=<file> bash -c ':'` 会让 bash source 该文件，`ENV=` 对 POSIX sh/dash
同理，`PROMPT_COMMAND=` 在交互 bash 每个提示符前运行，`ZDOTDIR` 改写 zsh 的
`.zshenv` 位置，导出的 `BASH_FUNC_name%%=() { … }` 函数体本身就是代码；
`tmux new-session/run-shell/send-keys` 与 `screen -dmS` 在 Moss 进程树之外运行
命令——这些在 main 上都不会触发「可执行读取」拦截，BASH_ENV 里放的探针真的
跑了起来。现在：环境变量赋值在**同一行内有 POSIX shell 头**时报为可执行
（`ENV=production npm start` 不误拦——这个名字常被应用配置占用），覆盖前缀、
`env`、`export`/`declare`、`set`、裸赋值、pwsh `$env:` 各种形态；tmux/screen
仅在其携带命令时报（`tmux ls`、`tmux attach`、`screen -ls` 不受影响）。

### O157 — PreToolUse hook `ask` now asks the user; `-p` treats it as deny

A PreToolUse hook that exits 0 with `ask` (Claude `hookSpecificOutput.permissionDecision:
"ask"`, or moss/legacy top-level `decision: "ask"`) previously fell through to
"approved": the call ran without anyone confirming. An `ask` is now recognized
(case-insensitive) and every matching hook runs, so a deny after an ask still
blocks (merge order: deny > ask > allow). Interactive sessions show Moss's y/a/n
confirmation naming the hook, its config file and its reason; `y` and `a`
approve only that call and grant nothing (the hook asks again next time), `n`
refuses. The prompt appears in every mode, full included — trusted workspace,
plan-allow and session allow rules do not skip it. `-p` and runs without a
terminal cannot confirm and treat the ask as deny: the run ends 「被拦」/`Blocked
by` with exit 9. A host that ignores the `hookAsks` field fails closed.

`PreToolUse` hook 以 exit 0 输出 `ask`（Claude 的
`hookSpecificOutput.permissionDecision: "ask"`，或 moss/旧格式的 `decision: "ask"`）
以前会落成「已批准」：调用直接运行，没有人确认过。现在 `ask` 被识别（不区分大小写），
且所有匹配的 hook 都会运行——ask 之后再出现 deny 仍然拦截（合并顺序：deny > ask >
allow）。交互会话弹出 y/a/n 确认，点名 hook、配置文件与理由；`y`/`a` 只批准这一次、
不授予任何信任（下次钩子还会再问），`n` 拒绝。任何模式（包括 full）都会弹确认——
受信任工作区、plan 放行、会话 allow 规则都不能跳过它。`-p` 与无终端的运行无法确认，
按拒绝处理：末行「被拦」，exit 9。不理解 `hookAsks` 字段的宿主按拦截失败关闭。

### O156 — Windows PowerShell 5.1: a missing hook command is "failed to start"

A hook run through Windows PowerShell 5.1 (`powershell -Command <missing>`)
prints `X : The term 'X' is not recognized … operable program` (space before
the colon, wrapped at console width) and exits 1. Moss did not recognize it,
so Claude-format `UserPromptSubmit`, `Stop` and `PermissionRequest` hooks let
the action through. It is now "failed to start; treated as deny" on every
event, like pwsh 7 and cmd. Detection does not rely on English: 5.1's error
record ends with an untranslated `CategoryInfo … CommandNotFoundException`
line, and the Chinese texts of pwsh 7 and 5.1 are recognized too.

Windows PowerShell 5.1 下 hook 命令不存在（`X : The term 'X' … operable
program`，冒号前有空格、按控制台宽度折行，exit 1）以前识别不出来，Claude 格式的
UserPromptSubmit、Stop、PermissionRequest 会放行；现在所有事件都按「未能启动，
已按拒绝处理」拦截。识别不依赖英文：5.1 错误记录末尾的
`CategoryInfo … CommandNotFoundException` 不随语言变化，pwsh 7 和 5.1 的中文
文本也能识别。

The detector no longer builds a regular expression from stderr text. A hook
whose stderr started with a token of 32759+ characters followed by `:` made
it throw ("Regular expression too large"); a Stop hook was then allowed and
the other events crashed. The name is now read with a fixed pattern and
capped, and any detection error makes the hook fail closed.

识别不再用 stderr 内容拼正则。以前 stderr 开头是 32759 字符以上的一个词再接
`:` 时会抛「Regular expression too large」，Stop hook 因此被放行，其他事件直接
报错。现在用固定正则取名并限制长度，识别过程出任何异常都按拦截处理。

The English PowerShell text is matched at least as loosely as before this
change: no space after the colon (`X:The term 'X' …`) and no article
(`… recognized as name of …`) are still a missing command, so those hooks
block exactly as they did.

英文 PowerShell 文本的识别不比改动前更严：冒号后没有空格（`X:The term 'X' …`）、
省略冠词（`… recognized as name of …`）仍算命令不存在，这些 hook 照旧拦截。

### O135 — PreToolUse hooks: any non-zero exit blocks

A `PreToolUse` hook that exits non-zero now blocks the tool call in both Moss
and Claude formats, whatever its output says: `{"decision":"allow"}`,
`{"decision":"approve"}` and `hookSpecificOutput.permissionDecision: "allow"`
from a process that failed are ignored. The run ends 「被拦」/`Blocked by` with
exit 9, and the reason names the hook and says its allow was ignored. This is
deliberately stricter than Claude Code, which treats non-zero exits other than
2 as non-blocking errors. On Windows a hook whose command is missing (cmd or
pwsh) is treated as "failed to start" and blocks.

`PreToolUse` hook 非 0 退出一律拦截，Moss 和 Claude 两种格式都一样，输出里的
allow / approve / `permissionDecision: "allow"` 都不算数；末行「被拦」，exit 9，
提示里点名 hook 并说明已忽略其 allow。这比 Claude Code 更严（它对 2 以外的非 0
只当非阻塞错误）。Windows 上 hook 命令不存在（cmd 或 pwsh）按「未能启动」拦截。

## 0.26.1 (2026-10-11)

First npm release of the package (`@rdk-moss/agent`). Version 0.26.0 was tagged
in-repo but never published; npm `latest` was 0.6.0 before this release.

### TUI — OSC 11 replies no longer leak into the composer

On startup Moss asks the terminal for its background colour (OSC 11). When the
reply arrives split across stdin chunks — as real terminals do — neither piece
matched the old single-chunk check and the reply text (`]11;rgb:…`) landed in
the composer as if typed. A small state machine (`src/cli/tui/osc-reply-filter.ts`)
now reassembles OSC 11 replies across arbitrary chunk boundaries (BEL and ST
terminators), holds a bounded tail for split heads, and flushes as plain text
when no reply materialises. Theme detection still works; ordinary typing and
pastes are untouched. Verified with a PTY harness: split-reply repro shows a
clean composer after the fix.

### O88 — hooks fail closed

A blocking hook that cannot start or times out now blocks instead of silently allowing. Exit codes 126/127 (and 9009 on Windows) are treated as "failed to start" and block too, so hooks that intentionally exit with these codes are now blocked.

### O90 — hooks timeoutMs clamped to Node timer max

Moss-format `timeoutMs` values above the Node.js timer maximum (~2^31-1 ms) are
clamped to the maximum with a one-time warning instead of firing immediately.

### O86 — read-after-edit honesty

A file read is no longer answered with a "content unchanged, see the earlier
read" stub after the file was edited by a write/patch/move, after the earlier
read left the model context (compaction/elision), or when the on-disk bytes no
longer hash-match the last recorded read. Failed writes no longer invalidate
the earlier read. Files larger than 2 MiB skip the pre-stub hash (always real
content). Placeholder wording is bilingual; the pre-O86 placeholder is still
recognised in resumed sessions but never re-emitted.

## Unreleased

### O43 / O58 — npm one-line install

Recommended install is one command after Node ≥ 22.16:

```bash
npm install -g @rdk-moss/agent@latest
```

`package.json` is no longer `"private": true` (publishConfig stays `access: public`).
`scripts/check-node-version.cjs` runs from both `preinstall` and `prepare`, so a Node
older than 22.16 exits immediately with copyable upgrade commands for macOS (brew /
nvm / fnm), Ubuntu/Debian (NodeSource / nvm / fnm), and Windows (`winget`), plus the
success-path `npm install -g @rdk-moss/agent@latest`. A failing
`npm install -g --install-links .` does not leave a broken global `moss` shim.
`MOSS_TEST_FAKE_NODE_VERSION` lets tests exercise the failure path without an old
Node binary. README
(en + zh) leads with the npm one-liner; source clone remains the optional developer
path. No curl native-binary installer in this phase.

### O60 — custom OpenAI-compatible gateway docs

README (zh + en) documents `provider openai-compatible` with `model` / `baseUrl` /
`apiKeyEnv`. A trailing `/v1` on `baseUrl` is optional; Moss appends
`/v1/chat/completions` and never produces `/v1/v1`. `moss config --help` and the
invalid-`baseUrl` hint say `/v1` is optional. `test/api-v1-url.spec.mjs` locks
`buildApiV1Url` for bare hosts, trailing slash, `/v1`, and the d-robotics preset.

### O59 — doctor binary path and PATH duplicates

`moss doctor` prints `version` (with build stamp) and `binary` (realpath of the
running entry + package root), and warns when several distinct `moss` executables
are on PATH (PATH order, which one wins, whether it is the running one; PATHEXT on
Windows, symlinks deduped). Scanner lives in `src/cli/moss-binary-path.ts`.

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

### A `.env` file cannot change approval or other safety controls

`MOSS_AUTO_APPROVE`, `MOSS_PROFILE`, `MOSS_CONFIG_PROFILE`,
`MOSS_GOAL_VERIFY_LOOP`, `MOSS_GOAL_VERIFY_CMD`, and the other approval, trust,
redaction, and tool-permission variables (26 keys) are ignored when they come
from any `.env` file: a project `.env`, an ancestor directory's `.env`,
`~/.env`, or the install directory's `.env`, whether or not that folder is
trusted. They still work from the real process environment and from CLI flags.
Moss prints one line naming the ignored keys and the `.env` path (`-p` and the
REPL on stderr; the fullscreen TUI in the transcript, because the alternate
screen hides earlier stderr). `MOSS_DEVICE_HOST`, `MOSS_DEVICE_PORT`,
`MOSS_DEVICE_USER`, `MOSS_DEVICE_ID`, `MOSS_DEVICE_KIND`, and `MOSS_DEVICE_KEY`
wait for folder trust with the other routing variables, so an untrusted project
cannot point the user's `MOSS_DEVICE_PASSWORD` at another host. `~/.env` and
the install directory's `.env` still apply those device fields. That is the
documented way to name a board.

When a project `.env` (even in a trusted folder) sets `MOSS_DEVICE_HOST`, Moss
sends that host only a `MOSS_DEVICE_PASSWORD` written in the same `.env`. Your
own password from the real environment, `~/.env`, or the install `.env` is not
sent, and Moss prints a line saying so. A project's `.moss/devices.json` is
ignored until the folder is trusted (the untrusted-folder line lists it), and a
registry entry whose `passwordEnvVar` or `passphraseEnvVar` names an API key,
token, secret, credential, or auth variable loses its auth. `VISUAL`, `EDITOR`,
and `BASH_FUNC_*` join the variables a project `.env` cannot set. The trust
prompt now says a trusted project can change the device target.

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
`npm install -g @rdk-moss/agent@latest` is the recommended install path.

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
