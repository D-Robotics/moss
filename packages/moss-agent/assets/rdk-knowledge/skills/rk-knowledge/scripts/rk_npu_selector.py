#!/usr/bin/env python3
"""Map a Rockchip RK35xx SoC to its NPU facts.

Answers "how many TOPS / how many NPU cores / what core_mask can I use?" for an
RK35xx board deterministically, so Claude never drifts on the per-core-vs-total
distinction (6 TOPS is the WHOLE NPU, not per core).

Usage:
    python3 rk_npu_selector.py rk3588
    python3 rk_npu_selector.py            # prints the whole table

Source of truth: airockchip/rknn-toolkit2 README (Support Platform list),
rknpu2/runtime rknn_api.h (core_mask enum), and Rockchip SoC specs. The 6 TOPS
total / 3-core (RK3588) / 2-core (RK3576) facts are from the Rockchip RKNPU
docs. Keep this in sync with SKILL.md's cheat-sheet if the mapping changes.
"""
from __future__ import annotations

import sys

# soc key -> (display, NPU TOPS, npu_cores, core_mask ceiling, CPU)
SOCS = {
    "rk3588":  ("RK3588 / RK3588S", "6 TOPS INT8", 3, "NPU_CORE_0_1_2 (all 3)", "4x A76 + 4x A55"),
    "rk3576":  ("RK3576",           "6 TOPS INT8", 2, "NPU_CORE_0_1 (both)",   "4x A72 + 4x A53"),
}

# common ways a board / probe string might name the SoC -> canonical key
ALIASES = {
    "rk3588s": "rk3588",
    "rock5b": "rk3588", "rock-5b": "rk3588",
    "rock5itx": "rk3588", "rock-5-itx": "rk3588",
    "orangepi5": "rk3588", "orange-pi-5": "rk3588", "opi5": "rk3588",
    "orangepi5plus": "rk3588", "orange-pi-5-plus": "rk3588",
    "firefly": "rk3588", "roc-rk3588s-pc": "rk3588",
}

FIELDS = ["soc", "npu_tops", "npu_cores", "core_mask_max", "cpu"]


def normalize(raw: str) -> str | None:
    key = raw.strip().lower().replace("rockchip,", "").replace("_", "").replace(" ", "")
    if key in SOCS:
        return key
    key2 = raw.strip().lower().replace("rockchip,", "")
    return ALIASES.get(key) or ALIASES.get(key2)


def show(key: str) -> None:
    row = SOCS[key]
    print(f"# {row[0]}")
    for field, value in zip(FIELDS, row):
        print(f"  {field:14s}: {value}")
    print("  note          : 6 TOPS is the WHOLE NPU, not per core. Default "
          f"NPU_CORE_AUTO runs one model on one core (~1/{row[2]}). Use the full "
          "NPU by pinning model instances to separate cores or setting the full "
          "core_mask. A .rknn is platform-specific (target_platform must match).")


def show_all() -> None:
    print(f"{'soc':18s} {'npu_tops':14s} {'cores':6s} core_mask ceiling")
    print("-" * 72)
    for row in SOCS.values():
        print(f"{row[0]:18s} {row[1]:14s} {row[2]:<6d} {row[3]}")


def main() -> int:
    if len(sys.argv) < 2:
        show_all()
        return 0
    key = normalize(sys.argv[1])
    if key is None:
        print(f"Unknown SoC: {sys.argv[1]!r}. Known: {', '.join(SOCS)}", file=sys.stderr)
        return 1
    show(key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
