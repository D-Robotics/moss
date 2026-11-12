#!/usr/bin/env python3
"""Generic artifact/report differ for simulation benchmarks (Moss tool).

  refdiff.py xml <mine.xml> <reference.xml>     semantic MuJoCo XML diff
  refdiff.py report <mine.json> <reference.json> checkpoint-level verifier diff

The XML diff focuses on structural elements (bodies, sites, joints, geoms,
actuators) and ignores visual assets (mesh/material/texture) and default-zero
attributes. Per-component vector comparison means one wrong axis is never
hidden by a matching norm. Nothing here is task-specific.
"""

from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET

STRUCTURAL = {"body", "site", "joint", "geom", "actuator", "motor", "position",
              "velocity", "general", "include", "attachment", "frame", "camera", "light"}
VECTOR_ATTRS = {"pos", "size", "axis", "quat", "fromto", "range", "fullinertia"}
NUMERIC_TOL = 0.002
MAX_ROWS = 30


def _numbers(text: str) -> list[float] | None:
    parts = text.replace(",", " ").split()
    try:
        return [float(p) for p in parts]
    except ValueError:
        return None


def _fmt(v: float) -> str:
    return f"{v:+.4f}"


def walk(root: ET.Element):
    def rec(elem: ET.Element, path: list[str]):
        for child in list(elem):
            if child.tag in STRUCTURAL or child.tag in ("compiler", "option"):
                yield path, child
            yield from rec(child, path + [elem.tag])
    yield from rec(root, [])


def diff_xml(mine_path: str, ref_path: str) -> None:
    def build(path: str):
        out = {}
        for parents, elem in walk(ET.parse(path).getroot()):
            if elem.tag in ("compiler", "option"):
                continue
            name = elem.get("name")
            key = f"{elem.tag}:{name}" if name else elem.tag
            out[key] = (elem, "/".join(parents[-2:]))
        return out

    mine, ref = build(mine_path), build(ref_path)
    missing = sorted(set(ref) - set(mine))
    extra = sorted(set(mine) - set(ref))
    print(f"# structural elements: mine {len(mine)} | reference {len(ref)}")

    # Missing elements matter most when the reference has them and they carry
    # physical attributes (mount sites, joints, wheels).
    interest = ("site:", "joint:", "actuator:", "body:")
    miss_show = [k for k in missing if k.startswith(interest)][:12] or missing[:12]
    if missing:
        print(f"# missing in mine ({len(missing)}):")
        for k in miss_show:
            print("  -", k)
    extra_show = [k for k in extra if k.startswith(interest)][:12] or extra[:12]
    if extra:
        print(f"# extra in mine ({len(extra)}):")
        for k in extra_show:
            print("  +", k)

    deltas: list[tuple[float, str, str, str, str]] = []
    for key in sorted(set(mine) & set(ref)):
        a, b = mine[key][0], ref[key][0]
        for attr in sorted(set(a.attrib) | set(b.attrib)):
            if attr in ("name", "class", "rgba", "material", "contype", "conaffinity",
                        "rgba", "autolimits", "inertia", "type"):
                continue
            va, vb = a.get(attr), b.get(attr)
            na = _numbers(va) if va else None
            nb = _numbers(vb) if vb else None
            if na is not None and nb is not None and len(na) == len(nb):
                # skip default zeros that the writer simply omitted
                if all(abs(x) < 1e-9 for x in na) and all(abs(y) < 1e-9 for y in nb):
                    continue
                for i, (x, y) in enumerate(zip(na, nb)):
                    if abs(x - y) > NUMERIC_TOL:
                        label = f"{attr}[{i}]" if len(na) > 1 else attr
                        deltas.append((abs(x - y), key, label, _fmt(x), _fmt(y)))
            elif (va or vb) and va != vb:
                deltas.append((0.5, key, attr, str(va), str(vb)))

    deltas.sort(key=lambda d: -d[0])
    print(f"# attribute deltas ({len(deltas)}), largest first:")
    for mag, key, attr, va, vb in deltas[:MAX_ROWS]:
        print(f"  {attr:14s} mine={va:>10s} ref={vb:>10s}   {key}")
    if len(deltas) > MAX_ROWS:
        print(f"  … {len(deltas) - MAX_ROWS} more deltas (refine with grep)")
    if not deltas:
        print("  (no structural attribute deltas above tolerance)")


def diff_report(mine_path: str, ref_path: str) -> None:
    def load(p: str) -> dict:
        d = json.load(open(p))
        if "checkpoints" in d:
            return d
        for k in ("verifier_result", "results", "report"):
            inner = d.get(k)
            if isinstance(inner, dict) and "checkpoints" in inner:
                return inner
        return d

    mine, ref = load(mine_path), load(ref_path)
    cp_m, cp_r = mine.get("checkpoints") or {}, ref.get("checkpoints") or {}
    rows = []
    for k in sorted(set(cp_m) | set(cp_r)):
        a = float(cp_m.get(k, 0.0) or 0.0)
        b = float(cp_r.get(k, 0.0) or 0.0)
        if a < b - 1e-9:
            rows.append((b - a, k, a, b))
    for key in ("reward", "raw_total", "merit"):
        if key in mine or key in ref:
            print(f"# {key}: mine={mine.get(key)} ref={ref.get(key)}")
    print(f"# stages mine: {json.dumps(mine.get('stages'))}")
    print(f"# stages ref : {json.dumps(ref.get('stages'))}")
    rows.sort(key=lambda r: -r[0])
    print(f"# checkpoints below reference ({len(rows)}), largest gap first:")
    for gap, k, a, b in rows:
        print(f"  {k:28s} mine={a:.4f} ref={b:.4f} gap={-gap:+.4f}")


def main() -> int:
    if len(sys.argv) != 4 or sys.argv[1] not in ("xml", "report"):
        print(__doc__)
        return 2
    mode, mine, ref = sys.argv[1:]
    (diff_xml if mode == "xml" else diff_report)(mine, ref)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
