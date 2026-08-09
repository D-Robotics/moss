# Formatting verification evidence

Date: 2026-08-08

## Mechanical baseline

- `npm run format` completed across the approved Prettier surface.
- The resulting tracked diff was reviewed as a mechanical formatting/line-ending baseline.
- `npm run format:check` and `git diff --check` passed after the baseline.
- The repository's pre-migration complete `npm run verify` passed after one pre-existing Windows
  portability issue in `exec-wait.spec.mjs` was corrected to use a Node fixture instead of the
  shell-specific `sleep` executable.
- Full verification completed in 231.9 seconds and included boundaries, hygiene, the 200-case
  harness benchmark, build, typecheck, legacy lint, 9 core spec files, 256 agent spec files, and the
  create-moss-app suite.

The landing and blame-ignore procedure is documented in `docs/formatting-baseline.md`; the
formatting-only merge commit must be added to `.git-blame-ignore-revs` after it exists.

## LF versus Windows-style checkout

A committed snapshot of the current working tree was created in a system temporary directory, then
cloned without checkout into two clean Git worktrees. The first was configured with
`core.autocrlf=false`; the second used `core.autocrlf=true`. Both then checked out the same snapshot
and used the same workspace Prettier 3.8.3 installation.

| Measurement | LF checkout | Windows-style checkout |
| --- | ---: | ---: |
| `format:files` exit | 0 | 0 |
| Files evaluated | 875 | 875 |
| File-list SHA-256 | `a305467771bbb2875c17e9b6db08420f90c6e7b76d50b3f7293410ec72bf468d` | `a305467771bbb2875c17e9b6db08420f90c6e7b76d50b3f7293410ec72bf468d` |
| Prettier check exit | 0 | 0 |
| Worktree clean after check | yes | yes |

This proves `.gitattributes`, `.prettierignore`, the pinned formatter, and the enumerated file set
produce the same result under the two checkout modes available on the current Windows host. CI will
repeat the repository command on Linux, macOS, and Windows.
