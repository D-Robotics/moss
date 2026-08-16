# Leaderboard and cloud/local evaluation

Moss uses two evidence layers: deterministic integration cases run in repository verification, and
canonical third-party harness runs whose environment, dataset, model, agent artifact, failures, and
trajectories are preserved.

## Primary target: Terminal-Bench 2 via Harbor

Terminal-Bench measures autonomous agents in real terminal environments. Harbor officially supports
custom agents, so Moss provides `benchmarks/harbor/moss_agent.py`, an adapter that installs an exact
published `@rdk-moss/agent` version and runs the headless stream-JSON CLI in the task workspace.

Authoritative upstream material:

- [Harbor custom agents](https://harborframework.com/docs/agents)
- [Running Terminal-Bench 2](https://harborframework.com/docs/running-tbench)
- [Terminal-Bench 2 leaderboard submission repository](https://huggingface.co/datasets/alexgshaw/terminal-bench-2-leaderboard/blob/main/README.md)

The submission repository currently says submissions are closed while a new process is designed.
Moss can produce canonical Harbor logs now, but must not claim a public rank until submissions reopen
and the result is accepted. The checked manifest pins the reviewed Harbor and dataset revisions,
requires five trials, and preserves the official `timeout_multiplier=1` policy.

Run the local readiness audit:

```bash
npm run check:leaderboard-readiness
```

It reports `blocked` rather than failing the repository when Docker, Harbor, the exact agent version,
model, or provider key is unavailable. On a benchmark host, require every prerequisite with:

```bash
node scripts/check-leaderboard-readiness.mjs --require-ready
```

The resulting report prints the canonical Harbor command. A formal run must retain every success,
timeout and failure plus `result.json`, artifacts and trajectories; it must not expose the benchmark
repository or ground truth to the agent.

## Secondary target: SWE-bench Verified

[SWE-bench](https://github.com/SWE-bench/SWE-bench) is the secondary coding benchmark. Its canonical
evaluation requires Docker and substantial disk/CPU resources. Current public Verified submissions
also have research-report and affiliation eligibility requirements described by the official
[SWE-bench experiments repository](https://github.com/SWE-bench/experiments). Until those conditions
and the complete 500-instance artifact set are met, Moss should report local canonical results rather
than claim leaderboard submission.

## Deterministic cloud/local recovery

```bash
npm run demo:cloud-local
```

This built-artifact scenario creates a local release manifest and a loopback network fixture. The
remote boundary intentionally returns HTTP 503 once. Moss must observe the failed tool outcome, retry,
obtain an attestation, reconcile its digest with the local artifact, complete through the Web NDJSON
transport, and expose the ordered evidence through TaskRun history. Loopback makes CI deterministic;
it is a protocol/recovery proof, not a claim that a third-party cloud was available.

## Multi-model review

With credentials supplied only through the environment:

```bash
MOSS_REVIEW_MODELS=model-a,model-b npm run demo:multi-model-review
```

Each model must call the same read-only interaction-contract tool and ground one independent UX or
reliability recommendation in `INTERACTION_CONTRACT_OK`. Results are comparable review evidence, not
a leaderboard score.

The checked review ledger records a successful run with `qwen3.8-max` and `qwen3-coder-next`. Both
independently identified pre-retry remote failure/reconciliation visibility as the highest remaining
risk, reinforcing the Web event-history and explicit failed-tool evidence direction.
