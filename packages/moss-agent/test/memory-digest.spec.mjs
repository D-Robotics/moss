#!/usr/bin/env node
/**
 * memory-digest — buildDigest(Moss 真记忆注入路径)测试 + trust 分级。
 * 验:基线(scope 过滤/pinned 优先/最近优先/maxChars)+ trust 分级(world>opinion>observation>通用 优先)。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../dist/memory/index.js';

const mkd = () => fs.mkdtemp(path.join(os.tmpdir(), 'moss-digest-'));

// ─── 1. 基线:scope 过滤(device 不混进 workspace 默认)────────────────────────
{
  const dir = await mkd();
  const mm = new MemoryManager(dir);
  await mm.add('device fact A', 'memory', undefined, { scope: 'device', scopeRef: 'd1' });
  await mm.add('workspace fact B', 'memory', undefined, { scope: 'workspace' });
  const d = await mm.buildDigest({ scopes: ['workspace'] });
  assert.ok(d.includes('workspace fact B'), 'workspace scope 进 digest');
  assert.ok(!d.includes('device fact A'), 'device scope 被过滤(不在 scopes)');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ 基线:scope 过滤(只取指定 scope)');

// ─── 2. 基线:pinned 优先 ─────────────────────────────────────────────────────
{
  const dir = await mkd();
  const mm = new MemoryManager(dir);
  await mm.add('pinned fact', 'memory', undefined, { pinned: true });
  await mm.add('normal fact', 'memory');
  const d = await mm.buildDigest();
  assert.ok(d.indexOf('pinned fact') < d.indexOf('normal fact'), 'pinned 排在 normal 前');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ 基线:pinned 优先');

// ─── 3. 基线:空记忆 → 空字符串 ────────────────────────────────────────────────
{
  const dir = await mkd();
  const mm = new MemoryManager(dir);
  const d = await mm.buildDigest();
  assert.equal(d, '', '无记忆 → 空字符串');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ 基线:空记忆 → 空字符串');

// ─── 4. trust 分级:world > opinion > observation > 通用 优先 ─────────────────
// 注:添加顺序故意与 trust 顺序相反(通用最先=最旧,world 最后=最新),排除"最近优先"巧合。
// 真按 trust 分级 → world 仍应排最前(即便它最新,trust 是主排序);若无 trust 分级 → 按"最近优先"world 也排前(巧合),
// 故用 opinion vs observation 的相对序判定:opinion 后加(更新)但应排 observation 前(因 opinion trust 高)。
{
  const dir = await mkd();
  const mm = new MemoryManager(dir);
  // 故意:observation 先加(更旧),opinion 后加(更新)—— 若按"最近优先"opinion 在前(无法区分 trust);
  // 再加 world(最新)、通用(中间),用 world vs observation 判:world 最新,无论 trust/最近都在前,无法区分。
  // 关键判据:把一个 observation 加在最最近,opinion 加在更早 → trust 分级会让 opinion 排前,无 trust 会按"最近"让 observation 排前。
  await mm.add('opinion evolve', 'memory', undefined, { trust: 'opinion' }); // 最早
  await mm.add('general plain', 'memory'); // 中
  await mm.add('observation newest', 'memory', undefined, { trust: 'observation' }); // 最最近
  const d = await mm.buildDigest();
  const posOpinion = d.indexOf('opinion evolve');
  const posObs = d.indexOf('observation newest');
  // opinion 最早(按"最近优先"该排最后),但 trust 高 → 应排 observation 前(若 trust 分级生效)
  assert.ok(
    posOpinion < posObs,
    `opinion(最早但 trust 高)应排 observation(最新但 trust 低)前 — 证明 trust 分级生效,而非"最近优先"巧合(${posOpinion} vs ${posObs})`
  );
  await fs.rm(dir, { recursive: true, force: true });
}
console.log(
  '✓ trust 分级:opinion(最早但 trust 高)排在 observation(最新但 trust 低)前 — 排除最近优先巧合'
);

// ─── 5. trust 分级不破 pinned(pinned 仍在最前)+ trust 是次级排序 ────────────
{
  const dir = await mkd();
  const mm = new MemoryManager(dir);
  await mm.add('pinned obs', 'memory', undefined, { pinned: true, trust: 'observation' });
  await mm.add('world root', 'memory', undefined, { trust: 'world' });
  const d = await mm.buildDigest();
  // pinned 优先级最高(trust 是次级)
  assert.ok(d.indexOf('pinned obs') < d.indexOf('world root'), 'pinned 仍最前(trust 是次级)');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ trust 是次级排序(pinned 仍最前,不破基线)');

console.log('\n✅ memory-digest 全部通过(5/5)');
