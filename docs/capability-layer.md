# Capability layer — contract and standard

The capability layer (`src/core/task/capability.ts` + the wiring in
`src/cli/task-run.ts` and `src/core/mcp/registry.ts`) answers one question at
planning time: _which of the agent's skills, builtin tools and MCP tools does
this task actually need?_ Its whole job is narrowing — the selected few enter
the planning context, everything else stays out until searched for.

## The standard

A change to this layer is done when all seven hold. Each criterion is locked by
a spec that fails if it regresses.

| #   | Criterion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Locked by                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | **The discovery surface equals the agent's real surface.** Workspace + user-config skills, builtin tools, and every connected MCP server's full `tools/list` catalog — no class of capability the agent can use is invisible to discovery.                                                                                                                                                                                                                                                                                                                        | `task-capability-mcp.spec.mjs`, `mcp-capability-selection.spec.mjs`                                       |
| 2   | **Selection is relevant.** Generic document-shape words (list/file/write/summary/…) never count as matches; short-stem prefixes do not fire (REST ≠ restart); stem variants match (types ↔ type); Chinese goals select English-described capabilities via CJK bigrams + a zh→en glossary.                                                                                                                                                                                                                                                                         | `capability-scoring.spec.mjs` (every case is an adversarial counterexample that was red first)            |
| 3   | **Selection is real.** Matched MCP tools are revealed (registered) before the run starts and named in the layer as directly callable, so the planner does not have to _discover_ them; unrelated tools are neither named nor loaded. Measured (capability-mcp-ledger, n=3/arm, wording-v2): searches 2→**0** per task, first MCP action is a direct call 3/3, tool uses 42→31, wall 137s→60s (−56%), engine turns 3.0→2.0, success 3/3 both arms. (The first wording left one habitual search per task; saying "directly callable, no search needed" removed it.) | `mcp-capability-selection.spec.mjs`, `bench/tasks/capability-mcp-ledger`, `.autopilot/reports/wording-v2` |
| 4   | **No approval bypass.** Revealed MCP tools declare no side-effect class, so the approval default routes every call through the normal pipeline — exactly like search-discovered tools.                                                                                                                                                                                                                                                                                                                                                                            | review-audited (twice, independently); no path constructs a bypass                                        |
| 5   | **The prompt budget is bounded.** At most 6 candidates, one line each, every description capped (140 chars in the layer, 500 in the revealed tool schema) — a hostile server cannot blow the context budget.                                                                                                                                                                                                                                                                                                                                                      | `capability-scoring.spec.mjs`, `mcp-capability-selection.spec.mjs`                                        |
| 6   | **Failure degrades to empty, loudly.** No MCP, a failed server, an empty catalog, a broken skills dir — the layer yields '' and the task still runs, but a warning is logged instead of silence.                                                                                                                                                                                                                                                                                                                                                                  | `mcp-capability-selection.spec.mjs`, `task-capability-mcp.spec.mjs`                                       |
| 7   | **The effect is measured.** `MOSS_CAPABILITY_LAYER=off` disables the layer for an A/B arm; benchmark deltas are reported, not assumed.                                                                                                                                                                                                                                                                                                                                                                                                                            | the gate spec in `mcp-capability-selection.spec.mjs` + the bench `passEnv` entries                        |

## Measured, not assumed

Two A/B rounds (task-os a/b/c, deepseek-flash@latest, temperature 0, 1 sample
per arm):

- **Before the diet** the layer restated builtin tool names and a device hint
  on MCP-less tasks — the OFF arm won all three (a: 6 vs 8 turns; b: PASS 6 vs
  FAIL; c: 8 vs 9). That measurement drove the redesign: the layer now speaks
  only when it knows something the model cannot already see.
- **After the diet** the layer is silent on MCP-less tasks, so the arms are
  equivalent modulo run noise (OFF 9/7/9 vs ON 8*/6/11; *re-run in isolation
  after a transient API failure — in=0/out=0 — passed at 8 turns). The value
  path (catalog → select → reveal) is spec-locked; bench-level benefit in
  MCP-rich workspaces is the open measurement, tracked on the team board.

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
- **Unattributed acceptance verdicts can mask** (adversarial-review follow-up):
  a `task_acceptance` call that omits `task_id` — the tool schema allows it —
  is treated as applying to every task, so it can silence another task's
  pending-FAIL repair nudge. Fix direction: back-fill the task id from the
  acceptance result text.
- **Bench crash triage is limited by `*.log` gitignore** — A/B driver logs
  (full stdout/stderr per sample) stay on disk only, so historical crash
  samples cannot be re-diagnosed from the repo.
