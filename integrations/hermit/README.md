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

## Daily experience references (SDK 0.33)

`RsiDailyStore(rootDir)` uses the same owner/environment `state.json` as `RsiEngine`,
including its cross-process writer lock and atomic replacement. The host must derive
`scope` from authenticated identity and admit project IDs before calling the SDK.
`read(scope)` returns `revision`, `storageDirectory`, `metadataBytes`, retention and
quota settings, project consent entries and experience references. Old state without
daily metadata defaults to collection disabled, 30 days and a 1 GiB metadata quota.
`collectionStatus` persists a bounded `ready` or `paused` state with a timestamp;
paused reasons are `quota` or `error`. A rejected over-quota collection latches the
pause across restarts. `indexQuota` reports bytes, limit bytes, stored reference
count and its 1,000-entry limit (including expired entries until a pruning write).
Its `exceeded` flag means bytes exceed the limit or the reference count is at capacity;
a candidate reference can also be rejected before current bytes reach the limit.

```js
const daily = new RsiDailyStore(rootDir);
daily.configure(scope, {
  expectedRevision: daily.read(scope).revision,
  projectId: trustedProjectId,
  enabled: true,
});
daily.record(scope, {
  runId: nativeRunId,
  projectId: trustedProjectId,
  completedAt: Date.now(),
  outcome: 'completed',
});
```

`RSI_DAILY_ALL_PROJECTS` is an explicit all-admitted-projects consent choice.
An exact project entry overrides it, including a project's opt-out. `record` only
accepts identifiers, timestamps, outcome and optional adapter/scope/evidence digests;
it does not store raw prompts, code, tool output or credentials. Unknown input fields
are discarded. Duplicate project/run pairs are idempotent, and references always
start with `eligibility: 'needs_judge'`. Successful completion alone is not training
admission. The host retains the source evidence and owns real-task qualification.

Further collection returns `reason: 'paused'` until an explicit CAS-protected
`configure(scope, { expectedRevision, projectId, enabled, resetCollectionStatus: true })`.
Changing consent or raising the quota alone does not clear a pause. Hosts catching
collection failures call `reportCollectionError(scope)` to persist a generic error
state, with no raw error text. This cannot persist if the storage itself is
unavailable; hosts must surface that failure directly. Control metadata (including
the pause and deletion tombstones) may exceed a tiny configured index quota so the
cause and replay protection are retained. No unbounded error history is written.

`deleteExperience(scope, id, { expectedRevision })` removes a reference and stores
a minimal digest tombstone against late event replay. This API does not delete a
host's original conversation, evidence files, or already derived training assets;
the host must complete any broader deletion workflow before reporting that outcome.
`exportMetadata(scope)` returns only versioned preferences, visible reference
metadata and status; it excludes local paths, tombstones and source task content.
`deleteMetadata(scope, { expectedRevision })` deletes all stored experience
references atomically, retaining consent, pause state and replay tombstones.
Both methods share owner/environment isolation with the single-reference API.
Metadata is bounded at 1,000 references and 10,000 deletion tombstones per owner/env;
capacity failures are explicit. `metadataBytes` and `quotaBytes` cover daily index
metadata only, not all training/workspace disk usage. The asset store below handles
managed filesystem payloads and workspace reservations. Expired references are filtered
on reads and pruned on subsequent configuration or successful collection writes.

After building, run `node scripts/verify/rsi-daily-store.mjs` and
`node scripts/verify/rsi-external-training.mjs` for offline persistence/protocol probes.

Hermit promotion uses a policy keyed by the complete trusted `RsiTaskScope` digest,
independent of native RSI's legacy global policy. Read it with
`engine.getTrainingPolicy(scope, taskScope)`; roll it back with
`engine.rollbackTrainingPolicy(scope, taskScope, expectedPolicyVersion)`.
`captureAdapter(scope, { model, providerIdentityDigest, taskScope })` captures that
scope's version. A promotion or rollback in another project cannot replace it.
The repository revision is an exact compatibility boundary: project updates require
a separately admitted scope and evaluation, not an inferred broad match.

## Local asset authority (SDK 0.33)

`RsiAssetStore(rootDir)` shares the policy transaction lock. `status(scope, taskScope?)`
reports actual owner-directory bytes (including training directories, pending uploads,
backups and orphan files), reserved remaining capacity, quota and retention settings.
The default quota is 1 GiB; raw evidence retention is 30 days, summaries 180 days,
and failed/cancelled workspace cleanup is eligible after 7 days. `configure` accepts
these settings with `expectedRevision`. Paths derive from authenticated scope only.

Every state write now uses schema 3: runs, cases, candidates, evaluations, sessions
and confirmations are immutable content-addressed JSON documents outside `state.json`.
Public `RsiStore.read` hydrates these records and verifies every byte digest. `migrate`
is idempotent; a schema-2 source is backed up before its atomic replacement. A failed
transaction leaves the prior index intact; unreferenced files are safely collectible.
Migration preserves native/legacy provenance and does not broaden scope or synthesize
Hermit sessions. An unreadable/corrupt index fails closed; adapter capture falls back
without trusting a damaged candidate.

`put(scope, taskScope, { kind, content, expectedRevision, dependencies?, adapterDigest?,
sessionId?, sourceId? })` stores explicitly admitted content. Kinds are experience,
case, adapter, evaluation and manifest. `sourceId` binds a host case/run identifier;
`sessionId` must reference an existing admitted session. Adapter text is limited to
8 KiB; other payloads to 16 MiB. Hosts must redact secrets before calling the API;
the SDK additionally rejects common credential/private-key patterns. `read` and `list`
enforce owner and exact task scope; digest knowledge is not authorization.
`exportAdapter` returns only text, compatibility scope and a minimal evaluation
summary, excluding raw traces, project code and credentials.

Before launching a worker, call `reserveWorkspace(scope, taskScope, { sessionId,
maxBytes, kind: 'training' | 'upload', expectedRevision })`. Use its `directory` and
check `checkWorkspace(scope, taskScope, lease.id)` before each actor/provider operation.
The SDK's training-call reservation also checks actual disk consumption and revoked
leases. Reserved capacity is charged before provider calls; unused capacity is released
only with `finishWorkspace(scope, taskScope, id, outcome)` after the host has stopped
the worker. These checks are not an OS filesystem quota: a trusted worker may write
between checks, so hosts needing hard physical ceilings must use an enforced filesystem
or container quota. Do not expose lease completion as a browser-trusted assertion.

`beginDeletion(scope, taskScope, { assetIds, expectedRevision })` computes descendants,
switches affected active/previous policies to baseline, invalidates derived candidates,
cancels sessions and revokes workspace leases in one transaction. It returns a deletion
ID and `requiredStopSessions`. Stop those workers, acknowledge their leases, then call
`completeDeletion(scope, taskScope, deletionId)`. Running task receipts also block
physical cleanup. Source blobs, related workspaces, superseded document versions and
local migration backups are cleared; minimal content-free revocations remain. The
host still owns deletion of its external conversation store or external caches.

`prune(scope)` derives protection from persisted policies, live runs and session/lease
references. Active, previous and in-flight versions and their required dependencies
are retained; other records expire under configured retention. Deletion/holdout ledgers
never reset through pruning. Metadata and small revocation writes may exceed a reduced
quota so users can stop or clean an over-limit store.

`backup(scope)` returns an owner-bound envelope signed with HMAC-SHA256 using a local
0600 `backup-auth.key`, excluded from the envelope. No running/revoked leases may exist.
`restore(scope, envelope, { expectedRevision })` requires the same protected key and
rejects forged/rehashed policies before extracting payloads. Capacity is checked first;
consumed holdouts, split exposures, proposal claims, budget reservations, daily tombstones
and candidate revocations are merged monotonically. Deleted assets cannot reappear.
Moving a backup to another installation requires separate secure host management of
the authentication key; arbitrary imported bundles cannot establish trusted policy.
Cloud synchronization is not implemented by this local store.

The optional Python source is copied from this canonical directory into
`dist/integrations/hermit/` during build; npm packages keep it under the existing
`dist` closure and do not bundle Python dependencies. Run
`node scripts/verify/rsi-assets.mjs` after building for the offline lifecycle probe.
