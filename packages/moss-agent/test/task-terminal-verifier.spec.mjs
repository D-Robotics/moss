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

// ─── 5. stdout_matches 终态谓词匹配最终回复 ──────────────────────────────────
{
  const plan = {
    id: 'p5', goal: 'g', status: 'completed', version: 1, steps: [],
    createdAt: '', updatedAt: '',
    terminalAccept: [{ name: 'stdout_matches', params: { pattern: 'deployed to /userdata' } }],
  };
  // 最终回复含"deployed to /userdata" → pass
  let v = await verifyTaskTerminal({ ...baseInput(plan), finalResponse: 'model deployed to /userdata/model.bin' });
  assert.equal(v.verdict, 'pass');
  // 不匹配 → fail
  v = await verifyTaskTerminal({ ...baseInput(plan), finalResponse: 'something else' });
  assert.equal(v.verdict, 'fail');
}
console.log('✓ stdout_matches 终态谓词匹配最终回复(pass/fail)');

// ─── 6. 多终态谓词 AND 语义 ──────────────────────────────────────────────────
{
  const productFile = path.join(tmp, 'cfg.txt');
  await fs.writeFile(productFile, 'config ok');
  const plan = {
    id: 'p6', goal: 'g', status: 'completed', version: 1, steps: [],
    createdAt: '', updatedAt: '',
    terminalAccept: [
      { name: 'file_exist', params: { path: productFile } },
      { name: 'stdout_matches', params: { pattern: 'config applied' } },
    ],
  };
  // 两都满足 → pass
  let v = await verifyTaskTerminal({ ...baseInput(plan), finalResponse: 'config applied successfully' });
  assert.equal(v.verdict, 'pass');
  // 一个不满足(file 有但 stdout 不匹配)→ fail(AND)
  v = await verifyTaskTerminal({ ...baseInput(plan), finalResponse: 'no match' });
  assert.equal(v.verdict, 'fail');
}
console.log('✓ 多终态谓词 AND 语义');

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

await fs.rm(tmp, { recursive: true, force: true });
console.log('\n✅ task-terminal-verifier P0 全部通过(8/8)');
