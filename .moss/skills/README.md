# Skill library

Each skill is a distilled, verifier-backed capability extracted from real runs.
The evidence column points at the run/report that validates it.

| skill | what it gives the agent | verified on |
| --- | --- | --- |
| `libero-manipulation` | drawer/pinch/in-cavity placement/push primitives + failure taxonomy + solver template | LIBERO-Pro 40/40 official `_check_success` (full re-run audit pass=40 fail=0) |
| `reference-diff` | generic model/report differ the agent runs itself; protocol-audit habit | RLE task08 0.402 → 0.7603 (agent-driven diff beat the reference on the controller); task09 0.3121 → 0.6125/0.6628/0.6506 |
| `benchmark-engineering` | checkpoint-driven iteration, measure-before-move, autonomy-vs-hints, policy-task variance, protocol reporting | RLE task08/09/07 sessions 1-14 |
| `rdk-npu-inference` | hrt_model_exec load/perf workflow, measured baselines | RDK X5 board: 1.58 ms / 1247 FPS (3 consistent runs) |
| `rdk-model-deploy` | quantize → compile → deploy → verify chain | RDK X5 deployment chain, binary-equality checks |
| `rdk-tros-ai` | TROS DNN node + classification pipeline | RDK X5: 520-600 FPS |
| `bench-repro` | reproduce a benchmark run end-to-end | all of the above |
| `worktree-parallel` | parallel worktree isolation | internal runs |
| `patch-discipline` | minimal, reviewed patches | internal runs |

Rule: a skill enters this library only after a verifier/official check produced
the evidence listed in its `SKILL.md`; unverified advice stays in docs, not here.
