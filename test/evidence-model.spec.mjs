#!/usr/bin/env node
/**
 * Evidence model (P0-8): evaluateExpectation comparator matrix and the
 * record_evidence tool — auto-evaluation, explicit verdicts, persistence to
 * .moss/evidence.jsonl, honest failure encodings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { evaluateExpectation } from '../dist/contracts/evidence.js';
import {
  recordEvidenceTool,
  listEvidenceRecords,
  summarizeEvidence,
} from '../dist/tools/evidence-tools.js';

function makeCtx(workspaceDir) {
  return { workspaceDir, sessionKey: 'evidence-test' };
}

test('evaluateExpectation: numeric, string, presence, regex comparators', () => {
  assert.deepEqual(evaluateExpectation('>=30', 31.2).result, 'pass');
  assert.deepEqual(evaluateExpectation('>=30', 17.3).result, 'fail');
  assert.deepEqual(evaluateExpectation('<=5', '4.9').result, 'pass');
  assert.deepEqual(evaluateExpectation('>0', 0).result, 'fail');
  assert.deepEqual(evaluateExpectation('==4', '4').result, 'pass');
  assert.deepEqual(evaluateExpectation('!=1', 2).result, 'pass');

  assert.deepEqual(evaluateExpectation('contains err', 'error: boom').result, 'pass');
  assert.deepEqual(evaluateExpectation('not-contains fail', 'all good').result, 'pass');
  assert.deepEqual(evaluateExpectation('not-contains fail', 'failed').result, 'fail');

  assert.deepEqual(evaluateExpectation('exists', 'active').result, 'pass');
  assert.deepEqual(evaluateExpectation('exists', '').result, 'fail');
  assert.deepEqual(evaluateExpectation('exists', undefined).result, 'fail');

  assert.deepEqual(evaluateExpectation('matches ^active$', 'active\n').result, 'pass');
  assert.deepEqual(evaluateExpectation('matches ^inactive$', 'active\n').result, 'fail');
  assert.deepEqual(evaluateExpectation('matches ([unclosed', 'x').result, 'inconclusive');

  // Bare values: numeric and string equality.
  assert.deepEqual(evaluateExpectation('3.5', 3.5).result, 'pass');
  assert.deepEqual(evaluateExpectation('ready', 'ready').result, 'pass');
  assert.deepEqual(evaluateExpectation('ready', 'not ready').result, 'fail');
});

test('evaluateExpectation: never silently passes on garbage', () => {
  assert.deepEqual(evaluateExpectation('>=30', 'not-a-number').result, 'inconclusive');
  assert.deepEqual(evaluateExpectation(undefined, 1).result, 'inconclusive');
  assert.deepEqual(evaluateExpectation('>=30', undefined).result, 'inconclusive');
  const evaluation = evaluateExpectation('>=30', 'abc');
  assert.match(evaluation.explanation, /non-numeric/);
});

test('record_evidence: auto-evaluates, persists, and summarizes', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-evidence-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ctx = makeCtx(workspace);

  const pass = await recordEvidenceTool.execute(
    {
      metric: 'camera_fps',
      expected: '>=30',
      observed: '31.2',
      source: 'device_exec',
      device_id: 'rdk-x5-001',
      task_id: 'person-stop-behavior',
    },
    ctx
  );
  assert.match(pass, /^evidence ev_\w+: PASS — camera_fps/);
  assert.match(pass, /31\.2 >= 30 → pass/);
  assert.match(pass, /device=rdk-x5-001/);

  const fail = await recordEvidenceTool.execute(
    { metric: 'camera_fps', expected: '>=30', observed: '17.3', source: 'device_exec' },
    ctx
  );
  assert.match(fail, /^evidence ev_\w+: FAIL — camera_fps/);

  const human = await recordEvidenceTool.execute(
    {
      metric: 'robot_stopped_within_1m',
      result: 'pass',
      source: 'human',
      details: 'observed by operator',
    },
    ctx
  );
  assert.match(human, /PASS — robot_stopped_within_1m/);

  const inconclusive = await recordEvidenceTool.execute(
    { metric: 'topic_hz', observed: '12.0', source: 'device_exec' },
    ctx
  );
  assert.match(inconclusive, /INCONCLUSIVE/);

  const records = await listEvidenceRecords(workspace);
  assert.equal(records.length, 4);
  const summary = summarizeEvidence(records);
  assert.deepEqual(summary, { total: 4, passed: 2, failed: 1, inconclusive: 1 });
  const first = records[3]; // newest-first listing: index 3 is the first recorded
  assert.equal(first.comparator, '>=', 'comparator persisted');
  assert.equal(first.deviceId, 'rdk-x5-001');

  const raw = await fs.readFile(path.join(workspace, '.moss', 'evidence.jsonl'), 'utf8');
  assert.equal(raw.split('\n').filter((l) => l.trim()).length, 4);
});

test('record_evidence: rejects inputs that cannot form a verdict', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-evidence-err-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ctx = makeCtx(workspace);

  assert.match(
    await recordEvidenceTool.execute({ source: 'exec' }, ctx),
    /^Error: record_evidence: metric is required/
  );
  assert.match(
    await recordEvidenceTool.execute({ metric: 'm' }, ctx),
    /^Error: record_evidence: source is required/
  );
  // observed without expectation records an honest INCONCLUSIVE observation.
  const raw = await recordEvidenceTool.execute({ metric: 'm', source: 'exec', observed: '1' }, ctx);
  assert.match(raw, /INCONCLUSIVE/);
  assert.match(raw, /without expectation/);
  assert.equal((await listEvidenceRecords(workspace)).length, 1, 'the observation was persisted');
});

test('record_evidence: metadata is runtime_state and plan-mode allowed', () => {
  assert.equal(recordEvidenceTool.metadata.sideEffectClass, 'runtime_state');
  assert.equal(recordEvidenceTool.metadata.planMode, 'allow');
});

// F24 regression (field evidence ev_mup0ne51_ygq7ud): the exists comparator
// scored observed "missing" as PASS ('observed present → pass'). A presence
// comparator must understand negative observations; anything indeterminate is
// inconclusive — never a silent pass (contracts/evidence.ts invariant).
test('evaluateExpectation exists: negative observations are absence, never PASS', () => {
  const negatives = [
    'missing',
    'not found',
    'no such file',
    'no such file or directory',
    'absent',
    'false',
    '0',
    'does not exist',
    'ENOENT: no such file or directory, open hello.txt',
  ];
  for (const observed of negatives) {
    assert.equal(
      evaluateExpectation('exists', observed).result,
      'fail',
      `exists with observed ${JSON.stringify(observed)} must be fail`
    );
  }
  // Empty/undefined observation stays fail (locked behavior).
  assert.equal(evaluateExpectation('exists', '').result, 'fail');
  assert.equal(evaluateExpectation('exists', undefined).result, 'fail');
  // Positive presence indicators stay pass (locked: 'active').
  for (const observed of ['exists (8 bytes)', 'present', 'active', 'connected', 'true', '1']) {
    assert.equal(
      evaluateExpectation('exists', observed).result,
      'pass',
      `exists with observed ${JSON.stringify(observed)} must be pass`
    );
  }
  // Indeterminate observations must never pass — inconclusive, honestly labeled.
  for (const observed of ['hello world', 'maybe?', 'some command output']) {
    const evaluation = evaluateExpectation('exists', observed);
    assert.equal(
      evaluation.result,
      'inconclusive',
      `exists with observed ${JSON.stringify(observed)} must be inconclusive, got ${evaluation.result}`
    );
  }
});

test('record_evidence: exists + observed "missing" with explicit fail records FAIL (F24 field repro)', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-evidence-f24-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ctx = makeCtx(workspace);

  // Verbatim shape of the field call: the model said fail, the harness said PASS.
  const out = await recordEvidenceTool.execute(
    {
      metric: 'file_exists:hello.txt',
      expected: 'exists',
      observed: 'missing',
      result: 'fail',
      source: 'search_files',
    },
    ctx
  );
  assert.match(out, /^evidence ev_\w+: FAIL — file_exists:hello\.txt/);
  const records = await listEvidenceRecords(workspace);
  assert.equal(records.length, 1);
  assert.equal(records[0].result, 'fail');
});

test('record_evidence: explicit verdict conflicting with auto-evaluation is exposed, never silently rewritten', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-evidence-f24c-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const ctx = makeCtx(workspace);

  // Explicit "pass" over an auto-evaluated fail must not become a stored PASS,
  // and the explicit verdict must not be silently dropped either: the conflict
  // surfaces as inconclusive naming both sides.
  const out = await recordEvidenceTool.execute(
    {
      metric: 'camera_fps',
      expected: '>=30',
      observed: '17.3',
      result: 'pass',
      source: 'device_exec',
    },
    ctx
  );
  assert.match(out, /^evidence ev_\w+: INCONCLUSIVE — camera_fps/);
  assert.match(out, /conflict/i);
  assert.match(out, /explicit result "pass"/);
  assert.match(out, /auto-evaluation "fail"/);
  const records = await listEvidenceRecords(workspace);
  assert.equal(records.length, 1);
  assert.equal(records[0].result, 'inconclusive');

  // A matching explicit verdict is recorded as-is (no conflict noise).
  const agreeing = await recordEvidenceTool.execute(
    {
      metric: 'camera_fps',
      expected: '>=30',
      observed: '17.3',
      result: 'fail',
      source: 'device_exec',
    },
    ctx
  );
  assert.match(agreeing, /^evidence ev_\w+: FAIL — camera_fps/);
  assert.doesNotMatch(agreeing, /conflict/i);
});
