#!/usr/bin/env node
/**
 * opinion-evolver(T2.3)— Opinion 置信度演化 + freshness + 硬作废。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createOpinion,
  evolveOpinion,
  hardSupersedeOpinion,
  encodeOpinionMeta,
  parseOpinionMeta,
} from '../dist/memory/opinion-evolver.js';
import { MemoryManager } from '../dist/memory/memory-manager.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-op-'));
const mm = new MemoryManager(tmp);
await mm.load();

// ─── 1. createOpinion + topic 编解码往返 ─────────────────────────────────────
{
  const id = await createOpinion(mm, 'rdk-device 在 S100 上量化常失败,建议改用 X5 toolchain', 0.5);
  const e = await mm.getById(id);
  assert.ok(e);
  assert.equal(e.trust, 'opinion');
  const meta = parseOpinionMeta(e.topic);
  assert.ok(meta);
  assert.equal(meta.confidence, 0.5);
  assert.equal(meta.freshness, 'new');
  assert.equal(meta.supports, 0);
  assert.equal(meta.contradicts, 0);

  // 编解码往返
  const re = parseOpinionMeta(encodeOpinionMeta(meta));
  assert.deepEqual(re, meta);
}
console.log('✓ createOpinion + topic 编解码往返');

// ─── 2. 支持证据 → confidence ↑,freshness strengthening/stable ───────────────
{
  const id = await createOpinion(mm, 'opinion-2 supports test', 0.4);
  const m1 = await evolveOpinion(mm, id, 'support', 0.15);
  assert.ok(m1);
  assert.ok(m1.confidence > 0.4, 'confidence ↑');
  assert.equal(m1.supports, 1);
  assert.equal(m1.contradicts, 0);
  assert.ok(['strengthening', 'stable'].includes(m1.freshness));

  // 再支持一次 → confidence 继续升
  const m2 = await evolveOpinion(mm, id, 'support', 0.15);
  assert.ok(m2.confidence > m1.confidence);
  assert.equal(m2.supports, 2);
}
console.log('✓ 支持证据 → confidence ↑ + supports 累加 + freshness strengthening/stable');

// ─── 3. 矛盾证据 → confidence ↓,freshness weakening ─────────────────────────
{
  const id = await createOpinion(mm, 'opinion-3 contradict test', 0.7);
  const m1 = await evolveOpinion(mm, id, 'contradict', 0.2);
  assert.ok(m1.confidence < 0.7, 'confidence ↓');
  assert.equal(m1.contradicts, 1);
  assert.ok(['weakening', 'stale'].includes(m1.freshness));
}
console.log('✓ 矛盾证据 → confidence ↓ + contradicts 累加 + freshness weakening/stale');

// ─── 4. confidence 钳到 [0,1] ─────────────────────────────────────────────────
{
  const id = await createOpinion(mm, 'opinion-4 clamp test', 0.95);
  // 连续支持不会超 1
  await evolveOpinion(mm, id, 'support', 0.5);
  let m = await evolveOpinion(mm, id, 'support', 0.5);
  assert.ok(m.confidence <= 1, '不超 1');

  const id2 = await createOpinion(mm, 'opinion-4b clamp low', 0.05);
  await evolveOpinion(mm, id2, 'contradict', 0.5);
  m = await evolveOpinion(mm, id2, 'contradict', 0.5);
  assert.ok(m.confidence >= 0, '不低于 0');
}
console.log('✓ confidence 钳到 [0,1]');

// ─── 5. 持续矛盾到低置信度 → freshness stale ─────────────────────────────────
{
  const id = await createOpinion(mm, 'opinion-5 stale test', 0.5);
  let m;
  for (let i = 0; i < 5; i++) m = await evolveOpinion(mm, id, 'contradict', 0.15);
  assert.ok(m.confidence < 0.3, '持续矛盾 → 低置信度');
  assert.equal(m.freshness, 'stale', '低置信度 → stale');
}
console.log('✓ 持续矛盾 → 低置信度 + freshness stale');

// ─── 6. 不删除:矛盾后 Opinion 仍在(保留证据链供层 3 仲裁)─────────────────────
{
  const id = await createOpinion(mm, 'opinion-6 no-delete test', 0.6);
  await evolveOpinion(mm, id, 'contradict', 0.3);
  await evolveOpinion(mm, id, 'contradict', 0.3);
  const e = await mm.getById(id);
  assert.ok(e, 'Opinion 仍在(不删除)');
  const meta = parseOpinionMeta(e.topic);
  assert.equal(meta.contradicts, 2, '矛盾证据计数保留');
}
console.log('✓ 不删除: 矛盾后 Opinion 仍在,证据计数保留');

// ─── 7. 硬作废:supersededBy 设置 + 不再演化(固件变更场景)───────────────────
{
  const oldId = await createOpinion(mm, 'opinion-7 old (固件 v2.3)', 0.7);
  const newId = await createOpinion(mm, 'opinion-7 new (固件 v2.4)', 0.5);
  const ok = await hardSupersedeOpinion(mm, oldId, newId);
  assert.equal(ok, true);
  const old = await mm.getById(oldId);
  const oldMeta = parseOpinionMeta(old.topic);
  assert.equal(oldMeta.supersededBy, newId, '旧 Opinion 标 supersededBy');

  // 硬作废后不再演化(拒)
  const m = await evolveOpinion(mm, oldId, 'support', 0.2);
  assert.equal(m, null, '硬作废 Opinion 拒演化(返回 null)');
}
console.log('✓ 硬作废: supersededBy + 拒演化(软演化 freshness vs 硬作废 supersedes 区分)');

// ─── 8. 非 Opinion 条目拒演化 ────────────────────────────────────────────────
{
  const worldId = await mm.add('a world truth here', 'memory', undefined, { trust: 'world' });
  const m = await evolveOpinion(mm, worldId, 'support', 0.1);
  assert.equal(m, null, 'world 条目拒演化(D5 可信根不动)');
}
console.log('✓ 非 Opinion 条目拒演化(world 不动)');

await fs.rm(tmp, { recursive: true, force: true });
console.log('\n✅ opinion-evolver T2.3 全部通过(8/8)');
