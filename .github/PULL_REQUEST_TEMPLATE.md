<!-- Thanks for contributing to Moss! Keep PRs focused. -->

## What & why

<!-- What does this change and why? Link the issue it addresses. -->

Fixes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Docs / infra
- [ ] Refactor (no behavior change)

## Checklist

- [ ] `npm run verify` is green (boundaries + hygiene + build + typecheck + lint + test)
- [ ] Added/updated tests (a test that fails before the fix and passes after, for bugfixes)
- [ ] New public exports are tagged `@public` / `@beta` / `@internal`
- [ ] No host-path imports, secrets, real IPs, or personal identifiers
- [ ] Change fits Moss's scope (robot-grade, host-neutral runtime — see `AGENTS.md` Scope Guard); robot/vendor specifics live in host adapters, knowledge modules, or platform extensions
- [ ] Docs updated if user-facing behavior changed
