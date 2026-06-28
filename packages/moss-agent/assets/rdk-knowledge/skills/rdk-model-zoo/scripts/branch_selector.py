#!/usr/bin/env python3
"""Map an RDK board to its Model Zoo repo / branch / sample layout.

Answers the recurring question "which branch do I clone, and what artifact /
runtime do I get?" deterministically, so Claude doesn't recite the table from
memory (and risk drifting on, e.g., S600 being on rdk_s vs a dev branch).

Usage:
    python3 branch_selector.py s600
    python3 branch_selector.py            # prints the whole table

Source of truth (verified against live repos):
  - rdk_model_zoo `rdk_x5` branch README -> X5 = rdk_x5, .bin, hbm_runtime
  - rdk_model_zoo `rdk_s`  branch README -> S100/S100P/S600 = rdk_s, .hbm, hbm_runtime
    ("Current branch. Primary delivery branch for RDK S100, S100P, and S600")
  - rdk_model_zoo `rdk_x3` branch -> X3 demos/<task>/, .bin, pyeasy_dnn
  - rdk_model_zoo_s `s100` -> historical archive for S100/S100P (.hbm)
Keep this in sync with SKILL.md's cheat-sheet if the official mapping changes.
"""
from __future__ import annotations

import sys

# key -> (display, repo, branch, sample_dir, artifact, python_runtime, note)
BOARDS = {
    "x3": (
        "RDK X3", "rdk_model_zoo", "rdk_x3", "demos/<task>/", ".bin",
        "pyeasy_dnn / hobot_dnn",
        "X3 uses demos/ (not samples/). Appendix: classification/detection/seg/OCR only.",
    ),
    "x5": (
        "RDK X5", "rdk_model_zoo", "rdk_x5", "samples/vision/<model>/", ".bin",
        "hbm_runtime",
        "Primary X5 branch. Old demos live on rdk_x5_legacy (pyeasy_dnn). Artifact is .bin.",
    ),
    "x5_legacy": (
        "RDK X5 (legacy)", "rdk_model_zoo", "rdk_x5_legacy", "(old demos)", ".bin",
        "hobot_dnn / pyeasy_dnn",
        "Historical archive of the old X5 demos (was 'main'). Use rdk_x5 for new work.",
    ),
    "s100": (
        "RDK S100", "rdk_model_zoo", "rdk_s", "samples/vision/<model>/", ".hbm",
        "hbm_runtime",
        "rdk_s is the current S-series branch (S100/S100P/S600). rdk_model_zoo_s/s100 is the archive.",
    ),
    "s100p": (
        "RDK S100P", "rdk_model_zoo", "rdk_s", "samples/vision/<model>/", ".hbm",
        "hbm_runtime",
        "Same rdk_s branch as S100/S600. S100P benchmarks generally faster than S100.",
    ),
    "s600": (
        "RDK S600", "rdk_model_zoo", "rdk_s", "samples/vision/<model>/", ".hbm",
        "hbm_runtime",
        "Covered by rdk_s. model_zoo_doc appendix has LLM benchmark only for S600 so far.",
    ),
}

# how a user / probe string might name the board -> canonical key
ALIASES = {
    "sunrise3": "x3", "xj3": "x3", "j3": "x3", "rdkx3": "x3",
    "sunrise5": "x5", "rdkx5": "x5",
    "rdkx5legacy": "x5_legacy", "legacy": "x5_legacy",
    "super100": "s100", "rdks100": "s100",
    "super100p": "s100p", "rdks100p": "s100p",
    "rdks600": "s600", "super600": "s600",
}

FIELDS = ["board", "repo", "branch", "sample_dir", "artifact", "runtime"]


def normalize(raw: str) -> str | None:
    key = raw.strip().lower().replace("rdk_", "").replace("rdk-", "").replace(" ", "").replace("_", "")
    if key in BOARDS:
        return key
    return ALIASES.get(key)


def show(key: str) -> None:
    row = BOARDS[key]
    print(f"# {row[0]}")
    for field, value in zip(FIELDS, row):
        print(f"  {field:11s}: {value}")
    print(f"  clone      : git clone -b {row[2]} https://github.com/D-Robotics/{row[1]}.git")
    print(f"  download   : https://archive.d-robotics.cc/downloads/rdk_model_zoo/{row[2]}/<MODEL_FAMILY>/<file>")
    print(f"  note       : {row[6]}")


def show_all() -> None:
    print(f"{'board':16s} {'branch':14s} {'sample_dir':22s} {'artifact':9s} runtime")
    print("-" * 80)
    for row in BOARDS.values():
        print(f"{row[0]:16s} {row[2]:14s} {row[3]:22s} {row[4]:9s} {row[5]}")


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
