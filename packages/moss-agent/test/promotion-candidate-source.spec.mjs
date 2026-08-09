#!/usr/bin/env node
/**
 * promotion-candidate-source — 终局硬信号触发的升层候选源。
 * 验:阈值触发 + 幂等 id + 无信号 no-op + 阈值下不产候选。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TerminalVerdictLog } from '../dist/acceptance/terminal-verdict-log.js';
import {
  createTerminalCandidateSource,
  createTerminalStatsSource,
} from '../dist/acceptance/promotion-candidate-source.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-cand-'));
const log = new TerminalVerdictLog({ baseDir: tmp });

// skill with 10 terminal passes -> candidate
for (let i = 0; i < 10; i++) {
  await log.append({
    schemaVersion: 2,
    id: String(i),
    taskId: `p${i}`,
    runId: `r${i}`,
    attemptId: `p${i}:r${i}:1`,
    evidenceId: `e${i}`,
    skill: 'rdk-device',
    skills: ['rdk-device'],
    attribution: 'single-skill',
    verdict: 'pass',
    reason: 'ok',
    sessionKey: 's',
    timestamp: 't',
    environmentFingerprint: 'env-real',
    environmentIdentityVersion: 1,
    environmentCompleteness: 'complete',
    executionDomain: 'real',
    realEvidenceEligible: true,
  });
}
// skill with 5 passes -> below threshold -> no candidate
for (let i = 0; i < 5; i++) {
  await log.append({
    schemaVersion: 2,
    id: `b${i}`,
    taskId: `bp${i}`,
    runId: `br${i}`,
    attemptId: `bp${i}:br${i}:1`,
    evidenceId: `be${i}`,
    skill: 'rdk-ros',
    skills: ['rdk-ros'],
    attribution: 'single-skill',
    verdict: 'pass',
    reason: 'ok',
    sessionKey: 's',
    timestamp: 't',
    environmentFingerprint: 'env-real',
    environmentIdentityVersion: 1,
    environmentCompleteness: 'complete',
    executionDomain: 'real',
    realEvidenceEligible: true,
  });
}

const baseReq = () => ({
  sessionKey: 's',
  runId: 'r',
  turn: 1,
  response: '',
  messages: [],
  totalToolCalls: 0,
  toolCallsByName: {},
});

const candidateSource = createTerminalCandidateSource({
  terminalVerdictLog: log,
  minProofCount: 10,
});
const candidates = await candidateSource(baseReq());

assert.equal(candidates.length, 1, 'only rdk-device crosses threshold');
assert.equal(candidates[0].targetSkill, 'rdk-device');
assert.equal(candidates[0].provenance.layer, 'L2');
assert.equal(candidates[0].provenance.kind, 'explicit-proposal');
assert.equal(candidates[0].provenance.source, 'terminal-hard-signal');
assert.match(candidates[0].id, /^term_rdk-device$/);

// idempotent: re-evaluating the same window yields the same id (not a flood)
const candidates2 = await candidateSource(baseReq());
assert.equal(candidates2[0].id, candidates[0].id, 'idempotent id across re-evaluation');

// stats source returns the terminal-only stats for the candidate's skill
const statsSource = createTerminalStatsSource({ terminalVerdictLog: log });
const stats = await statsSource(candidates[0]);
assert.ok(stats);
assert.equal(stats.skill, 'rdk-device');
assert.equal(stats.proofCount, 10);
assert.equal(stats.successRate, 1);

// stats for a skill below threshold still resolvable (proofCount 5)
const rosCand = {
  id: 'term_rdk-ros',
  targetSkill: 'rdk-ros',
  provenance: {
    layer: 'L2',
    kind: 'explicit-proposal',
    source: 'terminal-hard-signal',
    proposalRef: 'x',
  },
};
const rosStats = await statsSource(rosCand);
assert.equal(rosStats.proofCount, 5);

// ten retries of one execution must count as one proof, not unlock promotion
const retryLog = new TerminalVerdictLog({ baseDir: path.join(tmp, 'same-evidence-retries') });
for (let i = 0; i < 10; i += 1) {
  await retryLog.append({
    id: `retry-${i}`,
    schemaVersion: 2,
    taskId: 'plan-retry',
    attemptId: `attempt-${i}`,
    evidenceId: 'tool-use-one',
    skill: 'rdk-device',
    skills: ['rdk-device'],
    attribution: 'single-skill',
    verdict: 'pass',
    reason: 'same execution replayed',
    sessionKey: 's',
    timestamp: `2026-07-30T00:${String(i).padStart(2, '0')}:00.000Z`,
    environmentFingerprint: 'env-real',
    environmentIdentityVersion: 1,
    environmentCompleteness: 'complete',
    executionDomain: 'real',
    realEvidenceEligible: true,
  });
}
const retrySource = createTerminalCandidateSource({
  terminalVerdictLog: retryLog,
  minProofCount: 10,
});
assert.deepEqual(
  await retrySource(baseReq()),
  [],
  'one execution replayed ten times cannot unlock promotion'
);

// Legacy and multi-skill terminal records remain auditable but never become proof.
const ineligibleLog = new TerminalVerdictLog({ baseDir: path.join(tmp, 'ineligible') });
for (let i = 0; i < 10; i += 1) {
  await ineligibleLog.append({
    id: `legacy-${i}`,
    skill: 'legacy-skill',
    verdict: 'pass',
    reason: 'legacy',
    sessionKey: 's',
    timestamp: 't',
  });
  await ineligibleLog.append({
    schemaVersion: 2,
    id: `multi-${i}`,
    skill: 'unknown',
    skills: ['a', 'b'],
    attribution: 'multi-skill',
    verdict: 'pass',
    reason: 'multi',
    sessionKey: 's',
    timestamp: 't',
  });
}
assert.deepEqual(
  await createTerminalCandidateSource({ terminalVerdictLog: ineligibleLog, minProofCount: 10 })(
    baseReq()
  ),
  [],
  'legacy and multi-skill records cannot unlock promotion'
);

// no terminal signal at all -> no candidates
const emptyLog = new TerminalVerdictLog({ baseDir: path.join(tmp, 'empty') });
const emptySource = createTerminalCandidateSource({
  terminalVerdictLog: emptyLog,
  minProofCount: 10,
});
const none = await emptySource(baseReq());
assert.deepEqual(none, []);

await fs.rm(tmp, { recursive: true, force: true });
console.log(
  '✅ promotion-candidate-source: terminal-signal trigger above threshold, idempotent, no-signal no-op'
);
