## ADDED Requirements

### Requirement: Canonical quality command hierarchy

The repository SHALL provide a root `npm run check` command for fast, non-behavioral quality gates and a root `npm run verify` command that is a strict superset including build and behavioral tests. CI and Git hooks MUST invoke these repository commands instead of maintaining duplicate rule lists.

#### Scenario: Contributor runs the fast gate

- **WHEN** dependencies are installed in a clean checkout and the contributor runs `npm run check`
- **THEN** formatting, linting, type checking, repository boundaries, workspace hygiene, and maintainability checks run without requiring undocumented pre-existing artifacts

#### Scenario: Complete verification is requested

- **WHEN** a contributor or CI runs `npm run verify`
- **THEN** every fast quality gate plus the benchmark, build, public API checks, and package tests runs and any failing constituent returns a non-zero exit code

### Requirement: Deterministic cross-platform formatting

The repository SHALL define one pinned Prettier version, canonical LF text normalization, editor defaults, and explicit ignore rules. Formatting verification MUST cover supported tracked TypeScript, JavaScript/MJS, JSON, Markdown, YAML, and workflow files except generated, vendored, or byte-sensitive fixtures named in the ignore policy.

#### Scenario: Formatting is checked on supported operating systems

- **WHEN** the same commit is checked out and `npm run format:check` is run on Linux, macOS, and Windows
- **THEN** each operating system evaluates the same files with the same formatter version and produces the same pass or fail result

#### Scenario: A contributor introduces an unformatted file

- **WHEN** a covered tracked file does not match the configured formatter output
- **THEN** `npm run check` and `npm run verify` fail and report the file

### Requirement: Lint coverage and typed correctness

The repository SHALL use a supported ESLint flat configuration that covers TypeScript runtime source and repository JavaScript/MJS scripts and tests with scoped environments. TypeScript runtime source MUST be checked for unhandled promises, misused promises, non-exhaustive union or enum switches, and inconsistent type-only imports. Lint warnings MUST cause a non-zero gate result.

#### Scenario: MJS test or script contains a lint violation

- **WHEN** a tracked MJS test or repository script violates its configured correctness rules
- **THEN** `npm run lint` identifies the file and the quality gate fails

#### Scenario: Promise result is unintentionally ignored

- **WHEN** TypeScript runtime code creates a promise without awaiting, returning, explicitly voiding, or otherwise handling it
- **THEN** typed lint reports the violation before merge

#### Scenario: An intentional exception is needed

- **WHEN** code intentionally uses fire-and-forget execution or forward-compatible switch fallback behavior
- **THEN** the code uses the configured explicit form or a narrow suppression with a reason rather than disabling the rule for the repository

### Requirement: Clean-checkout type checking

Root and package typecheck commands SHALL resolve workspace dependencies from a clean checkout after dependency installation. Any prerequisite declaration preparation MUST be part of the command and MUST be described accurately in contributor and hook output.

#### Scenario: Core declarations do not exist

- **WHEN** `packages/moss/dist` is absent and the contributor runs the documented root typecheck command
- **THEN** the command prepares or resolves core types automatically and checks all TypeScript workspaces successfully when the source is valid

### Requirement: Moss package and OSS boundaries

Automated gates SHALL preserve the dependency direction `create-moss-app -> @rdk-moss/agent -> @rdk-moss/core`, require core to have zero runtime dependencies, reject host-path imports and tracked build output, and retain existing credential, package-engine, test-script, and Markdown-link checks.

#### Scenario: Reverse package dependency is introduced

- **WHEN** core imports agent or agent imports create-moss-app
- **THEN** the quality gate fails with the importing file and violated dependency direction

#### Scenario: Existing boundary invariant regresses

- **WHEN** a change introduces a forbidden host import, credential-shaped text, inconsistent engine constraint, missing test script, broken repository Markdown link, or tracked `dist` output
- **THEN** the existing specialized gate remains authoritative and fails verification

### Requirement: Boundary-aware error handling

Failures crossing tool, provider, CLI, or public runtime boundaries SHALL expose the repository's structured Moss error contract. Native errors MAY be used for internal invariants, cancellation, or low-level control flow only when they are converted or contained before crossing a governed boundary.

#### Scenario: Tool execution fails

- **WHEN** a built-in tool encounters an operational failure that is returned to a host or user
- **THEN** the failure carries a stable Moss error code, message, and applicable recovery hint rather than an unclassified native error

#### Scenario: Internal invariant throws a native error

- **WHEN** an internal helper throws a native error that never crosses a governed boundary
- **THEN** the quality policy permits it and the receiving boundary converts it if propagation becomes user-visible

### Requirement: Canonical contributor policy

The repository SHALL maintain one canonical code-standard document linked from root and package contributor guides, `AGENTS.md`, and the PR template. Referenced policy files and commands MUST exist, and shared rules MUST NOT conflict across those documents.

#### Scenario: Contributor follows repository guidance

- **WHEN** a contributor opens the root guide or a package guide
- **THEN** the guide links to the canonical standard, lists only valid commands, and distinguishes shared rules from package-specific additions

#### Scenario: Policy reference becomes stale

- **WHEN** a contributor document or PR checklist references a missing local policy file or nonexistent script
- **THEN** workspace hygiene fails with the stale reference

### Requirement: Incremental maintainability ratchet

The repository SHALL enforce a checked-in, reviewable baseline for legacy oversized source files. New files MUST satisfy the configured size ceiling, legacy files MUST NOT exceed their recorded ceiling without an explicit reviewed exception, and reductions MUST be retained as the new ceiling.

#### Scenario: Legacy hotspot grows

- **WHEN** a source file already above the configured limit gains lines beyond its recorded baseline without an exception
- **THEN** the maintainability gate fails and reports the previous and new size

#### Scenario: Legacy hotspot shrinks

- **WHEN** a baseline source file is reduced and the baseline is intentionally updated
- **THEN** subsequent checks use the lower recorded ceiling and prevent regression

#### Scenario: New source file is oversized

- **WHEN** a newly tracked source file exceeds the configured maximum
- **THEN** the maintainability gate fails unless a reviewed exception documents the ownership boundary that requires the size

### Requirement: Merge-title convention

The repository SHALL document Conventional Commit syntax and the accepted Moss scopes for merge or PR titles. If title validation is enabled as a required gate, it MUST apply to the final merge title and MUST NOT require external contributors to rewrite every work-in-progress commit.

#### Scenario: Squash merge title is prepared

- **WHEN** a PR is ready to merge using squash semantics
- **THEN** its final title communicates change type, optional Moss scope, and breaking-change intent in Conventional Commit form
