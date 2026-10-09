# Changelog

## Unreleased

### Legacy loop scheduler removed

`LoopScheduler`, its acceptance-failure prompt, and the loop TUI event bridge are gone.
`/goal`, `/task`, `moss task`, and `MOSS_GOAL_VERIFY_LOOP` behave as before. `/loop` still
rewrites to `/goal`. Acceptance commands run from `core/task/acceptance-command.ts`. A token
or tool-call budget stop ends the task (`run budget exceeded (…)`) instead of opening another
turn. `.moss/loop-state.json` and `.moss/loop-journal.jsonl` are no longer read or written;
files already in a workspace are left in place. `MOSS_DISABLE_NUDGES=goal-acceptance` is an
unknown id and is ignored.

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
`rdk-docs-mcp@0.2.0`, with BM25 + title fusion, `noGoodMatch`, board filtering, and section page
reads. Moss connects it in the background when a device target is configured
(`MOSS_DEVICE_HOST` or `.moss/devices.json`) or when `rdkDocs` is true. `rdkDocs.package` and
`MOSS_RDK_DOCS_PACKAGE` accept a trusted npm spec, local directory, or tarball for unpublished
server builds. Opt out with `MOSS_NO_RDK_DOCS=1` or `"rdkDocs": false`. A same-named `mcp.json`
entry replaces the builtin. Connect timeout is 45s and each request 20s for this server only; the
timeout does not delay the interactive shell. A failed connect prints
`[mcp] rdk-docs unreachable (<reason>) — RDK manual lookup is off this session.` and the system
prompt tells the agent the manual could not be checked. There is no cache and no offline copy.
When the server is up, the prompt points only at the registered `mcp__rdk-docs__search` tool and
treats version-specific search/ranking/section features as optional. A short `rdk-docs` skill is
indexed. The robotics fallback verifies `<installation>/setup.bash` before sourcing it; probe
scripts, connection steps, and device safety rules stay. See
`docs/superpowers/plans/2026-10-09-rdk-knowledge-via-mcp.md`.

### 斜杠命令、真实终端与基准

日常菜单与 Claude Code / Codex 对齐，其余命令隐藏但仍可输入。`/plan` 直接进入 plan 模式；
`/goal` 是"做到为止"的入口（`/loop` 迁移到它），没带 `--accept` 时从工作区已有的测试入口给出验收命令候选；
`/resume` 恢复会话；`/tasks`（别名 `/ps`）列后台任务；`/stop` 只停本会话的后台进程，打断用 Esc；
运行中发消息默认 steer，不能 steer 时排队。隐藏的 `/task` 新增 `verify`。
真实终端核对用 `MOSS_REAL_TERMINALS=1` 打开。新增 `npm run bench:device`（板卡任务成功率）与
`npm run bench:deepswe`（同模型 DeepSWE 对比）。RDK 手册由内置 rdk-docs MCP 供给（设备会话默认连接，
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
