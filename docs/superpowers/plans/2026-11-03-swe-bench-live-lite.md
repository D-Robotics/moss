# SWE-bench-Live Lite Implementation Plan

> **For agentic workers:** Use the current runtime's plan-execution workflow to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify and prepare the official Lite dataset, provide an auditable offline fixture prototype, and add a fail-closed preflight for a future real run.

**Architecture:** Keep Live separate from the old Verified runner. The preparation command verifies the pinned official Parquet checksum, then separates evaluation-only fields from the problem statements. A fixture-only command projects each row to `problem_statement`, invokes one synthetic worker per row, then optionally invokes a synthetic evaluator after all workers finish. It exports compatible prediction records and clearly labelled synthetic trajectories and statuses. The preflight probes dependencies without changing Docker and remains incomplete until isolation, temporal restrictions and full real model-input trajectories are demonstrated.

**Tech Stack:** Node.js 22, existing Moss process boundary, local JSONL/JSON, synthetic child commands; no new dependency.

---

## Official evidence and protocol decision

- Benchmark [README at 62d02936](https://github.com/microsoft/SWE-bench-Live/blob/62d02936a0726fbf4597b05bd07b09fb99eddae6/README.md) and [evaluation guide](https://github.com/microsoft/SWE-bench-Live/blob/62d02936a0726fbf4597b05bd07b09fb99eddae6/evaluation/README.md): one rollout; only the problem statement and instance image are available to the agent; no hints, test patch, evaluation feedback, or task-specific answers. Python Lite should use the older Python-only evaluator for comparability.
- [Python-only README at ad79b850](https://github.com/microsoft/SWE-bench-Live/blob/ad79b850f15e33992e96f03f6e97f05ddf9aa0be/README.md) specifies `python -m swebench.harness.run_evaluation --dataset_name SWE-bench-Live/SWE-bench-Live --split lite --namespace starryzhang --predictions_path <file> --max_workers <n> --run_id <id>`. Its [prediction loader](https://github.com/microsoft/SWE-bench-Live/blob/ad79b850f15e33992e96f03f6e97f05ddf9aa0be/swebench/harness/utils.py) accepts a JSON array or an ID-keyed JSON object whose values contain `instance_id`, `model_patch`, and `model_name_or_path`; the newer evaluator also accepts the ID-keyed object. The Python evaluator accepts a local JSONL dataset, useful for pinning an independently verified snapshot.
- The [submission README at 697c1d41](https://github.com/SWE-bench-Live/submission/blob/697c1d4174d897cd6e4b647f9f9eee1df55fd095/README.md) requires `preds.json`, the official `results.json`, rollout logs/trajectories, and a method README; if all trajectories cannot be shared, at least ten representative trajectories are required. Its [checklist](https://github.com/SWE-bench-Live/submission/blob/697c1d4174d897cd6e4b647f9f9eee1df55fd095/.github/pull_request_template.md) additionally forbids inspecting commits/issues/PRs published after the task issue. Maintainers review submissions.
- Target dataset is `SWE-bench-Live/SWE-bench-Live`, split `lite` (300; upstream states Lite is frozen). Official Hugging Face [dataset revision API](https://huggingface.co/api/datasets/SWE-bench-Live/SWE-bench-Live/revision/1653fb720eddacf4b16f775c9b4d0bdf3914fbaa?blobs=true) identifies revision `1653fb720eddacf4b16f775c9b4d0bdf3914fbaa` and `data/lite-00000-of-00001.parquet` SHA-256 `7ee0a75c41bfc954fd441b67ce738fc5c1cbae00721c4e30e7db4d893057c9ab`. The pinned file was downloaded from that revision and its digest independently matched. The [official rows API](https://datasets-server.huggingface.co/rows?dataset=SWE-bench-Live%2FSWE-bench-Live&config=default&split=lite&offset=0&length=1) reports 300 rows and confirms the dataset has no `docker_image` column. Image selection must follow the pinned Python-only harness rather than assuming a dataset image field or a single host architecture.
- The old `scripts/bench-swebench.mjs` targets Verified, can select among multiple samples, handles test-patch paths, and can inject FAIL_TO_PASS commands. It is not a Live implementation. Its credential and setup paths must not be reused for this prototype.
- `src/cli/print.ts` exposes assistant/tool events, but that contract does not establish that all system prompts and every model input are recorded; do not call those events a complete official trajectory without further verification. No score is produced by this prototype.

## Files and steps

- Create `scripts/bench-swebench-live.mjs`: verified official dataset preparation, fixture-only runner, prediction/trajectory export, read-only preflight.
- Create `scripts/lib/swebench-live-export.py`: decode a checksum-verified Parquet snapshot into separated full and rollout JSONL.
- Create `test/bench-swebench-live.spec.mjs`: synthetic local dataset and worker/evaluator processes; no Docker or model key.
- Modify `package.json`: expose `bench:swe-live`.
- Modify `src/utils/run-process.ts`: preserve restricted child environments during Windows timeout cleanup and resolve `taskkill.exe` from the trusted system directory.

### Task 0: Prepare the pinned official dataset

- [x] Add a regression rejecting a Parquet file whose SHA-256 differs from the pinned official value, before any conversion or output creation.
- [x] Download the official file into an isolated temporary directory and verify its SHA-256 against the official revision API.
- [x] Decode with an isolated Python/pyarrow environment and compare all 300 projected instance IDs and problem statements to the source rows. Record SHA-256 for both generated JSONL files and check them in preflight.

### Task 1: Project and export fixture rows

- [x] Write a test that supplies one JSONL row containing a statement and forbidden sentinel fields; the fake worker records its stdin and returns a synthetic patch. Assert its only dataset input is `{ "problem_statement": "..." }`, the prediction has the pinned evaluator's fields, and neither the output metadata nor trajectory contains the sentinels.
- [x] Run the test with Node 22 and observe failure because the adapter is absent.
- [x] Add the fixture runner: validate all IDs, reject duplicates and malformed input, create a new output directory exclusively, pass each projected statement once to a worker through stdin with a restricted environment, and write an explicitly synthetic trajectory and ID-keyed `preds.json`.
- [x] Rerun the test and observe success.

### Task 2: Distinguish incomplete outcomes and grading

- [x] Add a fixture containing completed, model-failure, skipped, timeout, and malformed-worker cases; assert separate statuses, no selected retry, empty predictions for failed cases, and a nonzero exit for incomplete runs.
- [x] Implement and verify those outcomes, with timeout enforced by the existing process boundary; do not print worker stderr or credentials.
- [x] Add a separate synthetic evaluator that exits nonzero and assert its failure is not reported as a model failure. Run it only after every rollout; never feed its output into workers.
- [x] Verify the synthetic evaluator output is labelled as such and cannot be confused with an official report.

### Task 3: Fail-closed real-run preflight

- [x] Add a preflight test using a fake Docker command and absent key/budget; assert nonzero `incomplete`, no secrets or command output, and no context-changing Docker calls.
- [x] Implement preflight: bounded read-only Docker server probe, Node/build/key/model/budget checks, dataset snapshot integrity check, and unconditional blockers for real isolation, temporal guard and complete real trajectories. Do not start containers or contact model providers.
- [ ] Add `bench:swe-live` and run the targeted test, formatting, lint/type checks and the applicable package verification under Node 22. Record gaps honestly.

## Real-run boundary

This prototype cannot launch Moss against official tasks and its synthetic trajectories are not submission evidence. The prepared directory separates `rollout/dataset.jsonl` (only ID and problem statement) from `evaluator/dataset.jsonl` (full, sensitive evaluation fields). The whole prepared directory must not be mounted into an agent container; a future runner must pass only a single selected problem statement to each agent. The private JSONL export format is pinned by locally verified hashes; those JSONL hashes are adapter results, not upstream-published dataset hashes. On Windows, place the prepared directory under a user-private parent with appropriate ACLs; POSIX mode bits do not establish Windows access control.

```bash
# Download the pinned public snapshot into a new directory.
curl -fL https://huggingface.co/datasets/SWE-bench-Live/SWE-bench-Live/resolve/1653fb720eddacf4b16f775c9b4d0bdf3914fbaa/data/lite-00000-of-00001.parquet -o /path/to/lite.parquet

# Build first; use Python >= 3.10 with pyarrow in an isolated environment.
# The verified conversion here used pyarrow 20.0.0. On Windows the venv Python
# normally lives in Scripts/python.exe rather than bin/python.
node scripts/bench-swebench-live.mjs prepare --parquet /path/to/lite.parquet --output /path/to/new-prepared-directory --python /path/to/python
node scripts/bench-swebench-live.mjs preflight --dataset /path/to/new-prepared-directory --budget-usd 10
node test/bench-swebench-live.spec.mjs
```

The `prepare` command checks the pinned Parquet SHA-256 before decoding; `preflight` checks both exported JSONL hashes and returns exit 2 while any implementation, Docker, provider or cost prerequisite is unresolved. The read-only Docker probe does not forward `SSH_AUTH_SOCK`; a `docker_server` blocker means the server could not be verified under that restricted environment, not necessarily that the daemon is stopped. SSH-agent-only remote contexts need separate authorized verification. A budget argument is a planning input, not an enforced spending limit. The fixture command accepts `fixture --dataset <synthetic.jsonl> --output <new-directory> --worker <fake-worker.mjs>` and optionally `--evaluator <fake-evaluator.mjs>`; every input row must explicitly contain `"synthetic_fixture": true`. Its output is synthetic. Fixture worker programs execute as ordinary host processes without a sandbox: use only trusted fake programs and artificial data, never the official dataset or a real model.

Before implementing a real rollout path, execute Moss inside the correct official image with no dataset or evaluator mounts, prevent access to post-issue information, provide credentials without argv/log exposure, capture every real model input/output and initial prompt, and test failure/timeout/cleanup with a disposable daemon. Determine model pricing and an enforceable total spending cap before any paid rollout. Provision and verify the pinned Python-only evaluator and Docker resources separately. The upstream evaluation guide estimates approximately 4 CPUs and 16 GB RAM per instance, with some large repositories requiring more; actual Lite requirements and throughput must be measured on the execution host.

After a separately implemented compliant rollout has finished, verify that the real predictions contain exactly the 300 unique IDs in the locked rollout dataset, with no missing or extra IDs and no second rollout. Keep model failures, skips and timeouts in the per-instance record and represent them with empty patches; do not silently drop them or use only submitted/successful instances as the denominator. Any unattempted or skipped work leaves the run incomplete. The upstream evaluation guide permits reporting a gold-valid denominator; if that is used later, record the actual gold evaluation procedure, excluded IDs and denominator explicitly. This session has not run gold evaluation.

Run the pinned upstream Python-only evaluator from a fresh evaluation-only directory with the pinned source installed in the Python environment. The following POSIX example clears the inherited environment **before** starting that Python, so model keys cannot reach its startup hooks or the evaluator. It uses the default Docker client configuration; a custom Docker context requires a separately sanitized environment with the necessary `DOCKER_*` variables set without putting credential values in argv. `-X utf8` makes local JSONL decoding consistent:

```bash
/usr/bin/env -i PATH="$PATH" HOME="$HOME" /path/to/python -X utf8 -m swebench.harness.run_evaluation --dataset_name /path/to/new-prepared-directory/evaluator/dataset.jsonl --split lite --namespace starryzhang --predictions_path /path/to/real-preds.json --max_workers 1 --run_id moss-live-lite
```

For Windows, this PowerShell 7 example starts Python with an allowlisted environment; substitute absolute paths and an existing, fresh evaluation-only working directory. Docker values are supplied through the environment, never command-line arguments. Neither evaluator example forwards `SSH_AUTH_SOCK`; a remote context requiring an SSH agent needs a separately authorized environment:

```powershell
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = 'C:\path\to\python.exe'
$start.WorkingDirectory = 'C:\path\to\evaluation-only-directory'
$start.UseShellExecute = $false
$start.EnvironmentVariables.Clear()
foreach ($name in @('Path','SystemRoot','USERPROFILE','TEMP','TMP','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_API_VERSION')) {
  $value = [Environment]::GetEnvironmentVariable($name, 'Process')
  if ($null -ne $value) { $start.EnvironmentVariables[$name] = $value }
}
@('-X','utf8','-m','swebench.harness.run_evaluation','--dataset_name','C:\path\to\prepared\evaluator\dataset.jsonl','--split','lite','--namespace','starryzhang','--predictions_path','C:\path\to\real-preds.json','--max_workers','1','--run_id','moss-live-lite') | ForEach-Object { $start.ArgumentList.Add($_) }
$process = [System.Diagnostics.Process]::Start($start)
$process.WaitForExit()
$process.ExitCode
```

The evaluator must run only after all rollouts and its test output must never be fed back to the agent. At upstream revision `ad79b850`, the aggregate report is written in the evaluator's current directory as `<model_name_or_path>.moss-live-lite.json` (slashes in the model name become `__`); the code creates `--report_dir` but does not pass it to `make_run_report`. Inspect that actual report and error/incomplete IDs rather than inferring success from the process exit code; an official submission expects the real report as `results.json`. This session has not run the official evaluator, contacted a model or submitted anything. Do not submit or publish without a separate explicit instruction.
