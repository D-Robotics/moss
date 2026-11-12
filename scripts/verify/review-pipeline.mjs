#!/usr/bin/env node
/**
 * Deterministic probe for the independent-review pipeline (acceptance-loop P1-a).
 *
 * No model calls: it pins the reviewer output contract parser, the verdict
 * rule, the git diff collector, and the `.moss/review.jsonl` persistence /
 * gitignore contract. The live reviewer is exercised by the real-run check in
 * docs/specs/2026-11-05-moss-acceptance-loop.md; this probe is the regression
 * gate that must not drift silently.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const dist = (rel) => pathToFileURL(path.join(root, 'dist', rel)).href;
const review = await import(pathToFileURL(path.join(root, 'dist/tools/review-tools.js')).href);

const tmpRoots = [];
async function tmpDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
async function git(cwd, args) {
  const result = await captureProcess('git', args, { cwd, timeoutMs: 30_000 });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[review] ok ${name}`);
}

// ── 1. Reviewer output contract ────────────────────────────────────────────

const failReview = [
  'VERDICT: FAIL',
  'FINDINGS:',
  '[Critical] src/calc.js:2 — add() returns a - b, so the sum is wrong — fix: return a + b',
  '[Important] src/calc.js:10 — no input validation — fix: reject non-number arguments',
  '[Suggestion] src/calc.js:14 — duplicated error string — fix: reuse ERR_BAD_INPUT',
  'CHECKS:',
  '- read src/calc.js',
  '- read src/index.js',
].join('\n');
const failParsed = review.parseReviewerOutput(failReview);
assert.equal(failParsed.statedVerdict, 'fail');
assert.equal(failParsed.findings.length, 3);
assert.deepEqual(
  {
    severity: failParsed.findings[0].severity,
    file: failParsed.findings[0].file,
    line: failParsed.findings[0].line,
    fix: failParsed.findings[0].fixHint,
  },
  { severity: 'critical', file: 'src/calc.js', line: 2, fix: 'return a + b' }
);
assert.ok(failParsed.findings[0].summary.includes('add() returns'));
assert.equal(failParsed.checks.length, 2);
assert.equal(review.computeReviewVerdict(failParsed), 'fail');
ok('parses FAIL + critical/important/suggestion findings and CHECKS');

const cleanParsed = review.parseReviewerOutput(
  ['VERDICT: PASS', 'FINDINGS:', 'CHECKS:', '- read src/calc.js'].join('\n')
);
assert.equal(cleanParsed.findings.length, 0);
assert.equal(review.computeReviewVerdict(cleanParsed), 'pass');
ok('parses PASS with no findings');

// A stated PASS cannot overrule a blocking finding.
assert.equal(
  review.computeReviewVerdict({
    statedVerdict: 'pass',
    findings: [{ severity: 'important', file: 'a.ts', summary: 'x' }],
  }),
  'fail'
);
ok('blocking finding overrides a stated PASS');

assert.equal(
  review.computeReviewVerdict({
    statedVerdict: 'pass',
    findings: [{ severity: 'suggestion', file: 'a.ts', summary: 'x' }],
  }),
  'pass'
);
// Findings without a verdict line are still not a completed review.
assert.equal(
  review.computeReviewVerdict({
    findings: [{ severity: 'suggestion', file: 'a.ts', summary: 'x' }],
  }),
  'unknown'
);
ok('suggestion-only review passes only with an explicit PASS');

// Unparseable prose must never become a PASS.
assert.equal(
  review.computeReviewVerdict(review.parseReviewerOutput('Looks good to me.')),
  'unknown'
);
ok('prose without a VERDICT line is unknown, not PASS');

// The prompt's own template must not be parsed as a finding.
const templateEcho = review.parseReviewerOutput(
  [
    'VERDICT: PASS or FAIL',
    'FINDINGS:',
    '[Critical|Important|Suggestion] path/to/file:line — what breaks and why — fix: the smallest change',
    'CHECKS: one line per file or command you inspected',
  ].join('\n')
);
assert.equal(templateEcho.findings.length, 0);
assert.equal(review.computeReviewVerdict(templateEcho), 'unknown');
ok('template echo yields no findings and no verdict');

// Lenient shapes: no brackets, no line number, bullet prefix.
const lenient = review.parseReviewerOutput(
  [
    'VERDICT: FAIL',
    'FINDINGS:',
    '- Important src/a.ts:5 — boom — fix: guard it',
    '[Suggestion] src/b.ts — duplicated logic',
    'critical src/c.ts:1: null deref',
  ].join('\n')
);
assert.equal(lenient.findings.length, 3);
assert.equal(lenient.findings[1].file, 'src/b.ts');
assert.equal(lenient.findings[1].line, undefined);
assert.equal(lenient.findings[2].severity, 'critical');
ok('parses bracketless, bulleted, and line-less findings');

// ── 2. Diff collection ─────────────────────────────────────────────────────

const repo = await tmpDir('moss-review-repo-');
await git(repo, ['init', '-q']);
await git(repo, ['config', 'user.email', 'probe@example.com']);
await git(repo, ['config', 'user.name', 'probe']);
await fs.writeFile(path.join(repo, 'calc.js'), 'export const add = (a, b) => a + b;\n');
await git(repo, ['add', '.']);
await git(repo, ['commit', '-qm', 'init']);

const clean = await review.collectReviewDiff(repo);
assert.equal(clean.diff.trim(), '');
assert.equal(clean.scopeLabel, 'working tree + staged changes');
ok('clean tree collects no diff');

await fs.writeFile(
  path.join(repo, 'calc.js'),
  'export const add = (a, b) => a - b;\nexport const sub = (a, b) => a - b;\n'
);
const changed = await review.collectReviewDiff(repo);
assert.ok(changed.diff.includes('a - b'));
assert.equal(changed.truncated, false);
assert.ok(changed.totalLines >= 3);
ok('working-tree diff is collected with a real change');

const filtered = await review.collectReviewDiff(repo, { paths: ['calc.js'] });
assert.ok(filtered.diff.includes('calc.js'));
const noneMatched = await review.collectReviewDiff(repo, { paths: ['nope.js'] });
assert.equal(noneMatched.diff.trim(), '');
ok('paths option narrows the review');

// An untracked file never shows up in `git diff HEAD`; grow a tracked one.
await fs.writeFile(path.join(repo, 'calc.js'), `${'x'.repeat(500_000)}\n`);
const big = await review.collectReviewDiff(repo, { paths: ['calc.js'] });
assert.equal(big.truncated, true);
assert.ok(big.diff.includes('[diff truncated'));
ok('oversized diff is truncated and says so');

const notRepo = await tmpDir('moss-review-nogit-');
await assert.rejects(() => review.collectReviewDiff(notRepo), /Not a git repository/);
ok('non-git workspace reports a typed error');

// ── 3. Persistence contract ────────────────────────────────────────────────

const record = {
  id: 'probe-record',
  createdAt: new Date(0).toISOString(),
  scope: 'working tree + staged changes',
  depth: 'quick',
  verdict: 'fail',
  statedVerdict: 'fail',
  findings: [
    { severity: 'critical', file: 'calc.js', line: 1, summary: 'wrong op', fixHint: 'a + b' },
  ],
  checks: ['read calc.js'],
  diffLines: 4,
  truncated: false,
  reviewerSuccess: true,
};
const logPath = await review.recordReview(repo, record);
assert.equal(logPath, path.join('.moss', 'review.jsonl'));
const rawLog = await fs.readFile(path.join(repo, '.moss', 'review.jsonl'), 'utf8');
assert.ok(rawLog.endsWith('\n'));
const gitignore = await fs.readFile(path.join(repo, '.moss', '.gitignore'), 'utf8');
assert.ok(gitignore.includes('review.jsonl'), 'runtime .gitignore must hide review.jsonl');
const statusAfterLog = (await git(repo, ['status', '--porcelain'])).trim();
assert.ok(!statusAfterLog.includes('review.jsonl'), 'review log must not show in git status');
const listed = await review.listReviewRecords(repo);
assert.equal(listed.length, 1);
assert.equal(listed[0].id, 'probe-record');
ok('review record persists under .moss and stays out of git status');

// A torn trailing line must not hide earlier reviews.
await fs.appendFile(path.join(repo, '.moss', 'review.jsonl'), '{"torn":');
const afterTorn = await review.listReviewRecords(repo);
assert.equal(afterTorn.length, 1);
assert.equal(afterTorn[0].id, 'probe-record');
ok('torn trailing line is skipped, earlier records survive');

// ── 5. `moss review` command: list/check exit codes ───────────────────────

const reviewCommand = await import(
  pathToFileURL(path.join(root, 'dist/cli/review-commands.js')).href
);
async function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.map(String).join(' '));
  try {
    return { code: await fn(), lines };
  } finally {
    console.log = original;
  }
}
const commandRepo = await tmpDir('moss-review-cmd-');
await git(commandRepo, ['init', '-q']);
const failRecord = {
  id: 'cmd-fail',
  createdAt: new Date(Date.now() - 2000).toISOString(),
  scope: 'working tree + staged changes',
  depth: 'quick',
  verdict: 'fail',
  findings: [
    {
      severity: 'critical',
      file: 'calc.js',
      line: 2,
      summary: 'add() returns the difference',
      fixHint: 'restore a + b',
    },
  ],
  checks: [],
};
await review.recordReview(commandRepo, failRecord);
const emptyRepo = await tmpDir('moss-review-empty-');
const empty = await captureLog(() =>
  reviewCommand.runReviewCommand(['check'], { workspaceDir: emptyRepo })
);
assert.equal(empty.code, 2, 'no review recorded must not read as a pass');
const failing = await captureLog(() =>
  reviewCommand.runReviewCommand(['check'], { workspaceDir: commandRepo })
);
assert.equal(failing.code, 1);
assert.ok(failing.lines.join('\n').includes('critical'));
ok('moss review check: no record -> 2, unresolved findings -> 1');
const listedJson = await captureLog(() =>
  reviewCommand.runReviewCommand(['list', '--json'], { workspaceDir: commandRepo })
);
assert.equal(listedJson.code, 0);
const listedPayload = JSON.parse(listedJson.lines.join('\n'));
assert.equal(listedPayload.schema, 'moss_review_list.v1');
assert.equal(listedPayload.records.length, 1);
ok('moss review list --json returns the records as JSON');
await review.recordReview(commandRepo, {
  ...failRecord,
  id: 'cmd-pass',
  createdAt: new Date().toISOString(),
  verdict: 'pass',
  findings: [],
});
const passing = await captureLog(() =>
  reviewCommand.runReviewCommand(['check'], { workspaceDir: commandRepo })
);
assert.equal(passing.code, 0);
assert.match(
  passing.lines.join('\n'),
  /^PASS — working tree \+ staged changes, quick · critical 0, important 0, suggestion 0$/m,
  'the PASS line states the verdict once, then the details'
);
ok('moss review check: latest PASS -> 0 (one verdict word, then details)');

// ── 6. Untracked files are part of the diff ───────────────────────────────

const untrackedRepo = await tmpDir('moss-review-untracked-');
await git(untrackedRepo, ['init', '-q']);
await fs.writeFile(path.join(untrackedRepo, 'notes.txt'), 'hello\n');
const untrackedDiff = await review.collectReviewDiff(untrackedRepo);
assert.ok(
  untrackedDiff.diff.includes('+++ b/notes.txt'),
  'a new untracked file must appear in the diff'
);
assert.ok(untrackedDiff.diff.includes('+hello'), 'untracked file content must be shown');
assert.match(untrackedDiff.scopeLabel, /untracked/);
ok('untracked new files are rendered into the review diff');
await fs.writeFile(path.join(untrackedRepo, 'blob.bin'), Buffer.from([0, 1, 2, 0]));
const binaryDiff = await review.collectReviewDiff(untrackedRepo);
assert.ok(binaryDiff.diff.includes('untracked binary file: blob.bin'));
ok('untracked binary files are named but not dumped');

// ── 7. Acceptance rubric comes from the task ledger ────────────────────────

const { loadTaskAcceptanceRubric } = review;
const rubricRepo = await tmpDir('moss-review-rubric-');
await fs.mkdir(path.join(rubricRepo, '.moss'), { recursive: true });
const older = {
  taskId: 't-old',
  goal: 'older task',
  acceptanceCriteria: [{ metric: 'old_metric', expected: '>=1' }],
  status: 'accepted',
  createdAt: 1,
  updatedAt: 1,
};
const newer = {
  taskId: 't-new',
  goal: 'ship the camera pipeline',
  acceptanceCriteria: [
    { metric: 'camera_fps', expected: '>=30', required: true },
    { metric: 'frame_drop', expected: '<=1%', required: false, description: 'over 60s' },
  ],
  status: 'executing',
  createdAt: 2,
  updatedAt: 5,
};
await fs.writeFile(
  path.join(rubricRepo, '.moss', 'tasks.jsonl'),
  `${JSON.stringify(older)}\n${JSON.stringify(newer)}\n`
);
const rubric = await loadTaskAcceptanceRubric(rubricRepo);
assert.equal(rubric?.taskId, 't-new');
assert.equal(rubric?.criteria, 2);
assert.ok(rubric?.text.includes('camera_fps >=30'), 'required criterion must be in the rubric');
assert.ok(
  rubric?.text.includes('frame_drop <=1% (optional) — over 60s'),
  'optional criterion keeps its marker and description'
);
assert.ok(!rubric?.text.includes('old_metric'), 'the newest task wins, not the older one');
ok('review rubric is taken from the newest task that declares acceptance criteria');

const emptyRubricRepo = await tmpDir('moss-review-rubric-empty-');
assert.equal(await loadTaskAcceptanceRubric(emptyRubricRepo), undefined);
ok('no task ledger means no implicit rubric (the reviewer falls back to correctness/security)');

// ── 8. Identical diffs are not reviewed twice ─────────────────────────────

const { reviewDiffFingerprint, findRepeatedReview } = review;
const fingerprint = reviewDiffFingerprint('diff --git a/x b/x\n+one\n');
assert.equal(fingerprint, reviewDiffFingerprint('diff --git a/x b/x\n+one\n'));
assert.notEqual(fingerprint, reviewDiffFingerprint('diff --git a/x b/x\n+two\n'));
const fpRecords = [
  { id: 'r1', depth: 'quick', diffFingerprint: fingerprint },
  { id: 'r2', depth: 'deep', diffFingerprint: fingerprint },
];
assert.equal(findRepeatedReview(fpRecords, fingerprint, 'quick')?.id, 'r1');
assert.equal(findRepeatedReview(fpRecords, fingerprint, 'deep')?.id, 'r2');
assert.equal(findRepeatedReview(fpRecords, 'other', 'quick'), undefined);
ok('review dedupe keys on the diff fingerprint and the review depth');

// ── 9. Repair attempts are capped ─────────────────────────────────────────

const { failingRepairAttempts, MAX_REPAIR_ATTEMPTS } = review;
assert.equal(MAX_REPAIR_ATTEMPTS, 3);
const failRecordFor = (id, fingerprint) => ({
  id,
  depth: 'quick',
  diffFingerprint: fingerprint,
  verdict: 'fail',
});
const passRecordFor = { id: 'p', depth: 'quick', diffFingerprint: 'fp-pass', verdict: 'pass' };
assert.equal(failingRepairAttempts([failRecordFor('a', 'f1')], 'quick'), 1);
assert.equal(
  failingRepairAttempts([failRecordFor('a', 'f1'), failRecordFor('b', 'f2')], 'quick'),
  2
);
assert.equal(
  failingRepairAttempts(
    [passRecordFor, failRecordFor('a', 'f1'), failRecordFor('b', 'f2')],
    'quick'
  ),
  2,
  'a pass ends the streak'
);
assert.equal(
  failingRepairAttempts([failRecordFor('a', 'f1'), failRecordFor('b', 'f1')], 'quick'),
  1,
  'the same fingerprint counted once'
);
assert.equal(failingRepairAttempts([failRecordFor('a', 'f1')], 'deep'), 0, 'depth-scoped');
ok('repair attempts cap at 3 and only count distinct failing diffs');

// B213: `/diff` shows staged-only changes too (it compares against HEAD, not just
// the unstaged working tree).
{
  const { runWorkingTreeDiff } = await import(dist('utils/git-spawn.js'));
  const repo = await tmpDir('moss-diff-staged-');
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 't@t']);
  await git(repo, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\n');
  await git(repo, ['add', 'a.txt']);
  await git(repo, ['commit', '-qm', 'init']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\n');
  await git(repo, ['add', 'a.txt']);
  const staged = await runWorkingTreeDiff(repo);
  assert.equal(staged.exitCode, 0, staged.output);
  assert.match(staged.output, /\+two/, 'a staged-only change must be visible to /diff');
  await git(repo, ['reset', '-q', 'HEAD', 'a.txt']);
  const unstaged = await runWorkingTreeDiff(repo);
  assert.match(unstaged.output, /\+two/, 'an unstaged change stays visible');
  await fs.writeFile(path.join(repo, 'new-file.txt'), 'new\n');
  const withUntracked = await runWorkingTreeDiff(repo);
  assert.match(withUntracked.output, /Untracked files \(1\):/, 'untracked files are named');
  assert.match(withUntracked.output, /\?\? new-file\.txt/);
  ok('/diff sees staged, unstaged and untracked changes');
}

// B223: `review check --json` is the machine-readable form of the same gate.
{
  const jsonPass = await captureLog(() =>
    reviewCommand.runReviewCommand(['check', '--json'], { workspaceDir: commandRepo })
  );
  assert.equal(jsonPass.code, 0);
  const parsed = JSON.parse(jsonPass.lines.join('\n'));
  assert.equal(parsed.schema, 'moss_review_check.v1');
  assert.equal(parsed.reviewed, true);
  assert.equal(parsed.verdict, 'pass');
  assert.equal(parsed.exitCode, 0);
  assert.equal(typeof parsed.record.id, 'string');
  const jsonEmpty = await captureLog(() =>
    reviewCommand.runReviewCommand(['check', '--json'], { workspaceDir: emptyRepo })
  );
  assert.equal(jsonEmpty.code, 2);
  const empty = JSON.parse(jsonEmpty.lines.join('\n'));
  assert.equal(empty.reviewed, false);
  assert.equal(empty.verdict, null);
  assert.equal(empty.exitCode, 2);
  ok('review check --json mirrors the exit-code gate (pass + no-review)');
}

// B211: the global `--json` flag must reach `review list` through the real CLI
// parser (it is stripped from commandArgs), not only when called in-process.
{
  const cli = await captureProcess(
    process.execPath,
    [path.join(root, 'dist/cli.js'), 'review', 'list', '--json'],
    {
      cwd: commandRepo,
      env: {
        ...process.env,
        MOSS_LANG: 'en',
        MOSS_NO_TUI: '1',
        MOSS_CONFIG_DIR: path.join(commandRepo, 'cfg'),
      },
      timeoutMs: 30_000,
    }
  );
  assert.equal(cli.status, 0, cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.schema, 'moss_review_list.v1');
  assert.equal(parsed.total, parsed.records.length);
  assert.ok(
    Array.isArray(parsed.records) && parsed.records.length > 0,
    'real CLI --json returns records'
  );
  assert.equal(typeof parsed.records[0].verdict, 'string');
  ok('moss review list --json works through the real CLI parser');
}

for (const dir of tmpRoots) {
  await fs.rm(dir, { recursive: true, force: true });
}
console.log(`[review] PASS (${checks} checks)`);
