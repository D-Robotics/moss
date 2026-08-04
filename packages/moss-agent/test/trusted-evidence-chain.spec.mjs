#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planTool, resetPlanControllerForTests } from '../dist/plan-execute/plan-tools.js';
import { getActivePlanForSession } from '../dist/plan-execute/plan-controller-store.js';
import { SkillRegistry } from '../dist/skills/registry.js';
import { ContractRegistry } from '../dist/acceptance/contract-registry.js';
import { ExperienceLog } from '../dist/memory/experience-log.js';
import { createObjectiveVerifierHook } from '../dist/core/tools/objective-verifier-hook.js';
import { wrapWithTerminalArbitration } from '../dist/core/tools/terminal-arbitration-gate.js';
import { TerminalVerdictLog } from '../dist/acceptance/terminal-verdict-log.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-trusted-chain-'));
const workspaceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ctx = (sessionKey, runId) => ({ workspaceDir, sessionKey, runId });
const parseId = (output) => /Plan created: (\S+)/.exec(output)?.[1];
const makePlan = async (sessionKey, terminalPath) => {
  const context = ctx(sessionKey, `setup-${sessionKey}`);
  const output = await planTool.execute({
    action: 'create', goal: `infer ${sessionKey}`,
    steps: [{ description: 'infer', expectedTools: ['device_exec'], expectedAccept: ['rdk-model-zoo'] }],
    terminalAccept: [{ name: 'file_exist', params: { path: terminalPath } }],
  }, context);
  const id = parseId(output);
  assert.ok(id, output);
  await planTool.execute({ action: 'review', planId: id }, context);
  await planTool.execute({ action: 'approve', planId: id }, context);
  await planTool.execute({ action: 'start', planId: id }, context);
  return getActivePlanForSession(sessionKey);
};

resetPlanControllerForTests();
const planA = await makePlan('session-a', path.join(tmp, 'missing-a.bin'));
const planB = await makePlan('session-b', path.join(tmp, 'missing-b.bin'));
assert.ok(planA && planB);
assert.notEqual(planA.id, planB.id);
assert.equal(getActivePlanForSession('session-a').id, planA.id);
assert.equal(getActivePlanForSession('session-b').id, planB.id);

const experienceLog = new ExperienceLog({ baseDir: tmp });
const contractRegistry = ContractRegistry.fromSkills(new SkillRegistry({ workspaceDir }).list());
const hook = createObjectiveVerifierHook({
  experienceLog,
  contractRegistry,
  deviceExecutor: { current: null },
  planProvider: { get: getActivePlanForSession },
});
for (const [sessionKey, plan, runId, toolCallId] of [
  ['session-a', planA, 'run-a', 'tool-a'],
  ['session-b', planB, 'run-b', 'tool-b'],
]) {
  await hook.process({
    tool: { name: 'device_exec' }, input: { command: 'python test_yolov5.py' },
    result: 'exit_code: 0\nbbox: 1, score: 0.9, name: kite', isError: false, durationMs: 10,
    ctx: { workspaceDir, sessionKey, runId, toolCallId }, sessionId: sessionKey,
  });
  const entry = (await experienceLog.readAll()).at(-1);
  assert.equal(entry.taskId, plan.id);
  assert.equal(entry.runId, runId);
  assert.equal(entry.stepId, `${plan.id}:step:1`);
  assert.equal(entry.contractSkill, 'rdk-model-zoo');
  assert.equal(entry.contractVersion, '2');
}

// Same session, different task/run evidence must not weaken plan A's all-pass audit.
await experienceLog.append({
  schemaVersion: 2, id: 'foreign', sessionKey: 'session-a', taskId: 'foreign-plan', runId: 'run-a',
  tool: 'device_exec', input: {}, reportedIsError: true, verdict: 'fail', reasonCode: 'foreign_failure',
  signalSource: 'exit_code', confidence: 'medium', durationMs: 1, timestamp: new Date().toISOString(),
  contractSkill: 'rdk-model-zoo',
});
const terminalVerdictLog = new TerminalVerdictLog({ baseDir: path.join(tmp, 'terminal') });
const gate = wrapWithTerminalArbitration(async () => ({ ok: true }), {
  experienceLog,
  planProvider: { get: getActivePlanForSession },
  deviceExecutor: { current: null }, workspaceDir, terminalVerdictLog,
});
const result = await gate({
  sessionKey: 'session-a', runId: 'run-a', turn: 7, response: 'done', messages: [],
  totalToolCalls: 1, toolCallsByName: { device_exec: 1 },
  executionEvidence: { source: 'device_exec', toolUseId: 'tool-a', exitCode: 0, stdout: 'bbox: kite', stderr: '' },
});
assert.equal(result.ok, false, 'only matching task/run v2 evidence participates in terminal audit');
const [terminal] = await terminalVerdictLog.readAll();
assert.equal(terminal.taskId, planA.id);
assert.equal(terminal.runId, 'run-a');
assert.equal(terminal.attemptId, `${planA.id}:run-a:7`);
assert.equal(terminal.evidenceId, 'tool-a');
assert.equal(terminal.attribution, 'single-skill');
assert.equal(terminal.skill, 'rdk-model-zoo');

await fs.rm(tmp, { recursive: true, force: true });
console.log('trusted-evidence-chain: real Plan tool, session isolation, v2 identity, task/run isolation, terminal attribution ok');
