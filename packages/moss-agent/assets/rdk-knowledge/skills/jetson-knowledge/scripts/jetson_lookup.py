#!/usr/bin/env python3
"""Map a Jetson module to its key specs, deterministically.

Answers "how many TOPS / which GPU arch / max JetPack / does Super Mode apply?"
without reciting the table from memory (and risk drifting on, e.g., quoting the
pre-Super 40 TOPS for Orin Nano instead of the current 67).

Usage:
    python3 jetson_lookup.py "orin nano"
    python3 jetson_lookup.py orin-nx-16gb
    python3 jetson_lookup.py            # prints the whole table

Source of truth: NVIDIA Jetson Orin product page and the JetPack 6.2 Super Mode
blog. INT8 figures are Sparse. Keep in sync with references/module-specs.md.
"""
from __future__ import annotations

import sys

# key -> (display name, GPU arch, INT8 sparse TOPS, memory, max JetPack, super mode, note)
MODULES = {
    "agx-orin-64gb": ("AGX Orin 64GB", "Ampere (2048-core)", "275 TOPS", "64GB LPDDR5", "6.x", "no (already MAXN)", "flagship"),
    "agx-orin-32gb": ("AGX Orin 32GB", "Ampere (1792-core)", "248 TOPS", "32GB LPDDR5", "6.x", "no (already MAXN)", ""),
    "orin-nx-16gb":  ("Orin NX 16GB",  "Ampere (1024-core)", "157 TOPS", "16GB LPDDR5", "6.x", "yes (was 100)", "nvpmodel -m 0"),
    "orin-nx-8gb":   ("Orin NX 8GB",   "Ampere (1024-core)", "117 TOPS", "8GB LPDDR5",  "6.x", "yes (was 70)",  "nvpmodel -m 0"),
    "orin-nano-8gb": ("Orin Nano 8GB", "Ampere (1024-core)", "67 TOPS",  "8GB LPDDR5",  "6.x", "yes (was 40)",  "nvpmodel -m 2; 'Super' devkit"),
    "orin-nano-4gb": ("Orin Nano 4GB", "Ampere (512-core)",  "34 TOPS",  "4GB LPDDR5",  "6.x", "yes (was 20)",  "nvpmodel -m 2"),
    "xavier-nx":     ("Xavier NX",     "Volta (384-core)",   "21 TOPS",  "8/16GB LPDDR4x", "5.1.x (last)", "no", "NOT Ampere; no JetPack 6"),
    "nano":          ("Jetson Nano",   "Maxwell (128-core)", "472 GFLOPS FP16 (no INT8 accel)", "2/4GB LPDDR4", "4.6.x (EOL)", "no", "do NOT quote a TOPS number"),
}

# loose user phrasings -> canonical key
ALIASES = {
    "agxorin": "agx-orin-64gb", "agx-orin": "agx-orin-64gb", "agx": "agx-orin-64gb",
    "orin-nx": "orin-nx-16gb", "orinnx": "orin-nx-16gb", "nx": "orin-nx-16gb",
    "orin-nano": "orin-nano-8gb", "orinnano": "orin-nano-8gb",
    "orin-nano-super": "orin-nano-8gb", "orinnanosuper": "orin-nano-8gb", "nano-super": "orin-nano-8gb",
    "xaviernx": "xavier-nx", "xavier": "xavier-nx",
    "jetson-nano": "nano", "jetsonnano": "nano",
}

FIELDS = ["module", "gpu_arch", "ai_perf_int8", "memory", "max_jetpack", "super_mode", "note"]


def normalize(raw: str) -> str | None:
    key = raw.strip().lower().replace("nvidia", "").replace("jetson", "").strip(" -_")
    key = key.replace(" ", "-").replace("_", "-")
    while "--" in key:
        key = key.replace("--", "-")
    if key in MODULES:
        return key
    return ALIASES.get(key.replace("-", ""))  or ALIASES.get(key)


def show(key: str) -> None:
    row = MODULES[key]
    print(f"# {row[0]}")
    for field, value in zip(FIELDS, row):
        print(f"  {field:14s}: {value}")
    print("  reminder      : INT8 figures are Sparse (dense = half). TensorRT engines "
          "are device+version specific — build on the target Jetson.")


def show_all() -> None:
    print(f"{'module':16s} {'gpu':22s} {'int8 (sparse)':16s} {'max jetpack':14s} super")
    print("-" * 86)
    for row in MODULES.values():
        print(f"{row[0]:16s} {row[1]:22s} {row[2]:16s} {row[4]:14s} {row[5]}")


def main() -> int:
    if len(sys.argv) < 2:
        show_all()
        return 0
    key = normalize(" ".join(sys.argv[1:]))
    if key is None:
        print(f"Unknown module: {' '.join(sys.argv[1:])!r}. Known: {', '.join(MODULES)}", file=sys.stderr)
        return 1
    show(key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
