#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { wrapWithTerminalArbitration } from '../dist/core/tools/terminal-arbitration-gate.js';
import { ExperienceLog } from '../dist/memory/experience-log.js';
import { TerminalVerdictLog } from '../dist/acceptance/terminal-verdict-log.js';
import { LearningEventLog } from '../dist/memory/learning-event-log.js';
import { TrustedLearningCoordinator } from '../dist/memory/trusted-learning-coordinator.js';
import { MemoryManager } from '../dist/memory/memory-manager.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-terminal-recovery-'));
const product = path.join(dir, 'product.txt');
const experienceLog = new ExperienceLog({ baseDir: dir });
const terminalVerdictLog = new TerminalVerdictLog({ baseDir: dir });
const learningEventLog = new LearningEventLog({ baseDir: dir });
const memoryManager = new MemoryManager(dir);
await memoryManager.load();
const trustedLearningCoordinator = new TrustedLearningCoordinator({ eventLog: learningEventLog, memoryManager });
const plan = {
  id: 'recovery-plan', goal: 'produce file', status: 'completed', version: 1,
  steps: [{ step: 1, description: 'write', status: 'completed', expectedAccept: ['rdk-model-zoo'] }],
  createdAt: '', updatedAt: '', terminalAccept: [{ name: 'file_exist', params: { path: product } }],
};
const appendExperience = (id, verdict) => experienceLog.append({
  schemaVersion: 2, id: `exp-${id}`, taskId: plan.id, runId: 'run-1', sessionKey: 'session-1',
  toolCallId: id, evidenceId: id, attemptId: `run-1:${id}`, stepId: `${plan.id}:step:1`,
  tool: 'write', input: {}, reportedIsError: verdict === 'fail', verdict,
  reasonCode: verdict === 'fail' ? 'file_missing_after_write' : 'file_written', signalSource: 'file_exist',
  confidence: 'high', durationMs: 1, timestamp: new Date().toISOString(),
  contractSkill: 'rdk-model-zoo', environmentFingerprint: 'sha256:recovery-env',
});
const gate = wrapWithTerminalArbitration(async () => ({ ok: true }), {
  experienceLog, terminalVerdictLog, trustedLearningCoordinator,
  planProvider: { get: (sessionKey) => sessionKey === 'session-1' ? plan : null },
  deviceExecutor: { current: null }, workspaceDir: dir,
});
const request = (turn, toolUseId) => ({
  sessionKey: 'session-1', runId: 'run-1', turn, response: 'done', messages: [],
  totalToolCalls: 1, toolCallsByName: { write: 1 },
  executionEvidence: { source: 'write', toolUseId, exitCode: 0, stdout: '', stderr: '' },
});

await appendExperience('evidence-1', 'fail');
const first = await gate(request(1, 'evidence-1'));
assert.equal(first.ok, false, 'first objective terminal failure blocks completion');
assert.match(first.reason, /terminal_acceptance_failed/);

await fs.writeFile(product, 'ok');
const stale = await gate(request(2, 'evidence-1'));
assert.equal(stale.ok, false, 'replaying old evidence cannot recover');
assert.equal(stale.reason, 'stale_terminal_evidence');

await appendExperience('evidence-2', 'pass');
const recovered = await gate(request(3, 'evidence-2'));
assert.equal(recovered.ok, true, 'fresh matching v2 evidence can recover');

const events = await learningEventLog.readAll();
assert.deepEqual(events.map((event) => event.outcome), ['failed', 'recovered']);
assert.equal(events[1].previousFailureId, events[0].id);
assert.equal(events.some((event) => event.evidenceId === 'evidence-1' && event.turn === 2), false, 'stale retry creates no learning event');
const terminalEntries = await terminalVerdictLog.readAll();
assert.deepEqual(terminalEntries.map((entry) => entry.turn), [1, 3], 'stale retry cannot overwrite or add Promotion proof');

await fs.rm(dir, { recursive: true, force: true });
console.log('terminal-failure-recovery: fail block, stale rejection and fresh-evidence recovery ok');
