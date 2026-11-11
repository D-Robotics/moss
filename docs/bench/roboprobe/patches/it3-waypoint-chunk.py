#!/usr/bin/env python3
"""RoboProbe RSI iteration 3: cap the waypoints played per move_eef call.

Evidence (official cell run 2026-11-11_07-52-07, layout 3, white toy car):
  transcript lines such as "launching 126 waypoints (5.0s)" and "playing 60
  waypoints" show one move_eef can consume dozens of an episode's 200 env
  steps. Episodes then end at "Only 3 env steps remain" / "Ran out of env
  steps (12 left)" before the agent can run its descend -> look -> adjust loop.

Effect: `_arm_steps` returns ceil(travel / declared_step_limit), i.e. the whole
Cartesian path in one shot. This patch renames that to `_arm_steps_uncapped`
and inserts a wrapper that caps it at L3_INSPECT_MAX_ARM_STEPS (default 12), so
the same travel is played over several turns, each ending with an observation.

Apply AFTER any running cell has finished: the policy server imports this
module at start, so editing mid-run changes nothing until a restart.

    python3 it3-waypoint-chunk.py --apply
    python3 it3-waypoint-chunk.py --revert
"""
from __future__ import annotations

import argparse
import pathlib

TARGETS = [
    pathlib.Path(
        "/root/RoboDojo/XPolicyLab/policy/RoboDojo_Agent_L3_Inspect_EEF/policy.py"
    ),
    pathlib.Path(
        "/root/RoboProbe/policy/RoboDojo_Agent_L3_Inspect_EEF/policy.py"
    ),
]

DEF_LINE = "    def _arm_steps(self, paths: Mapping[str, np.ndarray]) -> int:\n"
WRAPPER = '''    def _arm_steps(self, paths: Mapping[str, np.ndarray]) -> int:
        """Env steps for one move_eef call, capped by L3_INSPECT_MAX_ARM_STEPS."""
        return min(self._arm_steps_uncapped(paths), self._max_arm_steps)

'''
UNCAPPED_LINE = (
    "    def _arm_steps_uncapped(self, paths: Mapping[str, np.ndarray]) -> int:\n"
)

INIT_ANCHOR = "        self._arm_step_limits: dict[str, np.ndarray] = {}\n"
INIT_PATCH = '''        self._max_arm_steps = int(os.environ.get("L3_INSPECT_MAX_ARM_STEPS", "12"))
        if self._max_arm_steps < 1:
            raise InfrastructureFailure("L3_INSPECT_MAX_ARM_STEPS must be >= 1")
''' + INIT_ANCHOR


def apply() -> None:
    for path in TARGETS:
        if not path.exists():
            print(f"missing {path}")
            continue
        src = path.read_text()
        if "_max_arm_steps" in src:
            print(f"already patched {path}")
            continue
        if DEF_LINE not in src or INIT_ANCHOR not in src:
            print(f"anchor not found in {path}")
            continue
        src = src.replace(DEF_LINE, WRAPPER + UNCAPPED_LINE, 1)
        src = src.replace(INIT_ANCHOR, INIT_PATCH, 1)
        if "\nimport os\n" not in src:
            src = src.replace("import json\n", "import json\nimport os\n", 1)
        path.write_text(src)
        print(f"patched {path}")


def revert() -> None:
    for path in TARGETS:
        if not path.exists():
            continue
        src = path.read_text()
        if "_max_arm_steps" not in src:
            print(f"not patched {path}")
            continue
        src = src.replace(WRAPPER + UNCAPPED_LINE, DEF_LINE, 1)
        src = src.replace(INIT_PATCH, INIT_ANCHOR, 1)
        path.write_text(src)
        print(f"reverted {path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--apply", action="store_true")
    g.add_argument("--revert", action="store_true")
    a = ap.parse_args()
    apply() if a.apply else revert()
