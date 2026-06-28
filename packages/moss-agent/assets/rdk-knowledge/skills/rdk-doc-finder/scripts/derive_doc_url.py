#!/usr/bin/env python3
"""Derive a candidate developer.d-robotics.cc URL from a doc repo + source path.

All six D-Robotics doc sites are Docusaurus with url=https://developer.d-robotics.cc,
baseUrl=/<repo>/, routeBasePath=/. The site URL is the repo file path with the
leading NN_ / NN- numeric ordering prefix stripped from each segment and the .md
dropped. This script applies that rule deterministically so Claude doesn't have to
do the string surgery by hand — and flags the two known exceptions that REQUIRE a
manual verify before the URL is trusted.

Usage:
    python3 derive_doc_url.py tros_doc docs/03_boxs/detection/yolo.md
    python3 derive_doc_url.py rdk_studio_doc docs/3-user-guide/10-openclaw/1-overview.md

Always curl/web_fetch the printed URL before handing it out: prefix-stripping is
NOT global (e.g. 01_40pin_user_sample keeps its 01_) and custom frontmatter slugs
override the path entirely (e.g. S100/S600 hardware intros).

Source of truth: each repo's docusaurus.config.js; rules curl-verified 200/404.
"""
from __future__ import annotations

import re
import sys

KNOWN_REPOS = {
    "rdk_x_doc", "rdk_s_doc", "tros_doc",
    "model_zoo_doc", "rdk_studio_doc", "accessories_doc", "rdk_doc",
}

BASE = "https://developer.d-robotics.cc"

# Path segments that are known to KEEP their numeric prefix on the live site.
# Stripping these produces a 404 — verify, do not auto-strip blindly.
KEEP_PREFIX_SEGMENTS = {"01_40pin_user_sample"}

PREFIX_RE = re.compile(r"^\d+[_-]")


def strip_prefix(segment: str) -> str:
    if segment in KEEP_PREFIX_SEGMENTS:
        return segment
    return PREFIX_RE.sub("", segment)


def derive(repo: str, src_path: str) -> tuple[str, list[str]]:
    warnings: list[str] = []
    path = src_path.strip().lstrip("/")
    if path.startswith("docs/"):
        path = path[len("docs/"):]
    if path.endswith(".md"):
        path = path[:-len(".md")]
    elif path.endswith(".mdx"):
        path = path[:-len(".mdx")]

    segments = [s for s in path.split("/") if s]
    out_segments = [strip_prefix(s) for s in segments]

    for seg in segments:
        if seg in KEEP_PREFIX_SEGMENTS:
            warnings.append(
                f"segment '{seg}' KEEPS its numeric prefix on the live site (stripping it 404s)"
            )
    if PREFIX_RE.match(segments[-1]) if segments else False:
        warnings.append(
            "last segment had a numeric prefix; if the source has a custom frontmatter "
            "'slug:' the real URL may keep the prefixes — check the frontmatter"
        )

    url = f"{BASE}/{repo}/" + "/".join(out_segments)
    return url, warnings


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        print("error: expected exactly <repo> <docs/path.md>", file=sys.stderr)
        return 2
    repo, src_path = sys.argv[1], sys.argv[2]
    if repo not in KNOWN_REPOS:
        print(f"warning: '{repo}' is not a known D-Robotics doc repo "
              f"({', '.join(sorted(KNOWN_REPOS))})", file=sys.stderr)
    url, warnings = derive(repo, src_path)
    print(url)
    for w in warnings:
        print(f"  ⚠️  {w}", file=sys.stderr)
    print("  → verify with: curl -s -o /dev/null -w '%{http_code}' -L "
          f"'{url}'", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
