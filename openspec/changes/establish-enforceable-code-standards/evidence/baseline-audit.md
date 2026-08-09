# Code-standard baseline audit

Date: 2026-08-08

This audit records the repository state before the new quality gates are enabled. Commands were
run from the repository root on Windows with Node.js 22-compatible workspace dependencies already
installed.

## Existing command and tool baseline

- `npm run lint` exits successfully, but the command only evaluates
  `packages/*/src/**/*.ts`. Legacy `.eslintrc.json` explicitly ignores JavaScript and MJS files.
- Installed tooling resolves to ESLint 8.57.1, `@typescript-eslint/eslint-plugin` 7.18.0,
  `@typescript-eslint/parser` 7.18.0, Prettier 3.8.3, and TypeScript 5.9.3.
- The root `verify` script does not invoke `format:check`.
- Package `docs` scripts invoke TypeDoc, but TypeDoc, API Extractor, and TSDoc validation tooling
  are not installed at the workspace root.
- Root type checking depends on declarations in `packages/moss/dist`; it fails from a clean state
  until core has been built.

## Tracked text inventory

| Extension | Tracked files | Files containing CRLF | Files containing bare LF | Mixed files | Missing final newline |
| --- | ---: | ---: | ---: | ---: | ---: |
| `.ts` | 446 | 446 | 0 | 0 | 2 |
| `.mjs` | 289 | 289 | 1 | 1 | 3 |
| `.json` | 42 | 42 | 0 | 0 | 5 |
| `.jsonl` | 3 | 3 | 0 | 0 | 3 |
| `.md` | 180 | 180 | 0 | 0 | 1 |
| `.yaml` | 6 | 6 | 0 | 0 | 0 |
| `.yml` | 4 | 4 | 0 | 0 | 0 |
| `.txt` | 1 | 1 | 0 | 0 | 0 |
| `.sh` | 1 | 1 | 0 | 0 | 0 |

The Windows working tree therefore starts from a CRLF checkout. A one-process Prettier
`--list-different` audit across package source/tests/docs, repository scripts, root metadata, and
GitHub YAML/Markdown found 863 differences: 446 TS, 287 MJS, 94 Markdown, 30 JSON, 4 YML, and 2
YAML files. This is the mechanical formatting baseline, not evidence of 863 behavioral defects.

`packages/create-moss-app/index.mjs` was already reported as modified solely because of working-tree
line endings (`git diff --numstat` reported `0 0`) before implementation began. It must not be
treated as an unrelated behavioral edit.

## Reviewed formatting exclusions

- Generated output: every `dist/`, `coverage/`, and package `docs-api/` directory, generated
  `benchmarks/*-results.json`, and captured `docs/evidence/` data.
- Dependency/cache output: `node_modules/`, `.codegraph/`, and local Moss/session directories already
  excluded by `.gitignore`.
- Bundled domain data: `packages/moss-agent/assets/rdk-knowledge/` (105 tracked files). These are
  synchronized knowledge/skill assets whose content is governed by their source and acceptance
  metadata rather than the repository code formatter.
- Byte-sensitive golden data: `packages/moss-agent/test/e2e/golden/*.jsonl`. Exact serialized bytes
  are test inputs and JSONL is not an approved Prettier surface.
- OpenSpec evidence: `openspec/changes/*/evidence/`, which may contain captured command output.

Test and script MJS files themselves are intentionally included. A fixture is excluded only when
its byte representation is the contract, not merely because it is test data.

## Published entry points

The first rollout governs every currently stable TypeScript export-map entry:

- `@rdk-moss/core`: 9 entries — `.`, six `./contracts/*` entries, and two `./prompts/*` entries.
- `@rdk-moss/agent`: 25 entries — `.`, `./knowledge`, `./extensions`, `./safety`, `./channels`,
  `./prompts`, `./skills`, `./core`, `./goal`, `./utils`, `./context`, `./provider`,
  `./tools/builtin`, `./mesh`, `./observability`, `./mcp`, `./memory`, `./skill-learning`,
  `./teaching`, `./vision`, `./web-browser`, `./structured-output`, `./eval`, `./plan-execute`, and
  `./runtime`.
- `create-moss-app`: no TypeScript export map; the public executable is
  `create-moss-app -> index.mjs` and is governed through CLI contract tests.

## Oversized TypeScript baseline

The selected new-file ceiling is 800 physical source lines. Seventeen existing source files exceed
that limit and require a checked-in ratchet rather than immediate unrelated refactoring:

| Lines | Source file |
| ---: | --- |
| 5,137 | `packages/moss-agent/src/cli/tui.ts` |
| 2,800 | `packages/moss-agent/src/cli/coding-completion-gate.ts` |
| 2,312 | `packages/moss-agent/src/cli/tui-utils.ts` |
| 2,197 | `packages/moss-agent/src/core/agent/moss-agent.ts` |
| 2,010 | `packages/moss-agent/src/tools/web-search.ts` |
| 1,466 | `packages/moss-agent/src/core/loop/agent-loop.ts` |
| 1,465 | `packages/moss-agent/src/cli/config.ts` |
| 1,398 | `packages/moss/src/contracts/host-adapter.ts` |
| 1,396 | `packages/moss-agent/src/cli-main.ts` |
| 1,384 | `packages/moss-agent/src/cli/setup.ts` |
| 1,207 | `packages/moss-agent/src/context/compaction.ts` |
| 1,092 | `packages/moss-agent/src/memory/memory-manager.ts` |
| 1,024 | `packages/moss-agent/src/cli/approval.ts` |
| 940 | `packages/moss-agent/src/cli/output.ts` |
| 859 | `packages/moss-agent/src/tools/web-fetch.ts` |
| 813 | `packages/moss-agent/src/tools/file-tools.ts` |
| 801 | `packages/moss-agent/src/core/session/session-manager.ts` |

The maintainability implementation must compute its own deterministic counts after the formatting
baseline and store those post-format values as the authoritative ceilings.

## Existing generated and fixture paths

- Ignored generated directories observed locally: `packages/moss/dist` and
  `packages/moss-agent/dist`.
- Tracked golden directory: `packages/moss-agent/test/e2e/golden`.
- No tracked `external/` or `vendor/` directory was found.
- Package tests comprise 272 tracked files; they remain in lint coverage even when byte-sensitive
  data files are excluded from formatting.
