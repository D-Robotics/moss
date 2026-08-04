#!/usr/bin/env node
/**
 * memory-expire — expireStaleEntries 记忆过期清理测试(之前零覆盖)。
 * 验:soft-mark(超 maxAgeDays 标 stale)/ hard-delete(超 hardDeleteAfterDays 删)/ pinned 豁免 / 无 hardDeleteAfterDays 只标不删 / 新鲜不动。
 *
 * 注:本测试只验纯逻辑,不接运行时 —— 接线(多久跑/什么阈值)是设计决策,不在本切片拍。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../dist/memory/index.js';

const mkd = () => fs.mkdtemp(path.join(os.tmpdir(), 'moss-expire-'));
const DAY = 24 * 60 * 60 * 1000;

// helper:把某条目的 accessedAt 拨到 N 天前,并清 stale,再 save
async function ageEntry(mm, contentMatch, daysAgo) {
  const all = await mm.getAll(); // live reference (getAll returns this.entries)
  const ent = all.find((e) => e.content === contentMatch);
  ent.accessedAt = Date.now() - daysAgo * DAY;
  ent.stale = false;
  await mm.save();
}

// ─── 1. soft-mark:超 maxAgeDays 未访问 → 标 stale,不删 ────────────────────────
{
  const dir = await mkd();
  const mm = new MemoryManager(dir);
  await mm.add('old fact', 'memory');
  await ageEntry(mm, 'old fact', 30);
  const n = await mm.expireStaleEntries(10);
  assert.equal(n, 1, '标 stale 1 条');
  const after = (await mm.getAll()).find((e) => e.content === 'old fact');
  assert.equal(after.stale, true, '被标 stale');
  assert.ok(after, 'soft-mark 不删,条目仍在');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ soft-mark:超 maxAgeDays 未访问 → 标 stale,条目不删');

// ─── 2. hard-delete:超 hardDeleteAfterDays → 硬删 ─────────────────────────────
{
  const dir = await mkd();
  const mm = new MemoryManager(dir);
  await mm.add('very old', 'memory');
  await ageEntry(mm, 'very old', 100);
  const before = (await mm.getAll()).length;
  const n = await mm.expireStaleEntries(10, 50); // hardDeleteAfterDays=50,100>50 → 硬删
  assert.equal(n, 1, '硬删 1 条');
  assert.equal((await mm.getAll()).length, before - 1, '条目被删');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ hard-delete:超 hardDeleteAfterDays → 硬删');

// ─── 3. pinned 豁免:pinned 条目超龄也不标/不删 ───────────────────────────────
{
  const dir = await mkd();
  const mm = new MemoryManager(dir);
  await mm.add('pinned old', 'memory', undefined, { pinned: true });
  await ageEntry(mm, 'pinned old', 100);
  const n = await mm.expireStaleEntries(10, 50);
  assert.equal(n, 0, 'pinned 豁免,不动');
  const after = (await mm.getAll())[0];
  assert.equal(after.pinned, true);
  assert.notEqual(after.stale, true, 'pinned 不被标 stale');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ pinned 豁免:超龄 pinned 条目不标 stale 不删');

// ─── 4. 无 hardDeleteAfterDays:只 soft-mark,绝不硬删 ─────────────────────────
{
  const dir = await mkd();
  const mm = new MemoryManager(dir);
  await mm.add('old but no hard cutoff', 'memory');
  await ageEntry(mm, 'old but no hard cutoff', 200);
  const n = await mm.expireStaleEntries(10); // 不传 hardDeleteAfterDays
  assert.equal(n, 1, '标 stale 1');
  assert.ok((await mm.getAll()).some((e) => e.content === 'old but no hard cutoff'), '无 hard cutoff → 只标不删,条目仍在');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ 无 hardDeleteAfterDays:只 soft-mark,绝不硬删(保守)');

// ─── 5. 最近访问的不动 ────────────────────────────────────────────────────────
{
  const dir = await mkd();
  const mm = new MemoryManager(dir);
  await mm.add('fresh fact', 'memory'); // createdAt = now
  const n = await mm.expireStaleEntries(10);
  assert.equal(n, 0, '新条目不动');
  const e = (await mm.getAll())[0];
  assert.notEqual(e.stale, true, '新鲜条目不标 stale');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ 最近访问的不动(在 maxAgeDays 内)');

console.log('\n✅ memory-expire 全部通过(5/5)');
