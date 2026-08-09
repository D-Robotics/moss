# Contributing to `@rdk-moss/core`

Follow the repository-wide [Moss Code Standards](../../docs/code-standards.md) and root
[contributor guide](../../CONTRIBUTING.md). This file lists additions specific to the core package.

## Scope

`@rdk-moss/core` contains host-neutral contracts and prompt builders. It has zero runtime dependencies
and cannot import `@rdk-moss/agent`, `create-moss-app`, product hosts, desktop shells, or frontend code.

Put contracts in `src/contracts/`, prompts in `src/prompts/`, and expose consumer-supported entry points
through `package.json` and the API inventory. Hardware/vendor facts belong in external knowledge modules
or extensions rather than core.

## Package checks

From the repository root:

```bash
npm run typecheck -w @rdk-moss/core
npm run build -w @rdk-moss/core
npm run test -w @rdk-moss/core
npm run api:check
```

The final contribution must also pass `npm run verify`.

## Contract changes

- Prefer additive optional fields for backward-compatible evolution.
- Use generics where a host-owned type crosses the contract boundary.
- Add consumer-facing TSDoc and an explicit stability tag to every new export.
- Update the API report, README/API documentation, and both root and package Unreleased changelogs.
- A breaking change needs migration guidance and a major-version review.
- Host Adapter manifest/compatibility changes also require the documented contract-version review in
  [the Host Adapter contract policy](../../docs/host-adapter-contract.md).

Core remains a pure TypeScript contract/string-builder package. Adding any runtime dependency is a gate
failure and requires an architectural proposal, not a package manifest shortcut.
