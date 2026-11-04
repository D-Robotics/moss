# CI and verify: one gate in about a minute

Status: implemented 2026-11-04. This note replaces the 2026-09/10 workflow (3
OS x 2 Node suite matrix, artifact-based summary gate, date-controlled Windows
blocking). The behavior spec suite referenced by the old design was removed by
the repository owner on 2026-11-04; this note describes what is verified now.

Standing decision (2026-11-04, owner request): this repository does not
reintroduce a behavior spec suite. New checks belong in
`scripts/verify/stages/` or `bench/`; extend the gate instead of duplicating
it.

## Product goal

A gate is worth what its latency is worth. A 30-minute suite on every push is
skipped, deferred, or ignored; a one-minute gate is run. So the design starts
from the feedback loop, not from "what could be tested":

- every push gets a verdict in about a minute;
- the developer runs the exact command CI runs;
- every claim in the verdict is backed by a real exit code, printed in the log;
- the fast gate never pretends to prove more than it does (see "What this does
  not prove").

## What is verified

`scripts/verify/cli.mjs` is the only entry point. A stage is one check with
declared dependencies and its own output; CI and `package.json` call the same
stages.

| Stage      | Check                                                                                 | Needs        | Measured (local, warm cache) |
| ---------- | ------------------------------------------------------------------------------------- | ------------ | ---------------------------- |
| `static`   | `prettier --check .`, `eslint .`, `tsc --noEmit` (run concurrently)                   | node_modules | 18.0s                        |
| `build`    | `tsc -p tsconfig.build.json` (incremental; `--clean` for a full rebuild), build stamp | node_modules | 7.5s                         |
| `smoke`    | `moss --version`, `--help`, `config --help` with a clean env, PTY startup (Unix)      | build        | 4.3s                         |
| `examples` | `examples/headless-run.mjs`, `repl-host.mjs`, `custom-tool-approval.mjs` (offline)    | build        | 0.8s                         |

Measured total on 2026-11-04 (8-core Apple laptop, warm node_modules):
**30.9s** for `npm run verify` (static + build + smoke + examples). The CI job
enforces `VERIFY_BUDGET_SECONDS=60` on the gate itself; exceeding it fails the
job, so the contract cannot silently rot.

## What this does not prove

This section is part of the design, not a disclaimer hidden in a log.

- **No behavior regression suite.** The 504 `test/*.spec.mjs` files were
  deleted on 2026-11-04. Nothing today runs the agent loop, tools, providers,
  permissions, TUI, MCP, device or task-runtime behavior automatically. The
  gate proves the tree compiles, the CLI boots, and the three embedding
  examples still work. Git history (up to commit `01a16fd7`) still holds the
  suite if it is ever restored.
- **No install e2e.** The documented `npm ci` + `npm install -g --install-links`
  path is not executed by any automated gate.
- **No real terminals.** PTY startup is checked by `smoke` on Unix; tmux /
  screen / Terminal.app behavior is only covered by the opt-in
  `npm run bench:tui-feel` path.
- **Windows** runs the same gate in the deep workflow, but the smoke stage
  skips the PTY check there (no `pty` module).
- **Benchmarks** (`npm run bench*`) and device/RDK paths are never part of CI.

## Invariants

1. **One entry point.** `scripts/verify/cli.mjs`; `package.json` scripts are
   thin aliases. If CI needs a variation, it is a flag, not a second script.
2. **No hidden builds.** CI installs with `npm ci --ignore-scripts`; the build
   is an explicit stage. The prepare hook's implicit build would otherwise run
   twice per job (once at install, once for the gate).
3. **Fail loudly.** Missing `dist/cli.js`, missing tool binaries, a stale
   incremental build, or an over-budget gate is a failure with an annotation,
   never a green line.
4. **One required status per workflow.** The fast workflow has one job
   (`Fast gate`); the deep workflow aggregates its matrix in `ci-gate.mjs`
   (`Deep gate`). No artifact passing, no "reported but non-blocking" rows, no
   date-controlled switches.
5. **Evidence is recorded.** The CLI appends a per-stage table to
   `$GITHUB_STEP_SUMMARY`; `ci-gate.mjs` appends the per-leg table. A verdict
   can be read without scrolling logs.
6. **The gate is tested by being run.** `npm run verify` fails on its own
   contract (stage crash, over budget), and the workflow runs it unchanged.

## Workflows

### `.github/workflows/ci.yml` — per push / PR

One Ubuntu job on Node 22.16.0:

1. checkout, setup-node (npm cache);
2. restore `node_modules` from `actions/cache` keyed by the lockfile hash (the
   install step is the largest fixed cost; a cache miss falls back to `npm ci`);
3. `npm run verify` with `VERIFY_BUDGET_SECONDS=60`.

Design target: **about a minute of wall clock on a cache hit** (checkout +
cache restore + 31s gate). A cache miss is slower by construction; the 60s
budget applies to the gate, not to GitHub's runner setup. A hard, guaranteed
sub-minute wall clock for the whole job would require a pre-warmed/self-hosted
runner; hosted runners pay a fixed checkout/install cost that cannot be
removed from the job.

Why one job and not a matrix: parallel jobs are the only way to cut coverage
latency, but each extra job pays its own install cost and multiplies the
required statuses. Per-push coverage on one OS is enough to catch the common
break; the OS matrix is the next tier.

### `.github/workflows/deep.yml` — nightly, tags, manual

The same gate on `ubuntu-latest` / `macos-latest` / `windows-latest` at Node
22.16.0 plus `ubuntu-latest` at Node 24 (runtime-version coverage is
OS-independent, so one Linux leg is enough), aggregated by `Deep gate`
(`scripts/verify/ci-gate.mjs`, fed by `toJSON(needs)`). Nightly cost is four
short jobs; a version tag carries the same matrix as release evidence.

## Branch protection

There is currently **no** branch protection on `main`; the single required
status is a repository setting, not a workflow property. When it is enabled,
require exactly `Fast gate` (and, for tag/release discipline, let the
`Deep verification` workflow stay advisory). Reference command:

```bash
gh api -X PUT repos/D-Robotics/moss/branches/main/protection \
  -F required_status_checks.strict=true \
  -f 'required_status_checks.contexts[]=Fast gate' \
  -F enforce_admins=false \
  -F required_pull_request_reviews=null \
  -F restrictions=null
```

Enabling protection blocks direct pushes to `main`; that is a product decision,
not part of this design.

## Adding a check

1. Add `scripts/verify/stages/<name>.mjs` exporting
   `stage = { name, requires, description, async run(context) }`. Return
   `{ ok: true }` or `{ ok: false, detail }`; print `[<name>] ...` lines.
2. Register it in `scripts/verify/cli.mjs` (`STAGES` and `ORDER`). Add it to
   `FAST_GATE` only if it fits the 60s budget; otherwise put it in a workflow
   step or make it opt-in via a flag.
3. Update the tables here and the command table in `AGENTS.md`.
4. If it needs tools CI must install, prefer a workflow step that installs the
   tool and then calls the same stage, so local and CI share the check.

## Cost

- Per push: one ~1-minute Ubuntu job (cache hit) instead of six suite legs
  (~33 minutes wall, ~1h worst observed) plus a summary job and artifact
  storage.
- Nightly: four short legs plus one gate job.
- Tags: the same matrix, so release evidence no longer depends on a manual
  `npm run verify` claim.
