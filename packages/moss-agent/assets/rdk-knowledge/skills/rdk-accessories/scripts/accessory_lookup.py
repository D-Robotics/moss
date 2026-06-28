#!/usr/bin/env python3
"""Deterministic lookup for D-Robotics official accessories.

Answers the recurring questions "does accessory X work on board Y?", "what chip
is in it?", and "what interface does it use?" without reciting tables from memory
(and risking the BMI088-vs-ICM-42688-P mix-up).

Usage:
    python3 accessory_lookup.py gs130wi          # show one accessory
    python3 accessory_lookup.py imu --board s100 # support + note for a board
    python3 accessory_lookup.py                  # list all accessories

Source of truth: D-Robotics accessories_doc and rdk_s_doc (see references/
accessories-catalog.md). Keep in sync with SKILL.md if the official docs change.
"""
from __future__ import annotations

import sys

# key -> spec dict. "boards" maps a canonical board key -> (supported, note).
ACCESSORIES = {
    "gs130w": {
        "name": "GS130W binocular depth camera",
        "chip": "2x SC132GS (global shutter), NO IMU",
        "interface": "2x 22-pin MIPI CSI-2",
        "ffc": "module-side contacts face AWAY from PCB",
        "boards": {
            "x3": ("no", "single MIPI only"),
            "x5": ("yes", "direct"),
            "x5m": ("yes", "needs carrier board"),
            "s100": ("yes", "needs Camera Expansion Board"),
            "s100p": ("yes", "needs Camera Expansion Board"),
            "s600": ("yes", "direct"),
        },
    },
    "gs130wi": {
        "name": "GS130Wi binocular depth camera (with IMU)",
        "chip": "2x SC132GS + ICM-42688-P IMU (NOT BMI088)",
        "interface": "2x 22-pin MIPI CSI-2 + 3-pin IMU timestamp",
        "ffc": "module-side contacts face TOWARD PCB (opposite of GS130W)",
        "boards": {
            "x3": ("no", "single MIPI only"),
            "x5": ("yes", "direct"),
            "x5m": ("yes", "needs carrier board"),
            "s100": ("yes", "needs Camera Expansion Board"),
            "s100p": ("yes", "needs Camera Expansion Board"),
            "s600": ("yes", "direct"),
        },
    },
    "imu": {
        "name": "RDK IMU Module",
        "chip": "Bosch BMI088 (NOT the GS130Wi's ICM-42688-P)",
        "interface": "40PIN, I2C or SPI (jumper-selected)",
        "driver": "official rdk-imu-module-sdk (C/Python/ROS2); IIO driver is X5/X5M only",
        "boards": {
            "x3": ("no", "-"),
            "x5": ("yes", "plugs straight into 40PIN; IIO or SDK"),
            "x5m": ("yes", "plugs straight into 40PIN; IIO or SDK"),
            "s100": ("yes", "cannot mount directly, needs jumper wiring; use SDK"),
            "s100p": ("yes", "cannot mount directly, needs jumper wiring; use SDK"),
            "s600": ("yes", "cannot mount directly, needs jumper wiring; use SDK"),
        },
    },
    "s100-cam": {
        "name": "RDK S100 Camera Expansion Board",
        "chip": "MAX96712 deserializer",
        "interface": "2x MIPI + 4x GMSL; DC plug 2.5/6mm",
        "boards": {"s100": ("yes", "-"), "s100p": ("yes", "-")},
    },
    "s600-cam": {
        "name": "RDK S600 Camera Expansion Board",
        "chip": "2x MAX96712 deserializer",
        "interface": "8x GMSL, NO MIPI; DC plug 2.5/5.5mm",
        "boards": {"s600": ("yes", "-")},
    },
    "s100-mcu": {
        "name": "RDK S100 MCU-Port Expansion Board",
        "chip": "on-board BMI088 (SPI-5; not yet implemented in SDK V4.0.2)",
        "interface": "5x CAN FD (CAN5-9) + 30-pin + RJ45 GbE (MCU domain)",
        "boards": {"s100": ("yes", "-"), "s100p": ("yes", "-")},
    },
    "s600-mcu": {
        "name": "RDK S600 MCU-Port Expansion Board",
        "chip": "on-board BMI088 (SPI-13)",
        "interface": "5x CAN FD (CAN1-4, CAN10) + 30-pin; NO RJ45",
        "boards": {"s600": ("yes", "-")},
    },
}

ALIASES = {
    "gs130": "gs130w", "gs130-w": "gs130w",
    "gs130-wi": "gs130wi", "gs130iw": "gs130wi", "gs130w-i": "gs130wi",
    "imu-module": "imu", "bmi088": "imu", "rdk-imu": "imu",
    "s100-camera": "s100-cam", "s100cam": "s100-cam",
    "s600-camera": "s600-cam", "s600cam": "s600-cam",
    "s100-mcu-port": "s100-mcu", "s100mcu": "s100-mcu",
    "s600-mcu-port": "s600-mcu", "s600mcu": "s600-mcu",
}

BOARD_ALIASES = {
    "rdkx3": "x3", "x3module": "x3", "x3-module": "x3",
    "rdkx5": "x5", "rdkx5m": "x5m", "x5-module": "x5m", "x5module": "x5m",
    "rdks100": "s100", "super100": "s100",
    "rdks100p": "s100p", "super100p": "s100p",
    "rdks600": "s600",
}


def canon(key: str, aliases: dict) -> str:
    k = key.strip().lower().replace("_", "-")
    return aliases.get(k, k)


def show(key: str, board: str | None) -> int:
    key = canon(key, ALIASES)
    acc = ACCESSORIES.get(key)
    if acc is None:
        print(f"Unknown accessory: {key!r}. Known: {', '.join(ACCESSORIES)}", file=sys.stderr)
        return 2
    print(f"{key}: {acc['name']}")
    print(f"  chip      : {acc['chip']}")
    print(f"  interface : {acc['interface']}")
    for extra in ("ffc", "driver"):
        if extra in acc:
            print(f"  {extra:<10}: {acc[extra]}")
    if board:
        b = canon(board, BOARD_ALIASES)
        supported, note = acc["boards"].get(b, ("unknown", "not in support table"))
        print(f"  on {b:<6}: {supported} ({note})")
    else:
        print("  boards    :")
        for b, (supported, note) in acc["boards"].items():
            print(f"    {b:<6} -> {supported} ({note})")
    return 0


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("--")]
    board = None
    if "--board" in argv:
        i = argv.index("--board")
        if i + 1 < len(argv):
            board = argv[i + 1]
            args = [a for a in args if a != board]
    if not args:
        for k in ACCESSORIES:
            show(k, None)
            print()
        return 0
    return show(args[0], board)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
