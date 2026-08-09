# Design: Coding Problem-Solving Loop (Completion Gates)

> Status: approved direction (2026-07-17). Ready for implementation plan after user review of this file.  
> Goal: Make Moss harder to **false-complete** coding work — real verification evidence, honest failure reporting, multi-step todos not abandoned mid-list — with **user-visible** gate corrections.  
> Reference inputs: Desktop `reference/claude-code`, `reference/codex`, `reference/grok-build`; Moss Unreleased coding harness parity.

## 1. Problem

Moss already has coding tools and soft completion gates (`coding-completion-gate.ts`):

- `evaluateTodoCompletionGate` — incomplete multi-item `todo_write` → one correction
- `evaluateCodingCompletionGate` — edits under fix/implement intent without verification → one correction

Gaps that still hurt **problem-solving** and **trust**:

1. **Verification is too loose**: any `exec` counts as verification (`toolCallsByName.exec > 0`), so `exec echo hi` can unlock “done”.
2. **Red results can be greenwashed**: after `run_tests` / `verify_fix` FAIL, the model can still claim success; no outcome gate.
3. **Failed tools do not force a next step**: prompt says “report faithfully”, but runtime does not correct silent ignore of tool errors.
4. **Todo gate is single-fire only**: Grok-style turn-end TodoGate allows up to 2 fires; Moss stops after one soft nudge.
5. **Gate corrections are model-only**: users often cannot tell the agent was “pushed” to finish properly.

Non-goals for this iteration (explicit):

- No LSP server, no Claude Code TaskCreate/Team full suite, no stopHooks plugin system
- No product change to default `acceptEdits` (tracked separately in CLAUDE.md 需求清单)
- No always-on `plan` tool surface
- No new module-level mutable state; no host credentials/UI ownership leaks into `@rdk-moss/core`

## 2. Success criteria

**Primary (user-perceivable):**

1. Fix/implement task that edits code and never runs a real test/build/typecheck → one (or chained) correction; finishing requires real evidence.
2. Multi-step `todo_write` with open items + “all done” prose → correction (up to 2 fires).
3. Latest verification tool result is FAIL + success claim → correction; model must fix or honestly report red.
4. Manual `moss "…"` on 2–3 scenarios in this repo shows the above; `npm run verify` green.

**Secondary:**

- Gate reason visible in CLI (oneshot/TUI) as a short status line when a correction turn is injected.
- Prompt quick-layers state the same verification definition (one sentence each).

## 3. Architecture

### 3.1 Placement

All logic stays on the **CLI host** path already used by `cli-main.ts`:

```
MossAgent.config.completionGate
  → createCliCompletionGate()          # packages/moss-agent/src/cli/coding-completion-gate.ts
       1. evaluateTodoCompletionGate
       2. evaluateCodingCompletionGate      # tighten
       3. evaluateVerificationOutcomeGate  # new
       4. evaluateFailureDrivenGate         # new
       5. optional extra host gate
```

Core loop wiring is unchanged (`agent-loop-response.ts`):

- When there are no more tool calls and `finalText` is non-empty, call `completionGate`.
- On `{ ok: false }` and `completionGateAttempts < retryLimit`: inject correction user message, `control: 'continue'`.
- On still failing after retries: existing throw / reject path.

Host-neutral: core still only sees the `completionGate` function type; gate policy is CLI-owned.

### 3.2 Chain order

1. **Todo incomplete first** (keep current priority — partial verify must not allow abandoning the checklist).
2. **Coding verification evidence** (tightened).
3. **Verification outcome** (red vs green claim).
4. **Failure-driven** (recent tool failure ignored while claiming done).
5. **extra** host gate.

Only the first failing gate returns; one correction message per continue turn.

### 3.3 Observability (user-visible)

When the loop continues due to a completion gate:

- Emit a single short line to the user-facing channel (prefer existing progress/status path; fallback: stderr when not quiet):  
  `↻ completion gate: <reason> (attempt k/n)`
- Do **not** dump the full `[System]` correction text to the user (model still receives full correction).

Minimal implementation options (plan may pick one):

- A) CLI wraps `createCliCompletionGate` and sets a process-local “last gate reason” read by oneshot/TUI on next turn start.
- B) Push a mini-event from the loop if a cheap typed event already exists for host UI (prefer not inventing a large event schema).

Prefer A if B needs core API churn.

## 4. Gate specifications

### 4.1 Todo completion gate (existing + small change)

**Keep:**

- Requires `todo_write` called ≥1 and latest checklist length ≥2.
- Open items = status `pending` | `in_progress`.
- Skip if response already signals remaining work (`remaining|still …|下一步|未完成|…`).

**Change:**

- `retryLimit`: `1` → `2`.
- Second-fire correction shorter: emphasize finish or explicit cancel via `todo_write`.

### 4.2 Coding verification evidence gate (tighten)

**Trigger (all):**

- Edit tools used: `edit_file` | `multi_edit` | `write_file` | `apply_patch` count ≥1
- User intent matches `CODING_CHANGE_RE` (existing)
- No recognized verification evidence (below)
- Not exempt

**Verification evidence (any one is enough):**

| Source                     | Rule                                                                            |
| -------------------------- | ------------------------------------------------------------------------------- |
| Tool name                  | `run_tests`, `verify_fix`, or `code_diagnostics` count ≥1                       |
| `exec` / `exec_background` | At least one tool_use whose command string matches verification command pattern |

**Verification command pattern** (case-insensitive; match against full command string):

```
\b(test|tests|verify|typecheck|lint|build|jest|vitest|pytest|mocha)\b
|cargo\s+test|go\s+test|npm\s+test|pnpm\s+test|yarn\s+test
|npm\s+run\s+(test|verify|check|lint|build|typecheck)
|pnpm\s+run\s+(test|verify|check|lint|build|typecheck)
|yarn\s+run\s+(test|verify|check|lint|build|typecheck)
|\bnpx\s+tsc\b|\btsc\b
|npm\s+run\s+verify\b
```

Command extracted from tool_use input fields: `command`, `cmd`, or `input` string if present. Scan assistant messages for tool_use (do not trust name counts alone for exec quality).

**Exemptions:**

- User text matches skip-tests intent: `不要跑测试|skip tests|no tests|只改文案|docs only|documentation only`
- Model response already admits tests not run (existing regex)
- Non-coding intent (existing)

**Breaking change for tests:** current case “edits + any exec passes” becomes **fail** unless command matches the pattern. Update `coding-completion-gate.spec.mjs` accordingly.

**retryLimit:** 1

### 4.3 Verification outcome gate (new)

**Purpose:** After real verification ran and failed, block success-claiming prose.

**Trigger (all):**

1. Session contains at least one verification-class tool_result (from `run_tests` / `verify_fix` / verification-pattern `exec`).
2. **Latest** such result is a failure under parsers:
   - Prefer harness-tools shape: lines/markers such as `FAIL`, `failed:`, `testsOk: false`, `Build: FAIL`, `Typecheck: FAIL`, `Tests: FAIL`, non-zero failure counts.
   - Fallback: clear failure markers in result text (`exit code [1-9]`, `Test Files.*failed`, etc.).
3. Model `response` matches success-claim regex (tight):  
   `(all\s+)?(tests?\s+)?pass(ed|ing)?|全部通过|验证通过|已修复|bug is fixed|works now|\ball green\b`  
   Avoid matching neutral “done with investigation” without success claim when possible; if ambiguous and latest verify is red, prefer to fire once.

**Correction:** Include up to 3 lines of failure preview; instruct to fix to green or report failure honestly.

**retryLimit:** 1  
**Skip if:** response already acknowledges failure (`fail|失败|still failing|未通过`).

### 4.4 Failure-driven gate (new)

**Purpose:** Recent tool failures must not be ignored under a completion claim.

**Trigger (all):**

1. Among the last ~8 user messages’ `tool_result` blocks (session tail), at least one is a clear failure:
   - `outcome === 'blocked'` / content starting with `Error:` / `exit code [1-9]` / common exception names, **or** structured harness FAIL
2. Response is a completion/success claim (reuse success-claim or “all done / 完成 / fixed”)
3. Response does **not** acknowledge error/failure (same acknowledge regex as above)

**Correction:** Quote a short failure snippet; require continue-from-error or explicit blocker.

**retryLimit:** 1  
**Skip if:** `stopReason === 'aborted_by_user'`; response is clearly a question to the user.

### 4.5 Debug soft nudge (P2 — same PR if cheap)

**Trigger:** fix/bug intent + edit tools used + zero of `{read_file, search_code, exec, run_tests, verify_fix, code_diagnostics, list_directory}` in the run → one soft correction to reproduce/locate first.

**retryLimit:** 1  
**Defer** to a follow-up PR if unit tests show high false-positive rate on trivial one-line known fixes.

## 5. Prompt alignment (small)

Add **one sentence** each (keep quick prompts compact):

- `buildSoftwareEngineeringPromptQuick`: verification means dedicated tools or an exec whose command is clearly test/build/typecheck/lint — not arbitrary shell; red output forbids success claims.
- `buildAgentBehaviorPromptQuick` `# Doing tasks` or `# Using your tools`: same contract in one line.

No full-prompt expansion; no new prompt layer.

## 6. Tests

Extend `packages/moss-agent/test/coding-completion-gate.spec.mjs` (build dist then run package tests as today):

| Case                                                      | Expected                       |
| --------------------------------------------------------- | ------------------------------ |
| edits + `exec` with `echo hi` + fix intent                | coding gate **fails**          |
| edits + `exec` with `npm test`                            | coding gate **passes**         |
| edits + `run_tests`                                       | passes                         |
| latest `run_tests` FAIL + “全部通过”                      | outcome gate **fails**         |
| latest FAIL + response admits failure                     | passes                         |
| open todos + done claim                                   | todo fails; `retryLimit === 2` |
| chain: incomplete todos beat coding                       | unchanged priority             |
| user “不要跑测试” + edits                                 | coding passes                  |
| failure-driven: Error tool_result + “fixed” without admit | fails                          |
| no edits                                                  | all ok                         |

Core prompt tests: only if existing assertions pin exact full string length/content; then update golden snippets minimally.

## 7. Files to change

| Path                                                                            | Change                                   |
| ------------------------------------------------------------------------------- | ---------------------------------------- |
| `packages/moss-agent/src/cli/coding-completion-gate.ts`                         | Tighten + new evaluators + chain         |
| `packages/moss-agent/test/coding-completion-gate.spec.mjs`                      | Cases above                              |
| `packages/moss/src/prompts/software-engineering-prompt.ts`                      | +1 sentence quick                        |
| `packages/moss/src/prompts/agent-behavior-prompt.ts`                            | +1 sentence quick                        |
| `packages/moss-agent/src/cli-main.ts` and/or `cli/oneshot.ts` / `cli/output.ts` | Gate visibility wrapper (minimal)        |
| `CHANGELOG.md`                                                                  | Unreleased Added/Fixed user-facing notes |

## 8. Verification plan (implementation phase)

1. Red tests for new cases → implement → green.
2. `npm run verify` full green.
3. Manual scenarios (same model the user uses day-to-day if possible):
   - Introduce a tiny failing assertion or ask moss to “fix” a planted bug without mentioning tests → expect verify tools or matching exec.
   - Multi-item todo and attempt early done.
   - Force red tests and ask to “confirm all pass”.
4. Confirm gate status line appears once per correction continue.

## 9. Risks and mitigations

| Risk                                      | Mitigation                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Verification regex misses exotic runners  | Prefer `run_tests`/`verify_fix`; extend pattern when real misses appear |
| False positive blocks legitimate finishes | Exemptions + low retryLimit + acknowledge-failure skip                  |
| Extra model turns / cost                  | Max 1–2 continues per gate family; chain returns first hit only         |
| FAIL parser fragile                       | Align with harness-tools output first; test those strings               |

## 10. Out of scope / deferred

- Default TUI `acceptEdits` product decision (CLAUDE.md open item)
- Plan mode discoverability
- LSP diagnostics reminder (Grok)
- Subagent completion parity beyond existing background-completion-reminder
- Multi-fire coding verification beyond retryLimit 1

Restart triggers for deferred items: user reports false completes still common after this ships; or explicit request for plan/LSP parity.

## 11. Decision log

- 2026-07-17: Priority = **problem-solving loop**, success = **real-scenario perceptible**.
- Approach **A** (deepen completion gates) preferred over new debug tools (B) or checklist mega-parity (C).
- User approved design direction; this file is the written spec for plan → implement.
