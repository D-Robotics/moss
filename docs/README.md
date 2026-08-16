# Moss Documentation Map

This index separates audiences and authority levels. Source, tests, manifests, API reports, and
commit-bound verification decide current behavior. A design note explains intent; it does not prove that
the runtime implements that intent.

## Start by role

| I want to…                         | Start here                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| Use the CLI/TUI                    | [`user-guide/README.md`](./user-guide/README.md)                             |
| Use the local Web workspace        | [`user-guide/24-web-ui.md`](./user-guide/24-web-ui.md)                       |
| Embed `MossAgent` in a host        | [`../packages/moss-agent/README.md`](../packages/moss-agent/README.md)       |
| Choose an extension mechanism      | [`../packages/moss-agent/EXTENDING.md`](../packages/moss-agent/EXTENDING.md) |
| Use the public runtime API         | [`../packages/moss-agent/API.md`](../packages/moss-agent/API.md)             |
| Implement a Host Adapter           | [`host-adapter-contract.md`](./host-adapter-contract.md)                     |
| Contribute code                    | [`../CONTRIBUTING.md`](../CONTRIBUTING.md)                                   |
| Work as a coding agent             | [`../AGENTS.md`](../AGENTS.md)                                               |
| Understand enforced code standards | [`code-standards.md`](./code-standards.md)                                   |

## Engineering contracts

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md): stable ownership, dependency, execution, state, and
  failure boundaries.
- [`code-standards.md`](./code-standards.md): formatting, boundaries, testing, API and release gates.
- [`error-boundary-policy.md`](./error-boundary-policy.md): where native errors become `MossError`.
- [`host-adapter-contract.md`](./host-adapter-contract.md): host-neutral integration and version review.
- [`env-vars.md`](./env-vars.md): environment variables and ownership.
- [`deepseek-harness-review.md`](./deepseek-harness-review.md): evidence-based plugin lifecycle
  lessons, staged Moss adoption, and explicit non-goals.

## Evaluation and evolution

- [`agent-harness-benchmark.md`](./agent-harness-benchmark.md): benchmark schema and required gate.
- [`agent-efficiency-benchmark.md`](./agent-efficiency-benchmark.md): efficiency evaluation.
- [`self-evolution-loop.md`](./self-evolution-loop.md): partially implemented design context; verify each
  claim against source, tests, and active OpenSpec before relying on it.
- `evidence/`: immutable or date-bound evidence artifacts; every conclusion must name its source revision.

## Change records

- `../openspec/changes/`: active or retained change proposals, designs, specs and task records.
- `docs/superpowers/specs/` and `docs/superpowers/plans/`: historical design/plan material; not runtime
  authority.
- Git history, merged PRs, and `CHANGELOG.md` replace hand-maintained commit/session summaries.

## Documentation lifecycle

- **Contract / reference**: current and enforced; update it with the owning code/gate.
- **User guide**: current user behavior; CLI/help remains the executable authority.
- **Proposal / design**: intended direction; use `proposed`, `accepted`, `implemented`, `superseded`, or `archived` when adding status metadata.
- **Evidence / audit**: tied to a date and source revision; never silently treated as current.
- **Archive**: explanatory history only.

Do not add a shared `SESSION.md` or duplicate test counts, file lengths, roadmap status, or manual DONE lists.
Put temporary progress in OpenSpec/issue/PR, and put released user-facing facts in `CHANGELOG.md`.
