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

for (const dir of tmpRoots) {
  await fs.rm(dir, { recursive: true, force: true });
}
console.log(`[review] PASS (${checks} checks)`);
