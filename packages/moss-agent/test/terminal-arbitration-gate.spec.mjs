#!/usr/bin/env node
/**
 * terminal-arbitration-gate(P0 接线)— completionGate 链里终态审计。
 * 验:单步全 pass + 终态 fail → 拦截返 correction;否则透传原 gate。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { wrapWithTerminalArbitration } from '../dist/core/tools/terminal-arbitration-gate.js';
import { ExperienceLog } from '../dist/memory/experience-log.js';
import { TerminalVerdictLog } from '../dist/acceptance/terminal-verdict-log.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-gate-'));
const log = new ExperienceLog({ baseDir: tmp });

// 原始 gate(透传用)— 默认 ok:true(.mjs 不能用 TS 的 `as const`,纯值断言足够)
const passthroughGate = async () => ({ ok: true });

// ─── 1. 无 plan → 透传原 gate ────────────────────────────────────────────────
{
  const wrapped = wrapWithTerminalArbitration(passthroughGate, {
    experienceLog: log, planProvider: { get: () => null },
    deviceExecutor: { current: null }, workspaceDir: tmp,
  });
  const r = await wrapped({ sessionKey: 's', runId: 'r', turn: 1, response: 'done', messages: [], totalToolCalls: 1, toolCallsByName: {} });
  assert.equal(r.ok, true, '无 plan → 透传原 gate');
}
console.log('✓ 无 plan → 透传原 gate(不审计)');

// ─── 2. plan 未执行中(status !== executing)→ 透传 ──────────────────────────
{
  const plan = { id: 'p', goal: 'g', status: 'approved', version: 1, steps: [], createdAt: '', updatedAt: '', terminalAccept: [{ name: 'file_exist', params: { path: '/x' } }] };
  const wrapped = wrapWithTerminalArbitration(passthroughGate, {
    experienceLog: log, planProvider: { get: () => plan },
    deviceExecutor: { current: null }, workspaceDir: tmp,
  });
  const r = await wrapped({ sessionKey: 's', runId: 'r', turn: 1, response: '', messages: [], totalToolCalls: 1, toolCallsByName: {} });
  assert.equal(r.ok, true, 'plan 非 executing → 透传(不重复审计)');
}
console.log('✓ plan 非 executing → 透传(不重复审计)');

// Completed is the lifecycle point where terminal acceptance matters most.
{
  const productFile = path.join(tmp, 'completed-plan-missing.bin');
  const plan = {
    id: 'completed-plan', goal: 'g', status: 'completed', version: 1,
    steps: [{ step: 1, description: 'deploy', status: 'completed', expectedAccept: ['rdk-device'] }],
    createdAt: '', updatedAt: '',
    terminalAccept: [{ name: 'file_exist', params: { path: productFile } }],
  };
  await log.append({
    id: 'completed-plan-exp', tool: 'device_exec', input: {}, reportedIsError: false,
    verdict: 'pass', reasonCode: 'exit_zero', signalSource: 'exit_code',
    confidence: 'medium', verdictLevel: 'L1', durationMs: 1,
    timestamp: '2026-07-30T00:00:00.000Z', sessionKey: 'completed-plan-session',
    diagnostics: { contractSkill: 'rdk-device' },
  });
  const wrapped = wrapWithTerminalArbitration(passthroughGate, {
    experienceLog: log, planProvider: { get: () => plan },
    deviceExecutor: { current: null }, workspaceDir: tmp,
  });
  const r = await wrapped({
    sessionKey: 'completed-plan-session', runId: 'r', turn: 1, response: 'done',
    messages: [], totalToolCalls: 1, toolCallsByName: {},
  });
  assert.equal(r.ok, false, 'completed plan still undergoes terminal acceptance audit');
}
console.log('✓ completed plan still undergoes terminal acceptance audit');

// ─── 3. ★ 核心:单步全 pass + 终态 fail → 拦截返 correction ──────────────────
{
  // plan executing + terminalAccept(产物不存在 → 终态 fail)
  const productFile = path.join(tmp, 'missing.bin');
  const plan = { id: 'p', goal: 'g', status: 'executing', version: 1, steps: [{ expectedAccept: ['rdk-device'] }], createdAt: '', updatedAt: '', terminalAccept: [{ name: 'file_exist', params: { path: productFile } }] };
  const tvLog = new TerminalVerdictLog({ baseDir: path.join(tmp, 'audit-fail-log') });
  // 灌单步全 pass(契约说成功)
  await fs.writeFile(path.join(tmp, 'experiences.jsonl'), '');
  await log.append({
    id: '1', tool: 'device_exec', input: {}, reportedIsError: false,
    verdict: 'pass', reasonCode: 'exit_zero', signalSource: 'exit_code',
    confidence: 'medium', verdictLevel: 'L1', durationMs: 1,
    timestamp: '2026-07-29T00:00:00.000Z', sessionKey: 's1',
    diagnostics: { contractSkill: 'rdk-device' },
  });
  const wrapped = wrapWithTerminalArbitration(passthroughGate, {
    experienceLog: log, planProvider: { get: () => plan },
    deviceExecutor: { current: null }, workspaceDir: tmp,
    terminalVerdictLog: tvLog,
  });
  const r = await wrapped({
    sessionKey: 's1', runId: 'run-audit', turn: 2, response: 'done', messages: [], totalToolCalls: 1, toolCallsByName: {},
    executionEvidence: { source: 'exec', toolUseId: 'audit-evidence', exitCode: 0, stdout: '', stderr: '' },
  });
  assert.equal(r.ok, false, '单步全 pass + 终态 fail → 拦截');
  assert.match(r.reason, /terminal_contract_drift/);
  assert.match(r.correction, /Terminal acceptance failed/);
  assert.match(r.correction, /rdk-device/, 'correction 含疑似失效契约');
  const [entry] = await tvLog.readAll();
  assert.equal(entry.verdict, 'fail', 'audit failure is persisted before blocking');
  assert.equal(entry.taskId, plan.id);
  assert.equal(entry.attemptId, `${plan.id}:run-audit:2`);
  assert.equal(entry.evidenceId, 'audit-evidence');
  assert.equal(entry.schemaVersion, 2);
  assert.equal(entry.attribution, 'single-skill');
  assert.deepEqual(entry.skills, ['rdk-device']);
}
console.log('✓ ★ 核心: 单步全 pass + 终态 fail → 拦截返 correction(T3.3 真接线生效)');

// ─── 4. 终态 pass → 透传(单步全 pass + 终态 pass,一致)──────────────────────
{
  const productFile = path.join(tmp, 'exists.bin');
  await fs.writeFile(productFile, 'ok');
  const plan = { id: 'p2', goal: 'g', status: 'executing', version: 1, steps: [], createdAt: '', updatedAt: '', terminalAccept: [{ name: 'file_exist', params: { path: productFile } }] };
  const wrapped = wrapWithTerminalArbitration(passthroughGate, {
    experienceLog: log, planProvider: { get: () => plan },
    deviceExecutor: { current: null }, workspaceDir: tmp,
  });
  const r = await wrapped({ sessionKey: 's1', runId: 'r', turn: 1, response: '', messages: [], totalToolCalls: 1, toolCallsByName: {} });
  assert.equal(r.ok, true, '终态 pass → 透传(不误拦)');
}
console.log('✓ 终态 pass → 透传(不误拦)');

// ─── 5. plan 无 terminalAccept → 终态 unknown → 透传(不造假)────────────────
{
  const plan = { id: 'p3', goal: 'g', status: 'executing', version: 1, steps: [], createdAt: '', updatedAt: '' };
  const wrapped = wrapWithTerminalArbitration(passthroughGate, {
    experienceLog: log, planProvider: { get: () => plan },
    deviceExecutor: { current: null }, workspaceDir: tmp,
  });
  const r = await wrapped({ sessionKey: 's1', runId: 'r', turn: 1, response: '', messages: [], totalToolCalls: 1, toolCallsByName: {} });
  assert.equal(r.ok, true, '终态 unknown → 透传(不造假,不审计)');
}
console.log('✓ plan 无 terminalAccept → 终态 unknown → 透传(不造假)');

// ─── 6. 审计异常不影响主流程(fall through)──────────────────────────────────
{
  // 故意让 experienceLog 抛(传坏的)— 但 experienceLog readAll 不会抛,
  // 这里验 wrapped 不抛:即使 plan 状态怪,也 fall through
  const plan = { id: 'p4', goal: 'g', status: 'executing', version: 1, steps: [], createdAt: '', updatedAt: '', terminalAccept: [] };
  const wrapped = wrapWithTerminalArbitration(passthroughGate, {
    experienceLog: log, planProvider: { get: () => plan },
    deviceExecutor: { current: null }, workspaceDir: tmp,
  });
  const r = await wrapped({ sessionKey: 'no-match', runId: 'r', turn: 1, response: '', messages: [], totalToolCalls: 0, toolCallsByName: {} });
  assert.equal(r.ok, true, '空 terminalAccept → unknown → 透传');
}
console.log('✓ 审计边界: 异常/边界 → fall through 不影响主流程');

// ─── 7. T3.4 closure: terminal verdict recorded to log for promotion stats ─
{
  const { TerminalVerdictLog } = await import('../dist/acceptance/terminal-verdict-log.js');
  const tvLog = new TerminalVerdictLog({ baseDir: tmp });
  const productFile = path.join(tmp, 'exists2.bin');
  await fs.writeFile(productFile, 'ok');
  const plan = {
    id: 'ptv', goal: 'g', status: 'executing', version: 1,
    // steps reference contract skills via expectedAccept (the real Plan shape)
    steps: [{ step: 1, description: 'deploy', status: 'completed', expectedAccept: ['rdk-device'] }],
    createdAt: '', updatedAt: '',
    terminalAccept: [{ name: 'file_exist', params: { path: productFile } }],
  };
  const wrapped = wrapWithTerminalArbitration(passthroughGate, {
    experienceLog: log, planProvider: { get: () => plan },
    deviceExecutor: { current: null }, workspaceDir: tmp,
    terminalVerdictLog: tvLog,
  });
  await wrapped({ sessionKey: 'stv', runId: 'r', turn: 1, response: '', messages: [], totalToolCalls: 1, toolCallsByName: {} });
  const recorded = await tvLog.readAll();
  assert.equal(recorded.length, 1, 'terminal verdict recorded once per referenced skill');
  assert.equal(recorded[0].skill, 'rdk-device');
  assert.equal(recorded[0].verdict, 'pass');
}
console.log('✓ T3.4 closure: terminal verdict recorded to log (promotion statistic feed)');

// ─── 8. Process predicates receive request execution evidence, never prose ────
{
  const plan = {
    id: 'process-evidence', goal: 'g', status: 'executing', version: 1, steps: [],
    createdAt: '', updatedAt: '',
    terminalAccept: [{ name: 'stdout_matches', params: { pattern: 'DEPLOY_OK' } }],
  };
  const wrapped = wrapWithTerminalArbitration(passthroughGate, {
    experienceLog: log, planProvider: { get: () => plan },
    deviceExecutor: { current: null }, workspaceDir: tmp,
  });
  await log.append({
    id: 'process-evidence', tool: 'exec', input: {}, reportedIsError: false,
    verdict: 'pass', reasonCode: 'exit_zero', signalSource: 'exit_code',
    confidence: 'medium', verdictLevel: 'L1', durationMs: 1,
    timestamp: '2026-07-30T00:00:00.000Z', sessionKey: 'process-evidence',
    diagnostics: { contractSkill: 'rdk-device' },
  });
  const r = await wrapped({
    sessionKey: 'process-evidence', runId: 'r', turn: 1, response: 'DEPLOY_OK', messages: [], totalToolCalls: 1, toolCallsByName: {},
    executionEvidence: { source: 'exec', toolUseId: 'e1', exitCode: 0, stdout: 'not deployed', stderr: '' },
  });
  assert.equal(r.ok, false, 'execution evidence, not matching assistant prose, determines the terminal predicate');
  assert.match(r.reason, /terminal_acceptance_failed|terminal_contract_drift/);
}
console.log('✓ process predicates receive request execution evidence rather than assistant prose');

// Multi-skill plans retain one overall terminal record, without crediting either skill.
{
  const tvLog = new TerminalVerdictLog({ baseDir: path.join(tmp, 'multi-skill') });
  const productFile = path.join(tmp, 'multi-exists.bin');
  await fs.writeFile(productFile, 'ok');
  const plan = {
    id: 'multi-plan', goal: 'g', status: 'completed', version: 3,
    steps: [
      { step: 1, description: 'a', status: 'completed', expectedAccept: ['rdk-device'] },
      { step: 2, description: 'b', status: 'completed', expectedAccept: ['rdk-ros'] },
    ],
    createdAt: '', updatedAt: '', terminalAccept: [{ name: 'file_exist', params: { path: productFile } }],
  };
  const wrapped = wrapWithTerminalArbitration(passthroughGate, {
    experienceLog: log,
    planProvider: { get: (sessionKey) => sessionKey === 'multi-session' ? plan : null },
    deviceExecutor: { current: null }, workspaceDir: tmp, terminalVerdictLog: tvLog,
  });
  await wrapped({ sessionKey: 'multi-session', runId: 'multi-run', turn: 4, response: '', messages: [], totalToolCalls: 1, toolCallsByName: {} });
  const [entry] = await tvLog.readAll();
  assert.equal(entry.skill, 'unknown');
  assert.equal(entry.attribution, 'multi-skill');
  assert.deepEqual(entry.skills, ['rdk-device', 'rdk-ros']);
  assert.equal(entry.planVersion, 3);
}

await fs.rm(tmp, { recursive: true, force: true });
console.log('\n✅ terminal-arbitration-gate P0 接线 全部通过(9/9)');
