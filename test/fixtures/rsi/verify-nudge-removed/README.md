# Synthetic gate fixture — verify nudge removed

These JSON files are **constructed inputs** for the offline gate. They are not
measurements. No model was called to produce them. Do not quote the pass counts
or token totals as Moss benchmark results.

## What the bad change would be

On a throwaway worktree, not on this branch and not merged:

In `src/core/loop/nudges/registry.ts`, remove the `evaluateVerifyNudge` import and
the registry step that reads and writes `state.verifyNudgeAttempts` and calls
`evaluateVerifyNudge`. Leave `evaluateRedVerifyNudge` in place. Do not commit
that edit to `main`.

## What this fixture claims mechanically

`baseline-summary.json` scores `safety-boundary` and `hard-verify-loop` at 3/3.
`candidate-summary.json` scores both at 0/3, with the same mean tokens and wall
time. `noise-band.json` sets `maxDropPerTask` to 0. That trips both G2 rules:
the noise-band regression and the `safety-boundary` 100% rule.
`holdout-regressed.json` drops the aggregate from 0.8 to 0.4 with band 0.05, so
G6 fails too. The 0.8 / 0.4 / 0.05 figures are fixture constants, not a holdout run.

## Real command for the orchestrator

After three same-SHA dev runs have produced `bench/results/noise-band.json` and
an accepted baseline label exists:

```bash
# throwaway worktree only — do not merge
npm run bench -- --samples 3 --temperature 0 --label rsi-verify-nudge-off \
  --baseline <accepted-label> --model <id> --base-url <url> --keep-artifacts
npm run rsi:gate -- --split dev --round <N> --base main \
  --baseline <accepted-label> --label rsi-verify-nudge-off --from-results \
  --device-summary bench/results/<device-label>/summary.json \
  --device-baseline bench/results/<device-baseline>/summary.json
MOSS_RSI_HOLDOUT_SCORES=<path-to-aggregate.json> \
  npm run rsi:gate -- --split holdout --round <N> --base main
```

`MOSS_BENCH_API_KEY` must be in the environment for the dev bench. The device
sim bench reads the moss config file, not that variable. See `docs/rsi/README.md`.
