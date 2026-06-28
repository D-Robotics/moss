#!/usr/bin/env python3
"""Deterministic RDK system-config lookup: board -> CPU freq points, governor
sysfs path, thermal-zone count, and fan cooling-device mapping.

Answers the recurring "what frequency / which sysfs path / which fan cooling
device for board X?" so Claude does not recite per-board sysfs from memory and
risk drifting (e.g. S100 fan = cooling_device2 vs S600 = cooling_device5/6).

Usage:
    python3 sysconf_lookup.py s600
    python3 sysconf_lookup.py            # prints the whole table

Source of truth: D-Robotics rdk_x_doc / rdk_s_doc docs/02_System_configuration/
04_frequency_management.md and 03_config_txt.md. Keep in sync with SKILL.md and
references/system-config.md if the official docs change.
"""
from __future__ import annotations

import sys

# board key -> dict of verified facts
BOARDS = {
    "x3": {
        "name": "RDK X3",
        "family": "X",
        "cpu_freqs_khz": "240000..1800000 (e.g. 240000/500000/800000/1000000/1200000/1500000/1800000)",
        "governor_path": "/sys/devices/system/cpu/cpufreq/policy0/scaling_governor",
        "setspeed_path": "/sys/devices/system/cpu/cpufreq/policy0/scaling_setspeed",
        "overclock": "boost 1.2->1.5GHz: echo 1 > /sys/devices/system/cpu/cpufreq/boost",
        "thermal_zones": "1 zone (thermal_zone0: startup 80 / throttle 95 / shutdown 105 C)",
        "fan_control": "none documented",
    },
    "x5": {
        "name": "RDK X5",
        "family": "X",
        "cpu_freqs_khz": "300000/600000/1200000/1500000",
        "governor_path": "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor",
        "setspeed_path": "/sys/devices/system/cpu/cpufreq/policy0/scaling_setspeed",
        "overclock": "boost 1.5->1.8GHz (X5H ONLY; X5M cannot; check cat /sys/class/socinfo/soc_name)",
        "thermal_zones": "2 zones (zone0=DDR 95; zone1=CPU/BPU/GPU throttle 95 / shutdown 105)",
        "fan_control": "none documented (cooling devices cpu/bpu/gpu/ddr, no emc2305 fan stage)",
    },
    "ultra": {
        "name": "RDK Ultra",
        "family": "X",
        "cpu_freqs_khz": "not documented in 02_System_configuration",
        "governor_path": "(srpi-config NOT available on Ultra; see board docs)",
        "setspeed_path": "n/a",
        "overclock": "n/a",
        "thermal_zones": "not documented in 02_System_configuration",
        "fan_control": "not documented in 02_System_configuration",
    },
    "s100": {
        "name": "RDK S100",
        "family": "S",
        "cpu_freqs_khz": "1500000/2000000 (per chip)",
        "governor_path": "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor",
        "setspeed_path": "/sys/devices/system/cpu/cpufreq/policy0/scaling_setspeed",
        "overclock": "none (S-series has no boost/overclock)",
        "thermal_zones": "5 zones (zone0 CPU/fan; zone4 BPU; zone1/2/3 shutdown-only)",
        "fan_control": "fan=cooling_device2 bound to thermal_zone0; set zone0 policy=user_space then echo 0-10 > cooling_device2/cur_state",
    },
    "s100p": {
        "name": "RDK S100P",
        "family": "S",
        "cpu_freqs_khz": "1500000/2000000 (per chip; same family as S100)",
        "governor_path": "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor",
        "setspeed_path": "/sys/devices/system/cpu/cpufreq/policy0/scaling_setspeed",
        "overclock": "none (S-series has no boost/overclock)",
        "thermal_zones": "as S100 (5 zones)",
        "fan_control": "as S100 (fan=cooling_device2, thermal_zone0)",
    },
    "s600": {
        "name": "RDK S600",
        "family": "S",
        "cpu_freqs_khz": "525000/1050000/2100000 (per chip)",
        "governor_path": "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor",
        "setspeed_path": "/sys/devices/system/cpu/cpufreq/policy0/scaling_setspeed",
        "overclock": "none (S-series has no boost/overclock)",
        "thermal_zones": "19 zones (CPU 0-6, DDR 7-10, BPU 11-18; zone2 & zone16 drive fans)",
        "fan_control": "fans=cooling_device5/6 bound to thermal_zone2 & thermal_zone16; set both policies=user_space then echo 0-10 > cooling_device5/cur_state",
    },
}

ALIASES = {
    "sunrise3": "x3", "xj3": "x3",
    "sunrise5": "x5", "rdkx5": "x5",
    "rdkultra": "ultra",
    "super100": "s100", "rdks100": "s100",
    "super100p": "s100p", "rdks100p": "s100p",
    "rdks600": "s600", "super600": "s600",
}

FIELDS = ["name", "family", "cpu_freqs_khz", "governor_path",
          "setspeed_path", "overclock", "thermal_zones", "fan_control"]


def normalize(raw: str) -> str | None:
    key = raw.strip().lower().replace("rdk_", "").replace("rdk-", "").replace(" ", "").replace("_", "")
    if key in BOARDS:
        return key
    return ALIASES.get(key)


def show(key: str) -> None:
    row = BOARDS[key]
    print(f"# {row['name']} ({row['family']}-series)")
    for field in FIELDS:
        print(f"  {field:14s}: {row[field]}")


def show_all() -> None:
    for key in BOARDS:
        show(key)
        print()


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
