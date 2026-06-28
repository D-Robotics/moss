#!/usr/bin/env python3
"""Board -> TROS environment lookup for RDK boards.

Deterministic mapping of an RDK board to its ROS2 distro, setup path,
apt package prefix, and on-board model artifact. Facts verified against
D-Robotics/tros_doc and per-node READMEs (2026-06).

Usage:
    python3 tros_env.py s600
    python3 tros_env.py x5
    python3 tros_env.py            # print the whole table
"""
import sys

# canonical, doc-verified board facts
BOARDS = {
    "x3":     {"ubuntu": "20.04/22.04", "distro": "Foxy/Humble", "setup": "/opt/tros/humble/setup.bash", "apt": "tros-humble-*", "artifact": ".bin"},
    "x5":     {"ubuntu": "22.04",       "distro": "Humble",      "setup": "/opt/tros/humble/setup.bash", "apt": "tros-humble-*", "artifact": ".bin"},
    "ultra":  {"ubuntu": "22.04",       "distro": "Humble",      "setup": "/opt/tros/humble/setup.bash", "apt": "tros-humble-*", "artifact": ".bin"},
    "s100":   {"ubuntu": "22.04",       "distro": "Humble",      "setup": "/opt/tros/humble/setup.bash", "apt": "tros-humble-*", "artifact": ".hbm"},
    "s100p":  {"ubuntu": "22.04",       "distro": "Humble",      "setup": "/opt/tros/humble/setup.bash", "apt": "tros-humble-*", "artifact": ".hbm"},
    "s600":   {"ubuntu": "24.04",       "distro": "Jazzy",       "setup": "/opt/tros/jazzy/setup.bash",  "apt": "tros-jazzy-*",  "artifact": ".hbm"},
}

ALIASES = {
    "rdkx3": "x3", "rdk-x3": "x3", "x3module": "x3", "x3m": "x3",
    "rdkx5": "x5", "rdk-x5": "x5", "x5module": "x5", "x5m": "x5",
    "rdkultra": "ultra", "rdk-ultra": "ultra",
    "rdks100": "s100", "super100": "s100",
    "rdks100p": "s100p", "s100-p": "s100p", "super100p": "s100p",
    "rdks600": "s600", "super600": "s600",
}


def normalize(name: str) -> str:
    key = name.strip().lower().replace(" ", "").replace("_", "")
    key = ALIASES.get(key, key)
    return key


def fmt(key: str, b: dict) -> str:
    return (f"{key.upper():7} | Ubuntu {b['ubuntu']:<12} | ROS2 {b['distro']:<13} | "
            f"source {b['setup']:<32} | apt {b['apt']:<14} | model {b['artifact']}")


def main() -> int:
    if len(sys.argv) < 2:
        print("Board  | Ubuntu       | ROS2 distro   | setup path                        | apt prefix     | artifact")
        for k, b in BOARDS.items():
            print(fmt(k, b))
        print("\nNote: S600 = Ubuntu 24.04 / Jazzy (/opt/tros/jazzy). All others = Humble (/opt/tros/humble).")
        return 0

    key = normalize(sys.argv[1])
    b = BOARDS.get(key)
    if not b:
        print(f"Unknown board: {sys.argv[1]!r}. Known: {', '.join(BOARDS)}", file=sys.stderr)
        return 2
    print(fmt(key, b))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
