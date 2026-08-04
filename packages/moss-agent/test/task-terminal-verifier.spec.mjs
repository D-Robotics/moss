#!/usr/bin/env node
/**
 * task-terminal-verifier(P0)— 任务级终态判定(读产物)。
 * 不造假:产物文件内容是真硬信号(D1),非模型文本。无 plan/terminalAccept → unknown。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { verifyTaskTerminal, arbitrateTaskTerminal } from '../dist/acceptance/task-terminal-verifier.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-term-'));
const baseInput = (plan) => ({
  plan, workspaceDir: tmp, deviceExecutor: null, finalResponse: '',
});

// ─── 1. 有 plan + terminalAccept file_exist 产物存在 → pass ────────────────
{
  const productFile = path.join(tmp, 'model.bin');
  await fs.writeFile(productFile, 'binary content');
  const plan = {
    id: 'p1', goal: 'deploy model', status: 'completed', version: 1, steps: [],
    createdAt: '', updatedAt: '',
    terminalAccept: [{ name: 'file_exist', params: { path: productFile } }],
  };
  const v = await verifyTaskTerminal(baseInput(plan));
  assert.equal(v.verdict, 'pass');
  assert.equal(v.checkedCount, 1);
}
console.log('✓ 有 plan + terminalAccept file_exist 产物存在 → pass');

// ─── 2. 产物不存在 → fail ────────────────────────────────────────────────────
{
  const plan = {
    id: 'p2', goal: 'g', status: 'completed', version: 1, steps: [],
    createdAt: '', updatedAt: '',
    terminalAccept: [{ name: 'file_exist', params: { path: path.join(tmp, 'nope.bin') } }],
  };
  const v = await verifyTaskTerminal(baseInput(plan));
  assert.equal(v.verdict, 'fail');
  assert.match(v.reason, /file_missing/);
}
console.log('✓ 产物不存在 → fail');

// ─── 3. 无 plan → unknown(不造假)────────────────────────────────────────────
{
  const v = await verifyTaskTerminal(baseInput(null));
  assert.equal(v.verdict, 'unknown');
  assert.match(v.reason, /无 plan/);
  assert.equal(v.checkedCount, 0);
}
console.log('✓ 无 plan → unknown(不造假)');

// ─── 4. 有 plan 无 terminalAccept → unknown ──────────────────────────────────
{
  const plan = {
    id: 'p4', goal: 'g', status: 'completed', version: 1, steps: [],
    createdAt: '', updatedAt: '', successCriteria: ['model runs on board'],
    // 无 terminalAccept(只有人读 successCriteria)
  };
  const v = await verifyTaskTerminal(baseInput(plan));
  assert.equal(v.verdict, 'unknown');
  assert.match(v.reason, /无 terminalAccept/);
}
console.log('✓ 有 plan 无 terminalAccept → unknown(人读 successCriteria 不机器判)');

// ─── 5. 进程谓词只信任结构化终端执行证据 ────────────────────────────────────
{
  const stdoutPlan = {
    id: 'p5', goal: 'g', status: 'completed', version: 1, steps: [],
    createdAt: '', updatedAt: '',
    terminalAccept: [{ name: 'stdout_matches', params: { pattern: 'DEPLOY_OK' } }],
  };
  const assistantOnly = await verifyTaskTerminal({
    ...baseInput(stdoutPlan),
    finalResponse: 'DEPLOY_OK',
  });
  assert.equal(assistantOnly.verdict, 'unknown', 'assistant prose is not terminal stdout evidence');

  const stdoutEvidence = await verifyTaskTerminal({
    ...baseInput(stdoutPlan),
    finalResponse: 'not trusted',
    executionEvidence: { source: 'exec', toolUseId: 'e1', exitCode: 0, stdout: 'DEPLOY_OK', stderr: '' },
  });
  assert.equal(stdoutEvidence.verdict, 'pass');

  const exitPlan = {
    id: 'p5-exit', goal: 'g', status: 'completed', version: 1, steps: [],
    createdAt: '', updatedAt: '',
    terminalAccept: [{ name: 'exit_code_zero', params: {} }],
  };
  const noExitEvidence = await verifyTaskTerminal({
    ...baseInput(exitPlan),
    finalResponse: 'exit_code: 0',
  });
  assert.equal(noExitEvidence.verdict, 'unknown');

  const nonzeroEvidence = await verifyTaskTerminal({
    ...baseInput(exitPlan),
    finalResponse: '',
    executionEvidence: { source: 'exec', toolUseId: 'e2', exitCode: 3, stdout: '', stderr: 'failed' },
  });
  assert.equal(nonzeroEvidence.verdict, 'fail');
}
console.log('✓ stdout_matches/exit_code_zero only consume structured terminal evidence');

// ─── 6. 文件谓词不要求终端执行证据 ────────────────────────────────────────────
{
  const productFile = path.join(tmp, 'cfg.txt');
  await fs.writeFile(productFile, 'config ok');
  const plan = {
    id: 'p6', goal: 'g', status: 'completed', version: 1, steps: [],
    createdAt: '', updatedAt: '',
    terminalAccept: [{ name: 'file_exist', params: { path: productFile } }],
  };
  const v = await verifyTaskTerminal(baseInput(plan));
  assert.equal(v.verdict, 'pass');
}
console.log('✓ file_exist terminal predicate remains available without execution evidence');

// ─── 7. arbitrateTaskTerminal:单步全 pass + 终态 fail → auditFailed ──────────
{
  const plan = {
    id: 'p7', goal: 'g', status: 'completed', version: 1, steps: [],
    createdAt: '', updatedAt: '',
    terminalAccept: [{ name: 'file_exist', params: { path: path.join(tmp, 'missing.bin') } }], // 产物不存在→终态 fail
  };
  // 单步全 pass(契约都说成功)
  const experiences = [
    { id: '1', tool: 'device_exec', input: {}, reportedIsError: false, verdict: 'pass', reasonCode: 'exit_zero', signalSource: 'exit_code', confidence: 'medium', verdictLevel: 'L1', durationMs: 1, timestamp: '', sessionKey: 's', diagnostics: { contractSkill: 'rdk-device' } },
  ];
  const { terminal, arbitration } = await arbitrateTaskTerminal({
    ...baseInput(plan), experiences,
  });
  assert.equal(terminal.verdict, 'fail', '终态:产物不存在 → fail');
  assert.equal(arbitration.auditFailed, true, '单步全 pass 但终态 fail → 判据失效');
  assert.deepEqual(arbitration.suspectSkills, ['rdk-device']);
}
console.log('✓ arbitrateTaskTerminal: 单步全 pass + 终态 fail → auditFailed(T3.3 接线验证)');

// ─── 8. 终态 unknown 时不判 auditFailed ──────────────────────────────────────
{
  const plan = { id: 'p8', goal: 'g', status: 'completed', version: 1, steps: [], createdAt: '', updatedAt: '' }; // 无 terminalAccept
  const experiences = [
    { id: '1', tool: 'device_exec', input: {}, reportedIsError: false, verdict: 'pass', reasonCode: 'exit_zero', signalSource: 'exit_code', confidence: 'medium', verdictLevel: 'L1', durationMs: 1, timestamp: '', sessionKey: 's', diagnostics: { contractSkill: 'rdk-device' } },
  ];
  const { terminal, arbitration } = await arbitrateTaskTerminal({ ...baseInput(plan), experiences });
  assert.equal(terminal.verdict, 'unknown');
  assert.equal(arbitration.auditFailed, false, '终态 unknown → 无法判定判据失效(不造假)');
}
console.log('✓ 终态 unknown → 不判 auditFailed(不造假)');

// ─── 9. 漂移校准接线:terminalVerdictLog 足样本 → driftChecks 非空 ──────────────
{
  const { TerminalVerdictLog } = await import('../dist/acceptance/terminal-verdict-log.js');
  const tvLog = new TerminalVerdictLog({ baseDir: tmp });
  // 历史终局:12 次,3 pass 9 fail → terminalSuccessRate=0.25
  for (let i = 0; i < 3; i++) {
    await tvLog.append({ id: `p${i}`, skill: 'rdk-device', verdict: 'pass', reason: 'ok', sessionKey: 's', timestamp: 't' });
  }
  for (let i = 0; i < 9; i++) {
    await tvLog.append({ id: `f${i}`, skill: 'rdk-device', verdict: 'fail', reason: 'miss', sessionKey: 's', timestamp: 't' });
  }
  const plan = {
    id: 'p9', goal: 'g', status: 'completed', version: 1, steps: [],
    createdAt: '', updatedAt: '',
    terminalAccept: [{ name: 'file_exist', params: { path: path.join(tmp, 'missing.bin') } }], // 终态 fail
  };
  // 单步全 pass → singleStepPassRate=1.0,但终局只有 0.25 → 漂移 0.75 超阈
  const experiences = [
    { id: '1', tool: 'device_exec', input: {}, reportedIsError: false, verdict: 'pass', reasonCode: 'exit_zero', signalSource: 'exit_code', confidence: 'medium', verdictLevel: 'L1', durationMs: 1, timestamp: '', sessionKey: 's', diagnostics: { contractSkill: 'rdk-device' } },
  ];
  const { arbitration } = await arbitrateTaskTerminal({
    ...baseInput(plan), experiences,
    terminalVerdictLog: tvLog, minDriftSamples: 10,
  });
  assert.ok(arbitration.driftChecks, '应返回 driftChecks');
  assert.ok(arbitration.driftChecks.length > 0, 'rdk-device 有足够样本 → driftChecks 非空');
  const dc = arbitration.driftChecks.find((d) => d.skill === 'rdk-device');
  assert.ok(dc, '含 rdk-device 漂移检查');
  assert.equal(dc.driftDetected, true, 'singleStep 1.0 vs terminal 0.25 → 漂移检测');
}
console.log('✓ 漂移校准接线:terminalVerdictLog 足样本 → driftChecks 检出漂移');

// ─── 10. 冷启动 guard:样本不足 → driftChecks 空 ──────────────────────────────
{
  const { TerminalVerdictLog } = await import('../dist/acceptance/terminal-verdict-log.js');
  const tvLog = new TerminalVerdictLog({ baseDir: path.join(tmp, 'cold') }); // 独立目录,隔离前测污染
  for (let i = 0; i < 3; i++) { // 仅 3 < minDriftSamples 10
    await tvLog.append({ id: `c${i}`, skill: 'rdk-device', verdict: 'pass', reason: 'ok', sessionKey: 's', timestamp: 't' });
  }
  const plan = {
    id: 'p10', goal: 'g', status: 'completed', version: 1, steps: [],
    createdAt: '', updatedAt: '',
    terminalAccept: [{ name: 'file_exist', params: { path: path.join(tmp, 'missing.bin') } }],
  };
  const experiences = [
    { id: '1', tool: 'device_exec', input: {}, reportedIsError: false, verdict: 'pass', reasonCode: 'exit_zero', signalSource: 'exit_code', confidence: 'medium', verdictLevel: 'L1', durationMs: 1, timestamp: '', sessionKey: 's', diagnostics: { contractSkill: 'rdk-device' } },
  ];
  const { arbitration } = await arbitrateTaskTerminal({
    ...baseInput(plan), experiences,
    terminalVerdictLog: tvLog, minDriftSamples: 10,
  });
  assert.ok(!arbitration.driftChecks || arbitration.driftChecks.length === 0, '样本不足(<10)→ 不跑漂移(冷启动 guard)');
}
console.log('✓ 冷启动 guard:样本不足 → driftChecks 空(不误报)');

// ─── 11. 同一 execution 重试十次仍是冷启动 ────────────────────────────────────
{
  const { TerminalVerdictLog } = await import('../dist/acceptance/terminal-verdict-log.js');
  const retryOnlyLog = new TerminalVerdictLog({ baseDir: path.join(tmp, 'drift-same-evidence') });
  for (let i = 0; i < 10; i += 1) {
    await retryOnlyLog.append({
      id: `d-${i}`,
      taskId: 'p',
      attemptId: `a-${i}`,
      evidenceId: 'same-tool-result',
      skill: 'rdk-device',
      verdict: 'fail',
      reason: 'same failure replayed',
      sessionKey: 's',
      timestamp: `2026-07-30T01:${String(i).padStart(2, '0')}:00.000Z`,
    });
  }
  const plan = {
    id: 'p11', goal: 'g', status: 'completed', version: 1, steps: [],
    createdAt: '', updatedAt: '',
    terminalAccept: [{ name: 'file_exist', params: { path: path.join(tmp, 'missing.bin') } }],
  };
  const experiences = [
    { id: '1', tool: 'device_exec', input: {}, reportedIsError: false, verdict: 'pass', reasonCode: 'exit_zero', signalSource: 'exit_code', confidence: 'medium', verdictLevel: 'L1', durationMs: 1, timestamp: '', sessionKey: 's', diagnostics: { contractSkill: 'rdk-device' } },
  ];
  const retryDrift = await arbitrateTaskTerminal({
    ...baseInput(plan), experiences,
    terminalVerdictLog: retryOnlyLog, minDriftSamples: 10,
  });
  assert.deepEqual(retryDrift.arbitration.driftChecks, [], 'one replayed execution cannot satisfy drift sample threshold');
}
console.log('✓ 同一 execution 重试十次仍是冷启动');

// ─── 12. 无 terminalVerdictLog → driftChecks 空(no-op)──────────────────────
{
  const plan = {
    id: 'p11', goal: 'g', status: 'completed', version: 1, steps: [],
    createdAt: '', updatedAt: '',
    terminalAccept: [{ name: 'file_exist', params: { path: path.join(tmp, 'missing.bin') } }],
  };
  const experiences = [
    { id: '1', tool: 'device_exec', input: {}, reportedIsError: false, verdict: 'pass', reasonCode: 'exit_zero', signalSource: 'exit_code', confidence: 'medium', verdictLevel: 'L1', durationMs: 1, timestamp: '', sessionKey: 's', diagnostics: { contractSkill: 'rdk-device' } },
  ];
  const { arbitration } = await arbitrateTaskTerminal({ ...baseInput(plan), experiences });
  assert.ok(!arbitration.driftChecks || arbitration.driftChecks.length === 0, '无 log → driftChecks 空(行为同前)');
}
console.log('✓ 无 terminalVerdictLog → driftChecks 空(no-op,行为同前)');

await fs.rm(tmp, { recursive: true, force: true });
console.log('\n✅ task-terminal-verifier P0 全部通过(12/12)');
