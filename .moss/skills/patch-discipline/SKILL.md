---
name: patch-discipline
description: How to make code changes in the moss repo — read-before-edit, minimal diffs, verify with real runs
when: editing any file in this repository or producing a patch
---

# Patch discipline for moss

1. Read the real source before editing. Never guess behavior from file names.
2. Make the minimal change that fixes the problem. Match surrounding style; do not refactor neighbors in the same patch.
3. Every user-facing success message must come from a real probe, exit code, or post-condition — never a fixed string.
4. All subprocesses go through `runProcess` / `spawnProcess` from `src/utils/run-process.ts`; tool paths must not use execFileSync/execSync.
5. New tools must declare `metadata.sideEffectClass` (readonly vs mutating drives approval).
6. After a logic change: `npm run build` then run the real command / probe that exercises the change (`npm run verify:quick` is the compiled gate). A bug fix needs a red-then-green executable probe; do not add `test/*.spec.mjs` files (owner decision, 2026-11-04).
7. Errors crossing tool/provider/CLI boundaries become `MossError` with the original cause preserved.
