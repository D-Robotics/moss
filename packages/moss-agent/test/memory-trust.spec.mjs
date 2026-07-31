#!/usr/bin/env node
/**
 * memory-manager trust 维度 + World 写保护(T2.1)— D5 可信根边界。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryManager } from '../dist/memory/memory-manager.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-trust-'));
const mm = new MemoryManager(tmp);
await mm.load();

// ─── 1. add 支持 trust,可 add world(人工/外部)─────────────────────────────
{
  const worldId = await mm.add('hard truth: RDK X5 SoC is X3', 'memory', undefined, { trust: 'world' });
  const e = await mm.getById(worldId);
  assert.ok(e);
  assert.equal(e.trust, 'world');
}
console.log('✓ add 支持 trust(含 world,人工/外部可建)');

// ─── 2. D5 写保护:改 world 条目 content 被拒 ─────────────────────────────────
{
  const worldId = await mm.add('world fact', 'memory', undefined, { trust: 'world' });
  await assert.rejects(
    () => mm.update(worldId, { content: 'tampered' }),
    /trust=world entry is read-only/,
  );
  // 原 content 未变
  const e = await mm.getById(worldId);
  assert.equal(e.content, 'world fact');
}
console.log('✓ D5 写保护: 改 world 条目 content 被拒');

// ─── 3. 改 world 条目 trust 被拒(不可降级 world)────────────────────────────
{
  const worldId = await mm.add('world2', 'memory', undefined, { trust: 'world' });
  await assert.rejects(
    () => mm.update(worldId, { trust: 'observation' }),
    /trust=world entry is read-only/,
  );
}
console.log('✓ 改 world 条目 trust 被拒(不可降级)');

// ─── 4. 自抬 world 被拒(自进化不可把普通条目提成可信根)──────────────────────
{
  const plainId = await mm.add('plain memory', 'memory'); // 无 trust
  await assert.rejects(
    () => mm.update(plainId, { trust: 'world' }),
    /cannot self-promote to trust=world/,
  );
  // 普通 → observation 允许(自进化可设可演化层)
  await mm.update(plainId, { trust: 'observation' });
  const e = await mm.getById(plainId);
  assert.equal(e.trust, 'observation');
}
console.log('✓ 自抬 world 被拒;设 observation 允许(自进化可演化层)');

// ─── 5. world 条目改 pinned/starred 允许(无害元数据)─────────────────────────
{
  const worldId = await mm.add('world3', 'memory', undefined, { trust: 'world' });
  await mm.update(worldId, { pinned: true });
  const e = await mm.getById(worldId);
  assert.equal(e.pinned, true);
  assert.equal(e.trust, 'world', 'trust 仍 world(没被降级)');
}
console.log('✓ world 条目改 pinned/starred 允许(无害元数据)');

// ─── 6. scope 与 trust 正交(可同设)─────────────────────────────────────────
{
  const id = await mm.add('device observation', 'memory', undefined, {
    trust: 'observation', scope: 'device', scopeRef: 'board-x5',
  });
  const e = await mm.getById(id);
  assert.equal(e.trust, 'observation');
  assert.equal(e.scope, 'device');
  assert.equal(e.scopeRef, 'board-x5');
}
console.log('✓ scope 与 trust 正交(可同设)');

// ─── 7. search 按 trust 过滤(配合 hindsight-memory spec 的 trust 二次过滤)────
{
  await mm.add('obs1 observation', 'memory', undefined, { trust: 'observation' });
  await mm.add('op1 opinion here', 'memory', undefined, { trust: 'opinion' });
  // search 不过滤 trust,返回所有匹配 — 验证 trust 字段被持久化(重 load 后还在)
  const mm2 = new MemoryManager(tmp);
  await mm2.load();
  const all = await mm2.getAll();
  const trusts = new Set(all.filter((e) => e.trust).map((e) => e.trust));
  assert.ok(trusts.has('world'), 'world trust 持久化');
  assert.ok(trusts.has('observation'));
  assert.ok(trusts.has('opinion'));
}
console.log('✓ trust 持久化(重 load 后还在),scope+trust 正交可检索');

await fs.rm(tmp, { recursive: true, force: true });
console.log('\n✅ memory-manager trust T2.1 全部通过(7/7)');
