---
name: rdk-command-manual
description: Command-manual lookup for RDK-specific commands (hrut_somstatus, hrut_boardid, hrut_socuid, hrut_ps, rdkos_info, rdk-miniboot-update, rdk-backup, srpi-config, devmem) plus the Linux command appendix (apt/dmesg/ip/scp/tar...) as documented by D-Robotics. Use whenever the user asks what a command does, its syntax/options/flags, or which boards it applies to — the command is the anchor, not the symptom. Answer with exact syntax, per-board differences (X3 vs X5 vs Ultra vs S100/S100P/S600), and the official doc source. 触发词:hrut_somstatus 怎么读、hrut_boardid 选项含义、hrut_socuid、hrut_ps、rdkos_info -d 输出什么、rdk-miniboot-update 怎么用、rdk-backup 备份、srpi-config 有哪些菜单、devmem 读写寄存器、这条命令哪块板能用、命令语法/选项/适用板型。Routing — a command threw an error and you need symptom-based triage → rdk-board-knowledge; peripheral (camera/GPIO/I2C/UART/PWM) driver setup → rdk-peripheral-cookbook; locate a GitHub repo/source → rdk-source-map; locate an official doc-site chapter/URL → rdk-doc-finder; pure hardware/pinout facts → rdk-hardware.
---

# RDK Command Manual (RDK-specific commands + Linux command index)

This is the **command-as-anchor** lookup. The user already knows the command name (or a fragment) and wants its **exact syntax, options, typical use, which boards it applies to, and the official source**. If instead they have an *error/symptom* and don't know which command to run, that is `rdk-board-knowledge`, not this skill.

> Sources: D-Robotics official docs. RDK-specific commands come from `rdk_doc` `docs/09_Appendix/rdk-command-manual/` (X-series, category label `9.1 RDK专属命令用法`) and `rdk_s_doc` / `rdk_doc docs_s/09_Appendix/rdk-command-manual/` (S-series). `srpi-config` lives in `02_System_configuration/02_srpi-config.md`. The Linux appendix is `09_Appendix/linux-command-manual/` (label `9.2 Linux命令用法`). Every fact below was re-verified against these files on `main`.

## The one thing that matters most

**The same command name can behave differently per board.** `hrut_boardid` on X3 has `g/s/G/S/c/C` sub-options; on X5 it only prints (`-h` is the sole flag); on S-series it just emits `0x6A84`-style output. `hrut_somstatus` adds a multi-rail `voltage` block on S-series that X-series never shows. **Never recite a command's behavior without first pinning the board.** When unsure, tell the user to run `which <cmd>` or `<cmd> -h` on the actual board, then explain from the matching doc.

## Board → command-availability cheat-sheet

Confirm the board family first, then read the row. "Same" means the command exists with the same core behavior; differences are called out.

| Command | X3 | X5 | Ultra | S100 / S100P / S600 | sudo? |
|---------|----|----|-------|---------------------|-------|
| `hrut_somstatus` | yes | yes | yes | yes (+ `voltage` rails, `policy`-clustered freq, `bpu0: ratio` only) | yes |
| `hrut_boardid` | `g/s/G/S/c/C` + 32-bit bitfield | print-only (`-h`) | print-only | prints `0x6A84` encoded | varies |
| `hrut_socuid` | yes | yes | yes | yes | doc shows `sudo` on X3 |
| `hrut_ps` | yes | yes | yes | yes | no |
| `rdkos_info` | yes (has `[ION Memory Size]`) | yes | yes | yes (no ION line; board id `0x6A84`) | yes |
| `rdk-miniboot-update` | yes | yes | yes | not in S appendix → use OTA flow | yes |
| `rdk-backup` | yes | yes | yes | not in S appendix | yes |
| `srpi-config` | yes | yes | **NOT Ultra** | S100 documented (VNC still being adapted) | yes |
| `devmem` | yes | yes | yes | yes (identical) | depends on address |

> BPU profiling / monitoring commands (`hrut_bpuprofile`, `hrut_smi`, `bputop`, `cat /sys/devices/system/bpu/bpu0/ratio`, etc.) carry per-board and risk-tier nuances and are maintained in **rdk-board-knowledge** (`references/diagnostic-commands.md`), not here. Don't duplicate them.

## Workflows

### Workflow 1 — Answer "what does command X do / what are its options?"

1. **Pin the board family** (X3 / X5 / Ultra / S-series). If the user didn't say, ask, or tell them to run `which <cmd>` / `<cmd> -h`.
2. **Open the matching row** in the cheat-sheet, then the full entry in [rdk-commands.md](references/rdk-commands.md) for exact syntax, every option, typical usage, and the source path.
3. **Call out per-board differences explicitly** — e.g. "on X5 `hrut_boardid` only prints, the `g/s` set is X3-only."
4. **Give the official doc URL** when the user wants to read more (URL pattern in the reference header).

### Workflow 2 — Answer "which command checks temperature / status / board id on this board?"

1. Map the intent to the command: temperature/freq/BPU-load → `hrut_somstatus`; full system snapshot for a bug report → `rdkos_info`; board id → `hrut_boardid`; SoC UID → `hrut_socuid`; rich process info → `hrut_ps`.
2. If the intent is **"the command errored, what's wrong"** → stop and route to `rdk-board-knowledge` (symptom triage). This skill explains *what a command is*, not *why it failed*.
3. For collecting evidence before filing an issue, recommend `sudo rdkos_info -d` (300 log lines) — it bundles hardware model, CPU/BPU status, memory, OS/kernel/miniboot versions.

### Workflow 3 — Answer "how do I update miniboot / back up the system?"

1. **X-series**: `sudo rdk-miniboot-update` (latest) or `-f <file>`; preview the default image with `rdk-miniboot-update -l`. Back up with `sudo rdk-backup [dir]` — **must be online first**, produces `rdk-<datetime>.img`.
2. **S-series**: `rdk-miniboot-update`/`rdk-backup` are **not in the S appendix**. Route miniboot updates to the OTA flow (`rdk_doc docs_s/07_Advanced_development/02_linux_development/06_OTA/02_ota_miniboot.md`) and full flashing to `xburn`. See the source note in [rdk-commands.md](references/rdk-commands.md).

### Workflow 4 — Answer "what's in srpi-config / how do I configure Wi-Fi/SSH/interfaces?"

1. **Reject Ultra immediately**: `srpi-config` is documented only for X3, X5, X3 Module — **not RDK Ultra**.
2. Map the request to a menu (full menu tree in [rdk-commands.md](references/rdk-commands.md)): Wi-Fi/password/hostname/login → **System Options**; SSH/VNC/40-pin bus → **Interface Options**; overclock/ION memory → **Performance Options**; locale/timezone → **Localisation**; expand filesystem/boot order → **Advanced**.
3. **40-pin peripheral bus**: interfaces on the same row share pins — only one can be active at a time. X5 adds PWM. For deeper driver/devicetree setup, hand off to `rdk-peripheral-cookbook`.
4. **S100** also has `srpi-config` but a leaner Interface menu (VNC being adapted; peripheral config points to `config.txt`).

### Workflow 5 — Answer Linux-appendix command questions

The appendix (`apt / dmesg / dpkg / dpkg-deb / find / grep / ifconfig / ip / mount / netstat / nohup / ps / route / rsync / scp / ssh / tar / top / zip`) is **generic Linux usage** that D-Robotics bundled for beginners. **Index back to the official page** ([linux-commands.md](references/linux-commands.md)) or explain from standard `man` semantics. **Do not invent RDK-specific behavior** for these. If the user's real problem is an RDK-board symptom (APT key failure, TROS package not found), that's `rdk-board-knowledge`.

## Worked examples

**Example 1 — "hrut_boardid 在我的 X5 上为什么没有 g/s 这些选项？"**
*"Because the `g/s/G/S/c/C` sub-options are X3-only. On X5 `hrut_boardid` is print-only — its only flag is `-h`, and it just prints the current boardid. The full 32-bit bitfield (DDR vendor/type/freq/capacity/SOM type/base-board) you may have seen is the **X3** definition. On S-series it instead prints a `0x6A84`-style code (chip id / power design / board revision)."* Point to the `hrut_boardid` entry in references/rdk-commands.md.

**Example 2 — "rdkos_info -d 和默认输出有什么区别?"**
*"`-d` is detailed mode: it appends the latest **300** lines of system log, vs the default `-s` simple mode which shows **30**. `-b` collects no logs at all. The body is the same: `[Hardware Model]`, `[CPU And BPU Status]`, memory, `[RDK OS Version]`, `[RDK Kernel Version]`, `[RDK Miniboot Version]`. On X-series you also get `[ION Memory Size]`; on S-series the board id shows as `0x6A84` and there's no ION line. Run `sudo rdkos_info -d` and paste the output — it's the single best snapshot for a bug report."*

**Example 3 — "S100 上怎么更新 miniboot?"**
*"`rdk-miniboot-update` is documented for X-series; it's **not** in the S-series command appendix. On S100, update miniboot through the OTA flow (`docs_s/07_Advanced_development/.../06_OTA/02_ota_miniboot.md`), and do full-image flashing with `xburn`. Don't assume the X-series `rdk-miniboot-update -f` path exists unchanged on S100 — verify with `which rdk-miniboot-update` on the board first."*

**Example 4 — "srpi-config 里在哪开 SSH 和 40pin 的 I2C？"**
*"Both are under **Interface Options**. SSH is a direct enable/disable (on by default). For I2C use **Peripheral bus config** — it edits the devicetree bus `status` and takes effect after reboot. Note interfaces sharing a pin row are mutually exclusive (only one active); X5 adds PWM to that table. Heads-up: `srpi-config` is X3/X5/X3-Module only — **not Ultra**. For driver-level peripheral bring-up, use rdk-peripheral-cookbook."*

## Common pitfalls

| ❌ Don't | ✅ Do |
|---------|------|
| Recite a command's options without pinning the board | Confirm X3/X5/Ultra/S first; behaviors differ |
| Claim `hrut_boardid g` works on X5 | X5 is print-only; `g/s/G/S/c/C` is X3-only |
| Assume `rdk-miniboot-update`/`rdk-backup` exist on S-series | Not in S appendix → OTA flow + `xburn` |
| Offer `srpi-config` to an Ultra user | Documented for X3/X5/X3 Module only, not Ultra |
| Invent RDK-specific flags for `apt`/`scp`/`tar` | Treat appendix Linux commands as standard `man` |
| Triage an error message here | Route command *errors/symptoms* to rdk-board-knowledge |
| Re-document `hrut_bpuprofile`/`hrut_smi` | They live in rdk-board-knowledge's diagnostic-commands.md |

## Reference map

| Read this | When |
|-----------|------|
| [rdk-commands.md](references/rdk-commands.md) | Any RDK-specific command — full syntax, every option, per-board differences, srpi-config menu tree, flashing/OTA pointers, source paths |
| [linux-commands.md](references/linux-commands.md) | A command from the Linux appendix (`apt`/`dmesg`/`ip`/`scp`/`tar`...) — index + official URL pattern |
| `scripts/cmd_lookup.py` | Deterministic "command → one-liner + per-board availability + source" lookup so you don't drift |
| rdk-board-knowledge → `diagnostic-commands.md` | BPU profiling/monitoring commands and command-error symptom triage |
