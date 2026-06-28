#!/usr/bin/env python3
"""Deterministic RDK board hardware lookup.

Answers the recurring "what does board X have?" questions (TOPS / RAM / power /
LED color / 40PIN level / CAN type / default IP / OS line) without reciting the
table from memory and risking drift (e.g. X3 power LED is RED not green, S600 IO
is 1.8V, only X5 is SocketCAN).

Usage:
    python3 board_specs.py s600          # one board
    python3 board_specs.py x5 --field can
    python3 board_specs.py               # whole matrix

Source of truth: official D-Robotics hardware-introduction docs (rdk_x_doc,
rdk_doc, rdk_s_doc). Keep in sync with references/board-specs.md.
"""
from __future__ import annotations

import sys

# canonical key -> ordered field dict
BOARDS: dict[str, dict[str, str]] = {
    "x3": {
        "board": "RDK X3", "soc": "Sunrise 3 (X3J3)", "bpu_arch": "Bernoulli2",
        "march": "bernoulli2", "tops": "5", "ram": "2 GB", "model": ".bin",
        "os": "Ubuntu 22.04 / Humble", "power": "5V/3A USB-C (Module 12V/2A DC)",
        "power_led": "RED", "io_level": "3.3V (40-pin)",
        "can": "none on-board",
        "default_ip": "192.168.1.10 (≤2.0.0) / 192.168.127.10 (2.1.0+)",
        "hdmi": "1080P", "default_user": "sunrise/sunrise primary, root/root present",
    },
    "x5": {
        "board": "RDK X5", "soc": "Sunrise 5", "bpu_arch": "Bayes-e",
        "march": "bayes-e", "tops": "10", "ram": "4 / 8 GB", "model": ".bin",
        "os": "Ubuntu 22.04 / Humble", "power": "5V/5A USB-C",
        "power_led": "green power + orange status (blink, 3.1.0+)",
        "io_level": "3.3V (40-pin)",
        "can": "Linux SocketCAN can0 (TCAN4550 SPI-to-CAN-FD, up to 8 Mbps)",
        "default_ip": "192.168.127.10", "hdmi": "1080P (PoE supported)",
        "default_user": "root/root direct, sunrise present",
    },
    "ultra": {
        "board": "RDK Ultra", "soc": "Sunrise 5 Ultra", "bpu_arch": "Bayes",
        "march": "bayes", "tops": "96", "ram": "8 GB", "model": ".bin",
        "os": "Ubuntu 22.04 / Humble", "power": "DC >=12V/5A",
        "power_led": "RED", "io_level": "3.3V (40-pin)",
        "can": "none on-board", "default_ip": "192.168.1.10",
        "hdmi": "1080P (1080p60 only currently)",
        "default_user": "root/root direct, sunrise present",
    },
    "s100": {
        "board": "RDK S100", "soc": "S100 (Nash)", "bpu_arch": "Nash-e",
        "march": "nash-e", "tops": "80", "ram": "12 GB", "model": ".hbm",
        "os": "Ubuntu 22.04 / Humble", "power": "12-20V DC, max 150W (90W adapter)",
        "power_led": "green power + orange Main-running",
        "io_level": "3.3V (40-pin J24)",
        "can": "MCU-domain CANHAL CAN5-CAN9 (NOT SocketCAN, no can0)",
        "default_ip": "eth0 DHCP, eth1 fixed 192.168.127.10",
        "hdmi": "2K@60Hz (2560x1440)", "default_user": "both sunrise/sunrise AND root/root",
    },
    "s100p": {
        "board": "RDK S100P", "soc": "S100P (Nash)", "bpu_arch": "Nash-m",
        "march": "nash-m", "tops": "128", "ram": "24 GB", "model": ".hbm",
        "os": "Ubuntu 22.04 / Humble", "power": "12-20V DC, max 150W (90W adapter)",
        "power_led": "green power + orange Main-running",
        "io_level": "3.3V (40-pin J24)",
        "can": "MCU-domain CANHAL CAN5-CAN9 (NOT SocketCAN, no can0)",
        "default_ip": "eth0 DHCP, eth1 fixed 192.168.127.10",
        "hdmi": "2K@60Hz (2560x1440)", "default_user": "both sunrise/sunrise AND root/root",
    },
    "s600": {
        "board": "RDK S600", "soc": "S600 (Nash)", "bpu_arch": "Nash",
        "march": "nash-p", "tops": "560 (4x core)", "ram": "32 / 64 GB", "model": ".hbm",
        "os": "Ubuntu 24.04 / Jazzy (/opt/tros/jazzy)",
        "power": "12-28V DC, max 16A, 4-pin Microfit (24V/8A adapter)",
        "power_led": "green power + orange Main",
        "io_level": "1.8V (NO 40-pin; 2x10 + 1x12 + 1x14 self-locking connectors)",
        "can": "MCU CANHAL: MCU x5 (J16) + Main x4 (J17), NOT SocketCAN",
        "default_ip": "eth0 DHCP, eth1 fixed 192.168.127.10",
        "hdmi": "2K@60Hz (2560x1440)", "default_user": "both sunrise/sunrise AND root/root",
    },
}

ALIASES = {
    "sunrise3": "x3", "xj3": "x3", "j3": "x3", "x3j3": "x3", "x3module": "x3",
    "sunrise5": "x5", "rdkx5": "x5",
    "rdkultra": "ultra", "sunrise5ultra": "ultra",
    "super100": "s100", "rdks100": "s100", "s100e": "s100",
    "super100p": "s100p", "rdks100p": "s100p",
    "rdks600": "s600",
}

FIELD_ORDER = ["board", "soc", "bpu_arch", "march", "tops", "ram", "model",
               "os", "power", "power_led", "io_level", "can", "default_ip",
               "hdmi", "default_user"]


def normalize(raw: str) -> str | None:
    key = raw.strip().lower().replace("rdk_", "").replace("rdk-", "").replace(" ", "").replace("_", "")
    if key in BOARDS:
        return key
    return ALIASES.get(key)


def show(key: str, field: str | None) -> int:
    spec = BOARDS[key]
    if field:
        if field not in spec:
            print(f"Unknown field: {field!r}. Known: {', '.join(FIELD_ORDER)}", file=sys.stderr)
            return 1
        print(spec[field])
        return 0
    print(f"# {spec['board']}")
    for f in FIELD_ORDER:
        print(f"  {f:13s}: {spec[f]}")
    return 0


def show_all() -> None:
    print(f"{'board':12s} {'arch':11s} {'tops':12s} {'ram':9s} {'model':6s} {'led':14s} io_level")
    print("-" * 92)
    for spec in BOARDS.values():
        led = "red" if spec["power_led"].startswith("RED") else "green/orange"
        print(f"{spec['board']:12s} {spec['bpu_arch']:11s} {spec['tops']:12s} "
              f"{spec['ram']:9s} {spec['model']:6s} {led:14s} {spec['io_level']}")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        show_all()
        return 0
    key = normalize(argv[1])
    if key is None:
        print(f"Unknown board: {argv[1]!r}. Known: {', '.join(BOARDS)}", file=sys.stderr)
        return 1
    field = None
    if "--field" in argv:
        i = argv.index("--field")
        if i + 1 < len(argv):
            field = argv[i + 1].lower()
    return show(key, field)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
