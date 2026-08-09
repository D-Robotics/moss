<!-- Thanks for contributing to Moss! Keep PRs focused. -->

Read the canonical [Moss Code Standards](../docs/code-standards.md). Use an approved Conventional Commit
PR title; CI validates the title used for squash merging.

## What & why

<!-- What does this change and why? Link the issue it addresses. -->

Fixes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Docs / infra
- [ ] Refactor (no behavior change)

## Checklist

- [ ] `npm run check` is green (format + lint/TSDoc + typecheck + boundaries + hygiene + maintainability)
- [ ] `npm run verify` is green (strict superset: benchmark + build + API reports + all package tests)
- [ ] Added/updated tests (a test that fails before the fix and passes after, for bugfixes)
- [ ] New public exports are tagged `@public` / `@beta` / `@internal`
- [ ] No host-path imports, secrets, real IPs, or personal identifiers
- [ ] Change fits Moss's robot-grade, host-neutral scope; robot/vendor specifics live in host adapters, knowledge modules, or platform extensions
- [ ] API reports, consumer docs, changelog, and migration notes are updated when applicable
- [ ] Docs updated if user-facing behavior changed

## Security-sensitive changes (if applicable)

- [ ] Enumerated shell separators, path normalization, indirection, and encoding/escaping bypasses
- [ ] Shared policy is used by every enforcement layer; reason codes distinguish policy rejection from availability failure
- [ ] Added negative tests for the complete exploit chain, not only the first observed payload
- [ ] The PR is safe to merge atomically and does not rely on a later follow-up to close a known exploit
