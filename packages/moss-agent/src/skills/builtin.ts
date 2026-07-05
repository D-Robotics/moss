import type { SkillMeta } from './types.js';

const BUILTIN_UPDATED_AT = 0;

export const BUILTIN_SKILLS: SkillMeta[] = [
  {
    name: 'superpower-methodical-builder',
    description:
      'Use for substantial coding, product, architecture, UX, model-selection, or quality-critical work: define done, compare paths, implement cleanly, and verify.',
    sourcePath: 'builtin://superpower-methodical-builder/SKILL.md',
    version: '1.0.0',
    tags: ['superpower', 'planning', 'architecture', 'verification'],
    trigger: [
      'substantial work',
      'architecture',
      'multi-file',
      'quality-critical',
      'methodical-builder',
    ],
    risk: 'low',
    permissions: {},
    runtimePolicy: { delegatePreference: 'hybrid', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Before coding
1. Define done: what observable behavior signals completion? Write it as one sentence.
2. Compare paths: list 2+ approaches. Pick by simplicity, risk, and fit with existing code. Say why you picked it.
3. Identify affected files + edge cases (empty, max, error, concurrent) up front.

## During
- Smallest useful vertical slice first — end-to-end thin, then thicken.
- Match surrounding style (naming, error handling, comment density).
- Touch only what the task requires.

## After
- Verify against the done-criteria: run it and observe the behavior, not just the tests.
- State what was verified and what remains uncertain.

## Anti-patterns
- No speculative config / flags / abstractions.
- No "while I'm here" refactors.
- No error handling for impossible states.`,
  },
  {
    name: 'superpower-systematic-debugging',
    description:
      'Use when fixing bugs, regressions, test failures, or unexpected behavior: reproduce, minimize, identify root cause, fix narrowly, and add regression coverage.',
    sourcePath: 'builtin://superpower-systematic-debugging/SKILL.md',
    version: '1.0.0',
    tags: ['superpower', 'debugging', 'bugfix', 'regression'],
    trigger: ['bug', 'failure', 'regression', 'unexpected behavior', 'systematic-debugging'],
    risk: 'low',
    permissions: {},
    runtimePolicy: { delegatePreference: 'hybrid', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Steps
1. Reproduce: get a reliable repro (command, input, state). If you can't reproduce it, you can't verify the fix.
2. Minimize: strip the repro to the smallest input that still triggers.
3. Isolate: bisect (git bisect, comment-out, binary chop) to the exact change or line.
4. Root cause: state it as a sentence. "X happens because Y assumes Z, which is false when W."
5. Fix narrowly: change the minimal code that addresses the root cause. Don't refactor adjacent code.
6. Add a regression test: must fail before the fix and pass after.
7. Verify: repro gone, new test passes, no regressions in the adjacent area.

## Anti-patterns
- Don't fix the first symptom you see — find the root cause.
- Don't fix multiple bugs at once — one cause, one fix, one commit.
- Don't add error handling to mask the bug — fix the bug.`,
  },
  {
    name: 'superpower-test-driven-development',
    description:
      'Use for behavior changes and bug fixes: write or identify a failing test before production code, make it pass, then refactor while green.',
    sourcePath: 'builtin://superpower-test-driven-development/SKILL.md',
    version: '1.0.0',
    tags: ['superpower', 'tdd', 'testing', 'bugfix'],
    trigger: ['tdd', 'test first', 'failing test', 'behavior change', 'bug fix'],
    risk: 'low',
    permissions: {},
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Cycle (Red -> Green -> Refactor)
1. Red: write the smallest test that captures the desired behavior. Run it — it must FAIL, and fail for the right reason.
2. Green: write the minimum production code to make the test pass. No more.
3. Refactor: improve structure with tests green. Run after each change.

## Principles
- Test behavior, not implementation: hit the public API; don't assert internal state.
- One logical behavior per test.
- Name tests by behavior: "add returns the sum of two numbers", not "testAdd1".
- Arrange - Act - Assert structure.

## When NOT to TDD
- Exploratory / spike work: write throwaway code, then add tests once the design settles.
- Visual / UI: snapshot or manual first, then lock.

## Anti-patterns
- Don't write tests that pass without the production code (false green).
- Don't test by mocking the unit under test — you're testing the mock.`,
  },
  {
    name: 'moss-upgrade-and-migration-contract',
    description:
      'Use when changing workspace storage, paths, config, generated runtime folders, or upgrade behavior: preserve user data, migrate or read-through legacy locations, update every reader/writer, and add regression coverage.',
    sourcePath: 'builtin://moss-upgrade-and-migration-contract/SKILL.md',
    version: '1.0.0',
    tags: ['migration', 'upgrade', 'compatibility', 'workspace-data'],
    trigger: [
      'migration',
      'path migration',
      'workspace storage',
      'config path',
      'upgrade',
      'backward compatibility',
      'user data',
    ],
    risk: 'medium',
    permissions: { workspaceRead: true, workspaceWrite: true },
    runtimePolicy: { delegatePreference: 'hybrid', approvalLevel: 'confirm' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Principles
- User data is sacred: never lose, corrupt, or silently relocate it.
- Migrate, don't break: old locations must still read (read-through) until a safe migration completes.
- Update every reader AND writer of a changed path/format — grep for the old value.

## Steps
1. Inventory: find all readers/writers of the old path or format (rg / codegraph callers).
2. Add the new path/format alongside the old (additive, no deletion yet).
3. Migrate on read: when old is found, read it, write to new, leave old intact or archive it.
4. Update writers to emit the new format/path.
5. Add a regression test: old-format input -> correct new-format behavior, no data loss.
6. Document the migration and when the old path can safely be removed.

## Anti-patterns
- Don't delete the old location in the same change that introduces the new.
- Don't migrate lazily without a fallback when the new path is missing.`,
  },
  {
    name: 'codegraph-structural-navigation',
    description:
      'Use CodeGraph for structural code navigation when codegraph_* tools are available: definitions, callers, callees, traces, impact, and focused context.',
    sourcePath: 'builtin://codegraph-structural-navigation/SKILL.md',
    version: '1.0.0',
    tags: ['codegraph', 'structural-search', 'callgraph', 'impact'],
    trigger: ['codegraph', 'callers', 'callees', 'trace', 'impact radius', 'where is defined'],
    risk: 'low',
    permissions: { workspaceRead: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## When to use CodeGraph (vs grep/read)
Use codegraph_* tools BEFORE non-trivial implementation for: definitions, signatures, callers, callees, call traces, impact radius, and focused task context. Reads are sub-millisecond; the index lags writes by about a second.

## Tool selection
- "What is the symbol named X?" -> codegraph_search
- "How does this feature / area work?" -> codegraph_context (PRIMARY — composes search + node + callers + callees)
- "How does X reach Y?" -> codegraph_trace (one call, full path including dynamic-dispatch hops)
- "What calls X?" -> codegraph_callers
- "What would changing X break?" -> codegraph_impact
- "Show several related symbols' source" -> codegraph_explore (one capped call, prefer over many node/Read)

## Anti-patterns
- Don't delegate a codegraph lookup to a subagent — codegraph IS the index; reading files repeats work it already did.
- Don't run grep + read loops for "how does X reach Y" — codegraph_trace returns the path in one call.
- After edits, run \`codegraph sync <repo>\` so the index catches up.`,
  },
  {
    name: 'code-review',
    description:
      'Use for structured code review: read the diff, check for bugs, security issues, naming, simplicity, test coverage, and return findings with severity. Use verify_fix after applying any review-driven changes.',
    sourcePath: 'builtin://code-review/SKILL.md',
    version: '1.0.0',
    tags: ['review', 'quality', 'security', 'bugs', 'best-practices'],
    trigger: ['code review', 'review this', 'review the code', 'audit', 'check for bugs'],
    risk: 'low',
    permissions: { workspaceRead: true },
    runtimePolicy: { delegatePreference: 'hybrid', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Steps
1. Get the diff: \`git --no-pager diff\` (staged) or \`git --no-pager diff HEAD\` (all changes). For a PR, diff against the base branch.
2. Read each changed hunk in full context — open the file around the hunk, don't review the hunk in isolation.
3. Evaluate per dimension, worst-first:
   - Correctness: off-by-one, wrong null/undefined handling, races, unhandled error paths, state mutation bugs.
   - Security: injection, SSRF, path traversal, secret leakage, unsafe deserialization, missing auth.
   - API correctness: hallucinated signatures, wrong types, deprecated calls, wrong SDK version.
   - Simplicity: dead code, over-abstraction, speculative config, unused params, "while I'm here" edits.
   - Tests: does the change add or adjust tests? Are edge cases covered?
4. For each finding report: severity (critical / major / minor / nit), file:line, what's wrong, suggested fix.
5. Run \`verify_fix\` after applying any review-driven change.

## Output format
Return findings ranked by severity, critical first. If there are no issues, say so plainly — do not invent nits to seem thorough.`,
  },
  {
    name: 'git-workflow',
    description:
      'Use for Git operations: branch, commit (conventional commits), diff, log, merge, rebase, stash. Provides structured commit messages and branch naming conventions.',
    sourcePath: 'builtin://git-workflow/SKILL.md',
    version: '1.0.0',
    tags: ['git', 'vcs', 'commit', 'branch', 'merge', 'rebase'],
    trigger: ['git', 'commit', 'branch', 'merge', 'rebase', 'stash', 'diff', 'pull request'],
    risk: 'medium',
    permissions: { workspaceRead: true, workspaceWrite: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'confirm' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Branch
- Branch from latest main: \`git checkout main && git pull && git checkout -b <type>/<scope>-<slug>\`.
- Types: feat / fix / refactor / docs / chore / test / perf.
- Slug: imperative, lowercase, hyphenated.

## Commit (conventional)
Format: \`<type>(<scope>): <subject>\` — subject imperative mood, <= 50 chars, no trailing period.
Body: what + why (not how). Footer: \`Co-Authored-By:\` or \`BREAKING CHANGE:\`.
One logical change per commit. Stage precisely — avoid \`git add -A\` for mixed changes.

## Before push
- \`git log --oneline origin/main..HEAD\` — review your commit messages.
- \`git --no-pager diff origin/main...HEAD\` — review your full diff.
- Rebase if your history is noisy: \`git rebase -i origin/main\`.

## PR
- Title matches the first commit. Body: what changed, why, how it was verified, migration notes.`,
  },
  {
    name: 'refactoring',
    description:
      'Use for code refactoring: identify code smells, write/verify tests, make small incremental changes, and verify after each step.',
    sourcePath: 'builtin://refactoring/SKILL.md',
    version: '1.0.0',
    tags: ['refactoring', 'clean-code', 'maintainability'],
    trigger: ['refactor', 'clean up', 'simplify', 'extract method', 'rename', 'code smell'],
    risk: 'low',
    permissions: { workspaceRead: true, workspaceWrite: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Principles
- Tests first: confirm green tests exist before refactoring. If none exist, write characterization tests that capture current behavior.
- Smallest safe steps: one refactor per change. Verify (build + tests) between steps.
- Preserve behavior: refactoring changes structure, NOT behavior. If behavior changes, it's not a refactor.
- Rename only when the new name is unambiguously clearer.

## Smells to address
Long method (> ~40 lines), deep nesting (> 3), feature envy, duplicated blocks, large class, magic numbers, dead code, unclear names.

## Anti-patterns
- Don't refactor code not touched by the current task.
- Don't introduce abstractions for a single use.
- Don't change public API unless asked.

## Verify
After each step: typecheck + run the affected tests. Report what changed and what was verified.`,
  },
  {
    name: 'documentation',
    description:
      'Use for generating or updating documentation: API docs, README, CHANGELOG, inline comments, and architecture docs.',
    sourcePath: 'builtin://documentation/SKILL.md',
    version: '1.0.0',
    tags: ['documentation', 'docs', 'readme', 'changelog', 'api'],
    trigger: ['document', 'docs', 'readme', 'api doc', 'changelog', 'comment'],
    risk: 'low',
    permissions: { workspaceRead: true },
    runtimePolicy: { delegatePreference: 'hybrid', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Principles
- Document the WHY, not the WHAT — the code shows what; docs explain why it exists, when to use it, and the gotchas.
- Audience: write for the person who reads this six months from now, not for yourself.
- Examples over prose: one working example beats a paragraph.
- Keep code examples runnable — verify them mentally against the current API.

## Per type
- README: what it is, install, quickstart, common usage, where to find more.
- API doc: signature, params, return, throws, one example, edge cases.
- CHANGELOG: user-impact, reverse-chronological, past tense (Added / Fixed / Changed / Removed).
- Architecture doc: component diagram (mermaid), data flow, key decisions + rationale.

## Anti-patterns
- Don't document what's obvious from the code.
- Don't leave outdated examples — verify against the current code.
- Don't write marketing copy inside technical docs.`,
  },
  {
    name: 'create-presentation',
    description:
      'Use to produce a polished, self-contained deliverable: an HTML slide deck (reveal.js), a Mermaid/HTML diagram, or a styled Markdown/HTML document. Emits ONE file the user can open directly in a browser.',
    sourcePath: 'builtin://create-presentation/SKILL.md',
    version: '1.0.0',
    tags: ['presentation', 'slides', 'html', 'artifact', 'diagram', 'deliverable'],
    trigger: [
      'presentation',
      'slides',
      'slide deck',
      'ppt',
      'pptx',
      'make html',
      'html document',
      'diagram',
      'mermaid',
      'deliverable',
    ],
    risk: 'low',
    permissions: { workspaceRead: true, workspaceWrite: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Principles
- Self-contained: ONE .html or .md file the user can open directly. For HTML, pull reveal.js / mermaid / highlight.js from a CDN (no npm install, no build step).
- Print/export-friendly: slides must also read well as a printed PDF (use reveal.js's print stylesheet, avoid animation-only meaning).
- Minimal viable deck: title slide, agenda (only if >5 slides), one idea per slide, a closing summary. Don't pad.
- Real content over filler: if the user gave a topic, produce actual slides about it — not placeholders.

## HTML slide deck (default for "presentation"/"slides"/"ppt")
Use reveal.js 5 from CDN. Skeleton:
\`\`\`html
<!doctype html>
<html><head>
  <meta charset="utf-8"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reset.css"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/theme/black.css" id="theme"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/plugin/highlight/monokai.css"/>
</head><body>
  <div class="reveal"><div class="slides">
    <section><h1>Title</h1><p>Subtitle</p></section>
    <section><h2>One idea</h2><p>Details</p></section>
    <section data-markdown><script type="text/template">## Markdown slide\\n- bullet</script></section>
    <section><h2>Code</h2><pre><code class="language-ts">const x = 1;</code></pre></section>
  </div></div>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5/plugin/highlight/highlight.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5/plugin/markdown/markdown.js"></script>
  <script>Reveal.initialize({ hash:true, center:true, plugins:[RevealHighlight,RevealMarkdown] });</script>
</body></html>
\`\`\`
- Choose a theme that fits the topic (black/white/sky/serif). Avoid mixing themes.
- For diagrams inside a slide, embed a Mermaid block (see below) — don't hand-draw ASCII.

## Mermaid diagram (default for "diagram"/"flow")
Emit a single HTML file with mermaid from CDN:
\`\`\`html
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<div class="mermaid">graph LR; A-->B; B-->C;</div>
<script>mermaid.initialize({startOnLoad:true});</script>
\`\`\`
Pick the right diagram type: graph LR (flow), sequenceDiagram (interactions), classDiagram (structure), gantt (timeline), pie (proportions).

## Styled Markdown document (default for "doc"/"document")
Emit a .md file with front-matter + Mermaid where a diagram aids understanding. Keep it runnable in any markdown viewer. For a polished standalone .html doc, wrap the markdown in a minimal HTML page with a readable font and max-width.

## Anti-patterns
- Don't emit multiple loose files when one self-contained file works.
- Don't hand-draw diagrams as ASCII art when Mermaid renders cleanly.
- Don't add a build step (npm/webpack) — CDN + one file is the deliverable.
- Don't use animation as the only way to understand a slide (printed output loses it).`,
  },
];

export function listBuiltinSkills(): SkillMeta[] {
  return BUILTIN_SKILLS.map((skill) => ({
    ...skill,
    tags: [...skill.tags],
    trigger: [...skill.trigger],
    permissions: { ...skill.permissions },
    runtimePolicy: skill.runtimePolicy ? { ...skill.runtimePolicy } : undefined,
    body: skill.body,
  }));
}
