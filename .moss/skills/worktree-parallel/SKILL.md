---
name: worktree-parallel
description: How to run writable sub-agents in isolated git worktrees and merge their lease patches
when: fanning out multiple implementation tasks that may touch the same files
---

# Worktree-parallel writable sub-agents

1. In `fan_out_subagents`, give each implementation task `scope: "full"`, declared `writePaths`, and `worktree: true` (or set `MOSS_WORKTREE_SUBAGENTS=1` once and full-scope tasks default to isolated worktrees).
2. Each child then works in its own `git worktree` under `.moss/worktrees/` — concurrent writers cannot see or stomp each other.
3. On completion the child's changes are collected as a binary patch under `.moss/patches/<leaseId>.patch`; its summary ends with `[worktree lease=<id> patch=<digest> changed=<n>]`.
4. Merge leases back with `merge_subagent_patch` (leaseId + patchId from the child result). Merging uses `git apply --3way`, so changes in different regions of a file compose; a same-region collision returns `merge_conflict` with the conflicting paths — resolve manually, do not force.
5. Merge order matters when tasks touch the same files: merge one, verify, then the next.
6. Worktrees are cleaned up automatically after patch collection; the patch files remain for audit.
