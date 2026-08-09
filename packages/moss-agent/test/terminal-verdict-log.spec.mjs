#!/usr/bin/env node
/**
 * terminal-verdict-log — T3.4 候选触发的可信根安全统计源(任务级终态信号)。
 * 验:append-only + 按 skill 聚合 + verdict 三态校验 + unknown 不计 proof。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  TerminalVerdictLog,
  aggregateTerminalBySkill,
} from '../dist/acceptance/terminal-verdict-log.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-tvlog-'));
const log = new TerminalVerdictLog({ baseDir: tmp });

// append-only, three-state verdict
await log.append({
  id: '1',
  skill: 'rdk-device',
  verdict: 'pass',
  reason: 'file_exist ok',
  sessionKey: 's1',
  timestamp: '2026-07-29T00:00:00.000Z',
});
await log.append({
  id: '2',
  skill: 'rdk-device',
  verdict: 'pass',
  reason: 'file_exist ok',
  sessionKey: 's1',
  timestamp: '2026-07-29T00:01:00.000Z',
});
await log.append({
  id: '3',
  skill: 'rdk-device',
  verdict: 'fail',
  reason: 'product missing',
  sessionKey: 's2',
  timestamp: '2026-07-29T00:02:00.000Z',
});

const all = await log.readAll();
assert.equal(all.length, 3, 'append-only, all entries kept');
assert.equal(all[0].skill, 'rdk-device');

// aggregation per skill (terminal signal, NOT contractSkill)
const stats = aggregateTerminalBySkill(all);
const dev = stats.get('rdk-device');
assert.ok(dev);
assert.equal(dev.skill, 'rdk-device');
assert.equal(dev.proofCount, 3); // pass+fail decided
assert.equal(dev.pass, 2);
assert.equal(dev.fail, 1);
assert.equal(dev.successRate, 2 / 3);

// unknown does not count toward proofCount (undecided = not evidence)
await log.append({
  id: '4',
  skill: 'rdk-ros',
  verdict: 'unknown',
  reason: 'no terminalAccept',
  sessionKey: 's3',
  timestamp: '2026-07-29T00:03:00.000Z',
});
const stats2 = aggregateTerminalBySkill(await log.readAll());
const ros = stats2.get('rdk-ros');
assert.equal(ros.proofCount, 0, 'unknown-only skill has 0 proof (not evidence)');

// Read-time canonicalization: replace one attempt, then collapse retries of one proof.
const dedupEntries = [
  {
    id: 'a-old',
    taskId: 'p',
    attemptId: 'attempt-a',
    evidenceId: 'ev-1',
    skill: 'rdk-device',
    verdict: 'unknown',
    reason: 'pending',
    sessionKey: 's',
    timestamp: '2026-07-30T00:00:00.000Z',
  },
  {
    id: 'a-new',
    taskId: 'p',
    attemptId: 'attempt-a',
    evidenceId: 'ev-1',
    skill: 'rdk-device',
    verdict: 'pass',
    reason: 'ok',
    sessionKey: 's',
    timestamp: '2026-07-30T00:01:00.000Z',
  },
  {
    id: 'b',
    taskId: 'p',
    attemptId: 'attempt-b',
    evidenceId: 'ev-1',
    skill: 'rdk-device',
    verdict: 'pass',
    reason: 'retry same proof',
    sessionKey: 's',
    timestamp: '2026-07-30T00:02:00.000Z',
  },
  {
    id: 'c',
    taskId: 'p',
    attemptId: 'attempt-c',
    evidenceId: 'ev-2',
    skill: 'rdk-device',
    verdict: 'fail',
    reason: 'new proof',
    sessionKey: 's',
    timestamp: '2026-07-30T00:03:00.000Z',
  },
  {
    id: 'legacy-1',
    skill: 'legacy',
    verdict: 'pass',
    reason: 'old',
    sessionKey: 's',
    timestamp: '2026-07-29T00:00:00.000Z',
  },
  {
    id: 'legacy-1',
    skill: 'legacy',
    verdict: 'pass',
    reason: 'duplicate old',
    sessionKey: 's',
    timestamp: '2026-07-29T00:01:00.000Z',
  },
  {
    id: '',
    skill: 'malformed',
    verdict: 'pass',
    reason: 'missing identity',
    sessionKey: 's',
    timestamp: '2026-07-30T00:04:00.000Z',
  },
  {
    id: 'missing-skill',
    skill: '',
    verdict: 'pass',
    reason: 'missing skill',
    sessionKey: 's',
    timestamp: '2026-07-30T00:05:00.000Z',
  },
];
const dedupStats = aggregateTerminalBySkill(dedupEntries);
assert.equal(
  dedupStats.get('rdk-device').proofCount,
  2,
  'ev-1 and ev-2 are two independent proofs'
);
assert.equal(dedupStats.get('rdk-device').pass, 1);
assert.equal(dedupStats.get('rdk-device').fail, 1);
assert.equal(dedupStats.get('legacy').proofCount, 1, 'duplicate legacy id collapses');
assert.equal(dedupStats.has('malformed'), false, 'identity-less record is not promotable proof');
assert.equal(dedupStats.has(''), false, 'skill-less record is not promotable proof');

// Identity values may contain delimiter text without colliding across skills.
const collisionEntries = [
  {
    id: 'attempt-1',
    attemptId: 'x:attempt:y',
    skill: 'collision',
    verdict: 'pass',
    reason: 'first attempt',
    sessionKey: 's',
    timestamp: '2026-07-30T01:00:00.000Z',
  },
  {
    id: 'attempt-2',
    attemptId: 'y',
    skill: 'collision:attempt:x',
    verdict: 'pass',
    reason: 'second attempt',
    sessionKey: 's',
    timestamp: '2026-07-30T01:01:00.000Z',
  },
  {
    id: 'evidence-1',
    attemptId: 'evidence-attempt-1',
    evidenceId: 'x:evidence:y',
    skill: 'proof',
    verdict: 'pass',
    reason: 'first evidence',
    sessionKey: 's',
    timestamp: '2026-07-30T01:02:00.000Z',
  },
  {
    id: 'evidence-2',
    attemptId: 'evidence-attempt-2',
    evidenceId: 'y',
    skill: 'proof:evidence:x',
    verdict: 'pass',
    reason: 'second evidence',
    sessionKey: 's',
    timestamp: '2026-07-30T01:03:00.000Z',
  },
];
const collisionStats = aggregateTerminalBySkill(collisionEntries);
assert.equal(
  collisionStats.get('collision').proofCount,
  1,
  'attempt delimiter text does not collide'
);
assert.equal(
  collisionStats.get('collision:attempt:x').proofCount,
  1,
  'attempt delimiter text preserves the other skill'
);
assert.equal(collisionStats.get('proof').proofCount, 1, 'evidence delimiter text does not collide');
assert.equal(
  collisionStats.get('proof:evidence:x').proofCount,
  1,
  'evidence delimiter text preserves the other skill'
);

// reject non-three-state verdict (trusted-root: terminal signal must be objective)
let threw = false;
try {
  await log.append({
    id: '5',
    skill: 'x',
    verdict: 'maybe',
    reason: 'r',
    sessionKey: 's',
    timestamp: 't',
  });
} catch {
  threw = true;
}
assert.ok(threw, 'non-three-state verdict rejected');

// empty log (no file) reads as []
const emptyLog = new TerminalVerdictLog({ baseDir: path.join(tmp, 'nope') });
assert.deepEqual(await emptyLog.readAll(), [], 'missing file -> []');

await fs.rm(tmp, { recursive: true, force: true });
console.log(
  '✅ terminal-verdict-log: append-only + per-skill terminal aggregation + verdict validation'
);
