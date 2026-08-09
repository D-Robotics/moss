# Contributing to Moss

Thanks for contributing to Moss, D-Robotics' vendor-neutral, robotics-first terminal agent and
embeddable runtime. Chinese issue and PR descriptions are welcome; public API documentation should use
clear English for the international developer community.

The repository's shared, enforceable rules live in the
[Moss Code Standards](docs/code-standards.md). Read that policy before changing code. This guide explains
how to apply it to a contribution; package guides contain only package-specific additions.

## Repository scope and layout

Moss is a TypeScript/ESM npm-workspaces monorepo requiring Node.js 22.16 or newer.

| Package                    | npm name          | Responsibility                                                                                |
| -------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| `packages/moss`            | `@rdk-moss/core`  | Host-neutral contracts and prompts; zero runtime dependencies.                                |
| `packages/moss-agent`      | `@rdk-moss/agent` | Agent runtime, CLI, tools, providers, memory, skills, teaching, mesh, MCP, and observability. |
| `packages/create-moss-app` | `create-moss-app` | Project scaffolding CLI.                                                                      |

The enforced dependency direction is:

```text
create-moss-app -> @rdk-moss/agent -> @rdk-moss/core
```

Robot/vendor facts belong in knowledge modules, platform extensions, or host adapters. Public packages
must not import downstream host application code.

## Setup

```bash
git clone https://github.com/D-Robotics/moss.git
cd moss
npm install
npm run build
```

## Required commands

Use focused checks while iterating, then run the complete gate before opening a PR:

```bash
npm run check
npm run verify
```

- `npm run check` runs format verification, lint/TSDoc, clean-checkout type checking, architecture
  boundaries, workspace hygiene, the source-size ratchet, and standards regression tests.
- `npm run verify` is a strict superset that adds the harness benchmark, build, API verification, and all
  package tests.
- `npm run api:check` compares the approved public entry-point inventory and API reports.
- `npm run docs` generates TypeDoc from a clean checkout and prepares core declarations automatically.
- `npm run format` applies the pinned formatting baseline.

Package tests import `dist/` and are build-first. For a focused agent iteration:

```bash
npm run build -w @rdk-moss/agent
npm run test:filter -w @rdk-moss/agent -- --filter module-name
```

## Change expectations

- Bug fixes include a regression test that fails before the fix and passes after it.
- Keep changes focused and preserve the package dependency direction and host-neutral boundaries.
- New public exports require a consumer summary, `@public`/`@beta`/`@internal`, an API report update,
  documentation, and an Unreleased changelog entry.
- Breaking public changes require a migration note, a `!` in the PR title, and the relevant major-version
  or contract review. Host Adapter changes also follow
  [the Host Adapter contract policy](docs/host-adapter-contract.md).
- Changes to source files in the maintainability baseline must not increase their recorded ceiling.
- Never add credentials, internal addresses, personal identifiers, generated `dist`/`docs-api` output,
  or downstream host implementation imports.

## Pull requests

Use the PR template and a Conventional Commit title such as `fix(agent): preserve provider error cause`.
The allowed types and scopes are listed in the canonical standard and enforced in CI. Link the issue the
change addresses and explain both the user outcome and verification evidence.

Before requesting review, confirm:

- `npm run verify` is green.
- Focused regression tests cover the change.
- Public docs, API reports, release tags, changelogs, and migrations are updated when applicable.
- The diff contains no unrelated or generated artifacts.

Questions are welcome in [GitHub Discussions](https://github.com/D-Robotics/moss/discussions) or an
issue. Contributions are licensed under the [MIT License](LICENSE).
