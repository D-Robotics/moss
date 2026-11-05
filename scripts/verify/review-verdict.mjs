#!/usr/bin/env node
/**
 * Structured review-verdict probe (offline).
 *
 * The completion gate used to decide "did the independent reviewer fail?" by
 * regexing the review tool's prose. `review_changes` already writes a structured
 * record to `.moss/review.jsonl` and `moss review check` exits on it, so the
 * gate must read the same truth: a truncated/reworded result must not hide a
 * critical finding, and a FAIL sentence left in an old tool result must not
 * hold an answer that a later record passed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { readLatestReviewSummary } = await load('dist/core/loop/review-ledger.js');
const { evaluateVerificationCompletionGate, createVerificationCompletionGate } = await load(
  'dist/core/loop/verification-completion-gate.js'
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[review-verdict] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-reviewgate-'));
const ws = path.join(tmp, 'ws');
const moss = path.join(ws, '.moss');
await fs.mkdir(moss, { recursive: true });
const log = path.join(moss, 'review.jsonl');

const now = Date.now();
const record = (overrides = {}) => ({
  id: 'review-1',
  createdAt: new Date(now).toISOString(),
  scope: 'working tree',
  depth: 'quick',
  verdict: 'fail',
  findings: [
    {
      severity: 'critical',
      file: 'src/db.ts',
      line: 12,
      summary: 'string-concatenated SQL',
      fixHint: 'use a parameterised query',
    },
    { severity: 'suggestion', file: 'src/db.ts', summary: 'naming' },
  ],
  checks: ['read src/db.ts'],
  diffLines: 20,
  truncated: false,
  reviewerSuccess: true,
  ...overrides,
});

const message = (role, content, timestamp) => ({ role, content, timestamp });
const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, text) => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: text }],
  timestamp: now + 1_000,
});

const runMessages = (resultText) => [
  message('user', 'do the thing', now - 1_000),
  message('assistant', [toolUse('t1', 'write_file', { path: 'a.ts' })], now - 900),
  toolResult('t1', 'wrote a.ts'),
  message('assistant', [toolUse('t2', 'review_changes', {})], now - 500),
  toolResult('t2', resultText),
];

// --- reader ---------------------------------------------------------------
assert.equal(readLatestReviewSummary(ws), undefined, 'absent log reads as undefined');
await fs.writeFile(
  log,
  `${JSON.stringify(record({ id: 'old-1', createdAt: new Date(now - 120_000).toISOString(), verdict: 'pass' }))}\n`
);
await fs.appendFile(log, `${JSON.stringify(record({ id: 'fail-1' }))}\n`);
await fs.appendFile(log, '{"id":"torn","createdAt":"'); // process died mid-append
const latest = readLatestReviewSummary(ws);
assert.equal(latest?.id, 'fail-1');
assert.equal(latest?.verdict, 'fail');
assert.deepEqual(latest?.findings, { critical: 1, important: 0, suggestion: 1, total: 2 });
ok('reader: newest record, finding counts, torn trailing line skipped');

// --- structured FAIL that the prose never spells out -----------------------
const opaque = 'Review complete. 2 finding(s) saved to .moss/review.jsonl.';
const held = evaluateVerificationCompletionGate({
  response: 'DONE.',
  messages: runMessages(opaque),
  latestReview: latest,
});
assert.equal(held.ok, false);
assert.equal(held.kind, 'review-fail');
assert.match(held.reason, /1 critical, 0 important/);
assert.match(held.correction, /review-1|fail-1.*moss review check|moss review check/);
ok('structured FAIL holds an answer whose prose never said FAIL');

const acknowledged = evaluateVerificationCompletionGate({
  response: 'Still unresolved: the SQL injection is not fixed.',
  messages: runMessages(opaque),
  latestReview: latest,
});
assert.equal(acknowledged.ok, true);
ok('an answer that owns the open findings is allowed through');

// --- a stale record from an earlier session must not hold this run ---------
const stale = evaluateVerificationCompletionGate({
  response: 'DONE.',
  messages: runMessages(opaque),
  latestReview: { ...latest, createdAtMs: now - 600_000 },
});
assert.equal(stale.ok, true);
ok('a review record older than the run does not block it');

// --- a later structured PASS outranks a stale FAIL sentence in the result --
const passRecord = record({ id: 'pass-2', verdict: 'pass', findings: [] });
await fs.appendFile(log, `\n${JSON.stringify(passRecord)}\n`);
const passing = readLatestReviewSummary(ws);
const proseFail = evaluateVerificationCompletionGate({
  response: 'DONE.',
  messages: runMessages('VERDICT: FAIL — Critical finding in src/db.ts'),
  latestReview: passing,
});
assert.equal(proseFail.ok, true);
ok('structured PASS outranks a stale FAIL sentence in an older tool result');

// --- sub-agent reviews have no ledger record: prose path still works -------
const subagentFail = evaluateVerificationCompletionGate({
  response: 'DONE.',
  messages: [
    message('user', 'review this', now - 800),
    message('assistant', [toolUse('t1', 'create_subagent', {})], now - 700),
    toolResult('t1', 'Critical finding: the migration drops a column.\nVERDICT: FAIL'),
  ],
});
assert.equal(subagentFail.ok, false);
assert.equal(subagentFail.kind, 'review-fail');
ok('a sub-agent review with no ledger record still blocks via prose');

// --- wrapper: reads the ledger itself, then stays bounded ------------------
const failWs = path.join(tmp, 'fail-ws');
await fs.mkdir(path.join(failWs, '.moss'), { recursive: true });
await fs.writeFile(
  path.join(failWs, '.moss', 'review.jsonl'),
  `${JSON.stringify(record({ id: 'fail-ws-1' }))}\n`
);
const gate = createVerificationCompletionGate({ workspaceDir: failWs });
const request = { response: 'DONE.', messages: runMessages(opaque) };
const firstBlock = await gate(request);
assert.equal(firstBlock.ok, false);
assert.match(firstBlock.correction, /moss review check/);
let afterLimit = firstBlock;
for (let index = 0; index < 4 && afterLimit.ok === false; index += 1) {
  afterLimit = await gate(request);
}
assert.equal(afterLimit.ok, true, 'the repair ceiling lets the run end');
ok('wrapper: injects the record-backed correction, bounded by the repair ceiling');

await fs.rm(tmp, { recursive: true, force: true });
console.log(`[review-verdict] ${checks}/7 checks passed`);
