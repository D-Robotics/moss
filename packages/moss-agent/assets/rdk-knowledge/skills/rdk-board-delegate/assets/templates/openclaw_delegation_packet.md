# OpenClaw Delegation Packet

Fill every field before calling `board_openclaw_chat` / `board_openclaw_delegate`.
A packet missing any field gets bounced. Keep it concrete — paste real command
output, not paraphrase.

## Goal
<!-- One sentence. E.g. "Reload my new MCU1 firmware and confirm IPC works." -->

## Background
<!-- Why + device state. -->
- Board: <!-- RDK S100 / S100P / S600 -->
- OS / TROS: <!-- S100/S100P = Ubuntu 22.04 + Humble; S600 = Ubuntu 24.04 + Jazzy -->
- Firmware: <!-- debug / release -->
- Current MCU state: <!-- offline / running (cat /sys/class/remoteproc/remoteproc_mcu1/state) -->
- Why this matters now: <!-- the user-facing reason -->

## Done so far
<!-- Commands run WITH their actual output. -->
```
$ cat /sys/class/remoteproc/remoteproc_mcu0/mcu_version
<paste output>

$ echo start > /sys/class/remoteproc/remoteproc_mcu0/state
<paste output / error>

$ ipcbox_set_mode debug
<paste output>
```

## Analysis
<!-- Your hypothesis and why. Common ones:
  - started before wfi -> ran wild (mcu-development.md §3.1 CAUTION)
  - MCU0/MCU1 double-enabled the same interrupt (§6)
  - IPC channel/buf count/size mismatched between Acore and MCU (§5.1)
  - build used the wrong arg order (S100 = s100 mcu1 gcc; S600 = s600 gcc mcu1) -->

## Expectation
<!-- Exactly what you need back: MCU serial log / crash node content / a specific sysfs value. -->
- [ ] MCU-COM serial log (921600 8-N-1)
- [ ] `cat /sys/devices/platform/soc/soc:mcu_crash/crash`
- [ ] Specific sysfs value: <!-- which one -->
