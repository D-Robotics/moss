#!/usr/bin/env node
/**
 * Deterministic probe for task-ledger deferral (backlog B05, task group).
 *
 * The six Task OS tools define the vocabulary of a verifiable-task run, but a
 * plain fix never calls them; they used to occupy every headless prompt. They
 * are now a deferred group revealed by task intent, an existing ledger, or an
 * explicit host task flow.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, 'dist', relative)).href);
const deferred = await load('core/tools/deferred-tool-offer.js');

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[task-ledger-reveal] ok ${name}`);
}

const TASK = [
  'task_define',
  'task_acceptance',
  'task_plan_update',
  'record_evidence',
  'record_failure',
  'record_repair',
];

// ── 1. Group registration ─────────────────────────────────────────────────

assert.deepEqual([...deferred.TASK_DEFERRED_TOOLS], TASK);
for (const name of TASK) {
  assert.equal(deferred.isDeferredToolName(name), true, `${name} is deferred`);
  assert.equal(deferred.deferredGroupFor(name), 'task');
}
assert.deepEqual([...deferred.deferredToolGroupNames()].sort(), ['subagent', 'task']);
ok('the six Task OS tools are one deferred group');

// ── 2. Offer state and reveal note ────────────────────────────────────────

const offer = new deferred.DeferredToolOffer();
for (const name of TASK) assert.equal(offer.isOffered(name), false);
assert.equal(offer.isOffered('read_file'), true);
const note = offer.reveal('task');
assert.match(note, /Loaded task tools: task_define, task_acceptance/);
assert.match(note, /machine-checkable acceptance criteria/);
assert.match(note, /no evidence means not done/);
for (const name of TASK) assert.equal(offer.isOffered(name), true);
assert.equal(offer.isRevealed('subagent'), false);
ok('revealing task does not reveal sub-agent tools, and the note teaches the contract');

const unknown = new deferred.DeferredToolOffer().reveal('nope');
assert.match(unknown, /unknown tool group "nope"/);
assert.match(unknown, /subagent, task/);
ok('an unknown group lists the real groups');

// ── 3. Intent detection ───────────────────────────────────────────────────

const positives = [
  'Define a task with machine-checkable acceptance criteria for the robot demo.',
  '把这个需求做成任务，写清楚验收标准',
  'record evidence for the boot-time measurement',
  'What is the definition of done here?',
  '/goal ship the acceptance loop end to end',
  '目标：让部署闭环可验收',
];
const negatives = [
  'fix the typo in README',
  "what's 2+2?",
  'run the test suite and report failures',
  'verify the build passes',
  'refactor this function',
];
for (const message of positives) {
  assert.equal(deferred.messageRequestsTaskLedger(message), true, message);
}
for (const message of negatives) {
  assert.equal(deferred.messageRequestsTaskLedger(message), false, message);
}
ok('task intent is recognized in Chinese and English without catching ordinary work');

// ── 4. Existing ledger detection ──────────────────────────────────────────

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-ledger-'));
try {
  assert.equal(deferred.workspaceHasTaskLedger(dir), false);
  await fs.mkdir(path.join(dir, '.moss'), { recursive: true });
  await fs.writeFile(path.join(dir, '.moss', 'tasks.jsonl'), '');
  assert.equal(deferred.workspaceHasTaskLedger(dir), false, 'an empty ledger is not intent');
  await fs.writeFile(path.join(dir, '.moss', 'tasks.jsonl'), '{"taskId":"t1"}\n');
  assert.equal(deferred.workspaceHasTaskLedger(dir), true);
  ok('an existing non-empty ledger reveals the group on the next run');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(`[task-ledger-reveal] PASS (${checks} checks)`);
