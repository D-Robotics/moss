---
name: bench-repro
description: How to reproduce and grade a bench task or A/B arm for moss capability work
when: running benchmarks, investigating a bench regression, or collecting A/B evidence
---

# Reproducing bench evidence

- Internal bench: `npm run bench -- --task <id> --samples <n> --label <label>` (provider via `MOSS_BENCH_API_KEY`, `--model`, `--base-url`; temp=0; approval=never). Results land in `bench/results/<label>/` (never committed).
- A/B: `npm run bench:ab -- <engine> --samples <n>` for `best-of-n` / `reasoning-high` / `goal-loop` / `model-routing`; the verdict json lands in `bench/results/ab-<engine>-<stamp>.json`.
- Noise discipline: compare only same-SHA runs; use `npm run bench:noise` for the noise band; a delta inside the band is not evidence.
- SWE-bench (external board): `npm run bench:swe -- --samples 2 --label <label>` produces predictions; grade with `npm run bench:swe -- --eval --label <label>`. Instance subset is locked in `bench/boards/swebench-instances.json` — never edit it mid-study.
- A baseline must be collected from a pinned build (`--dist bench/.cache/<snapshot>/dist`), not from a dirty tree.
