#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DeviceSshSession } from '../dist/tools/device-ssh-session.js';
import { makeReadonlyExecutor } from '../dist/core/tools/device-readonly-executor.js';
import { SkillRegistry } from '../dist/skills/registry.js';
import { ContractRegistry } from '../dist/acceptance/contract-registry.js';
import { evaluatePostconditions } from '../dist/acceptance/predicate-evaluator.js';
import { probeDeviceEnvironmentFacts, trustedEnvironmentIdentity } from '../dist/memory/environment-fingerprint.js';
import { planTool, resetPlanControllerForTests } from '../dist/plan-execute/plan-tools.js';
import { getActivePlanForSession } from '../dist/plan-execute/plan-controller-store.js';
import { ExperienceLog } from '../dist/memory/experience-log.js';
import { TerminalVerdictLog } from '../dist/acceptance/terminal-verdict-log.js';
import { CrossSignalLog, hasIndependentCrossSignal } from '../dist/acceptance/cross-signal-log.js';
import { wrapWithTerminalArbitration } from '../dist/core/tools/terminal-arbitration-gate.js';

const host = process.env.MOSS_REALBOARD_HOST;
if (process.env.MOSS_REALBOARD_TEST !== '1' || !host) {
  console.log('  [SKIP] realboard-priority-contracts: set MOSS_REALBOARD_TEST=1 and MOSS_REALBOARD_HOST to opt in');
  process.exit(0);
}
const session = new DeviceSshSession({ host, user: 'root', port: 22 });
try {
  await session.connect();
} catch {
  console.log(`  [SKIP] realboard-priority-contracts: ${host} unreachable`);
  process.exit(0);
}

const workspace = process.cwd();
const facts = await probeDeviceEnvironmentFacts(session);
const identity = trustedEnvironmentIdentity({ workspaceDir: workspace, runtimeMode: 'device', device: facts });
assert.match(facts.boardModel ?? '', /RDK\s+X5/i);
assert.equal(identity.completeness, 'complete');
const readonly = makeReadonlyExecutor({ sshSession: session });
const contracts = ContractRegistry.fromSkills(new SkillRegistry({ workspaceDir: workspace }).list());

async function assertContract(skill, command) {
  const contract = contracts.findBySkill(skill);
  assert.ok(contract, `${skill} contract loaded`);
  const executed = await session.run(command, { timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });
  const result = await evaluatePostconditions(contract.postconditions, {
    result: executed.stdout, exitCode: executed.exitCode, reportedIsError: executed.exitCode !== 0,
    input: { command }, workspaceDir: workspace, deviceExecutor: readonly,
  });
  assert.equal(result.verdict, 'pass', `${skill}: ${result.reasonCode}`);
  return executed;
}

await assertContract('rdk-hardware', 'cat /proc/device-tree/model');
await assertContract('rdk-command-manual', 'hrut_somstatus');
await assertContract('rdk-isp-tuning', '/app/multimedia_samples/sample_isp/get_isp_data/get_isp_data -h');
assert.equal((await session.run('systemctl is-active cam-service')).stdout.trim(), 'active');

// Safe capture: no service restart or ISP config write; only fresh YUV plus /tmp JPEG.
await session.run("(sleep 8; printf 'lq') | timeout 30 /app/multimedia_samples/sample_isp/get_isp_data/get_isp_data -s 50 -c io >/dev/null 2>&1", { timeout: 40_000 });
const yuv = (await session.run('ls -t /root/handle_*.yuv | head -1')).stdout.trim();
assert.match(yuv, /1920x1080.*\.yuv$/);
const ffmpegCommand = `ffmpeg -loglevel error -f rawvideo -pix_fmt nv12 -s 1920x1080 -i ${yuv} -frames 1 /tmp/photo.jpg -y`;
const capture = await assertContract('rdk-capture-photo', ffmpegCommand);
assert.equal(capture.exitCode, 0);

// Use a real Plan entry and the production terminal gate to persist independent
// execution + artifact channels for the same real evidence item.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-real-cross-signal-'));
const planSession = 'real-capture-contract';
const runId = 'real-capture-run';
resetPlanControllerForTests();
const ctx = { workspaceDir: workspace, sessionKey: planSession, runId: 'setup' };
const created = await planTool.execute({
  action: 'create', goal: 'safe RDK X5 capture verification',
  steps: [{ description: 'convert fresh stable frame', expectedTools: ['device_exec'], expectedAccept: ['rdk-capture-photo'] }],
  terminalAccept: [
    { name: 'exit_code_zero', params: {} },
    { name: 'file_nonempty', params: { path: '/tmp/photo.jpg' } },
    { name: 'image_decodable', params: { path: '/tmp/photo.jpg' } },
  ],
}, ctx);
const planId = /Plan created: (\S+)/.exec(created)?.[1];
assert.ok(planId);
await planTool.execute({ action: 'review', planId }, ctx);
await planTool.execute({ action: 'approve', planId }, ctx);
await planTool.execute({ action: 'start', planId }, ctx);
const plan = getActivePlanForSession(planSession);
assert.ok(plan);

await fs.mkdir(tmp, { recursive: true });
const experienceLog = new ExperienceLog({ baseDir: tmp });
const terminalLog = new TerminalVerdictLog({ baseDir: tmp });
const crossLog = new CrossSignalLog({ baseDir: tmp });
await experienceLog.append({
  schemaVersion: 2, id: 'capture-exp', sessionKey: planSession, taskId: plan.id, runId,
  stepId: `${plan.id}:step:1`, attemptId: `${runId}:capture-evidence`, toolCallId: 'capture-evidence', evidenceId: 'capture-evidence',
  contractSkill: 'rdk-capture-photo', contractVersion: '1', environmentFingerprint: identity.fingerprint,
  environmentIdentityVersion: 1, environmentCompleteness: 'complete', executionDomain: 'real', realEvidenceEligible: true,
  tool: 'device_exec', input: { command: 'ffmpeg capture to /tmp/photo.jpg' }, reportedIsError: false,
  verdict: 'pass', reasonCode: 'capture_verified', signalSource: 'file_exist', confidence: 'high', verdictLevel: 'L1',
  durationMs: 1, timestamp: new Date().toISOString(),
});
const gate = wrapWithTerminalArbitration(async () => ({ ok: true }), {
  experienceLog, terminalVerdictLog: terminalLog, crossSignalLog: crossLog,
  planProvider: { get: getActivePlanForSession }, workspaceDir: workspace, deviceExecutor: { current: readonly },
});
assert.equal((await gate({
  sessionKey: planSession, runId, turn: 1, response: '', messages: [], totalToolCalls: 1,
  toolCallsByName: { device_exec: 1 },
  executionEvidence: { source: 'device_exec', toolUseId: 'capture-evidence', exitCode: 0, stdout: '', stderr: '' },
})).ok, true);
assert.equal(await hasIndependentCrossSignal({
  skill: 'rdk-capture-photo', terminalEntries: await terminalLog.readAll(), crossSignals: await crossLog.readAll(),
}), true);

await fs.rm(tmp, { recursive: true, force: true });
await session.close();
console.log(`realboard-priority-contracts: X5 contracts and independent capture signal passed (${identity.fingerprint})`);
