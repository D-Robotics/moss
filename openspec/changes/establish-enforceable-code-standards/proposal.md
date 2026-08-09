## Why

Moss already documents important architecture, safety, testing, and style rules, but those rules are split across contributor guides, agent instructions, tool configuration, hooks, and CI. Several written requirements are not actually enforced, so a clean `npm run verify` does not currently prove that the repository follows its declared code standard.

The repository needs one enforceable, cross-platform quality contract before further growth makes formatting drift, stale documentation, oversized modules, and public API changes increasingly expensive to review.

## What Changes

- Define one canonical repository code standard for TypeScript, ESM JavaScript, tests, scripts, documentation, package boundaries, error handling, and public APIs.
- Make formatting deterministic across Linux, macOS, and Windows, and require formatting checks in the same CI gate contributors are told to run.
- Replace the legacy, source-only ESLint setup with a supported flat configuration that covers TypeScript plus repository JavaScript/MJS, with type-aware correctness rules introduced through a controlled baseline.
- Make advertised developer commands, especially `typecheck`, work from a clean checkout without relying on undocumented build artifacts.
- Preserve and extend the existing architecture, OSS-boundary, hygiene, and regression-test checks instead of replacing them with generic style rules.
- Clarify that `MossError` is required at tool, provider, CLI, and public runtime boundaries while native `Error` remains valid for internal invariants and low-level control flow.
- Add machine-reviewable public API reports and TSDoc validation for published package exports.
- Consolidate contributor guidance, remove stale references, and align commit/PR conventions with the repository's existing Conventional Commit practice.
- Introduce maintainability ratchets for new or growing code without requiring an immediate high-risk rewrite of existing large modules.

## Capabilities

### New Capabilities

- `repository-quality-gates`: Defines deterministic formatting, linting, type checking, architecture checks, clean-checkout behavior, contributor documentation, and incremental maintainability requirements that local and CI verification must enforce.
- `public-api-governance`: Defines reviewable API surface reports, TSDoc stability metadata, documentation validation, and CI behavior for the three published packages.

### Modified Capabilities

None. The repository has no existing main specs covering code-quality or public-API governance requirements.

## Impact

- Root tooling and configuration: `package.json`, lockfile, ESLint, Prettier, TypeScript orchestration, line-ending/editor configuration, ignore files, and Git hooks.
- Verification and CI: `npm run verify`, a new fast local quality command, custom hygiene/boundary scripts, and `.github/workflows/ci.yml`.
- Contributor-facing documentation: root and package contribution guides, `AGENTS.md`, PR template, missing or stale policy references, and commit/PR conventions.
- Published packages: generated API reports and TSDoc validation for `@rdk-moss/core`, `@rdk-moss/agent`, and `create-moss-app` where applicable.
- Source and test files: one isolated formatting baseline plus incremental lint/type fixes; no intended runtime API or behavioral break.
- Development dependencies: migration from end-of-life ESLint tooling and addition of API/TSDoc validation tools.
