# Contributing to Moss

Thanks for your interest in Moss — a vendor-neutral, **robotics-first** terminal agent and embeddable agent runtime made by [D-Robotics (地瓜机器人)](https://developer.d-robotics.cc). This guide gets you from clone to merged PR.

> 中文贡献者：欢迎用中文提 issue / PR 描述。代码与公开 API 注释请用英文，便于国际社区维护。

## What Moss is (and isn't)

Moss's north star is a **robot-grade, host-neutral runtime**: hosts own UI, model keys, credentials, storage, and deployment policy; Moss owns the runtime core. The strongest contributions deepen the robotics/edge-device line — RDK boards, ROS2, device diagnostics, on-device sessions, teaching. General coding ability is supporting scaffolding, not the headline.

Before proposing a feature, check it against the scope rules in `CLAUDE.md` (Scope Guard). Anything that hard-codes a robot family or vendor workflow into the core packages belongs in a **host adapter, knowledge module, or platform extension** instead — not Moss core.

## Project layout

A TypeScript, ESM, npm-workspaces monorepo (Node **>= 22.16.0**):

| Package                    | npm name          | Purpose                                                                                                         |
| -------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/moss`            | `@rdk-moss/core`  | Core contracts: KnowledgeModule, PlatformExtension, VendorPlugin, Host Adapter, robotics prompts                |
| `packages/moss-agent`      | `@rdk-moss/agent` | Standalone agent runtime + `moss` CLI (includes memory, skills, skill-learning, teaching, mesh, mcp subsystems) |
| `packages/create-moss-app` | `create-moss-app` | Scaffolding CLI                                                                                                 |

The memory / skills / skill-learning / teaching / mesh subsystems live inside `packages/moss-agent` (exposed via subpath exports like `./memory`, `./teaching`), not as separate packages.

## Development setup

```bash
git clone https://github.com/D-Robotics/moss.git
cd moss
npm install          # installs all workspaces
npm run build        # clean + build everything
```

## Commands

```bash
npm run build                    # build all workspaces
npm run typecheck                # type-check all workspaces
npm run test                     # all package tests
npm run test -w @rdk-moss/core   # a single package
npm run lint / npm run lint:fix
npm run verify                   # boundaries + hygiene + build + typecheck + lint + test
```

**Run `npm run verify` before opening a PR.** It is the same gate CI enforces.

## Tests

Tests are `*.spec.mjs` files under each package's `test/`, run by `scripts/run-package-tests.mjs`. We value test-first development for bugfixes: write a test that fails before your fix and passes after. Strictness lives in the root `tsconfig.base.json` — don't copy compiler options into a package `tsconfig`.

## Boundaries & invariants

Enforced by `npm run verify` (`check:boundaries` + `check:hygiene`). If a check fails, **fix the content, never weaken the check**:

- Public packages must not import host paths (`server/`, `electron/`, `config/`).
- No real credentials, API keys, internal IPs, or personal identifiers — anywhere, including comments, tests, and docs.
- `engines.node` in every package must equal the root.
- Every package must have a `test` script.

## API stability

All three packages publish publicly, so the public surface is a contract. Mark new exports with a TSDoc stability tag:

- `@public` — supported, semver-protected.
- `@beta` — public but may change before stabilizing.
- `@internal` — not semver-protected; may change in any release.

The Host Adapter contract (`@rdk-moss/core/contracts/host-adapter`) is versioned — changing its manifest shape or compatibility behavior requires a contract-version review (see [`docs/host-adapter-contract.md`](docs/host-adapter-contract.md)).

## Code style

**Formatting.** Prettier 3 (`npm run format`) and ESLint 8 (`npm run lint`) are both enforced by CI. Let Prettier own all whitespace decisions.

**Naming.** TypeScript: `PascalCase` for interfaces and classes, `UPPER_SNAKE_CASE` for module-level constants, `camelCase` for private fields. File names: `kebab-case.ts`. Prefix unused destructure bindings with `_`.

**Imports.** Order: Node.js built-ins → third-party → internal → type-only. Within each group, alphabetical. Use `import type` for imports only referenced in type positions.

**Error handling.** Use `throwMoss({ code: ErrorCode.X, message, hint })` (from `errors.ts`) instead of bare `new Error()`. Choose the closest `ErrorCode`: `USER_INPUT_INVALID` for bad config/CLI input, `PROVIDER_AUTH_FAILED` for auth failures, `INTERNAL_INVARIANT_VIOLATED` for true bugs.

**Logging.** Use `ctx.say(level, message)` inside session code. Use `console.warn` only for startup diagnostics before a `ctx` is available. Never use `console.log` in library paths.

**Comments.** Write them only when the _why_ is non-obvious. One line max.

## CHANGELOG

Every change that affects the published packages must have a corresponding entry in [`CHANGELOG.md`](CHANGELOG.md):

- Add entries under `## [Unreleased]` at the top.
- Use categories: `Added`, `Changed`, `Fixed`, `Removed`, `Internal`.
- One bullet per logical change.
- Sessions and parallel contributors should append, not rewrite, existing entries.

## Commit & PR

- Branch off `main`; keep PRs focused.
- Write clear commit messages (imperative mood: "Fix streaming tail truncation").
- Link the issue your PR addresses (`Fixes #123`).
- Fill in the PR template checklist and confirm `npm run verify` is green.

## Where to start

- Browse issues labelled [`good first issue`](https://github.com/D-Robotics/moss/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
- Read `CLAUDE.md` for the working rules, architecture-review discipline, and bug-fix checklists.
- Questions? Open a [Discussion](https://github.com/D-Robotics/moss/discussions) or an issue.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
