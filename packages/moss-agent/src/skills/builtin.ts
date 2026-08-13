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
- Verify efficiently: combine typecheck + test + import-check into one exec call; use \`node -e\` / \`node --check\` inline instead of writing throwaway verify-*.js files; don't re-read files you just wrote — verify by running, not by reading back.

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
    trigger: [
      'bug',
      'failure',
      'regression',
      'unexpected behavior',
      'systematic-debugging',
      '调试',
      '除零',
      '根因',
      'bug 修复',
    ],
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
    trigger: [
      'tdd',
      'test first',
      'failing test',
      'behavior change',
      'bug fix',
      '测试驱动',
      '先写测试',
      '失败测试',
    ],
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
      '升级',
      '迁移',
      '兼容性',
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
    trigger: [
      'codegraph',
      'callers',
      'callees',
      'trace',
      'impact radius',
      'where is defined',
      '调用者',
      '调用关系',
      '影响面',
    ],
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
    trigger: [
      'code review',
      'review this',
      'review the code',
      'audit',
      'check for bugs',
      '审查',
      '代码审查',
      '检查 bug',
      'review',
    ],
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
    trigger: [
      'git',
      'commit',
      'branch',
      'merge',
      'rebase',
      'stash',
      'diff',
      'pull request',
      '提交',
      '分支',
      '合并',
    ],
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
    trigger: [
      'refactor',
      'clean up',
      'simplify',
      'extract method',
      'rename',
      'code smell',
      '重构',
      '代码异味',
      '小步改',
    ],
    risk: 'low',
    permissions: { workspaceRead: true, workspaceWrite: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'none' },
    inputs: ['implementation-plan', 'verified-codebase-context'],
    outputs: ['refactored-code'],
    before: ['verification-before-completion'],
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
After each step: typecheck + run the affected tests. Report what changed and what was verified.

## Efficient verification (avoid turn bloat)
- Prefer inline checks over scratch files: \`node -e "require('./api')"\` or \`node --check file.js\` instead of creating \`verify-*.js\` then deleting it.
- Batch reads: if you need to confirm 3 files after a refactor, read them in one tool call (parallel read_file), not 3 sequential turns.
- One verification turn, not many: combine typecheck + test + import-check into a single exec call when possible (e.g. \`node --check a.js && node --check b.js && node -e "require('./api')"\`).
- Don't re-read files you just wrote — you already know their content. Trust the edit and verify by running, not by reading back.`,
  },
  {
    name: 'documentation',
    description:
      'Use for generating or updating documentation: API docs, README, CHANGELOG, inline comments, and architecture docs.',
    sourcePath: 'builtin://documentation/SKILL.md',
    version: '1.0.0',
    tags: ['documentation', 'docs', 'readme', 'changelog', 'api'],
    trigger: ['document', 'docs', 'readme', 'api doc', 'changelog', 'comment', '文档', '说明文档'],
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
      'Use to create, inspect, edit, render, and quality-check native PowerPoint .pptx presentations. Preserve a supplied reference deck when present; use HTML slides only when explicitly requested or native PowerPoint is unavailable.',
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
      '演示',
      '幻灯片',
    ],
    risk: 'low',
    permissions: { workspaceRead: true, workspaceWrite: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Native PPTX is the default
Create or return a real .pptx for PowerPoint, PPT, PPTX, slide, or presentation requests. HTML/reveal.js is only an explicit fallback.

## Reference-deck workflow
1. Inspect every reference slide, then duplicate suitable source slides and edit inherited elements in place.
2. Preserve masters, layouts, typography, colors, logos, spacing, and image frames. Preserve the original file and save a copy.
3. Keep all objects inside the canvas. Use contain for QR codes and logos; use cover only for photos. Shorten copy or choose another layout before shrinking text.

## Windows native helper
Use assets/presentation-tools/pptx-native.ps1 for existing decks and final verification:
- inspect: powershell -File <helper> -Action inspect -InputPath <deck.pptx>
- render every slide: powershell -File <helper> -Action render -InputPath <deck.pptx> -RenderDir <dir>
- overflow audit: powershell -File <helper> -Action audit -InputPath <deck.pptx>
- replace text: inspect shape ids, write a UTF-8 JSON array of {"slide":1,"shapeId":7,"text":"New title"}, then run replace-text with -MapPath and -OutputPath.
This helper requires Microsoft PowerPoint on Windows. If unavailable, state that and use a compatible PPTX library already present.

## Quality gate
Render and visually inspect every slide, then run the overflow audit. Fix clipping, overlap, unexpected wrapping, stretched images, tiny QR codes, unresolved placeholders, and inconsistent page furniture. Do not claim completion from file creation alone.

## HTML fallback principles
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
  {
    name: 'web-research',
    description:
      'Use for current news, latest releases, market or technical research that depends on fresh external information. Enforces recency, source quality, cross-checking, and explicit dates.',
    sourcePath: 'builtin://web-research/SKILL.md',
    version: '1.0.0',
    tags: ['research', 'web', 'news', 'rss', 'latest', 'sources'],
    trigger: ['latest', 'news', 'research', '最新', '新闻', '调研', '联网搜索'],
    risk: 'low',
    permissions: { network: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Freshness first
- For today/latest/current/news requests, call web_search with recency=day or week. Do not add a guessed year to the query.
- Prefer dated RSS/news results for discovery. Read the publication date and distinguish when the event happened from when an article was published.
- Use exact dates in the answer. If no genuinely recent result exists, say so instead of presenting old material as current.

## Source quality
1. Start with primary sources: official newsroom, release notes, repositories, papers, regulators, or company posts.
2. Use reputable reporting to add context and independent confirmation.
3. Cross-check important claims with at least two independent sources when practical.
4. A dated RSS news snapshot with publisher, date, title, and summary is enough for a low-risk news overview. Do not web_fetch Google News redirect URLs; when full-text verification or a consequential claim requires the original article, search by publisher and title and fetch that original page.
5. For ordinary web-search snippets without structured RSS provenance, fetch the most relevant source before relying on it. If web_fetch fails, try another source or the browser tool; do not repeatedly retry one broken URL.
6. A request for a source or original source alone means name the publisher and include the publisher/source URL already present in the RSS snapshot. It does not request full-text verification. Fetch more only when the user explicitly asks to open the original article, inspect the full text, or verify a specific consequential claim.

## Output
- Lead with the answer, then list the evidence with source, date, and why it matters.
- When the user asks for sources, print the available URL for each cited item; a publisher name without its available URL is incomplete.
- Separate verified facts from inference.
- Never fabricate a citation, publication date, quote, or source.`,
  },
  {
    name: 'codebase-inspection',
    description:
      'Use to understand an unfamiliar repository before editing: map architecture, trace the relevant runtime flow, identify verification commands, and report evidence-backed findings.',
    sourcePath: 'builtin://codebase-inspection/SKILL.md',
    version: '1.0.0',
    tags: ['codebase', 'inspection', 'architecture', 'repository', 'analysis'],
    trigger: [
      'inspect codebase',
      'understand repository',
      'architecture review',
      '代码库分析',
      '架构评估',
      '看看代码',
    ],
    risk: 'low',
    permissions: { workspaceRead: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'none' },
    outputs: ['verified-codebase-context', 'architecture-map'],
    before: ['planning', 'refactoring'],
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Workflow
1. Read AGENTS.md and package/build metadata before assuming conventions.
2. If the root manifest already declares workspace package paths, use those paths directly; do not list the same directory merely to rediscover them.
3. Once the needed manifests, entry files, or test runners are known, read independent files in one parallel tool batch instead of serial discovery turns.
4. Map only the task-relevant entry points, state, boundaries, and tests. Prefer structural navigation for definitions/callers; use text search for configuration and messages.
5. Trace one complete runtime path from user input to observable output when the user asks for a flow. Read the source before making claims.
6. Generate hypotheses, then actively try to falsify each one by checking callers, tests, and alternative paths.
7. Identify the narrowest verification command and any environment dependency before editing.

## Output
- Stay within the requested scope; a short entry-point or command question should not become a general architecture report.
- Findings require file:line evidence.
- Separate confirmed findings from hypotheses.
- Include what is well-designed and should not be changed.
- Prioritize silent bugs and contract violations over missing-framework feature lists.`,
  },
  {
    name: 'planning',
    description:
      'Use for non-trivial implementation planning: define done, order dependencies, identify risks, and attach a concrete verification check to every phase.',
    sourcePath: 'builtin://planning/SKILL.md',
    version: '1.0.0',
    tags: ['plan', 'implementation', 'workflow', 'requirements', 'verification'],
    trigger: ['make a plan', 'implementation plan', 'roadmap', '制定计划', '实现计划', '分步骤'],
    risk: 'low',
    permissions: { workspaceRead: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'none' },
    inputs: ['verified-codebase-context', 'architecture-map'],
    outputs: ['implementation-plan'],
    before: ['refactoring'],
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Plan quality
- Define the user-visible done condition first.
- Read enough source to name real files and boundaries; do not plan from filenames alone.
- Break work into 3-7 dependency-ordered phases. Each phase must produce an observable result.
- Attach a verification step to every behavior change: failing regression, targeted test, build/typecheck, or real interaction.
- Name meaningful risks, migration concerns, and rollback points. Avoid speculative architecture and unrelated cleanup.

## Execution discipline
- Keep exactly one phase in progress.
- Update the plan when evidence changes the approach.
- Do not mark a phase complete until its stated verification passes.
- At handoff, report completed work, remaining work, verification, and uncertainty.`,
  },
  {
    name: 'verification-before-completion',
    description:
      'Use before claiming any code change is done: run the real verification command, read the output, and only then report success. Blocks "should be fine" completions.',
    sourcePath: 'builtin://verification-before-completion/SKILL.md',
    version: '1.0.0',
    tags: ['verification', 'superpower', 'quality', 'tests', 'completion'],
    trigger: [
      'verify',
      'verification',
      'before claiming done',
      'confirm it works',
      'run tests',
      '验证',
      '确认完成',
      '跑测试',
    ],
    risk: 'low',
    permissions: { workspaceRead: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'none' },
    inputs: ['refactored-code', 'implementation-result'],
    after: ['refactoring', 'superpower-test-driven-development'],
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Rule
Never report a code change as done until you have **seen** verification output with your own eyes.

## Minimum bar
1. Prefer \`run_tests\` or \`verify_fix\` over raw exec when available.
2. If only \`exec\` is used, capture exit code + relevant stdout/stderr.
3. Map each user requirement to evidence (test name, command output, or file:line).
4. If verification fails, fix and re-run — do not ship a red result as green.
5. If you did not run a check, say so explicitly instead of implying it passed.

## Efficient verification
- One combined command when possible: typecheck && test.
- No throwaway verify-*.js files — use \`node -e\` / \`node --check\` / project scripts.
- Do not re-read files you just wrote just to "confirm" the write.

## Anti-patterns
- "Should work now" without a command.
- Claiming all tests pass when output shows failures.
- Skipping failure-path cases the user named explicitly.`,
  },
  {
    name: 'frontend-ui-polish',
    description:
      'Use for web UI / frontend work: distinctive visual design, responsive layout, accessibility basics, and real interaction states — avoid generic AI-template aesthetics.',
    sourcePath: 'builtin://frontend-ui-polish/SKILL.md',
    version: '1.0.0',
    tags: ['frontend', 'ui', 'css', 'react', 'design', 'accessibility'],
    trigger: [
      'frontend',
      'ui',
      'css',
      'react component',
      'landing page',
      'dashboard',
      'stylesheet',
      '界面',
      '前端',
      '页面',
    ],
    risk: 'low',
    permissions: { workspaceRead: true, workspaceWrite: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Design bar
- Match the product domain: tools/SaaS = dense, quiet, work-focused; consumer/marketing = more expressive.
- Avoid generic AI aesthetics: purple gradients, decorative orbs, oversized hero cards, one-hue palettes.
- Prefer existing design system / tokens / component library over inventing a new style.

## Implementation
1. Read existing CSS/components before adding new ones.
2. Use semantic HTML and keyboard-reachable controls.
3. Cover empty / loading / error / disabled states for interactive UI.
4. Check text contrast and overflow on narrow widths; do not scale font size by viewport width alone.
5. Prefer icons from the project's icon set (e.g. lucide) over hand-drawn SVG when available.

## Verify
- Run the app or story when possible; report residual visual risk if you only did static review.
- Keep diffs surgical — no drive-by restyles of unrelated pages.`,
  },
  {
    name: 'pr-and-ship',
    description:
      'Use when preparing a pull request or shipping a change: focused diff, conventional commits, clear PR body, verification evidence, and no force-push or surprise secrets.',
    sourcePath: 'builtin://pr-and-ship/SKILL.md',
    version: '1.0.0',
    tags: ['pr', 'ship', 'git', 'review', 'release'],
    trigger: [
      'pull request',
      'create pr',
      'open pr',
      'ship',
      'ready to merge',
      '提交 pr',
      '发 pr',
      '合并',
    ],
    risk: 'medium',
    permissions: { workspaceRead: true, workspaceWrite: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'confirm' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Before PR
1. \`git status\` / \`git diff\` — only include intentional changes.
2. Run the project verification (tests / typecheck / lint as applicable).
3. Confirm no secrets, credentials, or dist/ artifacts in the diff.

## Commit
- Conventional commits: \`type(scope): subject\`.
- One logical change per commit when practical.
- Never force-push to shared main/master unless explicitly asked.

## PR body
- What changed (user impact).
- Why.
- How verified (commands + results).
- Risk / rollback notes.

## Anti-patterns
- Mixing unrelated refactors into a bugfix PR.
- Empty "fixed stuff" descriptions.
- Claiming CI is green without running or checking it.`,
  },
  {
    name: 'efficient-coding-loop',
    description:
      'Use for multi-step coding tasks: parallel reads/searches, multi_edit for batches, todo_write for plans, and close the loop with run_tests/verify_fix — Codex/Claude Code style turn efficiency.',
    sourcePath: 'builtin://efficient-coding-loop/SKILL.md',
    version: '1.0.0',
    tags: ['coding', 'efficiency', 'tools', 'parallel', 'harness'],
    trigger: [
      'implement',
      'fix the bug',
      'add feature',
      'multi-file',
      'coding task',
      '实现',
      '修复',
      '改代码',
    ],
    risk: 'low',
    permissions: { workspaceRead: true, workspaceWrite: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
    body: `## Turn efficiency (same model, better harness use)
1. **Parallel explore**: issue independent read_file / search_code / search_files / list_directory calls in one turn.
2. **Cheap discovery first**: search_code with output_mode=files_with_matches (or search_files globs) before content greps; open only the files you need.
3. **Surgical edit**: prefer edit_file or multi_edit over rewrite; use multi_edit when 2+ replacements are known.
4. **Plan long work**: todo_write for 3+ steps; keep exactly one in_progress.
5. **Verify once well**: run_tests, verify_fix, or code_diagnostics; fix reds; only then report done.
6. **No thrash**: do not re-read a file you just successfully wrote; do not stop mid-requirement.
7. **Long processes**: exec with run_in_background=true (or exec_background) for servers/watchers; poll with exec_logs.

## Tool choice
- Structure questions → CodeGraph when available, else search_code (files_with_matches) + read_file.
- Name patterns → search_files (rg --files, newest first).
- Skills → load_skill; missing marketplace skills → skillhub_search → skillhub_install → load_skill.
- Tests → run_tests (structured) over raw exec when possible.
- Shell only for install/build/git that tools do not cover.

## Anti-patterns
- Serial "read one file, think, read next" for independent files.
- Content-mode search_code dumps when you only need paths (use files_with_matches).
- Partial fix then "I would next…" without finishing.
- Inventing tool names not in the registered set.`,
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
