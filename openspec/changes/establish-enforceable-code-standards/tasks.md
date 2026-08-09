## 1. Baseline and Decisions

- [x] 1.1 Inventory formatter-sensitive fixtures, generated/vendor paths, tracked text extensions, current lint violations, published export entry points, and oversized TypeScript source files; save the audit summary with the change evidence.
- [x] 1.2 Resolve the design open questions by recording the selected new-file size ceiling, PR-title enforcement mode, and first-rollout API entry-point inventory in `design.md` before enabling gates.
- [x] 1.3 Add focused regression fixtures for cross-platform line endings, stale policy references, reverse package dependencies, and maintainability-baseline growth so each new gate can be proven to fail before its implementation.

## 2. Deterministic Formatting

- [x] 2.1 Add `.gitattributes`, `.editorconfig`, and `.prettierignore` with LF/UTF-8/editor defaults and reviewed exclusions for generated, vendored, evidence, and byte-sensitive fixture paths.
- [x] 2.2 Pin the current compatible Prettier version exactly and change `format`/`format:check` to cover the approved TS, JS/MJS, JSON, Markdown, YAML, and workflow surface.
- [x] 2.3 Apply one formatting-only baseline across the approved surface, confirm it contains no behavioral edits, and document that it must land separately for blame-ignore handling.
- [x] 2.4 Run formatting checks with clean Git worktrees configured for LF and Windows-style checkout behavior and verify that both evaluate the same file set and result.

## 3. Supported Lint Configuration

- [x] 3.1 Upgrade ESLint and typescript-eslint to mutually compatible supported releases, add `@eslint/js`, migrate to `eslint.config.mjs`, and remove the legacy `.eslintrc.json` path.
- [x] 3.2 Add scoped flat-config blocks for TypeScript runtime source, JS/MJS repository scripts, JS/MJS tests, and configuration files with the correct Node/test globals and ignore paths.
- [x] 3.3 Enable selected typed correctness rules for unhandled promises, misused promises, exhaustive switches, and consistent type imports; configure lint to fail on warnings.
- [x] 3.4 Fix or narrowly document typed-lint findings in `@rdk-moss/core` and shared `@rdk-moss/agent` runtime code without changing public behavior.
- [x] 3.5 Fix or narrowly document typed-lint findings in agent CLI, provider, tool, and subsystem code without broad rule disables.
- [x] 3.6 Fix JS/MJS lint findings in repository scripts and package tests, preserving intentional test fixtures through explicit scoped exclusions.
- [x] 3.7 Add a lint regression test or scripted fixture proving that covered MJS files and warnings cause a non-zero result.

## 4. Clean Type Checking and Command Hierarchy

- [x] 4.1 Make root and `@rdk-moss/agent` typecheck commands prepare or resolve core declarations when `packages/moss/dist` is absent, and verify both commands from a clean checkout state.
- [x] 4.2 Add the root `check` command containing format, lint, typecheck, boundaries, hygiene, and maintainability gates in a documented deterministic order.
- [x] 4.3 Refactor `verify` into a strict superset of `check` plus harness benchmark, build, API verification, and all package tests, with non-zero failures propagated.
- [x] 4.4 Change the installed pre-push hook to call `npm run check`, remove its duplicated gate list, and correct its output about typecheck prerequisites.

## 5. Moss-Specific Repository Gates

- [x] 5.1 Extend boundary or hygiene checks to reject reverse workspace dependencies and runtime dependencies in `@rdk-moss/core`, with positive tests for the allowed package direction.
- [x] 5.2 Implement the deterministic source-size ratchet, checked-in legacy baseline, configured new-file ceiling, and reviewed exception format.
- [x] 5.3 Add tests proving that a new oversized file, growth above a legacy ceiling, and stale baseline data fail while a deliberate reduced ceiling passes.
- [x] 5.4 Document the boundary-aware error policy and add focused regression tests that require structured Moss errors at tool/provider/CLI/public runtime boundaries while permitting contained internal native errors.
- [x] 5.5 Extend workspace hygiene to validate local policy-file references and documented npm script names, including the previously stale contributor-guide references.

## 6. Public API Governance

- [x] 6.1 Add pinned local TypeDoc, API Extractor, and TSDoc-lint dependencies and make existing package `docs` scripts run with documented clean-checkout prerequisites.
- [x] 6.2 Configure and check in API Extractor reports for the approved `@rdk-moss/core` entry points, including release-tag and forgotten-export validation.
- [x] 6.3 Configure and check in API Extractor reports plus an entry-point inventory for approved `@rdk-moss/agent` root and subpath exports.
- [x] 6.4 Add TSDoc syntax validation and supply missing or corrected `@public`, `@beta`, or `@internal` metadata and consumer-facing summaries for governed exports.
- [x] 6.5 Add `api:check` to build declarations, compare export manifests and API reports, fail on unreviewed drift, and include the command in `verify`.
- [x] 6.6 Add or update deterministic `create-moss-app` help, argument, generated-project, and bin/export contract tests instead of generating a TypeScript API report for the JavaScript CLI.

## 7. Canonical Policy and CI Alignment

- [x] 7.1 Create the canonical code-standard document covering formatting, naming/imports, typed correctness, package boundaries, error boundaries, tests, documentation, API stability, changelog, and approved Conventional Commit scopes.
- [x] 7.2 Update root and package contributor guides, root and package `AGENTS.md`, and the PR template to link the canonical policy, remove conflicting or missing references, and list the exact `check`/`verify` commands.
- [x] 7.3 Implement the recorded PR-title decision: either add merge-title validation for pull requests or explicitly document deferred enforcement with repository-setting prerequisites.
- [x] 7.4 Update CI so repository scripts are the source of truth, the complete required gate runs on Linux/macOS/Windows as designed, and formatting/API failures are visible as named checks.
- [x] 7.5 Add an Unreleased changelog entry describing contributor-tooling, quality-gate, and API-governance changes without claiming runtime behavior changes.

## 8. End-to-End Verification

- [x] 8.1 From a clean checkout with no package `dist` directories, run dependency installation, `npm run check`, package-level typecheck commands, and documentation commands; capture the successful command evidence.
- [x] 8.2 Run negative fixtures for formatting, MJS lint, typed promise handling, dependency direction, stale documentation, source-size growth, TSDoc, export inventory, and API-report drift and confirm each fails with actionable output.
- [x] 8.3 Run `npm run verify` successfully and confirm it includes every promised quality/API gate plus the existing benchmark, build, typecheck, lint, and all package tests.
- [x] 8.4 Verify the final tracked diff contains no generated `dist`, documentation output, credentials, or unrelated runtime changes and is partitionable into mechanical formatting, tooling, and policy review units.
