#!/usr/bin/env python3
"""Deterministic RDK command lookup.

Answers "what is command X, which boards does it apply to, and where is it
documented?" without reciting from memory (and risk drifting on, e.g., whether
hrut_boardid has g/s options on X5, or whether rdk-backup exists on S-series).

Usage:
    python3 cmd_lookup.py hrut_boardid
    python3 cmd_lookup.py rdk-backup
    python3 cmd_lookup.py            # list every command

Source of truth: D-Robotics rdk_doc / rdk_s_doc Appendix 9.1 and
02_System_configuration/02_srpi-config.md. Keep in sync with
references/rdk-commands.md if the official docs change.
"""
from __future__ import annotations

import sys

# name -> (one-liner, sudo, x-series note, s-series note, source file)
COMMANDS = {
    "hrut_somstatus": (
        "Temperature, CPU/BPU frequency, and BPU load (ratio).",
        "yes",
        "3 blocks: temperature / cpu freq (per core) / bpu (min/cur/max/ratio).",
        "Adds a voltage (mV) block; freq is per-cluster (policy0/policy4); bpu0 ratio only.",
        "09_Appendix/rdk-command-manual/cmd_hrut_somstatus.md",
    ),
    "hrut_boardid": (
        "Get/set the board id; affects boot-time hardware init (set with care).",
        "varies",
        "X3: g/s/G/S/c/C + 32-bit bitfield. X5: print-only (-h only).",
        "Prints e.g. 0x6A84 (chip code / power design / board revision).",
        "cmd_hrut_boardid.md (X3) / cmd_hrut_boardid_rdkx5.md (X5) / S equivalent",
    ),
    "hrut_socuid": (
        "Print the SoC chip UID.",
        "X3 example uses sudo",
        "e.g. soc_uid: 0x2106271200...",
        "e.g. 060c0b0d3090...",
        "09_Appendix/rdk-command-manual/cmd_hrut_socuid.md",
    ),
    "hrut_ps": (
        "Process info busybox ps lacks (prio/policy/vsize/rss/...).",
        "no",
        "Same on X and S.",
        "Same on X and S.",
        "09_Appendix/rdk-command-manual/cmd_hrut_ps.md",
    ),
    "rdkos_info": (
        "One-shot system snapshot (hw/sw versions, drivers, packages, latest log).",
        "yes",
        "-b/-s(default,30)/-d(300)/-v/-h; has [ION Memory Size].",
        "Same options; board id shown as 0x6A84; no ION line.",
        "09_Appendix/rdk-command-manual/cmd_rdkos_info.md",
    ),
    "rdk-miniboot-update": (
        "Update the minimal boot image (miniboot).",
        "yes",
        "-f<file>/-h/-l(preview path)/-s; no-arg = latest.",
        "NOT in S appendix -> use OTA miniboot flow.",
        "09_Appendix/rdk-command-manual/cmd_rdk-miniboot-update.md (X only)",
    ),
    "rdk-backup": (
        "Back up the current system to rdk-<datetime>.img.",
        "yes",
        "[dir] default /mnt; MUST be online first.",
        "NOT in S appendix.",
        "09_Appendix/rdk-command-manual/cmd_rdk-backup.md (X only)",
    ),
    "devmem": (
        "busybox: read/write physical addresses via /dev/mem mmap.",
        "depends on address",
        "devmem ADDRESS [WIDTH [VALUE]]; WIDTH 8/16/32 default 32.",
        "Identical to X.",
        "09_Appendix/rdk-command-manual/cmd_devmem.md (X and S)",
    ),
    "srpi-config": (
        "System-configuration TUI (Wi-Fi/SSH/interfaces/performance/locale).",
        "yes",
        "X3 / X5 / X3 Module ONLY -- NOT Ultra. X5 adds PWM to the bus picker.",
        "S100 documented; VNC being adapted; peripheral config via config.txt.",
        "02_System_configuration/02_srpi-config.md",
    ),
}

# how a board might be named -> family
BOARD_FAMILY = {
    "x3": "x", "x5": "x", "ultra": "x",
    "s100": "s", "s100p": "s", "s600": "s",
}


def show(name: str) -> None:
    one, sudo, xnote, snote, src = COMMANDS[name]
    print(f"# {name}")
    print(f"  what     : {one}")
    print(f"  sudo     : {sudo}")
    print(f"  X-series : {xnote}")
    print(f"  S-series : {snote}")
    print(f"  source   : {src}")


def show_all() -> None:
    for name in COMMANDS:
        show(name)
        print()


def main() -> int:
    if len(sys.argv) < 2:
        show_all()
        return 0
    raw = sys.argv[1].strip().lower().replace("_", "_")
    if raw in COMMANDS:
        show(raw)
        return 0
    # tolerate "cmd_hrut_boardid" / leading "cmd_"
    if raw.startswith("cmd_") and raw[4:] in COMMANDS:
        show(raw[4:])
        return 0
    print(f"Unknown command: {sys.argv[1]!r}. Known: {', '.join(COMMANDS)}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
