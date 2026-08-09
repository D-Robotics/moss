## Context

Moss is a TypeScript/ESM npm-workspaces monorepo that publishes three packages and supports Linux, macOS, and Windows. It already has strict TypeScript settings, extensive build-artifact tests, three-platform CI, custom OSS-boundary and workspace-hygiene checks, contributor guides, and agent-specific invariants.

The current controls do not form a single reliable contract. `npm run verify` omits `format:check`; formatting differs in most TypeScript source files; ESLint 8 only covers package `src/**/*.ts`; tracked tests and scripts are primarily MJS; clean-checkout type checking depends on prebuilt core declarations; TypeDoc scripts have no installed tool; and contributor documents contain stale or conflicting requirements. The repository also contains legacy modules above 1,000 lines, so globally enabling strict size or complexity limits would either fail immediately or trigger risky unrelated refactors.

The stakeholders are maintainers reviewing high-churn runtime code, external contributors using the documented commands, release owners protecting semver contracts, and coding agents consuming `AGENTS.md`.

## Goals / Non-Goals

**Goals:**

- Make the documented local quality command and CI gate prove the same enforceable rules.
- Produce deterministic results from a clean checkout on every supported operating system.
- Cover TypeScript source, MJS tests and scripts, repository metadata, and documentation with appropriate tools and scoped overrides.
- Detect asynchronous correctness bugs, dependency-direction violations, public API drift, invalid TSDoc, and stale contributor guidance before merge.
- Preserve the repository's existing architecture, security, behavioral tests, and public API stability rules.
- Introduce formatting and maintainability baselines without mixing mechanical churn with behavioral changes.

**Non-Goals:**

- Rewriting existing large modules solely to satisfy new metrics.
- Changing runtime behavior, package APIs, the test runner, or the package dependency direction.
- Enforcing one error class for every internal exception.
- Replacing Prettier with stylistic ESLint rules or adopting an unrelated general-purpose style guide wholesale.
- Requiring every temporary contributor commit to follow release-quality commit syntax when PRs are squash merged.

## Decisions

### 1. Establish one command hierarchy

Add a fast root `check` command that runs formatting verification, lint, clean-checkout type checking, architecture/boundary checks, workspace hygiene, and the maintainability ratchet. Keep `verify` as the complete superset that additionally runs the harness benchmark, build, API checks, and tests. The pre-push hook calls `npm run check` rather than duplicating its individual steps, and CI invokes repository scripts rather than reimplementing rules in YAML.

This preserves the existing `verify` contract while giving contributors a faster feedback loop. A separate undocumented CI-only rule set was rejected because it recreates the current documentation drift.

### 2. Normalize text before enforcing Prettier

Add `.gitattributes` with LF as the canonical working-tree line ending for text, `.editorconfig` for editor-level UTF-8/indent/newline behavior, and `.prettierignore` for generated artifacts, vendored data, and fixtures whose byte representation is part of a test. Pin the Prettier version exactly and expand formatting coverage to supported tracked text formats, including TS, JS/MJS, JSON, Markdown, YAML, and GitHub workflow files.

Apply the initial formatting result as an isolated mechanical baseline before behavioral or lint fixes. Keeping the current narrow source-only glob was rejected because most tests, scripts, and contributor documents would remain outside the standard.

### 3. Migrate to supported ESLint flat configuration with scoped typed rules

Replace `.eslintrc.json` and the end-of-life ESLint 8/typeScript-eslint 7 pair with compatible supported releases using `eslint.config.mjs`. Configure distinct file groups for TypeScript runtime source, JS/MJS scripts and tests, and tool configuration. Use core and typescript-eslint recommended correctness rules, then enable selected type-aware rules with high defect-detection value: unhandled or misused promises, exhaustive switches, and consistent type-only imports. Lint exits non-zero for warnings.

The implementation first audits violations, fixes genuine defects, and uses narrow documented suppressions for intentional fire-and-forget or forward-compatible switch behavior. Enabling every strict or stylistic typed rule at once was rejected because it would create a large low-signal migration and overlap with Prettier.

### 4. Make type checking explicitly prepare workspace dependencies

The root and package-level typecheck commands must resolve `@rdk-moss/core` from a clean checkout. The initial implementation will explicitly prepare core declarations before checking dependent workspaces and will update command descriptions and hook messages to acknowledge that preparation. This is a low-risk correction compatible with current package exports.

TypeScript project references or source-path aliases remain a possible later optimization. They are not selected for this change because they alter module-resolution behavior and could make development type resolution diverge from the published package contract.

### 5. Preserve specialized gates and add dependency-direction enforcement

Keep `check:boundaries`, `check:hygiene`, and the harness benchmark. Add explicit import/dependency rules for the allowed direction `create-moss-app -> @rdk-moss/agent -> @rdk-moss/core`, including the requirement that core retain zero runtime dependencies. Generic lint presets do not replace these Moss-specific invariants.

### 6. Treat error policy as a boundary contract

Require structured `MossError`/`wrapAsMoss` behavior for failures that cross tool, provider, CLI, or public runtime boundaries. Permit native `Error` for internal invariants, cancellation reasons, low-level adapters, and errors that are converted before crossing a boundary. Enforce the externally observable result through focused regression tests and use static restrictions only in the small set of files that construct boundary responses.

A repository-wide ban on `new Error()` was rejected because the current source uses native errors for legitimate internal control flow and such a ban would obscure rather than improve the public error contract.

### 7. Govern public APIs with reports and TSDoc validation

Add TSDoc syntax validation and API Extractor reports for the TypeScript library packages and their stable entry points. Check generated reports into version control; CI generates temporary reports and fails on drift rather than modifying the branch. Existing export-snapshot tests remain and verify that every package export is accounted for. The JavaScript-only `create-moss-app` CLI is governed by help/behavior snapshots and changelog requirements rather than a synthetic TypeScript API report.

API reports were selected over relying only on generated HTML documentation because concise signature diffs are reviewable in PRs and expose missing release tags. TypeDoc remains available for human-facing reference generation after its dependency and scripts are repaired.

### 8. Use a checked-in maintainability ratchet for legacy hotspots

Add a small deterministic check with a reviewed baseline for legacy oversized source files. New source files must stay below the configured limit, and a legacy file above the limit may not grow beyond its recorded ceiling unless an explicit, reviewed exception explains why. When a legacy file shrinks, the lower size becomes the new ceiling. Version one measures source-file length; more complex AST metrics can be proposed later after the first gate is stable.

Immediate global `max-lines` enforcement was rejected because it would force unrelated rewrites of high-churn runtime files. No size check at all was rejected because several modules already exceed 1,000 lines and continue to concentrate review risk.

### 9. Consolidate human and agent guidance

Create one canonical code-standard document. Root and package contribution guides link to it for shared rules and keep only package-specific additions. `AGENTS.md` keeps agent-specific architecture and execution invariants while linking to the same standard. Hygiene checks validate referenced files and the PR template names the exact commands CI uses. Use Conventional Commit syntax for merge/PR titles with a documented scope vocabulary; local work-in-progress commits are not gated.

## Risks / Trade-offs

- **Large initial formatting diff** -> Land it as an isolated mechanical change, record the commit for blame-ignore support, and make no behavioral edits in that commit.
- **Typed lint reveals many existing defects** -> Audit first, enable only selected high-value rules, split fixes by subsystem, and require narrow explanations for suppressions.
- **Cross-platform newline regressions** -> Normalize through `.gitattributes`, verify on all three CI operating systems, and exclude byte-sensitive fixtures explicitly.
- **Longer local checks** -> Keep `check` free of full builds/tests except the minimal core declaration preparation required for type resolution; retain filtered package tests for iteration.
- **API Extractor configuration misses subpath exports** -> Compare package export manifests with an explicit checked-in entry-point inventory and retain export snapshot tests.
- **Maintainability thresholds encourage artificial file splitting** -> Treat the ratchet as a review signal with documented exceptions, not a target to game; keep behavior and ownership boundaries primary.
- **Tool upgrades cause unrelated changes** -> Upgrade lint dependencies and configuration in a dedicated step, pin tool versions, and run the existing full three-platform verification before enabling the new gate.

## Migration Plan

1. Add canonical contributor documentation, newline/editor settings, Prettier ignore rules, and an exact formatter version.
2. Generate and review one formatting-only baseline; record it for blame-ignore use.
3. Migrate ESLint configuration and broaden file coverage, fixing or narrowly suppressing the resulting violations until lint is clean.
4. Repair clean-checkout type checking and make the pre-push hook delegate to `npm run check`.
5. Add dependency-direction and maintainability checks, then include all fast checks in `check` and `verify`.
6. Add TSDoc validation, API reports, export coverage, and working documentation scripts.
7. Align CI, PR templates, and contributor guides; run the complete three-platform gate.

Rollback is performed by reverting the relevant tooling step. The formatting baseline must be reverted as a whole rather than partially. Runtime source behavior and published API signatures are not intentionally changed, so no data or user migration is required.

## Resolved Rollout Decisions

- **New TypeScript source-file ceiling: 800 physical lines.** The baseline contains 17 legacy files
  above 800 lines. A 600-line ceiling would encourage arbitrary splitting during ordinary feature
  work, while 800 lines still blocks new hotspot-scale modules and supports an incremental ratchet.
- **PR-title enforcement: required CI validation on pull requests.** The gate validates the final PR
  title using Conventional Commit syntax and the documented Moss scopes. It does not inspect or
  reject contributors' work-in-progress commits. Repository maintainers must mark the named check
  required in branch protection when deploying the workflow.
- **Initial API inventory: every current stable export-map entry.** The first rollout governs all 9
  `@rdk-moss/core` entries and all 25 `@rdk-moss/agent` entries. `create-moss-app` is governed by its
  executable/help/argument/generated-project contract tests because it does not publish TypeScript
  declarations. New stable subpaths cannot be deferred silently; they require a report or an
  explicit reviewed non-governed classification.
