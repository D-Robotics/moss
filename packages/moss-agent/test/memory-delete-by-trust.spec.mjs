#!/usr/bin/env node
/**
 * memory-delete-by-trust — MemoryManager 按 trust 删除接口(T2.2 已知限制修复)。
 * 验:按 trust 删、可选 scope/scopeRef/topicPrefix 精筛、不误删别的 trust、空集 no-op。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../dist/memory/index.js';

const mkd = () => fs.mkdtemp(path.join(os.tmpdir(), 'moss-deltrust-'));

// ─── 1. deleteByTrust:删所有该 trust 条目 ────────────────────────────────────
{
  const dir = await mkd();
  const mm = new MemoryManager(dir);
  await mm.add('observation A about rdk-device', 'memory', undefined, { trust: 'observation', topic: 'proofCount=5' });
  await mm.add('opinion B about policy', 'memory', undefined, { trust: 'opinion' });
  await mm.add('plain general memory', 'memory'); // trust undefined = 通用
  assert.equal((await mm.getAll()).length, 3);
  const n = await mm.deleteByTrust('observation');
  assert.equal(n, 1, '删 1 条 observation');
  const all = await mm.getAll();
  assert.equal(all.length, 2, '剩 2 条');
  assert.ok(!all.some((e) => e.trust === 'observation'), 'observation 全删');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ deleteByTrust:删所有该 trust 条目,不误删别的 trust');

// ─── 2. scope 精筛:只删某 scope 的该 trust ───────────────────────────────────
{
  const dir = await mkd();
  const mm = new MemoryManager(dir);
  await mm.add('obs workspace', 'memory', undefined, { trust: 'observation', scope: 'workspace', topic: 'proofCount=3' });
  await mm.add('obs device', 'memory', undefined, { trust: 'observation', scope: 'device', scopeRef: 'd1', topic: 'proofCount=4' });
  const n = await mm.deleteByTrust('observation', { scope: 'device' });
  assert.equal(n, 1, '只删 device scope 的 observation');
  const all = await mm.getAll();
  assert.equal(all.length, 1, 'workspace 的 observation 保留');
  assert.equal(all[0].scope, 'workspace');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ deleteByTrust + scope 精筛:只删该 scope 的');

// ─── 3. topicPrefix 精筛:聚合器只删自己产的(proofCount= 开头)──────────────────
{
  const dir = await mkd();
  const mm = new MemoryManager(dir);
  await mm.add('aggregator obs', 'memory', undefined, { trust: 'observation', topic: 'proofCount=5' });
  await mm.add('user obs (no proofCount)', 'memory', undefined, { trust: 'observation', topic: 'manual' });
  const n = await mm.deleteByTrust('observation', { topicPrefix: 'proofCount=' });
  assert.equal(n, 1, '只删 topic 以 proofCount= 开头的(聚合器自产)');
  const all = await mm.getAll();
  assert.equal(all.length, 1, 'user 的 observation(topic=manual)保留');
  assert.equal(all[0].topic, 'manual');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ deleteByTrust + topicPrefix 精筛:聚合器只删自产条目,不误删用户 observation');

// ─── 4. 空集 no-op(无该 trust 条目→删 0)──────────────────────────────────────
{
  const dir = await mkd();
  const mm = new MemoryManager(dir);
  await mm.add('plain', 'memory');
  const n = await mm.deleteByTrust('observation');
  assert.equal(n, 0, '无 observation → 删 0');
  assert.equal((await mm.getAll()).length, 1, '原条目不动');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ deleteByTrust 空集 no-op');

console.log('\n✅ memory-delete-by-trust 全部通过(4/4)');
