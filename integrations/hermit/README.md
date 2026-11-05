# Optional official Hermit worker

This directory is an opt-in Python runtime, outside the Node SDK dependency closure.
It runs the **official `Trainer` and GEPA Evolver**, not an optimizer rewritten in
Studio or Moss. `prompt-only@1.0` names the **Adapter template**, not the method.
Only its `ADAPTER.md` context is exported (UTF-8, nonempty, at most 8192 bytes).
Tools, roles, hooks and symlinks are not supported exports.

Upstream pins:

- Hermit `0.2.0`, commit `2c9d94a1b1437d1c66b80aab05cb0262f557e6d7`,
  <https://github.com/Infini-AI-Lab/hermit>.
- GEPA commit `d771eb21b5dd3228bc3f567293d2ccfc423fc900`,
  <https://github.com/gepa-ai/gepa> (the dependency pinned by official Hermit).
- Python >=3.12; validated here on 3.12.15. `requirements.lock` records the base
  environment; `requirements-gepa.lock` records the complete GEPA environment.
  Install these only in an isolated optional venv, never into the Node package.
  These are version/source locks, not wheel hash attestations.

```sh
git clone https://github.com/Infini-AI-Lab/hermit.git /absolute/path/hermit
git -C /absolute/path/hermit checkout 2c9d94a1b1437d1c66b80aab05cb0262f557e6d7
python3.12 -m venv /absolute/path/hermit/.venv
/absolute/path/hermit/.venv/bin/python -m pip install -r integrations/hermit/requirements-gepa.lock
/absolute/path/hermit/.venv/bin/python integrations/hermit/worker.py probe --source-root /absolute/path/hermit
```

The editable Hermit requirement must resolve to that checkout. Installing the lock
into another location requires replacing **only** its editable source installation
with `pip install -e /absolute/path/hermit`; the worker rejects a different import
root or dirty tracked upstream source. GEPA's installed VCS provenance must match
its full commit.

## Host boundary

`src/core/rsi/hermit-worker.ts` provides `probeHermitWorker(runtime, signal?)` and
`runHermitWorker(input)`. Runtime supplies absolute `python`, `workerPath`, and
`sourceRoot`. Run input additionally supplies a fresh owned `jobDir`, SHA-256 of
`input/run.yaml`, `trainingTokenLimit` from the frozen manifest, loopback
`bridgeUrl`, ephemeral job `bridgeToken`, `timeoutMs`, optional `signal`, and a
**synchronous** `revoke()` that invalidates the host's job lease. Cancellation and
output overflow revoke before TERM/KILL of only the worker's own detached process
group. Late output is discarded. Provider/device credentials are never inherited.

The host writes trusted config, public task statements and train/validation ID
splits in `jobDir/input`. No holdout tasks, Judge implementation or answer files
belong there. `data.test` must be absent, train/validation disjoint, and each task
must belong to one of those splits. The configured agent and judge must be this
worker's `run_task` and `score_task`; both delegate to the host:

- `POST /run`: `{taskId,instructions,adapterDigest}` →
  `{runId,output,tokens?,cost_usd?,messages?}`. The host binds the run receipt to
  its task scope, actual Adapter digest and independently measured execution.
- `POST /score`: `{taskId,runId,adapterDigest}` → `{score,feedback?,extra?}`.
  The host checks the receipt and returns the frozen functional Judge result.
- `POST /v1/chat/completions`: the official GEPA reflection model's API. The
  configured `llm.base_url` must equal `bridgeUrl + '/v1'` and its `api_key_env`
  must be `MOSS_HERMIT_JOB_TOKEN`. This proxy **must reserve and settle each actual
  HTTP request and retry** against the SDK budget. Unknown usage blocks further
  calls. Hermit's own budget is an additional guard, not the authoritative ledger.

No route may accept browser-selected paths, code, secrets or arbitrary task IDs.
The host must invalidate routes once cancelled or finalized and must reject stale
receipts. Final confirmation, promotion, adoption and rollback remain host/SDK
operations; this worker cannot promote a candidate.

## Platform and isolation

GEPA runs trusted Python in the official Trainer process and modifies text through
its fixed public interface (`hermit/trainer/trainer.py`, `_evolve`, and official
`hermit/agent/evolver/methods/gepa/evolver.py`). It does not invoke a shell learner;
therefore this narrowly restricted configuration uses `sandbox.enabled: false`
and no shell tools, external environments or custom profiles. This is **not a
claim of OS isolation**. Moss acting and the hidden Judge must execute behind
independent host isolation capabilities. The host must refuse real training until
those physical read/capability probes pass. A successful GEPA dependency probe
alone does not authorize running real tasks or prove hidden-data isolation.

The unrelated official Codex prompt-only recipe requires Linux, bubblewrap,
Codex CLI and a Responses backend. Probe reports that capability separately; this
worker's production path accepts **GEPA only**. It never silently switches methods.

Training requires exactly two completed official steps, `ADAPTER.md` as the only
learnable file, outputs inside fresh `jobDir/output`, and a token allocation equal
to the frozen manifest value. The returned final/step commits, summary digest,
method and dependency pins come from actual upstream results. No performance gain
is inferred from a successful training run.

## Offline contract verification

After `npm run build`, set `HERMIT_PYTHON` to the optional venv executable:

```sh
HERMIT_PYTHON=/absolute/path/hermit/.venv/bin/python node integrations/hermit/verify-connector.mjs
/absolute/path/hermit/.venv/bin/python integrations/hermit/verify-trainer.py --source-root /absolute/path/hermit
/absolute/path/hermit/.venv/bin/python integrations/hermit/verify-gepa.py --source-root /absolute/path/hermit
```

The connector probe uses protocol fixtures for digest/path/overflow/cancellation
and process-group checks, including a TERM-ignoring descendant, a late valid
result and an unrelated sentinel. The Trainer probe runs the official teaching
example in a temporary directory. The GEPA probe runs actual official GEPA and
Trainer with one or more **scripted loopback model HTTP requests**, plus scripted
acting/Judge receipts. These prove interfaces only: no paid model, board, historic
bug task or self-improvement efficacy is claimed. Real acceptance needs fresh
RDK historical bugs, hidden final evaluation and measured provider usage.
