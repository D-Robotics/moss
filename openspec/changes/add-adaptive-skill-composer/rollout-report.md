# Adaptive Skill Composer rollout review

Date: 2026-08-04

## Decision

Rules composition is approved for explicit opt-in development cohorts. It remains default-off and `legacy` remains the rollback path. It is not approved as the product default because the historical suite did not persist a semantic downstream verifier result; process completion is only a proxy.

## Reproducible legacy baseline

Source: `D:/moss-eval/runs/skill-eval/skill-trial1`, installed `@rdk-moss/agent@0.6.0`, 37 historical tasks plus six RDK matcher-replay cases. The reproducible collector and raw metrics are in `evidence/legacy-baseline/`.

| Segment | Legacy exact match |
| --- | ---: |
| Single skill | 52.9% |
| Multi skill | 50.0% |
| No-skill rejection | 40.0% |
| Chinese | 50.0% |
| English | 47.4% |
| RDK matcher replay | 66.7% |

Legacy matcher latency averaged 0.395 ms (P95 0.552 ms), estimated injected content was 56,308 characters across all 43 selection cases, and the historical agent process completed on 29/37 executed tasks (78.4%). The RDK baseline is a matcher replay because the old suite had no executed RDK cases. The completion rate is explicitly a downstream proxy, not a semantic verifier pass rate. Four `load_skill` catalog/query calls and zero named manual loads were observed.

## Tuning and held-out protocol

The 37 original tasks were frozen into 22 train, 8 validation, and 7 held-out cases. Six RDK cases form a separate board segment. The script searched 60 combinations of `minScore`, `minConfidence`, and `maxSkills` using only train/validation. It then wrote `frozen-config.json` before first evaluating held-out prompts.

Frozen parameters:

- `minScore=0.08`
- `minConfidence=0`
- `maxSkills=4`
- `candidateLimit=12`
- `deadlineMs=750`

The shipped defaults use these values when users explicitly enable the Composer; `skills.composer.enabled` remains `false` by default.

## Final shadow result

Source: `evidence/composer-eval-final-v2/`. Every one of 43 tasks ran three times (129 samples).

| Metric | Full shadow | Held-out only |
| --- | ---: | ---: |
| Set F1 | 90.7% | 83.3% |
| Set Exact Match | 72.1% | 57.1% |
| Recall@5 | 77.9% | 78.6% |
| MRR | 76.7% | 78.6% |
| nDCG@5 | 76.4% | 74.9% |
| Cardinality error | 0.326 | 0.571 |
| Rejection accuracy | 100.0% | 100.0% |
| Dependency violation rate | 0.0% | 0.0% |
| Fallback rate | 0.0% | 0.0% |
| Average host latency | 0.984 ms | 0.905 ms |

All 43 tasks produced identical plans across their three attempts. All six RDK cases were exact across all attempts, including the ordered `rdk-board-knowledge -> rdk-device -> rdk-ros` chain and the empty-plan rejection case.

## Regressions found and corrected

- Generic tags such as `review`, `html`, and `branch` were incorrectly treated as exact aliases. Tags now remain lexical evidence rather than high-confidence exact matches.
- Simple factual lookups could activate workflow skills from a single noun. Informational queries now receive bounded lexical evidence while explicit action requests retain trigger matching.
- CJK triggers needed fuzzy bigram recall to tolerate inserted words in phrases.
- Several RDK Chinese triggers were mojibake. Representative board, device, ROS, hardware, doc, and capture skills now expose clean compact bilingual triggers.
- Retrieval cache entries were keyed only by registry digest. The host index could therefore hide board-only skills after the environment changed. The cache key now includes the eligible identity set, with a regression test.

## RDK X5 resource gate

Source: `evidence/board-rdk-x5/`. Tests ran on a 3 GB RDK X5 in an isolated network namespace with no model artifact.

| Metric | Idle | cam-service + CPU stream |
| --- | ---: | ---: |
| Cold start | 375.9 ms | 375.7 ms |
| Registry snapshot | 115.6 ms | 115.5 ms |
| First composition | 258.5 ms | 258.5 ms |
| Steady mean | 8.62 ms | 8.54 ms |
| P95 | 10.06 ms | 9.97 ms |
| RSS delta | 26.77 MB | 30.68 MB |

No measurable latency regression appeared under the representative concurrent load; RSS increased by about 3.9 MB. Standard-package inspection found zero model artifacts, zero native inference entries, and no optional dependencies.

## Gate review

- Quality: pass for opt-in (`Set F1 >= 0.75`).
- Rejection: pass (`>= 0.90`; observed 1.00).
- Ordering/safety: pass (zero dependency violations and zero fallbacks).
- Latency: pass on host and RDK X5 (`P95 < 25 ms`).
- Token/injection: observed and bounded by `maxSkills=4`; continue monitoring because better recall increases total injected context.
- Board resources: pass for opt-in on RDK X5 (about 31 MB worst observed incremental RSS).
- Legacy rollback: pass through runtime integration coverage; default-off config resolves to `legacy` and clears any active plan.
- Semantic downstream gate: not proven by the historical suite. Keep default-off until a task-specific verifier is added and reviewed.

No automatic promotion occurs. Enabling rules for a development cohort requires an explicit config change; making it the product default requires a second review with semantic downstream results.
