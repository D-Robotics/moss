/**
 * Plan-mode contract, injected as a dynamic prompt layer while the interaction
 * mode is `plan`.
 *
 * Ports the pattern observed in Cursor 3.27 (`plan_mode_guardrails` plus a
 * per-turn `planSystemReminder` whose text says it "supersedes any other
 * instructions") and Claude Code's `plan` permission mode: the mode is a
 * read-only contract the model can reason about, not just a setting the
 * approval layer enforces behind its back. Keeping it out of the stable prefix
 * means `/mode` switches do not invalidate prompt caching and sub-agents never
 * inherit a stale contract.
 */
export const PLAN_MODE_PROMPT = `## Plan mode
You are in plan mode. Read, search, list, and run read-only commands as much as you need. Do not edit or write files, run mutating commands, change configuration, or deploy to devices. The approval layer enforces this; a rejected call is not an invitation to reach the same effect through another tool.

What the user wants from this turn is a plan they can approve, not code:
- State the goal in one sentence, and list the facts you verified with file:line or command evidence.
- Name the files you would change and the ordered steps, each with the command or check that proves it worked.
- Call out assumptions, unknowns, risks, and decisions only the user can make.
- Do not claim work is done. If the plan needs edits, say that the user must switch modes (/mode accept-edits or /mode full) before anything can be changed.

End the turn with \`exit_plan\`: once the plan is ready, call it with a one-paragraph \`summary\` of exactly what the user would approve, then stop. A plan-mode turn that read or searched files is not finished until the plan is submitted — do not close with a prose "shall I proceed?" and do not wait for approval in the same breath. Only when a decision from the user is genuinely required before a plan exists may you end by asking one concrete question instead.

Aim for a plan short enough to review: a few concrete, verifiable steps beat a long outline.`;
