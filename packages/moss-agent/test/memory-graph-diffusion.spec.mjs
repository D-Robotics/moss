#!/usr/bin/env node
/**
 * memory-graph-diffusion — T2.4 图扩散召回通道(topic 邻居 merge 进 RRF)。
 * 验:同 topic 兄弟被拉入;已在结果里的不双计;无 topic 无扩散;不同 topic 不互扩。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../dist/memory/index.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-graphdiff-'));
}

// ─── 1. 同 topic 兄弟被图扩散拉入(即使不匹配查询)──────────────────────────────
{
  const dir = await makeTempDir();
  const mm = new MemoryManager(dir);
  await mm.load();
  // seed:匹配 "yolov5 部署"(含 deploy 词)
  await mm.add('yolov5 deploy steps on RDK X5 BPU', 'memory', undefined, { topic: 'deploy' });
  // sibling:同 topic 'deploy' 但不含查询词,纯靠图扩散应被拉入
  await mm.add('quantize mobilenet then flash the firmware', 'memory', undefined, {
    topic: 'deploy',
  });
  // 干扰项:不同 topic
  await mm.add('GPIO pin setup for LED blink', 'memory', undefined, { topic: 'gpio' });

  const results = await mm.search('yolov5 deploy', 10);
  const ids = results.map((r) => r.entry.content);
  assert.ok(
    ids.some((c) => c.includes('yolov5')),
    'seed 在结果'
  );
  assert.ok(
    ids.some((c) => c.includes('quantize mobilenet')),
    '★ 同 topic 兄弟(quantize/flash,不匹配查询)被图扩散拉入(T2.4)'
  );
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ 同 topic 兄弟被图扩散拉入(即使不匹配查询)');

// ─── 2. 无 topic 的 seed → 不扩散(无图边)─────────────────────────────────────
{
  const dir = await makeTempDir();
  const mm = new MemoryManager(dir);
  await mm.load();
  await mm.add('yolov5 deploy on BPU', 'memory'); // 无 topic
  await mm.add('unrelated quantize steps', 'memory'); // 无 topic
  const results = await mm.search('yolov5 deploy', 10);
  const ids = results.map((r) => r.entry.content);
  assert.ok(!ids.some((c) => c.includes('unrelated quantize')), '无 topic 不扩散,兄弟不被拉入');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ 无 topic 的 seed 不扩散');

// ─── 3. 不同 topic 不互扩─────────────────────────────────────────────────────
{
  const dir = await makeTempDir();
  const mm = new MemoryManager(dir);
  await mm.load();
  await mm.add('yolov5 deploy on BPU', 'memory', undefined, { topic: 'deploy' });
  await mm.add('GPIO blink led', 'memory', undefined, { topic: 'gpio' });
  const results = await mm.search('yolov5 deploy', 10);
  const ids = results.map((r) => r.entry.content);
  assert.ok(!ids.some((c) => c.includes('GPIO blink')), '不同 topic 不互扩');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ 不同 topic 不互扩');

// ─── 4. 已在结果里的兄弟不双计(seed 自身不重复)────────────────────────────────
{
  const dir = await makeTempDir();
  const mm = new MemoryManager(dir);
  await mm.load();
  await mm.add('yolov5 deploy BPU', 'memory', undefined, { topic: 'deploy' });
  await mm.add('yolov5 deploy BPU', 'memory', undefined, { topic: 'deploy' }); // 同 content 同 topic(hash 去重)
  const results = await mm.search('yolov5 deploy', 10);
  // 不应因图扩散把同条目重复列出
  const ids = results.map((r) => r.entry.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, '无重复条目(去重,不双计)');
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('✓ 已在结果里的兄弟不双计');

console.log('\n✅ memory-graph-diffusion T2.4 全部通过(4/4)');
