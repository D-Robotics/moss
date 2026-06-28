#!/usr/bin/env python3
"""Tell whether an RDK board's CAN is Linux SocketCAN or MCU-domain CANHAL.

This is the single most-confused peripheral fact on RDK: people run
`ip link set can0 ...` on S100/S600, where there is no SocketCAN device at all.
Answer it deterministically so guidance never drifts.

Usage:
    python3 can_mode.py s100
    python3 can_mode.py            # prints the whole table

Source of truth: rdk_doc rdk_x5/can.md (X5 = TCAN4550 SocketCAN) and rdk_s_doc
mcu_development/09_mcu_can.md (S100/S600 CAN in the MCU domain via CANHAL).
Keep in sync with references/rdk-can-and-board-io.md §0.
"""
from __future__ import annotations

import sys

# board key -> (display, CAN form, how to operate, has can0 device, default lines)
BOARDS = {
    "x5":    ("RDK X5",    "Linux SocketCAN (TCAN4550 on SPI5)",
              "ip link + can-utils (cansend/candump)", "yes", "can0"),
    "s100":  ("RDK S100",  "MCU-domain (CAN0~9, default CAN5~9)",
              "CANHAL lib + IPC + /app/Can sample", "no", "CAN5~CAN9"),
    "s100p": ("RDK S100P", "MCU-domain (same as S100)",
              "CANHAL lib + IPC + /app/Can sample", "no", "CAN5~CAN9"),
    "s600":  ("RDK S600",  "MCU-domain (CAN0~15, default CAN1~10)",
              "CANHAL lib + IPC + /app/Can sample", "no", "CAN1~CAN10"),
    "x3":    ("RDK X3",    "no on-board CAN", "-", "no", "-"),
    "ultra": ("RDK Ultra", "no on-board CAN", "-", "no", "-"),
}

ALIASES = {
    "sunrise5": "x5", "rdkx5": "x5",
    "super100": "s100", "rdks100": "s100",
    "super100p": "s100p", "rdks100p": "s100p",
    "rdks600": "s600",
    "sunrise3": "x3", "xj3": "x3", "j3": "x3", "rdkultra": "ultra",
}

FIELDS = ["board", "can_form", "operate_with", "has_can0", "default_lines"]


def normalize(raw: str) -> str | None:
    key = raw.strip().lower().replace("rdk_", "").replace("rdk-", "").replace(" ", "").replace("_", "")
    if key in BOARDS:
        return key
    return ALIASES.get(key)


def show(key: str) -> None:
    row = BOARDS[key]
    print(f"# {row[0]}")
    for field, value in zip(FIELDS, row):
        print(f"  {field:14s}: {value}")
    if row[3] == "no" and "MCU" in row[1]:
        print("  note          : ip link / cansend / candump do NOT apply here. "
              "Go through the MCU-domain CANHAL sample.")
    elif row[3] == "yes":
        print("  note          : standard SocketCAN; "
              "`ip link set can0 type can bitrate ... [dbitrate ... fd on]`.")


def show_all() -> None:
    print(f"{'board':12s} {'can_form':38s} {'has_can0':9s} operate_with")
    print("-" * 96)
    for row in BOARDS.values():
        print(f"{row[0]:12s} {row[1]:38s} {row[3]:9s} {row[2]}")


def main() -> int:
    if len(sys.argv) < 2:
        show_all()
        return 0
    key = normalize(sys.argv[1])
    if key is None:
        print(f"Unknown board: {sys.argv[1]!r}. Known: {', '.join(BOARDS)}", file=sys.stderr)
        return 1
    show(key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
