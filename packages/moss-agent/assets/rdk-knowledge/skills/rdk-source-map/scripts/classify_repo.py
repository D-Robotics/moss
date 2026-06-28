#!/usr/bin/env python3
"""Classify a D-Robotics repo name along the three orthogonal axes.

Answers "what is this repo?" deterministically — layer, target board, and
assembly system — so Claude doesn't recite the rules from memory and risk
confusing hobot- (BSP) with hobot_ (ROS2 app), or claiming a private
s100-/j5- prefixed repo is public.

Usage:
    python3 classify_repo.py x5-hobot-multimedia
    python3 classify_repo.py hobot_dnn
    python3 classify_repo.py rcl

Source of truth: `gh api orgs/D-Robotics/repos` metadata, verified 2026-06
(226 public / 327 total). This is a heuristic classifier over NAMING
CONVENTIONS; for a definitive answer on an unusual name, look it up:
    gh api repos/D-Robotics/<name> --jq '{lang:.language, desc:.description, private:.private}'
"""
from __future__ import annotations

import re
import sys

# Board prefixes -> (board, is the prefixed BSP/build repo set public?)
PREFIXES = [
    ("x5-",   "RDK X5",            True),
    ("s100-", "RDK S100 / S100P",  False),  # private BSP/build repos
    ("j5-",   "Journey 5 (征程5)",  False),  # private BSP/build repos
]

# Upstream ROS2 ports (NOT RDK-original)
UPSTREAM_ROS2 = re.compile(
    r"^(rcl|rclcpp|rcl_interfaces|rmw_|rosbag2|ament_|tinyxml_vendor|"
    r"vision_opencv|livox_ros_driver2|isaac_)"
)


def classify(name: str) -> dict[str, str]:
    raw = name.strip()
    low = raw.lower()
    out: dict[str, str] = {"repo": raw}

    # --- board axis ---
    board, public = "RDK X3 (no prefix)", True
    for pref, b, pub in PREFIXES:
        if low.startswith(pref):
            board, public = b, pub
            break
    out["board"] = board
    if not public:
        out["availability"] = "prefixed BSP/build repos are PRIVATE (cannot clone anonymously)"

    # --- layer / assembly axis ---
    if UPSTREAM_ROS2.match(low):
        out["layer"] = "Upstream ROS2 port (NOT RDK-original) — debug against upstream first"
        out["assembly"] = "TROS workspace (vcstool + ros2.repos)"
    elif low.endswith("_doc") or low.endswith("-doc") or "_doc_" in low or low.endswith("doc_center"):
        out["layer"] = "Documentation source"
        out["assembly"] = "n/a (docs) — route to skill rdk-doc-finder"
    elif low.startswith("nodehub"):
        out["layer"] = "NodeHub app packaging (deb for app center)"
        out["assembly"] = "wraps a TROS app"
    elif low.startswith("magicbox"):
        out["layer"] = "MagicBox product companion package"
        out["assembly"] = "product"
    elif low.startswith("tros") or low == "robot_dev_config":
        out["layer"] = "TROS tooling / orchestration"
        out["assembly"] = "TROS workspace (vcstool + ros2.repos)"
    elif "hobot-" in low or low.endswith("-rdk-gen") or low in {"manifest", "rdk-gen", "kernel", "uboot", "bootloader"} \
            or low.endswith("-manifest") or low.endswith("-kernel") or low.endswith("-uboot") \
            or low.endswith("-bootloader") or low.endswith("-kernel-rt"):
        out["layer"] = "BSP / system source (goes into the OS image)"
        out["assembly"] = "OS image build (repo + manifest + *-rdk-gen)"
    elif "hobot_" in low:
        out["layer"] = "TROS / ROS2 application package"
        out["assembly"] = "TROS workspace (vcstool + ros2.repos)"
    else:
        out["layer"] = "application / other — look up the description to confirm"
        out["assembly"] = "unknown — gh api repos/D-Robotics/<name>"

    # --- hyphen vs underscore note for hobot* names ---
    if "hobot-" in low:
        out["hobot_form"] = "HYPHEN = BSP/image library (lower layer)"
    elif "hobot_" in low:
        out["hobot_form"] = "UNDERSCORE = ROS2 package (upper layer; wraps the BSP lib)"

    return out


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    result = classify(sys.argv[1])
    width = max(len(k) for k in result)
    for k, v in result.items():
        print(f"  {k:<{width}} : {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
