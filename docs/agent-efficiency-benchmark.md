# Moss Agent Efficiency Benchmark

This benchmark complements the 200-case capability backlog with comparable execution metrics for the same isolated task across agent harnesses.

## Metrics

- Task outcome and independent test result.
- Wall-clock time to verified completion.
- Model-call count.
- Input, cached-input, and output tokens when the harness reports them.
- Tool-call count.
- Blocked environment runs are recorded but excluded from quality ranking.

## First task: pre-aborted child process

The fixture contains a Promise-based child-process runner that registers an `abort` listener but does not check `signal.aborted` before spawning. The agent must add a regression test first, observe it fail, add the minimal guard, and run `npm test`.

The first Moss run exposed a general harness bug: repeated thinking-only provider responses could trigger unbounded corrective turns. It timed out after 15 model calls with only the red test written. After bounding thinking-only correction to one retry, the same Moss command completed in 36 seconds with both tests passing.

Raw normalized results live in `benchmarks/agent-efficiency-results.json`.

## Second task: verified current robotics news

The agent must research the latest 24 hours of robotics and D-Robotics news, execute independent searches in parallel, distinguish cross-verified facts from single-source leads, and cite article-level URLs without falling back to local project files.

The first Moss run was incorrectly routed through the fast-news shortcut: a one-tool budget and 700-token output cap suppressed the requested parallel evidence gathering, then empty responses retried until the run was stopped. After routing verification-heavy prompts out of fast-news mode, bounding empty-response recovery, and allowing independent read-only searches in the same parallel batch, the task completed in four model calls. A manual evidence review then found that syndicated copies and unattributed publisher mentions were still being counted as independent verification, so verified-news runs now receive an explicit source-independence contract.

## Third task: manual context compaction in the TUI

A preloaded long session contains an early project code and release color plus later noise and a final constraint. The user runs `/context`, `/compact`, asks for the early facts, then runs `/context` and `/cost`. A separate run presses Escape during compaction and verifies that the persisted session is unchanged.

The first real run preserved the facts, but `/cost` omitted the compaction model calls entirely because the summarizer invoked the provider outside the normal agent-loop usage recorder. Compaction also used a generic `Working` label and had no active abort controller. The fixed run reports `Compacting context`, records successful and failed compaction calls in the workspace usage log, preserves the early facts, and stops cleanly without rewriting the session when Escape is pressed.

## Fourth task: BTW during an active task

The main session starts a live web-research task while the user asks `/btw` for a short fact already present in the task snapshot. The side answer must arrive independently, avoid continuing the inherited task, leave the main session untouched, and appear in workspace usage accounting.

The first run took 62 seconds because the side agent treated the inherited main-task request as another action to complete before answering the aside. Its usage was also omitted. The fixed path marks inherited user turns as reference-only, treats the final BTW question as the sole actionable request, defaults context-only asides to zero tools and a small output budget, and inherits usage logging. The same fact question then completed in 0.9 seconds with eight output tokens.

## Fifth task: stoppable and resumable autonomous loop

The TUI starts `/loop` on an isolated coding fixture, requests a stop during the first active model call, exits Moss, restarts in the same workspace, runs `/loop resume`, and independently verifies the generated code and tests. The persisted state must distinguish paused from completed work, preserve the continuation prompt and autonomous settings, and include completion-judge usage in `/cost`.

The first real run exposed that `/loop stop` only flipped scheduler flags: it did not pass the abort signal into the active agent run, so the user waited another 45 seconds and the model completed all three requested phases in one nominal iteration. The restored scheduler also reset its iteration count and lost its continuation/configuration state. After the fix, stop propagated immediately, the UI showed a dedicated stopping state, the cancelled iteration rolled back to zero, restart plus `/loop resume` completed the fixture in seven seconds, the state ended as `completed`, and the usage log contained both the agent calls and `loop:judge:1`.

## Sixth task: cross-module cache invalidation TDD

The fixture has a promise-coalescing file-read cache and a separate writer. The agent must first add a failing stale-read regression, then invalidate only after a successful write, preserve concurrent read coalescing, add coverage proving a failed write preserves the cached value, and run the complete test suite.

The first Moss run failed before editing because the word `concurrent` accidentally matched the unbounded `current` substring in the fresh-news router. That silently imposed the news policy's one-tool budget on a coding task. Word-boundary classification fixed the routing bug. A second run completed in 48.6 seconds but only reasoned about the failed-write invariant instead of testing it, and the renderer falsely warned that tests were not run because it ignored the dedicated `run_tests` tool. After adding an explicit-requirements completion checklist and recognizing `run_tests` as verification evidence, the final Moss run produced the same four behavioral tests as Codex and no false warning. Codex completed the fixture in 125.4 seconds; Claude Code produced no usable result in the current environment before being stopped after 232 seconds.

## Seventh task: strict structured output in headless mode

The agent must call `generate_structured`, enforce a strict object schema, and expose a directly consumable value through `--output-format stream-json`. Invalid output must stay under schema enforcement across correction turns, exhausted retries must fail closed with a non-zero exit code, concurrent runs sharing a session name must not share validation state, and unsupported schema keywords must be rejected rather than silently ignored.

The initial integration test showed that the pending schema was removed before the first validation attempt, so the second answer bypassed the gate; after the generic completion gate reached its retry limit, it also released an invalid answer as success. Further adversarial tests found hidden auto-repair (the validator approved a repaired in-memory object but returned the original invalid text), module-global cross-run state, ignored `$ref`, fractional values accepted as `integer`, and schema-valued `additionalProperties` not enforced. The corrected real CLI run emitted five parseable JSONL events, called `generate_structured`, returned a strict profile as `structured_output`, completed in 8.5 seconds, and reported 15,613 input plus 301 output tokens. Mock-provider headless tests independently prove successful parseability and terminal schema failure behavior.
