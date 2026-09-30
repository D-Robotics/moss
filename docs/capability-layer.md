# Capability layer — contract and standard

The capability layer (`src/core/task/capability.ts` + the wiring in
`src/cli/task-run.ts` and `src/core/mcp/registry.ts`) answers one question at
planning time: _which of the agent's skills, builtin tools and MCP tools does
this task actually need?_ Its whole job is narrowing — the selected few enter
the planning context, everything else stays out until searched for.

## The standard

A change to this layer is done when all seven hold. Each criterion is locked by
a spec that fails if it regresses.

| #   | Criterion                                                                                                                                                                                                                                                                                 | Locked by                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | **The discovery surface equals the agent's real surface.** Workspace + user-config skills, builtin tools, and every connected MCP server's full `tools/list` catalog — no class of capability the agent can use is invisible to discovery.                                                | `task-capability-mcp.spec.mjs`, `mcp-capability-selection.spec.mjs`                            |
| 2   | **Selection is relevant.** Generic document-shape words (list/file/write/summary/…) never count as matches; short-stem prefixes do not fire (REST ≠ restart); stem variants match (types ↔ type); Chinese goals select English-described capabilities via CJK bigrams + a zh→en glossary. | `capability-scoring.spec.mjs` (every case is an adversarial counterexample that was red first) |
| 3   | **Selection is real.** Matched MCP tools are revealed (registered) before the run starts, so the planner can call them without a search round trip; unrelated tools are neither named nor loaded.                                                                                         | `mcp-capability-selection.spec.mjs`                                                            |
| 4   | **No approval bypass.** Revealed MCP tools declare no side-effect class, so the approval default routes every call through the normal pipeline — exactly like search-discovered tools.                                                                                                    | review-audited (twice, independently); no path constructs a bypass                             |
| 5   | **The prompt budget is bounded.** At most 6 candidates, one line each, every description capped (140 chars in the layer, 500 in the revealed tool schema) — a hostile server cannot blow the context budget.                                                                              | `capability-scoring.spec.mjs`, `mcp-capability-selection.spec.mjs`                             |
| 6   | **Failure degrades to empty, loudly.** No MCP, a failed server, an empty catalog, a broken skills dir — the layer yields '' and the task still runs, but a warning is logged instead of silence.                                                                                          | `mcp-capability-selection.spec.mjs`, `task-capability-mcp.spec.mjs`                            |
| 7   | **The effect is measured.** `MOSS_CAPABILITY_LAYER=off` disables the layer for an A/B arm; benchmark deltas are reported, not assumed.                                                                                                                                                    | the gate spec in `mcp-capability-selection.spec.mjs` + the bench `passEnv` entries             |

## How to re-measure the A/B

```bash
set -a; . ~/.moss-ap-env; . ./.env; set +a
for t in task-os-a-coding task-os-b-device task-os-c-failure-repair; do
  MOSS_CAPABILITY_LAYER=off npm run bench -- --task "$t" --samples 1
  npm run bench -- --task "$t" --samples 1
done
```

## Known limitations (deliberate, documented)

- **Lexical, not semantic.** Scoring is token/bigram overlap; it has no
  embeddings and no intent model. The adversarial spec set is the guardrail,
  not a proof of general relevance.
- **Builtin tools match by name only** — they have no descriptions in the
  inventory, so their signal is weaker than MCP/skill candidates.
- **The zh→en glossary is small** (robotics domain). Unmapped Chinese terms
  still match Chinese-described capabilities via bigrams, but cross-language
  selection for other domains needs glossary entries.
- **A search with no query registers the whole server** — that is the designed
  escape hatch when discovery misses, not a discovery path. Context cost is the
  model's to manage there.
