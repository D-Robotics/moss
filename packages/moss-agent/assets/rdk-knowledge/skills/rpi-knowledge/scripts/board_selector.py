#!/usr/bin/env python3
"""Map a Raspberry Pi board to its specs, GPIO library, and AI path.

Answers the recurring questions "what CPU/RAM does board X have?", "does
RPi.GPIO work on it?", and "is there an NPU?" deterministically, so the model
doesn't drift on facts like Pi 5 = Cortex-A76 (NOT A72) or "16GB is Pi 5 only".

Usage:
    python3 board_selector.py pi5
    python3 board_selector.py            # prints the whole table

Source of truth: official raspberrypi.com product/spec pages (Pi 5, Pi 4B, CM4)
and the AI HAT+ page. Keep in sync with references/board-specs.md.
"""
from __future__ import annotations

import sys

# key -> (display, SoC, CPU, RAM variants, has RP1, GPIO library guidance, AI path)
BOARDS = {
    "pi5": (
        "Raspberry Pi 5", "BCM2712", "Cortex-A76 @2.4GHz",
        "1/2/4/8/16GB LPDDR4X", True,
        "gpiozero / lgpio (RPi.GPIO does NOT work — GPIO is on RP1)",
        "no NPU; CPU/ONNX/TFLite, or Hailo AI HAT+ (HEF)",
    ),
    "pi4b": (
        "Raspberry Pi 4 Model B", "BCM2711", "Cortex-A72 @1.8GHz",
        "1/2/4/8GB LPDDR4", False,
        "gpiozero / lgpio; classic RPi.GPIO still works",
        "no NPU; CPU/ONNX/TFLite",
    ),
    "cm4": (
        "Compute Module 4", "BCM2711", "Cortex-A72 @1.5GHz",
        "1/2/4/8GB LPDDR4-3200", False,
        "gpiozero / lgpio; classic RPi.GPIO still works",
        "no NPU; CPU/ONNX/TFLite",
    ),
}

ALIASES = {
    "raspberrypi5": "pi5", "rpi5": "pi5", "pi-5": "pi5", "5": "pi5",
    "raspberrypi4": "pi4b", "rpi4": "pi4b", "pi4": "pi4b", "pi-4b": "pi4b",
    "4b": "pi4b", "4": "pi4b",
    "computemodule4": "cm4", "rpicm4": "cm4", "cm-4": "cm4",
}

FIELDS = ["board", "soc", "cpu", "ram", "rp1", "gpio_lib", "ai_path"]


def normalize(raw: str) -> str | None:
    key = raw.strip().lower().replace("raspberry", "").replace("_", "").replace(" ", "")
    key = key.replace("rdk-", "").replace("model", "")
    if key in BOARDS:
        return key
    return ALIASES.get(key)


def show(key: str) -> None:
    row = BOARDS[key]
    print(f"# {row[0]}")
    for field, value in zip(FIELDS, row):
        printable = "yes" if value is True else "no" if value is False else value
        print(f"  {field:9s}: {printable}")
    note = ("16GB is Pi 5 only. No Raspberry Pi has an on-board NPU — "
            "add a Hailo AI HAT+ (Pi 5, PCIe) for acceleration.")
    print(f"  note     : {note}")


def show_all() -> None:
    print(f"{'board':24s} {'soc':9s} {'cpu':20s} {'ram':22s} rp1")
    print("-" * 86)
    for row in BOARDS.values():
        print(f"{row[0]:24s} {row[1]:9s} {row[2]:20s} {row[3]:22s} {'yes' if row[4] else 'no'}")


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
