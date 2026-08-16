# Moss Code Standards

This document is the canonical, enforceable code standard for the Moss repository. Contributor guides
and agent instructions may add package-specific navigation, but they must not redefine these shared
rules. When prose and an automated gate disagree, fix the inconsistency in the same change; do not
silently weaken the gate.

## What the standard protects

The standard answers six practical questions for every contribution:

1. **What should the code look like?** Formatting, names, imports, and line endings are deterministic.
2. **Is the code safe and correct?** TypeScript and ESLint catch common type, promise, switch, and error
   handling mistakes.
3. **Where does the code belong?** Package and host boundaries preserve the architecture.
4. **Was the change verified?** Focused regression tests and repository gates provide evidence.
5. **Can the public API change?** Stability metadata, export inventories, API reports, documentation,
   changelog entries, and migration notes govern published contracts.
6. **Will the code remain maintainable?** New files have a size ceiling and legacy hotspots may only
   shrink unless a reviewed exception is recorded.

## Canonical command hierarchy

Run commands from the repository root unless a package guide explicitly says otherwise.

| Command             | Contract                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format`    | Apply the pinned formatter to the approved tracked text surface.                                                                                                     |
| `npm run check`     | Fast required gate: formatting, lint, typecheck, package boundaries, workspace hygiene, vendored-source provenance, maintainability, and standards regression tests. |
| `npm run api:check` | Build declarations, verify the public entry-point inventory, and compare every API Extractor report.                                                                 |
| `npm run docs`      | Generate TypeDoc output for both TypeScript packages; dependent core declarations are prepared automatically.                                                        |
| `npm run verify`    | Complete gate: all of `check`, the harness benchmark, build, API verification, warning-clean TypeDoc generation, and all package tests.                              |

`npm run check` and package-level agent type checking work when `packages/moss/dist` is absent; their
lifecycle scripts prepare the required core declarations. The pre-push hook calls only `npm run check`.
CI calls repository scripts rather than maintaining another list of rules in workflow YAML.

Before opening or merging a pull request, `npm run verify` must pass. Use focused tests while iterating,
but do not substitute them for the final gate.

## Formatting, files, naming, and imports

- All repository text uses UTF-8 and LF. `.gitattributes` is authoritative across operating systems;
  `.editorconfig` supplies matching editor defaults.
- Prettier owns whitespace, indentation, quotes, wrapping, and supported Markdown/YAML/JSON layout.
  Do not hand-format against it. Generated, vendored, evidence, and byte-sensitive paths are listed in
  `.prettierignore` and require explicit review before exclusions change.
- TypeScript, JavaScript, and MJS source files use `kebab-case` file names. Tests use the module name plus
  `.spec.mjs`; repository gate tests use `.test.mjs`.
- Use `PascalCase` for classes, interfaces, types, and enums; `camelCase` for functions, variables, and
  fields; and `UPPER_SNAKE_CASE` only for true module constants.
- Prefer descriptive domain names. Avoid generic `data`, `manager`, or `utils` names when a narrower
  concept exists.
- Import order is Node built-ins, third-party packages, workspace/internal modules, then local modules,
  with a blank line between logical groups. Use `node:` specifiers and `.js` extensions for ESM imports.
- Use `import type` when an import is used only in type positions. Do not introduce circular imports or
  reach through another package's private source path.
- Prefix deliberately unused callback parameters with `_`. Remove unused declarations instead of
  accumulating suppressions.

## TypeScript and lint correctness

The repository uses ESLint flat config with zero allowed warnings. It covers runtime TypeScript,
repository and package MJS scripts, tests, and configuration files.

- Do not ignore a Promise accidentally. Await it, return it, or explicitly use `void` only when the
  rejection is handled and detachment is intentional.
- Do not pass async callbacks where the caller cannot observe their Promise. Wrap them and handle the
  resulting rejection.
- Handle every discriminated-union case. An intentional ignored case must be explicit; a `default` branch
  must not hide a newly introduced variant.
- Preserve strict types at public and subsystem boundaries. Avoid `any`; narrow `unknown` before use.
- Keep type-only imports consistent and do not use broad file- or rule-level ESLint disables. A narrowly
  scoped exception must explain the exact fixture or compatibility reason.
- TSDoc syntax is linted. Fix malformed tags, code spans, links, `@param` forms, and deprecation messages
  rather than disabling the rule.

## Architecture and dependency direction

The package direction is an existing Moss architecture rule that is now enforced automatically:

```text
create-moss-app -> @rdk-moss/agent -> @rdk-moss/core
```

- `@rdk-moss/core` has zero runtime dependencies and cannot import agent or create-app code.
- `@rdk-moss/agent` may depend on core, but cannot import create-app.
- `create-moss-app` may consume the published contracts of agent and core.
- Public packages must not import host implementation paths such as `server/`, `electron/`, or host
  `config/`, and must not depend on product-owned storage, credentials, or UI state.
- Hardware/vendor facts belong in knowledge modules, platform extensions, or host adapters. Keep shared
  contracts and runtime behavior host-neutral.
- Build output such as `dist/` and generated TypeDoc output must not be committed.

The `check:boundaries` gate reports the importing file and violated direction. Fix the placement or
abstraction instead of adding an allowlist for convenience.

## Error boundaries

Follow the detailed [Moss error boundary policy](./error-boundary-policy.md).

Native JavaScript errors are permitted for contained internal invariants, low-level adapters, parsing,
and cancellation. Before a failure crosses a tool, provider, CLI, or public runtime boundary, convert it
to a `MossError` with the closest `ErrorCode`, retain the original cause, and add safe actionable context.
Tests must assert the structured code and important metadata, not only human-readable wording.

Do not include credentials, full request bodies, environment dumps, or personal data in messages,
contexts, logs, fixtures, comments, or documentation.

## Tests and verification evidence

- A bug fix requires a regression test that fails before the fix and passes after it.
- Tests under packages are `*.spec.mjs`, import built `dist/`, and are run by
  `scripts/run-package-tests.mjs`. Package test scripts remain build-first.
- After one agent build, focus iteration with
  `npm run test:filter -w @rdk-moss/agent -- --filter <module-name>`. A filter that matches no tests is a
  failure.
- Prefer named `node:test` cases and assert externally observable outcomes. Avoid tests that merely
  restate implementation details.
- Cover Windows path/module behavior when touching processes, paths, dynamic imports, line endings, or
  shell commands. Convert filesystem paths with `pathToFileURL(...).href` before dynamic ESM import.
- Security fixes require negative cases for the complete bypass chain, including alternative separators,
  normalization, indirection, and encoding where applicable.
- Do not claim success until the command or behavioral result has actually been observed.

## Maintainability ratchet

New TypeScript source files under the governed package source roots may contain at most **800 physical
lines**. The checked-in baseline at `scripts/config/maintainability-baseline.json` records legacy files
that were already larger when the gate was adopted.

- A legacy file may not exceed its recorded `maxLines`.
- When a legacy file shrinks, lower its baseline in the same change; stale higher ceilings fail.
- Prefer extracting cohesive modules over extending a hotspot.
- A genuine ownership-boundary exception must be added under `exceptions` with `maxLines`, a responsible
  `owner`, and a concrete `reason`. The exception is a reviewed policy change, not an automatic escape.
- Missing files, duplicate baseline/exception entries, malformed exceptions, and stale ceilings fail the
  gate.

## Public API and documentation governance

The TypeScript packages are governed by the entry-point inventory in
`scripts/config/api-entrypoints.json` and checked-in API Extractor reports under each package's `etc/`
folder. `create-moss-app` is a JavaScript CLI and is governed by deterministic help, argument, generated
project, package-files, and bin contract tests.

For a public API change:

1. Add a consumer-facing TSDoc summary and an explicit `@public`, `@beta`, or `@internal` release tag.
2. Export the symbol from an approved root or subpath entry point. New subpaths must also be added to the
   inventory and package manifest.
3. Run `npm run api:update`, review the report diff, and commit the intentional report change. Normal
   verification uses `npm run api:check` and never updates reports.
4. Update relevant README/API documentation and run `npm run docs` from a clean checkout. The command
   prepares core declarations automatically; generated `docs-api/` output is review evidence, not a
   committed artifact. Historical intentionally unexported references are recorded explicitly; every
   new documentation warning fails verification.
5. Add an `Unreleased` changelog entry. For a breaking change, add `!` to the merge title, describe the
   migration, and obtain a major-version/contract review. Host Adapter contract changes also require a
   contract-version review.

Forgotten-export and release-tag warnings are visible in the initial checked reports. A new or removed
warning changes the report and therefore requires explicit API review; do not refresh a report merely to
make CI green.

## Changelog and commits

Update root and affected package changelogs when behavior, contributor workflow, public API, project
structure, or release contents change. Add entries under `## [Unreleased]` using `Added`, `Changed`,
`Fixed`, `Removed`, or `Internal`. Do not claim a runtime behavior change for tooling-only work.

Pull request titles use Conventional Commit syntax:

```text
type(scope): concise imperative summary
type(scope)!: concise breaking-change summary
```

Allowed types are `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`, and
`security`. The scope is optional; approved scopes are `core`, `agent`, `cli`, `provider`, `tools`,
`context`, `memory`, `skills`, `teaching`, `mesh`, `mcp`, `observability`, `create-moss-app`, `docs`, `ci`,
`deps`, and `release`. Work-in-progress commits are not gated; the PR title used for squash merging is.

For a coordinated npm release, run `npm run release:rdk-moss -- <version> --prepare`, review and
commit the three package manifests, lockfile, and scaffold fallback, then push that commit to `main`.
Run the local command without `--publish` for a dry-run. Official registry writes run only through the
fixed `Publish Moss npm release set` workflow dispatched on that `main` commit. Its repository-wide
`moss-npm-release` concurrency group never cancels an in-flight publisher, and the release script
fail-closes unless repository, workflow path, ref, event, source SHA, run identity, and workflow-scoped
`NPM_TOKEN` all match. Do not run or document local `--publish` as a supported release path: npm dist-tags
have no transaction ID or compare-and-swap, so separate clones cannot safely compensate one another.
The workflow's `publish` mode reads every previous target tag and uploads a conservative, source-bound
recovery journal before any registry mutation; promotion refuses to start if current tags no longer match
that journal. It also records the source SHA plus all tarball integrities under `artifacts/`. After an
unsuccessful publish, use the same workflow's `recover` mode with the exact failed run ID and attempt. The
workflow verifies that attempt through the attempt-specific GitHub API, downloads its immutable journal,
and fail-closes on any source, run, schema, registry, package-set, version, tag, or ownership mismatch. The
workflow reattaches the dispatched SHA as local `main`; the existing provenance gate then requires that
attached HEAD to equal both `GITHUB_SHA` and live official `main`. Recovery treats a complete formal tag set
at the journal version as committed, rolls back only a partial set, and clears the durable journal only after
version-owned staging tags have been removed and verified.

## Pull request checklist

- The change is in the correct package and preserves dependency direction.
- Formatting, lint, typed correctness, TSDoc, and warnings are clean.
- A focused regression test covers the change and `npm run verify` passes.
- Public API reports, docs, changelogs, stability tags, and migration notes are updated when applicable.
- New files respect the maintainability ceiling; reduced legacy ceilings are retained.
- No generated artifacts, host implementation imports, credentials, or unrelated changes are included.
- The PR title uses an allowed Conventional Commit type and scope.
