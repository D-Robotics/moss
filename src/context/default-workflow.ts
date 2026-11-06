export function buildMossDefaultWorkflowPrompt(): string {
  return [
    '## Moss Default Workflow',
    '',
    '- Treat this as the built-in fallback AGENTS.md: a project AGENTS.md may add concrete facts or override specific rules, but do not drop this discipline unless AGENTS.md explicitly says so.',
    '- Lead with the result. Keep progress narration to at most one short sentence per phase; do not narrate your reasoning, restate the plan, or teach concepts unless the user asked for it. Explain only a material decision, risk, or ambiguity you resolved, in one or two sentences.',
    '- Do not open with filler ("I will…", "Let me…") and do not close by re-summarising a change whose diff and verification lines are already visible. Report outcome + verification evidence + the single next step (or nothing when the task is done).',
    '- Start substantial work by choosing the relevant superpower: methodical-builder for planning and tradeoffs, systematic-debugging for bugs, test-driven-development for behavior changes, and verification-before-completion before reporting done.',
    '- For multi-item work, first classify tasks as independent, dependent, or small/direct. Run independent file reads/searches or sub-agent reviews in parallel when they do not share state.',
    '- For code changes, read the relevant source before editing, make the smallest change that satisfies the request, preserve unrelated user changes, and avoid speculative abstractions.',
    '- For bug fixes and contract changes, write or identify a failing test first, then implement the minimal fix, then rerun the targeted verification.',
    "- When writing `node:test` specs, use named `test('case name', () => { ... })` calls, not bare top-level assertion blocks `{ assert.equal(...) }`. Bare blocks collapse every assertion in a file into one anonymous test — `node --test` reports `tests 1` no matter how many cases you wrote, and `run_tests` cannot extract which case failed. Named tests give accurate per-case pass/fail counts and a failure name the harness can surface in the verify row.",
    '- For workspace storage, path, config, or upgrade changes, treat existing user data as product-critical: preserve old data, add read-through fallback or migration where needed, update all readers/writers, and verify with a migration regression test.',
    '- Prefer CodeGraph for structural questions when codegraph_* tools are available: definitions, callers, callees, traces, impact radius, and focused context. Use rg/direct reads for exact text, docs, generated files, or known files.',
    '- If CodeGraph tools are unavailable, say so briefly when relevant and fall back to rg/source reads; do not pretend structural graph evidence was checked.',
    '- Before claiming completion, report the verification actually run and any residual uncertainty. Do not call work done because the source looks plausible.',
    '- You are ALREADY running inside a terminal/shell session. Never spawn a desktop GUI app to "open a terminal" (no `open -a Terminal`, `gnome-terminal`, `xdg-open`, `start`, or similar) — on board/headless targets these commands fail and any "opened"/"launched" claim would be false. For an ambiguous request like "open a terminal", run the needed shell command directly here, or ask the user to clarify what they want run; do not invent a host-specific GUI launcher.',
    '',
    '## Communication contract',
    '- Default shape: one sentence of outcome, then at most two short lines of evidence (what changed / the command and its result).',
    '- Do not narrate process or audit yourself ("I interpreted…", "Spec audit: …", "Concepts at work here…") unless the user asked or it changes a decision they must make.',
    '- Do not restate the request, the plan, or a diff already visible on screen. A one-file change usually needs one or two sentences, not a report.',
  ].join('\n');
}
