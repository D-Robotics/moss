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
Answering `a` trusts that device for the rest of the session, not every future `device_exec`.

Each decision is appended to `.moss/evidence.jsonl` (`metric: device_policy`) and, when a
task is in progress, to its timeline as a `note`. Host `exec` hard blocks are unchanged.
See `docs/superpowers/plans/2026-10-09-device-safety-policy.md`.

### 设备安全策略

full 模式仍自动执行只读探测和可逆设备变更。重启、刷机、系统路径写入、网络变更、卸载系统包、
停用 ssh 等毁灭性操作改为 TTY 确认；无终端时拒绝，除非显式信任（`--trust-device`、
`MOSS_DEVICE_TRUST=full`、`permissions.deviceTrust`、按设备名单或 allow 规则）。
每次决定写入任务证据与时间线。本机 `exec` 硬拦截不变。
