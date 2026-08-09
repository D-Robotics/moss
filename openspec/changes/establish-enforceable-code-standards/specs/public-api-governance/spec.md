## ADDED Requirements

### Requirement: Reviewable TypeScript API reports

Each published TypeScript library package SHALL have checked-in API Extractor reports for every governed stable entry point. CI MUST generate reports from current declaration output and fail when the generated public surface differs from the checked-in report.

#### Scenario: Public signature changes

- **WHEN** a pull request adds, removes, or changes a governed exported declaration
- **THEN** API verification fails until the corresponding report is intentionally updated and included for review

#### Scenario: Implementation changes without API drift

- **WHEN** internal implementation changes do not alter governed declarations or release tags
- **THEN** generated API reports remain unchanged

### Requirement: Complete export entry-point inventory

Published package export maps SHALL be compared with a checked-in governed entry-point inventory or equivalent export snapshot. Every new stable subpath MUST have an API-governance disposition before verification passes.

#### Scenario: Stable subpath is added

- **WHEN** a package adds a new stable `exports` entry
- **THEN** verification fails until the entry point is included in API reporting and consumer documentation or explicitly classified as non-governed with a reviewed reason

#### Scenario: Export map and implementation diverge

- **WHEN** a declared subpath lacks a matching built entry point or a stable barrel export is omitted from the inventory
- **THEN** export and API verification fails with the missing path

### Requirement: Valid TSDoc stability metadata

Governed exported declarations SHALL use valid TSDoc syntax and exactly one applicable stability classification from `@public`, `@beta`, or `@internal`. Public and beta declarations MUST include consumer-meaningful documentation for their contract.

#### Scenario: Export lacks a stability tag

- **WHEN** a governed declaration is exported without a release tag
- **THEN** TSDoc or API verification fails and identifies the declaration

#### Scenario: TSDoc syntax is malformed

- **WHEN** a doc comment contains an invalid tag, malformed link, or incompatible release classification
- **THEN** lint or API verification fails before documentation generation

### Requirement: Reproducible API documentation commands

Every declared documentation script SHALL have its required tool installed in the workspace and SHALL run from a clean dependency installation using documented prerequisites. CI SHALL exercise API validation even when human-facing HTML or Markdown documentation is not published.

#### Scenario: Maintainer runs package documentation

- **WHEN** dependencies are installed and the maintainer runs a package's documented `npm run docs` command with its stated prerequisites
- **THEN** the command invokes the pinned local documentation tool and produces output without relying on an uninstalled global executable

### Requirement: Semver and changelog review for API changes

An intentional governed API report change SHALL require explicit review of release classification, semver impact, consumer documentation, and the package or root Unreleased changelog entry. Breaking changes MUST be identified as breaking in the review record.

#### Scenario: Public declaration is removed or incompatibly changed

- **WHEN** an API report shows a breaking public contract change
- **THEN** the PR records the required major-version decision, migration guidance, and changelog entry before merge

#### Scenario: Beta API changes

- **WHEN** a beta declaration changes incompatibly
- **THEN** the report exposes the change and the PR documents the beta compatibility decision without incorrectly treating the declaration as stable public API

### Requirement: JavaScript CLI contract governance

Published JavaScript-only CLI packages that do not emit TypeScript declarations SHALL govern their public contract through deterministic help/argument snapshots, behavioral smoke tests, package export/bin checks, and changelog review rather than fabricated API reports.

#### Scenario: create-moss-app CLI option changes

- **WHEN** a public `create-moss-app` flag, help entry, generated project contract, or executable mapping changes
- **THEN** the relevant snapshot or behavioral test and changelog must be updated for verification to pass
