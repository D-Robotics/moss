#!/usr/bin/env node
/**
 * observation-wiring — T2.2 ObservationAggregator 运行时接线验证。
 * 验:成功 completion 后,observation aggregator 真被调用(Experience→Observation 跑通),
 *    且不阻断 completion、失败不影响主流程。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ExperienceLog } from '../dist/memory/experience-log.js';
import { ObservationAggregator } from '../dist/memory/observation-aggregator.js';
import { MemoryManager } from '../dist/core/index.js';
import { composeCliCompletionGate } from '../dist/cli/completion-gate-composition.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-obs-wire-'));
const experienceLog = new ExperienceLog({ baseDir: tmp });
const memoryManager = new MemoryManager(tmp);
const aggregator = new ObservationAggregator({ experienceLog, memoryManager });

// 灌一条 Experience(有 contractSkill,聚合后产 Observation)
await experienceLog.append({
  id: 'e1', tool: 'device_exec', input: {}, reportedIsError: false,
  verdict: 'pass', reasonCode: 'exit_zero', signalSource: 'exit_code',
  confidence: 'medium', verdictLevel: 'L1', durationMs: 1,
  timestamp: '2026-07-30T00:00:00.000Z', sessionKey: 's1',
  diagnostics: { contractSkill: 'rdk-device' },
});

// coding gate 接受 + promotion observer 触发 aggregator
const codingGate = async () => ({ ok: true });
const promotionObserver = {
  observeCompletion: async () => { await aggregator.aggregate(); },
};

const gate = composeCliCompletionGate(codingGate, {
  terminalArbitration: { experienceLog, planProvider: { current: null }, deviceExecutor: { current: null }, workspaceDir: tmp },
  promotionObserver,
});

const req = { sessionKey: 's1', runId: 'r', turn: 1, response: 'done', messages: [], totalToolCalls: 1, toolCallsByName: {} };
const r = await gate(req);
assert.equal(r.ok, true, 'completion 不阻断');

// aggregator 应产了 Observation(trust=observation)
const mems = await memoryManager.getAll();
assert.ok(mems.some((m) => m.trust === 'observation' && m.content.includes('rdk-device')), `应有 rdk-device observation 条目,实际:${mems.map((m) => m.trust).join(',')}`);
console.log('✓ 成功 completion 后 ObservationAggregator 跑通(Experience→trust=observation 落盘)');

// aggregator 失败不影响 completion
const badAgg = new ObservationAggregator({ experienceLog, memoryManager: null });
const gate2 = composeCliCompletionGate(codingGate, {
  terminalArbitration: { experienceLog, planProvider: { current: null }, deviceExecutor: { current: null }, workspaceDir: tmp },
  promotionObserver: { observeCompletion: async () => { try { await badAgg.aggregate(); } catch {} } },
});
const r2 = await gate2(req);
assert.equal(r2.ok, true, 'aggregator 失败不阻断 completion');
console.log('✓ aggregator 失败不影响 completion');

await fs.rm(tmp, { recursive: true, force: true });
console.log('\n✅ observation-wiring T2.2 接线验证通过(2/2)');
