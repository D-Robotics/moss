# Round 1 — subtraction

First self-evolution round: measure what happens when loop nudges are removed. This change adds the switch and the candidate list. It does not delete any nudge. With `MOSS_DISABLE_NUDGES` unset, empty, or whitespace, behavior matches the previous build.

Ids are case-sensitive. Unknown ids do nothing. A disabled nudge is not injected and does not advance its once-per-run counter (red-wave resets included).

Token counts on each id are `ceil(chars / 4)` on the English text the code actually emits, including a short sample excerpt where the nudge quotes tool output. They are the cost **when the nudge fires**. Most runs pay 0 for a given id.

`safety-boundary` is not one of these reminders. An ablation that drops it below 100% fails the round even if other tasks rise. It is in the acceptance-family slice. Device tasks (`device-*`, `task-os-b-device`) are not in this round: they skip unless `MOSS_DEVICE_HOST` is set, and the device-bench runner does not forward this variable. Do not set `MOSS_DEVICE_TRUST`, do not pass `--trust-device`, and do not set `MOSS_GOAL_VERIFY_LOOP`.

## Switch

```bash
MOSS_DISABLE_NUDGES=todo,verify
```

Stable ids live in `NUDGE_IDS` (`src/core/loop/nudges/disable.ts`). Call sites consult `isNudgeDisabled`. `moss config env` lists the variable under runs, loops, and budgets.

`scripts/run-benchmark.mjs` builds a fresh child environment and copies `MOSS_DISABLE_NUDGES` onto that allowlist when the parent set the key (including an explicit empty value). Unset in the parent means the key is absent in the child. The module does not read `/proc` or the parent command line, so the same command works on Linux, macOS, and Windows. That runner is frozen; the one-line allowlist edit is the harness-maintenance exception in `docs/rsi/README.md`. `scripts/bench-device.mjs` is unchanged.

## Budget

A full dev bench run is about 11M tokens. Three measured runs scored 0.893 / 0.920 / 0.920. Twenty-eight full-set ablations would be about 300M tokens. This round does not do that.

Ablate **families** first. A family run disables every id in the family at once, on only the tasks its predictions name, plus a small control set. Split a family into single ids only when that family ablation is neutral-or-better on its slice. A regression means the family stays; do not spend the split.

**Neutral-or-better** means every concern task's pass count is at least its paired baseline on this same slice. One control task moving is a surprise to record, not by itself a reason to split. `safety-boundary`, when it is in the slice, must stay at 100%.

`--tasks <n>` draws a random subset of n tasks (default seed `moss-bench`, and it keeps `safety-boundary`). These ablations do not use it. They pass repeatable `--task <id>`. The match is `task.id.includes(substr)`. Pass the full id so `hard` does not pull in every hard task and `task` does not pull in `task-os-b-device`.

Cost model, so a family stays under about 2M tokens. The 11M figure is one `--samples 3` run of the 26 non-device tasks. Their `maxTurns` sum to 450. A slice is estimated as:

```text
11e6 * (sum of maxTurns of the selected tasks) / 450 * (samples / 3)
```

`maxTurns` over-weights tasks that stop early and under-weights a task that spends more tokens per turn than that share. The two long tasks (`hard-long-recall` 110, `compaction-recall` 40) are the ones that can break the cap, so families that include them use `--samples 1` and do not grow. Do not raise samples and do not add tasks.

Control pool: the five dev tasks with `maxTurns` ≤ 8, shuffled once with mulberry32 seed 1. Order: `skills-usage`, `no-interaction`, `error-recovery`, `capability-mcp-ledger`, `single-edit`. Each family appends the first three of those that are not already in its concern set.

Paired baseline: the same flags and task list, variable unset, label `abl-<family>-base`. Keep `<model>` and `<url>` identical across a family, its baseline, and any later split.

| family     | ids                                                                                         | samples | tasks                                                                                                                                                                                 | estimate |
| ---------- | ------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| tool-hints | web-tools, git-tools, install-tools, run-tests, build-tools, background-server              | 3       | background-process + skills-usage, no-interaction, error-recovery                                                                                                                     | 0.88M    |
| verify     | verify, red-verify                                                                          | 2       | test-fix-loop, hard-wrong-fix-rejected, hard-multi-hypothesis, hard-race-condition, hard-perf-regression, hard-spec-contradiction, hard-contradictory-validation + the three controls | 1.76M    |
| subagent   | fan-out, subagent-running, subagent-stopped, background-completion                          | 2       | subagent-fanout, background-process + the three controls                                                                                                                              | 0.91M    |
| retry      | reasoning-only, output-continuation, missing-tool-call, empty-response, truncated-tool-json | 1       | search-locate-fix, hard-long-recall, long-horizon-refactor, hard-dependency-conflict, multi-file-consistency, compaction-recall + the three controls                                  | 1.96M    |
| steering   | the five `steering-*` rules                                                                 | 1       | error-recovery, search-locate-fix, long-horizon-refactor, hard-long-recall, compaction-recall + skills-usage, no-interaction, capability-mcp-ledger                                   | 1.79M    |
| acceptance | acceptance-gate, task-repair, goal-acceptance（已随 LoopScheduler 退役）                    | 2       | task-os-a-coding, task-os-c-failure-repair, safety-boundary + the three controls                                                                                                      | 0.95M    |
| plan       | todo, ambiguity, follow-up-guard                                                            | 2       | long-horizon-refactor, multi-file-consistency, single-edit, test-fix-loop, error-recovery, no-interaction, hard-ambiguous-spec + skills-usage, capability-mcp-ledger                  | 1.63M    |

The seven family runs are about 9.9M tokens. Seven paired baselines are another 9.9M. Splitting every family (only if each one is neutral-or-better) is about 39M more. Worst case for the round is about 59M tokens, not 300M.

## Family commands

Replace `<model>` and `<url>`. `--keep-artifacts` stays on so a regression can be read from the run. Temperature stays at the runner default of 0. Leave `--temperature` off these commands: `--temperature 0` reads a second argument, so the next flag is discarded and the run errors. `--temperature none` is the branch that does not.

### `tool-hints`

Mechanism: the user named a tool class (web, git, install, tests, build, or a long-running server) and the model has called something else. The reminder says to call that class for real. Only `background-server` has a dev task that matches (`background-process`, the prompt says `long-running`). The other five are predicted neutral; the control tasks are where a surprise would show.

```bash
npm run bench -- --samples 3 --label abl-tool-hints-base --keep-artifacts --model <model> --base-url <url> --task background-process --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=web-tools,git-tools,install-tools,run-tests,build-tools,background-server npm run bench -- --samples 3 --label abl-tool-hints --keep-artifacts --model <model> --base-url <url> --task background-process --task skills-usage --task no-interaction --task error-recovery
```

### `verify`

Mechanism: after several edits, or after a red suite, push the model to run the real test command again. Predicted movers are the fix tasks below. `single-edit` is not in the concern set (often too short to fire); it is also not in this family's control draw.

```bash
npm run bench -- --samples 2 --label abl-verify-base --keep-artifacts --model <model> --base-url <url> --task test-fix-loop --task hard-wrong-fix-rejected --task hard-multi-hypothesis --task hard-race-condition --task hard-perf-regression --task hard-spec-contradiction --task hard-contradictory-validation --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=verify,red-verify npm run bench -- --samples 2 --label abl-verify --keep-artifacts --model <model> --base-url <url> --task test-fix-loop --task hard-wrong-fix-rejected --task hard-multi-hypothesis --task hard-race-condition --task hard-perf-regression --task hard-spec-contradiction --task hard-contradictory-validation --task skills-usage --task no-interaction --task error-recovery
```

### `subagent`

Mechanism: a child was started, failed, stopped, or a background command finished, and the parent should not invent the outcome. `fan-out` / `subagent-running` / `subagent-stopped` concern `subagent-fanout`. `background-completion` concerns `background-process`.

```bash
npm run bench -- --samples 2 --label abl-subagent-base --keep-artifacts --model <model> --base-url <url> --task subagent-fanout --task background-process --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=fan-out,subagent-running,subagent-stopped,background-completion npm run bench -- --samples 2 --label abl-subagent --keep-artifacts --model <model> --base-url <url> --task subagent-fanout --task background-process --task skills-usage --task no-interaction --task error-recovery
```

### `retry`

Mechanism: the model produced reasoning only, a length-truncated answer, a Chinese web plan with no tool call, an empty completion, or truncated tool-call JSON, and the loop injects one more chance. The long tasks in this set are why the sample count is 1. Estimate 1.96M; do not add a sample.

```bash
npm run bench -- --samples 1 --label abl-retry-base --keep-artifacts --model <model> --base-url <url> --task search-locate-fix --task hard-long-recall --task long-horizon-refactor --task hard-dependency-conflict --task multi-file-consistency --task compaction-recall --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=reasoning-only,output-continuation,missing-tool-call,empty-response,truncated-tool-json npm run bench -- --samples 1 --label abl-retry --keep-artifacts --model <model> --base-url <url> --task search-locate-fix --task hard-long-recall --task long-horizon-refactor --task hard-dependency-conflict --task multi-file-consistency --task compaction-recall --task skills-usage --task no-interaction --task error-recovery
```

### `steering`

Mechanism: cooldown rules that fire on repeated tool errors, repeated local listing, repeated web queries, a long tool chain, or a full context window. `error-recovery` is a concern task, so the control draw skips it and takes the next three cheap ids.

```bash
npm run bench -- --samples 1 --label abl-steering-base --keep-artifacts --model <model> --base-url <url> --task error-recovery --task search-locate-fix --task long-horizon-refactor --task hard-long-recall --task compaction-recall --task skills-usage --task no-interaction --task capability-mcp-ledger
MOSS_DISABLE_NUDGES=steering-error-recovery,steering-local-exploration-loop,steering-web-search-variation,steering-tool-loop,steering-context-pressure npm run bench -- --samples 1 --label abl-steering --keep-artifacts --model <model> --base-url <url> --task error-recovery --task search-locate-fix --task long-horizon-refactor --task hard-long-recall --task compaction-recall --task skills-usage --task no-interaction --task capability-mcp-ledger
```

### `acceptance`

Mechanism: a task contract exists and the loop will not let the run end without a verdict, a repair, or (only when `MOSS_GOAL_VERIFY_LOOP=1`, which these commands do not set) the goal-failure tail. `goal-acceptance` 已随 LoopScheduler 退役：未知 id 会被忽略，下面的命令仍能跑，但不再关掉任何注入。`safety-boundary` is here so a family that drops it below 100% fails the round.

```bash
npm run bench -- --samples 2 --label abl-acceptance-base --keep-artifacts --model <model> --base-url <url> --task task-os-a-coding --task task-os-c-failure-repair --task safety-boundary --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=acceptance-gate,task-repair,goal-acceptance npm run bench -- --samples 2 --label abl-acceptance --keep-artifacts --model <model> --base-url <url> --task task-os-a-coding --task task-os-c-failure-repair --task safety-boundary --task skills-usage --task no-interaction --task error-recovery
```

### `plan`

Mechanism: open a checklist, stop and ask on an either/or request, or turn "I will run the command" narration into a real tool call. `error-recovery`, `no-interaction`, and `single-edit` are already concerns, so the control draw adds `skills-usage` and `capability-mcp-ledger` only.

```bash
npm run bench -- --samples 2 --label abl-plan-base --keep-artifacts --model <model> --base-url <url> --task long-horizon-refactor --task multi-file-consistency --task single-edit --task test-fix-loop --task error-recovery --task no-interaction --task hard-ambiguous-spec --task skills-usage --task capability-mcp-ledger
MOSS_DISABLE_NUDGES=todo,ambiguity,follow-up-guard npm run bench -- --samples 2 --label abl-plan --keep-artifacts --model <model> --base-url <url> --task long-horizon-refactor --task multi-file-consistency --task single-edit --task test-fix-loop --task error-recovery --task no-interaction --task hard-ambiguous-spec --task skills-usage --task capability-mcp-ledger
```

## Not a switch

`src/prompts/` has no injected reminder text. `src/prompts/plan-detection.ts` is only the regex the follow-up guard uses. `src/contracts/prompts/` is the always-on system prompt, not a per-turn nudge.

`src/core/agent/` has no nudge of its own except the follow-up guard wiring (`follow-up-guard` below) and the best-of-n status string when sub-agent spawn is unavailable (`src/core/agent/moss-agent.ts`, the "best-of-n fix engine unavailable" return). That status is an engine report, not a soft reminder, and it stays on.

| id                   | where                                      | why it is not disabled                                                                                                                                                                       |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell-soft-failure` | `src/safety/shell-soft-failure-hint.ts:24` | `src/safety/**` is frozen. No production caller appends it today (only `test/mcp-rdk-docs.spec.mjs` calls `appendShellContinueHint`). Naming the id in the env does not change the function. |
| tool loop guard      | `src/core/tools/tool-loop-guard.ts:283`    | Hard stop: the tool call does not run, and the message is the reason. Removing only the text would leave a silent block. This round does not change tool control flow.                       |

### `shell-soft-failure` (listed, frozen)

- **Trigger:** `exec` or `device_exec` result with a non-zero exit, "No such file or directory", or stderr that matches error/cannot/failed, and the marker is not already present (`shouldAppendShellContinueHint`, line 5).
- **Text:** `[编排提示 · 须继续]` plus a must-call-another-tool paragraph. Local exec is about 153 characters (~39 English-style tokens, higher for Chinese). Device exec is about 185 characters.
- **Prevents:** ending the turn by restating a failed shell command.
- **Prediction:** no bench movement, because the tool path never appends it. There is no ablation command.

## Candidates

Each id keeps its trigger, text, and prediction. The run is the family slice above, not the full dev set. The **Split** line is the single-id command. Run it only after that family ablation is neutral-or-better, with the same tasks and samples as the family.

### `todo`

- **Where:** `src/core/loop/nudges/todo-nudge.ts:60` (fires from `evaluateTodoNudge`, line 34).
- **Trigger:** turns ≥ 3, tool calls ≥ 3, no `todo_write` / `task_define` / `task_plan_update`, user text looks multi-step (coding verb, numbered steps, or longer than 200 characters). Once per run.
- **Text:**

  ```text
  [System] This looks like multi-step work and you have not used `todo_write` yet. Open a short checklist now (3–7 items, exactly one `in_progress`), then continue. Keeping the plan in a tool result prevents losing the thread on long fixes/refactors. Skip only if the remaining work is truly a single trivial step.
  ```

- **Tokens:** ~78 when it fires.
- **Prevents:** losing the plan on a long edit sequence.
- **Prediction:** `task-os-*` should not move: `task_define` already silences this nudge. `long-horizon-refactor` and `multi-file-consistency` can regress if the checklist was what kept the rename/delete list intact, or improve if opening the list burned a turn. `single-edit` should stay flat (often under the 3-turn bar).
- **Split:** only after family `plan` is neutral-or-better. `MOSS_DISABLE_NUDGES=todo npm run bench -- --samples 2 --label abl-todo --keep-artifacts --model <model> --base-url <url> --task long-horizon-refactor --task multi-file-consistency --task single-edit --task test-fix-loop --task error-recovery --task no-interaction --task hard-ambiguous-spec --task skills-usage --task capability-mcp-ledger`

### `verify`

- **Where:** `src/core/loop/nudges/verify-nudge.ts:103` (`evaluateVerifyNudge`, line 64).
- **Trigger:** turns ≥ 3, weighted edits ≥ 2, user asked for a code change, no `run_tests` / `verify_fix`. For fix/implement wording, `code_diagnostics` and a bare `exec` do not silence it. Once per run.
- **Text:**

  ```text
  [System] You have already edited code several times without running verification. Before more edits: call `run_tests` or `verify_fix` (required for fix/implement — diagnostics/tsc/`npm run check` alone is not enough), or `exec` with a clear test command. Use the real output to decide the next fix. Do not keep patching while blind to whether the suite is green.
  ```

- **Tokens:** ~91 when it fires (fix/implement wording).
- **Prevents:** more patches before any suite run.
- **Prediction:** regress `test-fix-loop`, `hard-wrong-fix-rejected`, and `hard-multi-hypothesis` if the model keeps editing after two patches without `node test.js`. `single-edit` is often too short to fire, so it should stay flat. Tokens should fall on the long fix tasks where it was firing.
- **Split:** only after family `verify` is neutral-or-better. `MOSS_DISABLE_NUDGES=verify npm run bench -- --samples 2 --label abl-verify --keep-artifacts --model <model> --base-url <url> --task test-fix-loop --task hard-wrong-fix-rejected --task hard-multi-hypothesis --task hard-race-condition --task hard-perf-regression --task hard-spec-contradiction --task hard-contradictory-validation --task skills-usage --task no-interaction --task error-recovery`

### `red-verify`

- **Where:** `src/core/loop/nudges/red-verify-nudge.ts:239` (`evaluateRedVerifyNudge`, line 212).
- **Trigger:** latest runtime verification result (`run_tests`, `verify_fix`, or a test-shaped exec) is red. A later green `code_diagnostics` does not clear it. At most twice per red wave; a later green runtime result resets the counter.
- **Text:** `[System] The latest runtime verification result is RED (<tool>). Do not keep editing blindly.` plus up to four lines of output, then an instruction to fix and re-run the same suite.
- **Tokens:** ~111 with a short excerpt; the excerpt is the variable part.
- **Prevents:** treating a red suite as done, or "fixing" it with a green typecheck only.
- **Prediction:** regress `test-fix-loop`, `hard-race-condition`, and `hard-perf-regression`, where the first `node test.js` is red and the pass requires a later green run. `hard-spec-contradiction` and `hard-contradictory-validation` can improve if the nudge was pushing a green suite that the spec makes impossible, and the model was burning turns. `safety-boundary` should stay at 100%.
- **Split:** only after family `verify` is neutral-or-better. `MOSS_DISABLE_NUDGES=red-verify npm run bench -- --samples 2 --label abl-red-verify --keep-artifacts --model <model> --base-url <url> --task test-fix-loop --task hard-wrong-fix-rejected --task hard-multi-hypothesis --task hard-race-condition --task hard-perf-regression --task hard-spec-contradiction --task hard-contradictory-validation --task skills-usage --task no-interaction --task error-recovery`

### `fan-out`

- **Where:** `src/core/loop/nudges/fan-out-nudge.ts:179` (failure) and `:210` (success without suite evidence). `evaluateFanOutNudge`, line 164.
- **Trigger:** latest `fan_out_subagents` / `create_subagent` / `subagent_status` result is failed or empty; or, on a fix/implement ask, children report success without green suite evidence and the parent has not run `run_tests` / `verify_fix`. Once per run.
- **Text (failure):** verbatim start, then an excerpt and a merge/re-run instruction.

  ```text
  [System] Latest `<tool>` has FAILED or empty children. Do not invent overall success.
  ```

- **Tokens:** ~125 with a short failure excerpt.
- **Prevents:** declaring success from a failed or untested fan-out.
- **Prediction:** regress `subagent-fanout` if a child fails and the parent writes `tokens.txt` from invented values. Other dev tasks do not ask for fan-out, so they should stay flat. The success-without-tests branch should not fire on `subagent-fanout` (the prompt is not a fix/implement ask).
- **Split:** only after family `subagent` is neutral-or-better. `MOSS_DISABLE_NUDGES=fan-out npm run bench -- --samples 2 --label abl-fan-out --keep-artifacts --model <model> --base-url <url> --task subagent-fanout --task background-process --task skills-usage --task no-interaction --task error-recovery`

### `ambiguity`

- **Where:** `src/core/loop/nudges/ambiguity-nudge.ts:61` (`evaluateAmbiguityNudge`, line 52).
- **Trigger:** user text is at least 40 characters, matches a coding verb and an either/or marker (`or`, `either`, `或者`, …), at least one edit, and no `ask_user_question`. Once per run.
- **Text:**

  ```text
  [System] The user request looks multi-interpretation (either/or / 要么…或者…), and you already edited code without `ask_user_question` or an explicit stated assumption. Before more edits: either call `ask_user_question` with 2–4 concrete choices, or state in one line which interpretation you chose and why, then keep that scope for the rest of the run. Do not silently switch interpretations mid-task.
  ```

- **Tokens:** ~100 when it fires.
- **Prevents:** silent scope switches on an ambiguous coding ask. Headless bench cannot answer `ask_user_question`.
- **Prediction:** neutral on this dev set. `hard-ambiguous-spec`, `hard-spec-contradiction`, and `hard-contradictory-validation` do not use the either/or markers the regex requires, so the nudge should not fire. A move on those tasks would mean the regex matched something unintended.
- **Split:** only after family `plan` is neutral-or-better. `MOSS_DISABLE_NUDGES=ambiguity npm run bench -- --samples 2 --label abl-ambiguity --keep-artifacts --model <model> --base-url <url> --task long-horizon-refactor --task multi-file-consistency --task single-edit --task test-fix-loop --task error-recovery --task no-interaction --task hard-ambiguous-spec --task skills-usage --task capability-mcp-ledger`

### `subagent-running`

- **Where:** `src/core/loop/nudges/subagent-running-nudge.ts:108` (`evaluateSubagentRunningNudge`, line 91).
- **Trigger:** a `create_subagent` result still says `STARTED` and no later `subagent_status` is `SUCCESS` or `FAILED` for that id. Once per run.
- **Text (running):** verbatim start, then up to four task ids and an instruction to wait.

  ```text
  [System] A background `create_subagent` is still STARTED (no terminal `subagent_status` yet).
  ```

- **Tokens:** ~83 plus the id list.
- **Prevents:** inventing a child outcome while the child is still running.
- **Prediction:** `subagent-fanout` can regress if the model uses background `create_subagent` instead of `fan_out_subagents` and then writes tokens before the child finishes. Tasks that never spawn should stay flat.
- **Split:** only after family `subagent` is neutral-or-better. `MOSS_DISABLE_NUDGES=subagent-running npm run bench -- --samples 2 --label abl-subagent-running --keep-artifacts --model <model> --base-url <url> --task subagent-fanout --task background-process --task skills-usage --task no-interaction --task error-recovery`

### `subagent-stopped`

- **Where:** `src/core/loop/nudges/subagent-stopped-nudge.ts:96` (`evaluateSubagentStoppedNudge`, line 80).
- **Trigger:** `subagent_stop` ran, a recent result says STOPPED / STOP REQUESTED / ALREADY cancelled, and `run_tests` / `verify_fix` have not run. Once per run.
- **Text (stopped):** verbatim start, then an instruction to re-run, test, or mark the work incomplete.

  ```text
  [System] You stopped a background sub-agent (`subagent_stop`). That cancels the child — it is **not** proof the task is fixed.
  ```

- **Tokens:** ~79 when it fires.
- **Prevents:** treating cancel as a successful fix.
- **Prediction:** neutral on this dev set. No task asks the model to stop a sub-agent. A regress on `subagent-fanout` would mean the model stopped a child and then wrote `tokens.txt` anyway.
- **Split:** only after family `subagent` is neutral-or-better. `MOSS_DISABLE_NUDGES=subagent-stopped npm run bench -- --samples 2 --label abl-subagent-stopped --keep-artifacts --model <model> --base-url <url> --task subagent-fanout --task background-process --task skills-usage --task no-interaction --task error-recovery`

### `web-tools`

- **Where:** `src/core/loop/nudges/web-tools-nudge.ts:29`.
- **Trigger:** at least one tool call, user text asks for online lookup, and `web_search` / `web_fetch` have not run. Conceptual questions are exempt. Once per run.
- **Text:**

  ```text
  [System] The user asked for online lookup/research, but no `web_search` / `web_fetch` has run this turn. Use `web_search` (optionally with `query_keyword_groups`) then `web_fetch` with `focus` for depth, or clearly answer from local knowledge only — do not invent web results or cite URLs you did not retrieve.
  ```

- **Tokens:** ~78 when it fires.
- **Prevents:** invented URLs and citations.
- **Prediction:** neutral. No dev task asks for a web lookup. `capability-mcp-ledger` forbids guessing a checksum, but it does not match the web regex.
- **Split:** only after family `tool-hints` is neutral-or-better. `MOSS_DISABLE_NUDGES=web-tools npm run bench -- --samples 3 --label abl-web-tools --keep-artifacts --model <model> --base-url <url> --task background-process --task skills-usage --task no-interaction --task error-recovery`

### `git-tools`

- **Where:** `src/core/loop/nudges/git-tools-nudge.ts:26`.
- **Trigger:** at least one tool call, user asked for commit/push/PR/review/tag/release/issue, and no matching `git` / `gh` exec (or `git_commit` / `git_push`) has run. Status-only asks are exempt. Once per run.
- **Text:**

  ```text
  [System] The user asked for a git/gh VCS action (commit/push/PR/review/approve/tag/release/issue), and tools have already run without a matching `git` / `gh pr|release|issue` command. If VCS action is required: run the real command via `exec` and report its output. If you are waiting for approval, say so — do not invent commits, reviews, tags, releases, or issues.
  ```

- **Tokens:** ~92 when it fires.
- **Prevents:** invented commits, PRs, and releases.
- **Prediction:** neutral. No dev task asks for git or GitHub.
- **Split:** only after family `tool-hints` is neutral-or-better. `MOSS_DISABLE_NUDGES=git-tools npm run bench -- --samples 3 --label abl-git-tools --keep-artifacts --model <model> --base-url <url> --task background-process --task skills-usage --task no-interaction --task error-recovery`

### `install-tools`

- **Where:** `src/core/loop/nudges/install-tools-nudge.ts:26`.
- **Trigger:** at least one tool call, user asked to install dependencies, and no package-manager install exec has run. Once per run.
- **Text:**

  ```text
  [System] The user asked to install dependencies, and tools have already run without an install command (`npm`/`pnpm`/`yarn`/`bun` install/ci/add, or `pip install`). Run the real package-manager install via `exec` and report the output, or clearly say install was skipped. Do not invent install success.
  ```

- **Tokens:** ~76 when it fires.
- **Prevents:** invented install success.
- **Prediction:** neutral. `hard-dependency-conflict` is a source edit, not an install request, so the regex should not match.
- **Split:** only after family `tool-hints` is neutral-or-better. `MOSS_DISABLE_NUDGES=install-tools npm run bench -- --samples 3 --label abl-install-tools --keep-artifacts --model <model> --base-url <url> --task background-process --task skills-usage --task no-interaction --task error-recovery`

### `run-tests`

- **Where:** `src/core/loop/nudges/run-tests-tools-nudge.ts:31`.
- **Trigger:** at least one tool call, user explicitly asked to run tests (`run the tests`, `npm test`, `pytest`, `跑测试`, …), and no verify tool or test-shaped exec has run. "Skip tests" is exempt. Once per run. This is separate from `verify`, which keys off edits rather than the ask.
- **Text:**

  ```text
  [System] The user asked to run tests, and tools have already run without `run_tests` / `verify_fix` / `code_diagnostics` (or a test-shaped `exec` such as `npm test`). Run the suite now and report the real output — do not invent pass/fail results.
  ```

- **Tokens:** ~62 when it fires.
- **Prevents:** invented pass/fail when the user asked for a run.
- **Prediction:** neutral on this dev set. The fix tasks say `` `node test.js` must pass ``, which does not match the "run the tests" regex. A move means the regex matched a prompt it was not aimed at. The edit-pressure path is `verify`, not this id.
- **Split:** only after family `tool-hints` is neutral-or-better. `MOSS_DISABLE_NUDGES=run-tests npm run bench -- --samples 3 --label abl-run-tests --keep-artifacts --model <model> --base-url <url> --task background-process --task skills-usage --task no-interaction --task error-recovery`

### `build-tools`

- **Where:** `src/core/loop/nudges/build-tools-nudge.ts:33`.
- **Trigger:** at least one tool call, user asked to build/compile, and no build-shaped exec or verify tool has run. Once per run.
- **Text:**

  ```text
  [System] The user asked to build/compile the project, and tools have already run without a build-shaped command (`npm run build` / `cargo build` / `tsc` / `verify_fix` / `code_diagnostics`). Run a real build/typecheck and report the output — do not invent "build succeeded".
  ```

- **Tokens:** ~69 when it fires.
- **Prevents:** invented "build succeeded".
- **Prediction:** neutral. No dev task asks for a build.
- **Split:** only after family `tool-hints` is neutral-or-better. `MOSS_DISABLE_NUDGES=build-tools npm run bench -- --samples 3 --label abl-build-tools --keep-artifacts --model <model> --base-url <url> --task background-process --task skills-usage --task no-interaction --task error-recovery`

### `background-server`

- **Where:** `src/core/loop/nudges/background-server-nudge.ts:42`.
- **Trigger:** at least one tool call, user asked to start a server/watcher (the regex also matches the word `long-running`), and neither `exec_background` nor `exec` with `run_in_background` has been used. Once per run.
- **Text:**

  ```text
  [System] The user asked to start a long-running server/watcher, and tools have already run without `exec_background` (or `exec` with run_in_background). Start it in the background and report the bg handle, or clearly say it was not started. Do not invent a running server.
  ```

- **Tokens:** ~68 when it fires.
- **Prevents:** claiming a server is up without a background handle. A foreground server would be killed with the tool call.
- **Prediction:** regress `background-process`. The prompt contains `long-running` and requires a background start, a `ready` line, and a clean stop. Other tasks should stay flat.
- **Split:** only after family `tool-hints` is neutral-or-better. `MOSS_DISABLE_NUDGES=background-server npm run bench -- --samples 3 --label abl-background-server --keep-artifacts --model <model> --base-url <url> --task background-process --task skills-usage --task no-interaction --task error-recovery`

### `task-repair`

- **Where:** `src/core/loop/nudges/task-repair-nudge.ts:183` (first FAIL) and `:197` (FAIL after a recorded repair). `evaluateTaskRepairNudge`, line 217.
- **Trigger:** latest `task_acceptance` for a task is FAIL and no later `record_failure` / `record_repair` / `record_evidence` / same-task `task_acceptance` has run. At most twice per red wave. A later PASS resets the counter.
- **Text:** `[System] task_acceptance returned FAIL for <id> and no repair work has happened for it since. Do not drift — enter the repair loop now:` followed by diagnose, `record_failure`, fix, `record_repair`, `record_evidence`, re-run. The second form says the same fix was the wrong cause and demands a different hypothesis.
- **Tokens:** ~151 for the first form.
- **Prevents:** wandering off after a red acceptance verdict, and repeating one repair.
- **Prediction:** regress `task-os-c-failure-repair`, which is specified as fail-then-repair. The end-of-turn `acceptance-gate` is a different id and stays on, so the model can still be blocked once at the end; this ablation only removes the mid-run push. Expect a smaller drop than disabling `acceptance-gate`. `task-os-a-coding` should move less, because its happy path is a single PASS. `safety-boundary` does not call `task_acceptance`.
- **Split:** only after family `acceptance` is neutral-or-better. `MOSS_DISABLE_NUDGES=task-repair npm run bench -- --samples 2 --label abl-task-repair --keep-artifacts --model <model> --base-url <url> --task task-os-a-coding --task task-os-c-failure-repair --task safety-boundary --task skills-usage --task no-interaction --task error-recovery`

### `reasoning-only`

- **Where:** `src/core/loop/agent-loop-post-llm.ts:51` (after tools) and `:53` (no tools yet). Decision at line 42.
- **Trigger:** the turn is private reasoning only, the retry budget (1) remains, turns remain, and the run is not aborted. Disabling it stops the run as `thinking_only_complete` instead of injecting the reminder.
- **Text:** `[System] Your previous turn produced only private reasoning and no tool call. Continue the task now: call the next tool, or write the visible answer if the task is done.` The no-tool variant asks for a visible answer (~34 tokens).
- **Tokens:** ~43 after tools, once per streak.
- **Prevents:** a reasoning-only turn ending the run before a tool call or a visible answer.
- **Prediction:** regress `search-locate-fix` and `hard-long-recall` if the model spends the first turn in private reasoning and never reaches `read_file`. Token use falls on runs that were spending a whole extra turn on the retry. Tasks that already emit a tool call on turn one should stay flat.
- **Split:** only after family `retry` is neutral-or-better. `MOSS_DISABLE_NUDGES=reasoning-only npm run bench -- --samples 1 --label abl-reasoning-only --keep-artifacts --model <model> --base-url <url> --task search-locate-fix --task hard-long-recall --task long-horizon-refactor --task hard-dependency-conflict --task multi-file-consistency --task compaction-recall --task skills-usage --task no-interaction --task error-recovery`

### `output-continuation`

- **Where:** `src/core/loop/agent-loop-post-llm.ts:74`. Decision at line 64.
- **Trigger:** stream stop reason is `length`, there is no tool call, continuation count is under the cap, and the run is not aborted. Disabling it treats the truncated text as the final answer.
- **Text:** `[System] Your previous response was truncated due to max_tokens. Continue from where you left off without repeating already-output content.`
- **Tokens:** ~35 per continuation.
- **Prevents:** a truncated file write or answer being stored as complete.
- **Prediction:** regress `long-horizon-refactor` and `hard-dependency-conflict` if a large `write_file` hits `max_tokens` and the file is left half-written. Short tasks (`single-edit`, `no-interaction`) should stay flat.
- **Split:** only after family `retry` is neutral-or-better. `MOSS_DISABLE_NUDGES=output-continuation npm run bench -- --samples 1 --label abl-output-continuation --keep-artifacts --model <model> --base-url <url> --task search-locate-fix --task hard-long-recall --task long-horizon-refactor --task hard-dependency-conflict --task multi-file-consistency --task compaction-recall --task skills-usage --task no-interaction --task error-recovery`

### `missing-tool-call`

- **Where:** `src/core/loop/agent-loop-post-llm.ts:92`, plus the user-visible delta on line 96. The predicate is `shouldNudgeMissingToolInvocation` in `src/core/loop/agent-loop-assistant-turn.ts:170`.
- **Trigger:** no tool call, under the one-shot budget, and the visible text or thinking names a web tool, a URL, and a Chinese first-person "I will call" plan. Disabling it ends the turn when there is visible text.
- **Text:** `[System] You described using tools or opening a URL in plain text but did not emit any function/tool calls. You MUST invoke the appropriate tool now with valid JSON arguments for that URL/intent. Do not repeat the plan—call the tool immediately.` The transcript also gets a short Chinese note (~12 tokens).
- **Tokens:** ~62 plus ~12.
- **Prevents:** describing `web_fetch` instead of calling it.
- **Prediction:** neutral on this dev set. Bench prompts are English and do not match the Chinese plan pattern. The English narration path is `follow-up-guard`.
- **Split:** only after family `retry` is neutral-or-better. `MOSS_DISABLE_NUDGES=missing-tool-call npm run bench -- --samples 1 --label abl-missing-tool-call --keep-artifacts --model <model> --base-url <url> --task search-locate-fix --task hard-long-recall --task long-horizon-refactor --task hard-dependency-conflict --task multi-file-consistency --task compaction-recall --task skills-usage --task no-interaction --task error-recovery`

### `empty-response`

- **Where:** `src/core/loop/agent-loop-response.ts:371`. The decision is `empty_retry` in `src/core/loop/agent-loop-post-llm.ts:100`.
- **Trigger:** no tool call, blank visible text, retry budget 1 remains, turns remain, not aborted. Disabling it fails the run as `empty_complete` instead of asking again.
- **Text:** `[System] Your previous response was empty. Please answer the user's question again.`
- **Tokens:** ~21, once.
- **Prevents:** a single blank completion killing the run.
- **Prediction:** neutral unless the model emits an empty turn. If it does, `hard-long-recall` and `compaction-recall` regress, because the run errors instead of getting one more chance to write `answers.md`.
- **Split:** only after family `retry` is neutral-or-better. `MOSS_DISABLE_NUDGES=empty-response npm run bench -- --samples 1 --label abl-empty-response --keep-artifacts --model <model> --base-url <url> --task search-locate-fix --task hard-long-recall --task long-horizon-refactor --task hard-dependency-conflict --task multi-file-consistency --task compaction-recall --task skills-usage --task no-interaction --task error-recovery`

### `steering-error-recovery`

- **Where:** `src/core/loop/steering.ts:40` (rule check starts at line 37).
- **Trigger:** three or more consecutive tool errors. Cooldown 4 turns.
- **Text:** `[Steering] Multiple consecutive tool errors detected. Stop retrying the same preset tool path. First verify the command/path/arguments, then pivot to an independent evidence source: …`
- **Tokens:** ~105 when it fires.
- **Prevents:** repeating one broken tool path.
- **Prediction:** regress `error-recovery` and `search-locate-fix` if the model hits the same failure three times and, without the pivot, keeps retrying until max turns. Tokens fall on runs that were spending a turn acknowledging the steering text.
- **Split:** only after family `steering` is neutral-or-better. `MOSS_DISABLE_NUDGES=steering-error-recovery npm run bench -- --samples 1 --label abl-steering-error-recovery --keep-artifacts --model <model> --base-url <url> --task error-recovery --task search-locate-fix --task long-horizon-refactor --task hard-long-recall --task compaction-recall --task skills-usage --task no-interaction --task capability-mcp-ledger`

### `steering-local-exploration-loop`

- **Where:** `src/core/loop/steering.ts:148` (rule check starts at line 128).
- **Trigger:** three `search_code` or `list_directory` calls on the same path inside the last 16 messages. Cooldown 5 turns.
- **Text:** `[Steering] Repeated local exploration detected: <n> calls targeted the same local path (<path>). Stop issuing more search_code/list_directory variations on that path. …`
- **Tokens:** ~79 when it fires.
- **Prevents:** re-listing one directory instead of reading the file.
- **Prediction:** `search-locate-fix` can go either way. Regress if the nudge was what made the model open the bad module; improve if the nudge fired before the model had listed the sibling modules. `hard-long-recall` should stay flat: it asks for `read_file` on 90 distinct paths, not three lists of one path.
- **Split:** only after family `steering` is neutral-or-better. `MOSS_DISABLE_NUDGES=steering-local-exploration-loop npm run bench -- --samples 1 --label abl-steering-local-exploration-loop --keep-artifacts --model <model> --base-url <url> --task error-recovery --task search-locate-fix --task long-horizon-refactor --task hard-long-recall --task compaction-recall --task skills-usage --task no-interaction --task capability-mcp-ledger`

### `steering-web-search-variation`

- **Where:** `src/core/loop/steering.ts:116` (rule check starts at line 99).
- **Trigger:** at least three distinct `web_search` queries in the last 20 messages. Cooldown 5 turns.
- **Text:** `[Steering] You have already run web_search <n> time(s) with <d> different queries in this turn. If the results were relevant, pick the best URL and call web_fetch on it now. …`
- **Tokens:** ~112 when it fires (grows with the counts).
- **Prevents:** query rephrasing instead of opening a URL.
- **Prediction:** neutral. No dev task requires web search.
- **Split:** only after family `steering` is neutral-or-better. `MOSS_DISABLE_NUDGES=steering-web-search-variation npm run bench -- --samples 1 --label abl-steering-web-search-variation --keep-artifacts --model <model> --base-url <url> --task error-recovery --task search-locate-fix --task long-horizon-refactor --task hard-long-recall --task compaction-recall --task skills-usage --task no-interaction --task capability-mcp-ledger`

### `steering-tool-loop`

- **Where:** `src/core/loop/steering.ts:61` (rule check starts at line 52).
- **Trigger:** turn ≥ 8 and the recent assistant messages (at least four, within the last 12) are all tool calls. Cooldown 6 turns.
- **Text:** `[Steering] Extended tool loop detected — you have been executing tools for many turns. Pause the current tool chain and summarize what evidence is already known. …`
- **Tokens:** ~71 when it fires.
- **Prevents:** an open-ended tool chain that never answers.
- **Prediction:** `long-horizon-refactor` and `hard-long-recall` can regress if the pause makes the model summarize and stop before the last edit or the last fact. They can also improve if the chain was about to hit max turns. Expect a token drop on every long task where it fired, and watch pass rate rather than assuming the pause is free.
- **Split:** only after family `steering` is neutral-or-better. `MOSS_DISABLE_NUDGES=steering-tool-loop npm run bench -- --samples 1 --label abl-steering-tool-loop --keep-artifacts --model <model> --base-url <url> --task error-recovery --task search-locate-fix --task long-horizon-refactor --task hard-long-recall --task compaction-recall --task skills-usage --task no-interaction --task capability-mcp-ledger`

### `steering-context-pressure`

- **Where:** `src/core/loop/steering.ts:88` (rule check starts at line 72).
- **Trigger:** estimated context use is in the 75–100% band. Above 100% it stays silent on purpose. Cooldown 10 turns.
- **Text:** `[Steering] Context window is <pct>% full. Be concise in your responses. Summarize tool outputs instead of echoing them. Consider completing the current task and providing a summary.`
- **Tokens:** ~45 when it fires.
- **Prevents:** echoing large tool outputs until the window overflows.
- **Prediction:** regress `hard-long-recall` and `compaction-recall`. Both need exact values from many files; "summarize tool outputs" can drop `code` / `color` / `city`. Tokens should fall. `single-edit` should stay flat (the window never enters the band).
- **Split:** only after family `steering` is neutral-or-better. `MOSS_DISABLE_NUDGES=steering-context-pressure npm run bench -- --samples 1 --label abl-steering-context-pressure --keep-artifacts --model <model> --base-url <url> --task error-recovery --task search-locate-fix --task long-horizon-refactor --task hard-long-recall --task compaction-recall --task skills-usage --task no-interaction --task capability-mcp-ledger`

### `background-completion`

- **Where:** `src/core/loop/background-completion.ts:145` (`buildBackgroundCompletionSystemText`, line 136).
- **Trigger:** a background process reaches a terminal state and has not been reported yet. Disabling it drains the queue and injects nothing, so the model must use `exec_logs` / `exec_wait`.
- **Text:** `[System] Background command(s) finished while you were working:` plus one block per process (id, exit, command, up to 40 tail lines, capped at 4000 characters) and a line not to restart a success.
- **Tokens:** ~52 for the wrapper, plus the tail. A full tail can be about 1000 tokens.
- **Prevents:** not noticing that a background server or test finished.
- **Prediction:** regress `background-process`. The task is done only after `ready` is in the log and the pid is dead; without the completion message the model has to poll, and it often stops early or kills the wrong pid. Other tasks should stay flat.
- **Split:** only after family `subagent` is neutral-or-better. `MOSS_DISABLE_NUDGES=background-completion npm run bench -- --samples 2 --label abl-background-completion --keep-artifacts --model <model> --base-url <url> --task subagent-fanout --task background-process --task skills-usage --task no-interaction --task error-recovery`

### `acceptance-gate`

- **Where:** `src/core/loop/acceptance-completion-gate.ts:159` (FAIL with no repair) and `:171` (no verdict). `evaluateAcceptanceCompletionGate`, line 138.
- **Trigger:** `task_define` ran this run, and the latest acceptance is missing, or it is FAIL and no repair-path tool has run since. The gate blocks once per kind, then lets the run finish. Disabling the id makes the gate return ok immediately, so the correction is never injected.
- **Text (no verdict):** `You defined a task contract (task_define) but the run cannot end before acceptance is evaluated. Run task_acceptance for the task id now. …`
- **Text (unrepaired FAIL):** `task_acceptance returned FAIL and nothing since has entered the repair loop. Do not end the run on the first red verdict. …`
- **Tokens:** ~105 (no verdict) or ~90 (unrepaired FAIL), once per kind.
- **Prevents:** ending a task-contract run with no verdict, or with a FAIL and no repair.
- **Prediction:** regress `task-os-a-coding` and `task-os-c-failure-repair`. Both checks require a PASS verdict in `.moss/`. Without the gate the model can implement the function, say it is done, and never call `task_acceptance`. `safety-boundary` should stay at 100% (it never calls `task_define`). This is the largest expected drop in the round.
- **Split:** only after family `acceptance` is neutral-or-better. `MOSS_DISABLE_NUDGES=acceptance-gate npm run bench -- --samples 2 --label abl-acceptance-gate --keep-artifacts --model <model> --base-url <url> --task task-os-a-coding --task task-os-c-failure-repair --task safety-boundary --task skills-usage --task no-interaction --task error-recovery`

### `follow-up-guard`

- **Where:** guidance strings at `src/core/loop/follow-up-guard.ts:105`, `:112`, and `:119`. Injection is `gateFollowUpInjections` (line 200), called from `src/core/agent/moss-agent.ts`.
- **Trigger:** follow-up guard is enabled, the last assistant message has no tool call, and it matches "let me / I'll run|read|write …" or a Chinese "I will call `<tool>`" plan, and that tool was not used recently. Default cap is one guidance per check.
- **Text:** `You described running a command but did not use a tool. Please use the appropriate exec tool to actually execute it.` The read and write variants are the same shape (~29 tokens). The Chinese-plan variant names the tool and says to invoke it now.
- **Tokens:** ~29 per injection.
- **Prevents:** narrating a command or a file edit and then stopping.
- **Prediction:** regress `single-edit`, `test-fix-loop`, and `error-recovery` if the model says it will run `node test.js` or `node run.js` and then ends the turn. `no-interaction` can regress the same way on the `options.md` write. Tasks where the model emits real tool calls every turn should stay flat.
- **Split:** only after family `plan` is neutral-or-better. `MOSS_DISABLE_NUDGES=follow-up-guard npm run bench -- --samples 2 --label abl-follow-up-guard --keep-artifacts --model <model> --base-url <url> --task long-horizon-refactor --task multi-file-consistency --task single-edit --task test-fix-loop --task error-recovery --task no-interaction --task hard-ambiguous-spec --task skills-usage --task capability-mcp-ledger`

### `truncated-tool-json`

- **Where:** `src/core/loop/agent-loop.ts:117` (`correctionTextForTurnError`, line 106).
- **Trigger:** the turn error matches malformed or truncated tool-call JSON. Disabling it replaces the chunking instructions with the generic internal-error line (`An internal error occurred processing the last response…`).
- **Text:** `[System] Your last tool call was cut off mid-argument — its JSON was truncated, usually because the content (e.g. a whole file in one write_file) was too large for a single response. Do NOT repeat the same large call. Instead do it in smaller pieces: write a large file with an initial write_file holding only the first portion, then append the remainder with several smaller apply_patch calls.`
- **Tokens:** ~99 for the specific hint. The generic fallback is one sentence.
- **Prevents:** retrying one huge `write_file` until the run errors.
- **Prediction:** regress `long-horizon-refactor` and `multi-file-consistency` if a whole-file write is truncated and the model repeats it. Short edits (`single-edit`) should stay flat.
- **Split:** only after family `retry` is neutral-or-better. `MOSS_DISABLE_NUDGES=truncated-tool-json npm run bench -- --samples 1 --label abl-truncated-tool-json --keep-artifacts --model <model> --base-url <url> --task search-locate-fix --task hard-long-recall --task long-horizon-refactor --task hard-dependency-conflict --task multi-file-consistency --task compaction-recall --task skills-usage --task no-interaction --task error-recovery`

### `goal-acceptance`

已随 LoopScheduler 退役。`buildAcceptanceFailurePrompt` 已删除；`MOSS_DISABLE_NUDGES=goal-acceptance` 是未知 id，调用处会忽略。

- **Where:** was `src/core/loop/goal-loop.ts` (`buildAcceptanceFailurePrompt`). Injected by `LoopScheduler` after a failing acceptance command. That scheduler is gone.
- **Trigger:** goal mode has an acceptance command and it exited non-zero. Disabling it sets the next iteration prompt to the original goal only: the failure tail and the "do not edit the acceptance command" line are omitted. The default `npm run bench` does **not** set `MOSS_GOAL_VERIFY_LOOP`, so this prompt is not on the dev-bench path.
- **Text:** `The acceptance command for the goal still fails (exit <code>). Fix the underlying cause — do not work around, disable, or edit the acceptance command or its fixtures.` plus up to 2000 characters of output and the original goal.
- **Tokens:** ~50 for the instruction, plus the tail (up to ~500) and the goal text. Once per failed iteration.
- **Prevents:** the next goal iteration ignoring the verifier output, or editing the verifier to make it pass.
- **Prediction:** neutral on the commands below. They do not enable the goal verify loop. A non-neutral result means some other path built this prompt.
- **Split:** only after family `acceptance` is neutral-or-better. `MOSS_DISABLE_NUDGES=goal-acceptance npm run bench -- --samples 2 --label abl-goal-acceptance --keep-artifacts --model <model> --base-url <url> --task task-os-a-coding --task task-os-c-failure-repair --task safety-boundary --task skills-usage --task no-interaction --task error-recovery`

## Split commands

Run a block only after that family ablation is neutral-or-better. Same tasks and samples as the family. One id per command.

### `tool-hints`

```bash
MOSS_DISABLE_NUDGES=web-tools npm run bench -- --samples 3 --label abl-web-tools --keep-artifacts --model <model> --base-url <url> --task background-process --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=git-tools npm run bench -- --samples 3 --label abl-git-tools --keep-artifacts --model <model> --base-url <url> --task background-process --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=install-tools npm run bench -- --samples 3 --label abl-install-tools --keep-artifacts --model <model> --base-url <url> --task background-process --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=run-tests npm run bench -- --samples 3 --label abl-run-tests --keep-artifacts --model <model> --base-url <url> --task background-process --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=build-tools npm run bench -- --samples 3 --label abl-build-tools --keep-artifacts --model <model> --base-url <url> --task background-process --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=background-server npm run bench -- --samples 3 --label abl-background-server --keep-artifacts --model <model> --base-url <url> --task background-process --task skills-usage --task no-interaction --task error-recovery
```

### `verify`

```bash
MOSS_DISABLE_NUDGES=verify npm run bench -- --samples 2 --label abl-verify --keep-artifacts --model <model> --base-url <url> --task test-fix-loop --task hard-wrong-fix-rejected --task hard-multi-hypothesis --task hard-race-condition --task hard-perf-regression --task hard-spec-contradiction --task hard-contradictory-validation --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=red-verify npm run bench -- --samples 2 --label abl-red-verify --keep-artifacts --model <model> --base-url <url> --task test-fix-loop --task hard-wrong-fix-rejected --task hard-multi-hypothesis --task hard-race-condition --task hard-perf-regression --task hard-spec-contradiction --task hard-contradictory-validation --task skills-usage --task no-interaction --task error-recovery
```

### `subagent`

```bash
MOSS_DISABLE_NUDGES=fan-out npm run bench -- --samples 2 --label abl-fan-out --keep-artifacts --model <model> --base-url <url> --task subagent-fanout --task background-process --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=subagent-running npm run bench -- --samples 2 --label abl-subagent-running --keep-artifacts --model <model> --base-url <url> --task subagent-fanout --task background-process --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=subagent-stopped npm run bench -- --samples 2 --label abl-subagent-stopped --keep-artifacts --model <model> --base-url <url> --task subagent-fanout --task background-process --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=background-completion npm run bench -- --samples 2 --label abl-background-completion --keep-artifacts --model <model> --base-url <url> --task subagent-fanout --task background-process --task skills-usage --task no-interaction --task error-recovery
```

### `retry`

```bash
MOSS_DISABLE_NUDGES=reasoning-only npm run bench -- --samples 1 --label abl-reasoning-only --keep-artifacts --model <model> --base-url <url> --task search-locate-fix --task hard-long-recall --task long-horizon-refactor --task hard-dependency-conflict --task multi-file-consistency --task compaction-recall --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=output-continuation npm run bench -- --samples 1 --label abl-output-continuation --keep-artifacts --model <model> --base-url <url> --task search-locate-fix --task hard-long-recall --task long-horizon-refactor --task hard-dependency-conflict --task multi-file-consistency --task compaction-recall --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=missing-tool-call npm run bench -- --samples 1 --label abl-missing-tool-call --keep-artifacts --model <model> --base-url <url> --task search-locate-fix --task hard-long-recall --task long-horizon-refactor --task hard-dependency-conflict --task multi-file-consistency --task compaction-recall --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=empty-response npm run bench -- --samples 1 --label abl-empty-response --keep-artifacts --model <model> --base-url <url> --task search-locate-fix --task hard-long-recall --task long-horizon-refactor --task hard-dependency-conflict --task multi-file-consistency --task compaction-recall --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=truncated-tool-json npm run bench -- --samples 1 --label abl-truncated-tool-json --keep-artifacts --model <model> --base-url <url> --task search-locate-fix --task hard-long-recall --task long-horizon-refactor --task hard-dependency-conflict --task multi-file-consistency --task compaction-recall --task skills-usage --task no-interaction --task error-recovery
```

### `steering`

```bash
MOSS_DISABLE_NUDGES=steering-error-recovery npm run bench -- --samples 1 --label abl-steering-error-recovery --keep-artifacts --model <model> --base-url <url> --task error-recovery --task search-locate-fix --task long-horizon-refactor --task hard-long-recall --task compaction-recall --task skills-usage --task no-interaction --task capability-mcp-ledger
MOSS_DISABLE_NUDGES=steering-local-exploration-loop npm run bench -- --samples 1 --label abl-steering-local-exploration-loop --keep-artifacts --model <model> --base-url <url> --task error-recovery --task search-locate-fix --task long-horizon-refactor --task hard-long-recall --task compaction-recall --task skills-usage --task no-interaction --task capability-mcp-ledger
MOSS_DISABLE_NUDGES=steering-web-search-variation npm run bench -- --samples 1 --label abl-steering-web-search-variation --keep-artifacts --model <model> --base-url <url> --task error-recovery --task search-locate-fix --task long-horizon-refactor --task hard-long-recall --task compaction-recall --task skills-usage --task no-interaction --task capability-mcp-ledger
MOSS_DISABLE_NUDGES=steering-tool-loop npm run bench -- --samples 1 --label abl-steering-tool-loop --keep-artifacts --model <model> --base-url <url> --task error-recovery --task search-locate-fix --task long-horizon-refactor --task hard-long-recall --task compaction-recall --task skills-usage --task no-interaction --task capability-mcp-ledger
MOSS_DISABLE_NUDGES=steering-context-pressure npm run bench -- --samples 1 --label abl-steering-context-pressure --keep-artifacts --model <model> --base-url <url> --task error-recovery --task search-locate-fix --task long-horizon-refactor --task hard-long-recall --task compaction-recall --task skills-usage --task no-interaction --task capability-mcp-ledger
```

### `acceptance`

```bash
MOSS_DISABLE_NUDGES=acceptance-gate npm run bench -- --samples 2 --label abl-acceptance-gate --keep-artifacts --model <model> --base-url <url> --task task-os-a-coding --task task-os-c-failure-repair --task safety-boundary --task skills-usage --task no-interaction --task error-recovery
MOSS_DISABLE_NUDGES=task-repair npm run bench -- --samples 2 --label abl-task-repair --keep-artifacts --model <model> --base-url <url> --task task-os-a-coding --task task-os-c-failure-repair --task safety-boundary --task skills-usage --task no-interaction --task error-recovery
# goal-acceptance 已随 LoopScheduler 退役（未知 id，忽略）
MOSS_DISABLE_NUDGES=goal-acceptance npm run bench -- --samples 2 --label abl-goal-acceptance --keep-artifacts --model <model> --base-url <url> --task task-os-a-coding --task task-os-c-failure-repair --task safety-boundary --task skills-usage --task no-interaction --task error-recovery
```

### `plan`

```bash
MOSS_DISABLE_NUDGES=todo npm run bench -- --samples 2 --label abl-todo --keep-artifacts --model <model> --base-url <url> --task long-horizon-refactor --task multi-file-consistency --task single-edit --task test-fix-loop --task error-recovery --task no-interaction --task hard-ambiguous-spec --task skills-usage --task capability-mcp-ledger
MOSS_DISABLE_NUDGES=ambiguity npm run bench -- --samples 2 --label abl-ambiguity --keep-artifacts --model <model> --base-url <url> --task long-horizon-refactor --task multi-file-consistency --task single-edit --task test-fix-loop --task error-recovery --task no-interaction --task hard-ambiguous-spec --task skills-usage --task capability-mcp-ledger
MOSS_DISABLE_NUDGES=follow-up-guard npm run bench -- --samples 2 --label abl-follow-up-guard --keep-artifacts --model <model> --base-url <url> --task long-horizon-refactor --task multi-file-consistency --task single-edit --task test-fix-loop --task error-recovery --task no-interaction --task hard-ambiguous-spec --task skills-usage --task capability-mcp-ledger
```
