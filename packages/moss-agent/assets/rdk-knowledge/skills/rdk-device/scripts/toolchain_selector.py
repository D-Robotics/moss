#!/usr/bin/env python3
"""Map an RDK board to its BPU toolchain parameters.

Answers the recurring question "what march / tool / artifact / runtime do I use
for board X?" deterministically, so Claude doesn't have to recite the table from
memory (and risk drifting on, e.g., S600=nash-p vs nash).

Usage:
    python3 toolchain_selector.py s600
    python3 toolchain_selector.py            # prints the whole table

Source of truth: official D-Robotics FAQ (Super100=Nash-e, Super100P=Nash-m) and
the S600 LLM SDK (resolve_model_nash-p.md => S600=nash-p). Keep this in sync with
SKILL.md's cheat-sheet if the official mapping ever changes.
"""
from __future__ import annotations

import sys

# board key -> (display name, BPU arch, march, host tool, artifact, on-board runtime)
BOARDS = {
    "x3":    ("RDK X3",    "Bernoulli2", "bernoulli2", "hb_mapper",  ".bin", "hobot_dnn (pyeasy_dnn)"),
    "x5":    ("RDK X5",    "Bayes-e",    "bayes-e",    "hb_mapper",  ".bin", "hbm_runtime (3.5.0+) / pyeasy_dnn (older)"),
    "ultra": ("RDK Ultra", "Bayes",      "bayes",      "hb_mapper",  ".bin", "hobot_dnn"),
    "s100":  ("RDK S100",  "Nash-e",     "nash-e",     "hb_compile", ".hbm", "hbm_runtime"),
    "s100p": ("RDK S100P", "Nash-m",     "nash-m",     "hb_compile", ".hbm", "hbm_runtime"),
    "s600":  ("RDK S600",  "Nash",       "nash-p",     "hb_compile", ".hbm", "hbm_runtime"),
}

# common ways a user / probe string might name the board -> canonical key
ALIASES = {
    "sunrise3": "x3", "xj3": "x3", "j3": "x3",
    "sunrise5": "x5", "rdkx5": "x5",
    "rdkultra": "ultra",
    "super100": "s100", "rdks100": "s100",
    "super100p": "s100p", "rdks100p": "s100p",
    "rdks600": "s600",
}

FIELDS = ["board", "bpu_arch", "march", "host_tool", "artifact", "runtime"]


def normalize(raw: str) -> str | None:
    key = raw.strip().lower().replace("rdk_", "").replace("rdk-", "").replace(" ", "").replace("_", "")
    if key in BOARDS:
        return key
    return ALIASES.get(key)


def show(key: str) -> None:
    row = BOARDS[key]
    print(f"# {row[0]}")
    for field, value in zip(FIELDS, row):
        print(f"  {field:10s}: {value}")
    note = "Toolchain runs on an x86 Docker host; the board only has the runtime. " \
           f"Cross-family artifacts are NOT interchangeable ({row[4]} only loads on {row[1]})."
    print(f"  note      : {note}")


def show_all() -> None:
    print(f"{'board':12s} {'arch':12s} {'march':12s} {'tool':12s} {'artifact':9s} runtime")
    print("-" * 88)
    for row in BOARDS.values():
        print(f"{row[0]:12s} {row[1]:12s} {row[2]:12s} {row[3]:12s} {row[4]:9s} {row[5]}")


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
