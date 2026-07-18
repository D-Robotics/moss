# Spec: Agent Work Loop & Intent Routing (Moss)

**Status:** Active (Phase A in progress)  
**Date:** 2026-07-17  
**Goal:** Align Moss’s *runtime behavior* with a senior-agent work loop (intent → tools/skills → act → verify → deliver), comparable in discipline to Claude Code / Codex / Grok-build, without inventing product surface that does not exist yet.

**User supplements incorporated:**
- Engineering-partner loop (boundary → understand → verifiable blocks → verify → evidence close-out)
- Search stack: local `search_code`/`search_files` (+ explore subagent) vs web `web_search`→`web_fetch` vs `memory_read`
- Explicit non-goals: no silent API guess, no green-without-evidence, no scope creep, no unsolicited commit/push

---

## 1. Problem

Users describe an ideal loop:

| Stage | Ideal behavior |
|---|---|
| Understand intent | Parse request; ask when ambiguous; do not guess |
| Load tools/skills | Route coding vs design vs research; load Skill workflows when needed |
| Decide | Plan phases; hard rules (e.g. goal node first) |
| Execute | Read/edit/run/search; subagents when parallel helps |
| Verify | Treat verification as required; self-correct from evidence |
| Iterate | Until done-criteria met |
| Deliver | Structured, evidence-backed result |

**Today (Moss already has pieces):**

| Capability | Status |
|---|---|
| Coding tools (read/edit/search/exec/tests) | Strong |
| Completion gates (fresh green after last edit, red/empty/bg running blocked) | Strong (recent) |
| Mid-run nudges (todo / verify / red-verify / skill discovery) | Strong (recent) |
| Subagent fan-out + parent merge honesty | Strong (recent) |
| TUI/oneshot code-change visibility | Strong (recent) |
| Clipboard attach Ctrl+V | Improved (macOS + Linux/Windows backends) |
| Explicit *intent router* as a first-class runtime phase | **Weak / implicit** |
| Design canvas (Ardot) workflow | **Out of Moss agent scope** (Studio product) unless wired later |
| “Always ask before acting when unclear” as a hard gate | **Partial** (prompt + `ask_user_question`; not enforced by host) |
| Screenshot self-check for UI work | **Partial** (screenshot tools exist; not a required verify step) |

This spec defines what to implement in Moss agent/CLI so the loop is **observable, enforceable, and testable**.

---

## 2. Non-goals

- Full Ardot/canvas product implementation inside `@rdk-moss/agent`.
- Replacing the LLM’s planning with a rigid state machine for every chat turn.
- Breaking pure-chat latency wins (PONG-style turns stay light).

---

## 3. Design: Intent classes

Every user turn is classified into one **primary intent** (and optional secondary):

| Intent | Signals (examples) | Default tool/skill policy |
|---|---|---|
| `chat` | greetings, pure Q&A, no verbs of change | Minimal tools; no heavy skills index |
| `coding` | fix/implement/refactor/test/PR | Full coding tools; verification gates on |
| `debug` | bug/error/stack/crash | Same as coding + investigation nudge |
| `research` | search/docs/web/latest news | web_* + fetch; no local writes unless asked |
| `ops` | connect board/SSH/ROS/device | device_* + robotics domain prompt |
| `design` | UI/page/layout/design system/Ardot | *If* design tools registered: design path; else ask / handoff message |
| `plan_only` | plan/proposal/roadmap without implement | plan/plan_step/todo; no edit tools unless user confirms |

Classification is **best-effort heuristics first** (regex + length + tool history), with an optional model judge only when score is low.

---

## 4. Runtime phases (host-enforced where possible)

```
User turn
  → IntentClassify
  → ContextAssemble (prompt layers, skills index budget, tool filter)
  → AgentLoop
       while working:
         plan/todo (soft nudge)
         act (tools)
         observe (tool results, bg completion, skill discovery)
         mid-run discipline (verify/red-verify/todo)
       end-turn:
         completion gates (todo, fresh green, bg running, red, fan-out merge, debug investigate)
  → Deliver (answer + evidence summary)
```

### 4.1 Understand (before first mutation)

**Policy:**

- If intent ambiguous **and** action would write files / run destructive shell / device write → prefer `ask_user_question` or a short clarifying reply.
- Pure chat / low-risk reads: no forced ask.

**Open product choice (see §8):** hard-block first write without a stated done-criteria, or soft prompt only.

### 4.2 Load tools / skills

Already partially present:

- Oneshot tool routing (hide plan/eval/web when unused)
- Skill index + `load_skill` / SkillHub
- Board connect robotics domain injection

**New:**

- Intent → skill *suggestion* list (not auto-load full bodies except keyword match)
- Design intent without design tools → explicit system note: “Design canvas not available in this session; offer code-only UI or handoff”

### 4.3 Decide

- Multi-step coding: TodoNudge + user-facing checklist via `todo_write`
- Parallel independent subtasks: `fan_out_subagents` with merge gate
- Goal/loop: autonomous next-subtask chaining (`intervalMs=0`)

### 4.4 Execute

Unchanged tool surface; improve **visibility**:

- Tool results embed change previews (done)
- TUI/oneshot default diffs (done)

### 4.5 Verify (hard for coding/debug)

Host gates already:

- Fresh green after last edit
- Red / empty suite / no steps / bg still running → not done
- Fan-out FAILED children → not overall done

**New (optional phase 2):**

- `design` intent: require screenshot / vision check before done (if tools present)
- `ops` intent: require real probe evidence (already in board success messaging)

### 4.6 Deliver

Structured delivery template for coding (compact):

```
## Done
<one sentence done-criteria restated>

## Changes
- path: summary

## Verification
- command + pass/fail excerpt

## Follow-ups (if any)
```

Soft prompt only; not a schema hard-fail unless `generate_structured` requested.

---

## 5. Attachment / upload mode (vs reference)

### Current Moss

| Path | Behavior |
|---|---|
| `@file` picker | Local path attach |
| Ctrl+V | Clipboard image/file (macOS always; **Linux/Windows backends added**) |
| Paste path + Enter | Path attach |
| `/paste` | Same as clipboard attach |
| Pending chips | Esc clears; summary in prompt |

### Gaps vs Codex/CC

| Gap | Proposal |
|---|---|
| Linux/Win image paste | **Done** (wl-paste/xclip / PowerShell) |
| Drag-drop into terminal | Depends on terminal; document + if Ink/crossterm events available, accept file URIs |
| Multi-file paste | Allow batch paths from clipboard file-list (Win file drop list already attempted) |
| Inline image preview in TUI | Phase 2: show filename + size chip; optional ASCII/half-block preview |
| Same UX on non-macOS help text | **Done** (help strings updated) |

---

## 6. Implementation plan (phased)

### Phase A — Spec lock + small host hooks (this PR series)

1. Land edit result previews + cross-platform clipboard (in progress).
2. Add `IntentClassify` module (pure function + tests) used by oneshot/TUI for tool filter + skill budget only (no behavior change beyond logging/`/doctor` intent label).
3. Document delivery template in coding behavior prompt (1 short paragraph).

### Phase B — Soft enforcement

1. ~~Mid-run: if coding intent and first tool is write/edit without any read/search in session → stronger investigate nudge (exists for fix/bug; extend lightly).~~ **Done (2026-07-17):** `evaluateDebugInvestigationGate` covers implement/refactor finish claims without investigation tools; mid-run edits without a done claim still allowed.
2. Ambiguous multi-interpretation prompts → once-per-turn soft ask when write tools would run. *(open — depends on §8 hard vs soft ask)*

### Phase C — Design/ops verify extensions

1. When design tools registered: require visual verify skill path.
2. Ops: keep probe-based success (already).

---

## 7. Testing

| Case | Expected |
|---|---|
| Intent `chat` pure PONG | No heavy tools; no skills dump |
| Intent `coding` fix + edits | Completion needs fresh green |
| Empty/all-skip verify | Not green |
| Fan-out 1 fail + “all done” | Merge gate rejects |
| Ctrl+V image (injected backends) | Pending attachment image block |
| edit_file success result | Contains `--- change preview ---` |

---

## 8. Open questions for you (please answer)

1. **Ambiguity gate:** When intent is unclear and the model would write files, should Moss **hard-block** until `ask_user_question` / user reply, or only **soft-nudge** (current style)?
2. **Design intent without Ardot:** Prefer (a) code-only UI path, (b) explicit “not available” + stop, or (c) handoff instruction to Studio?
   - **Interim default (shipped):** soft dynamic handoff note offering (a)+(c)+one clarifying question; never invent canvas tool calls (`buildDesignIntentHandoffContext`).
3. **Delivery template:** Always inject for coding, only multi-step, or never (keep free-form)?
4. **Attachments:** Priority next — drag-drop, multi-image batch, or in-TUI thumbnail preview?
5. **Screenshot verify:** Required for frontend tasks, optional skill only, or off by default?

---

## 9. Success metrics

- False-complete rate on red/empty/stale verify: near zero (host gates).
- User can see every code mutation without Ctrl+O (TUI + oneshot progress).
- Ctrl+V attach works on macOS/Linux/Windows with documented deps.
- Intent routing does not regress pure-chat TTFT.

---

## 10. Mapping your described loop → Moss modules

| Your stage | Moss module(s) today | Spec addition |
|---|---|---|
| Understand | Prompt + ask_user_question | IntentClassify + optional hard ask |
| Load tools/skills | oneshot filter, skill index, domain detection | Intent → filter/budget |
| Decide | todo_write, plan, loop, fan_out | Unchanged + merge gate |
| Execute | tools | Edit previews in results |
| Verify | completion gates, harness, red-verify | Empty/skip/bg gates (done) |
| Iterate | agent loop | Mid-run nudges (done) |
| Deliver | free-form answer | Optional template |

---

**Next step after your answers to §8:** implement Phase A intent classifier + prompt delivery line, then Phase B soft enforcement with unit tests.
