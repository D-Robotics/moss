# Changelog

## Unreleased

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
