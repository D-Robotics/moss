#!/usr/bin/env node
/**
 * cli-completion-gate-composition — 纯组合 helper 的集成验证。
 * 验 composition 顺序:coding gate -> terminal arbitration -> promotion observation。
 *   1. 终态审计拦截(产物缺失)→ coding gate 不被调,promotion 不被调。
 *   2. 无 plan + coding gate 接受 → coding gate 被调,promotion 观察一次,原对象按身份保留。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { composeCliCompletionGate } from '../dist/cli/completion-gate-composition.js';
import { ExperienceLog } from '../dist/memory/experience-log.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-compose-'));
const log = new ExperienceLog({ baseDir: tmp });

// ─── 1. 终态审计拦截 → coding gate 与 promotion 都不被调 ──────────────────────
{
  let codingCalls = 0;
  let promotionCalls = 0;
  const codingGate = async () => { codingCalls += 1; return { ok: true }; };
  const promotionObserver = { observeCompletion: async () => { promotionCalls += 1; } };

  // plan executing + terminalAccept 指向不存在的产物 → 终态 fail → auditFailed
  const productFile = path.join(tmp, 'missing.bin');
  const plan = {
    id: 'p', goal: 'g', status: 'executing', version: 1, steps: [],
    createdAt: '', updatedAt: '',
    terminalAccept: [{ name: 'file_exist', params: { path: productFile } }],
  };
  // 灌单步全 pass(契约说成功)
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  await log.append({
    id: '1', tool: 'device_exec', input: {}, reportedIsError: false,
    verdict: 'pass', reasonCode: 'exit_zero', signalSource: 'exit_code',
    confidence: 'medium', verdictLevel: 'L1', durationMs: 1,
    timestamp: '2026-07-29T00:00:00.000Z', sessionKey: 's1',
    diagnostics: { contractSkill: 'rdk-device' },
  });

  const gate = composeCliCompletionGate(codingGate, {
    terminalArbitration: {
      experienceLog: log, planProvider: { get: () => plan },
      deviceExecutor: { current: null }, workspaceDir: tmp,
    },
    promotionObserver,
  });

  const r = await gate({ sessionKey: 's1', runId: 'r', turn: 1, response: 'done', messages: [], totalToolCalls: 1, toolCallsByName: {} });
  assert.equal(r.ok, false, '终态审计拦截 → ok:false');
  assert.equal(codingCalls, 0, '终态审计拦截 → coding gate 不被调');
  assert.equal(promotionCalls, 0, '终态审计拦截 → promotion 不被调(外层观察,原 gate 未 ok)');
}
console.log('✓ 终态审计拦截 → coding gate 与 promotion 都不被调(顺序:terminal 先于 coding/promotion)');

// ─── 2. 无 plan + coding gate 接受 → promotion 观察一次,原对象按身份保留 ───────
{
  let codingCalls = 0;
  let promotionCalls = 0;
  let observedCompletion = null;
  // 唯一可识别的成功结果对象(用于按身份断言)
  const success = { ok: true };
  const codingGate = async () => { codingCalls += 1; return success; };
  const promotionObserver = {
    observeCompletion: async (completion) => { promotionCalls += 1; observedCompletion = completion; },
  };

  const gate = composeCliCompletionGate(codingGate, {
    terminalArbitration: {
      experienceLog: log, planProvider: { get: () => null },
      deviceExecutor: { current: null }, workspaceDir: tmp,
    },
    promotionObserver,
  });

  const request = { sessionKey: 's2', runId: 'r', turn: 1, response: 'done', messages: [], totalToolCalls: 1, toolCallsByName: {} };
  const r = await gate(request);
  assert.equal(codingCalls, 1, '无 plan → coding gate 被调一次');
  assert.equal(r, success, '原成功结果按身份保留(wrapper 不重建对象)');
  assert.equal(promotionCalls, 1, 'coding gate 接受后 → promotion 观察一次');
  assert.equal(observedCompletion, request, 'promotion 收到的就是原始 request 对象');
}
console.log('✓ 无 plan + coding gate 接受 → coding 被调、promotion 观察一次、原对象按身份保留');

await fs.rm(tmp, { recursive: true, force: true });
console.log('\n✅ cli-completion-gate-composition 全部通过(2/2)');
