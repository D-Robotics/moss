# Agent capability regression CI

Moss is an AI agent harness, not just a library — `npm run verify` checks
that the *code* builds/types/lints/tests, but it cannot tell whether Moss
*as an agent* still reads files, calls tools in the right order, fixes
bugs end-to-end, or has degraded since the last change. That is the job of
a separate capability regression suite, run by
[`moss-ci`](https://github.com/1-ztc/ci_test) (PR
[#1](https://github.com/1-ztc/ci_test/pull/1)).

## What it runs

On every push/PR to `main` or dated working branches, the
`moss-ci.yml` workflow:

1. builds Moss from source (`npm run build --workspace @rdk-moss/agent`),
2. installs moss-ci from `1-ztc/ci_test@feat/implementation`,
3. writes a temporary model config from the `MOSS_API_KEY` secret (Moss
   never reads model settings from env vars, so this is written to a
   one-shot config.json on the runner),
4. runs a 13-test capability suite against the freshly-built Moss, then
5. diffs the result against the last run on the same branch and writes
   the report (`new_failure` / `fixed` / `improved` / `degraded`) to the
   job summary visible on the PR's Checks tab.

## Two layers (cost control)

- **quick** — every push/PR. ~9 single-turn tests (tool calls, code
  understanding, stability, quality) with flake detection. ~2-3 min.
- **full** — `workflow_dispatch` (manual) + nightly schedule. Adds the
  multi-step end-to-end tasks (autonomous bug-fix, read-process-write).
  ~10+ min, costs API quota.

`moss-ci run ... --tag quick` / `--tag full` selects the layer; the
suite's `tags:` field tags each test.

## Required secrets

- `MOSS_API_KEY` — the apiKey for the model Moss calls.
- `MOSS_CI_JUDGE_API_URL` *(optional)* — OpenAI-compatible
  `/chat/completions` endpoint for the `llm_judge` evaluator. Without it,
  quality tests use a default score.

## What the tests actually verify

Every assertion is designed so Moss can only pass by genuinely working —
e.g. extract a random token (`ZETA-7741-NOVA`) planted in a fixture file,
which Moss cannot guess without actually calling `read_file`. Coverage:

| Dimension | Tests | Evaluator |
|---|---|---|
| Tool calls | read_file / write_file / multi-step sequence + args | `tool_sequence`, `tool_args` |
| File side effects | write / modify a file | `side_effect` (`file_modified`) |
| Multi-step end-to-end | autonomous bug-fix; read-process-write | `side_effect` (`tests_pass`) |
| Code understanding | division-by-zero, empty-list, count | `contains` |
| Stability | key tests run 3× | flake detection |
| Quality | code review scored by an LLM | `llm_judge` |

Tool calls and file modifications are extracted from Moss's session
jsonl (`<cwd>/.moss/sessions/*.jsonl`), which records Anthropic-style
`tool_use` blocks with their `input`.

## Custom Anthropic-protocol endpoints

Moss's `anthropic` provider authenticates with `x-api-key` against the
official `api.anthropic.com`, but switches to `Authorization: Bearer`
for any custom `baseUrl` (e.g. an internal gateway) — so a custom
Anthropic-protocol endpoint works without code changes. See
`packages/moss-agent/src/provider/anthropic.ts` and
`packages/moss-agent/src/cli/providers.ts`.

## Running locally

```bash
# point moss-ci at a built Moss + model config
export MOSS_CLI_COMMAND='node /path/to/moss/packages/moss-agent/dist/cli.js --config-file /path/to/.moss/config.json'
# quick layer
moss-ci run examples/moss_capabilities.yaml --tag quick --no-fail-fast
# compare against the last run
moss-ci history
moss-ci diff <prev_run_id> <curr_run_id>
```
