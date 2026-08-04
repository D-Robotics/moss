# Legacy vs Rules Composer A/B

Same live registry, same 43 tasks, 3 attempts per task (129 paired samples).

| Metric | A: legacy matchByText | B: Rules Composer | B - A |
| --- | ---: | ---: | ---: |
| Set F1 | 67.5% | 90.7% | +23.2 pp |
| Set Exact Match | 51.2% | 72.1% | +20.9 pp |
| Rejection accuracy | 83.7% | 100.0% | +16.3 pp |
| Recall@5 | 70.9% | 77.9% | +7.0 pp |
| Cardinality error | 0.512 | 0.326 | -0.186 |
| Mean selection latency | 0.461 ms | 1.049 ms | +0.588 ms |
| Injected token estimate | 111459 | 115338 | +3879 |

Per-sample Set F1: Rules wins 45, legacy wins 3, ties 81. By unique task: Rules wins 15, legacy wins 1, ties 27.

Regression cases: `SK-M1` expected ["code-review","superpower-systematic-debugging"], legacy ["code-review","superpower-systematic-debugging"], rules ["code-review"].

This is a selector/injection A/B. It deliberately excludes LLM response variance and does not claim a semantic downstream-task improvement.
