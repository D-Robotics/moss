#!/usr/bin/env node
/**
 * Memory search — keyword retrieval, pinned boost, query variants.
 * Tests the BM25-based search path and the pure query-variant builder.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MemoryManager,
  buildMemorySearchQueryVariants,
} from '../dist/memory/index.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-test-'));
}

// ─── 1. Basic keyword search ────────────────────────────────────────────────

{
  const dir = await makeTempDir();
  const mm = new MemoryManager(dir);
  await mm.load();

  await mm.add('RDK X5 board uses Ubuntu 22.04 as operating system');
  await mm.add('User prefers Python over C++ for quick prototyping');
  await mm.add('GPIO pin 18 is configured as output for LED control');

  const results = await mm.search('RDK board operating system', 5);
  assert.ok(results.length > 0, 'search returns results');
  assert.ok(
    results[0].entry.content.includes('RDK X5'),
    'top result matches RDK board content'
  );
  assert.ok(results[0].score > 0, 'result has positive score');
  assert.ok(results[0].snippet.length > 0, 'result has a snippet');

  // No match
  const empty = await mm.search('quantumphysics', 5);
  assert.equal(empty.length, 0, 'no results for unrelated query');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 2. Pinned entries get score boost ──────────────────────────────────────

{
  const dir = await makeTempDir();
  const mm = new MemoryManager(dir);
  await mm.load();

  // Both entries contain the same keyword; one is pinned
  await mm.add('Device IP address is 192.168.1.10 for SSH access', 'memory', undefined, {
    pinned: false,
  });
  await mm.add('Device IP address is 192.168.1.10 for SSH access (pinned)', 'memory', undefined, {
    pinned: true,
  });

  const results = await mm.search('device IP address', 5);
  assert.ok(results.length >= 2, 'both entries found');

  // The pinned entry should have a higher score (×1.15 boost)
  const pinnedResult = results.find((r) => r.entry.pinned);
  const unpinnedResult = results.find((r) => !r.entry.pinned);
  assert.ok(pinnedResult, 'pinned entry in results');
  assert.ok(unpinnedResult, 'unpinned entry in results');
  assert.ok(
    pinnedResult.score >= unpinnedResult.score,
    'pinned entry scores >= unpinned'
  );
  // The boost is ×1.15, so the pinned score should be strictly higher
  // (unless they have identical content scores, which they don't due to different text)
  assert.ok(
    pinnedResult.score > unpinnedResult.score,
    'pinned entry scores strictly higher'
  );

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 3. Search respects limit ───────────────────────────────────────────────

{
  const dir = await makeTempDir();
  const mm = new MemoryManager(dir);
  await mm.load();

  for (let i = 0; i < 5; i++) {
    await mm.add(`Board configuration note number ${i} with GPIO settings`);
  }

  const limited = await mm.search('Board GPIO', 2);
  assert.ok(limited.length <= 2, 'search respects limit parameter');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 4. buildMemorySearchQueryVariants — recall/preference queries ───────────

{
  // Plain query — no recall/device keywords, just the trimmed original
  const plain = buildMemorySearchQueryVariants('install python package with pip');
  assert.equal(plain.length, 1, 'plain query → single variant');
  assert.equal(plain[0], 'install python package with pip');

  // Preference/recall query in English — adds anchor variants
  const prefEn = buildMemorySearchQueryVariants('what is my preference for response style');
  assert.ok(prefEn.length > 1, 'preference query → multiple variants');
  assert.ok(
    prefEn.some((v) => v.includes('preference')),
    'includes recall anchor with preference keyword'
  );

  // Preference/recall query in Chinese — adds CN + EN anchors
  const prefCn = buildMemorySearchQueryVariants('用户偏好什么回答方式');
  assert.ok(prefCn.length > 1, 'Chinese preference query → multiple variants');
  assert.ok(
    prefCn.some((v) => v.includes('偏好')),
    'includes Chinese recall anchor'
  );
  assert.ok(
    prefCn.some((v) => v.includes('preference')),
    'includes English recall anchor for CN query'
  );
}

// ─── 5. buildMemorySearchQueryVariants — device/project queries ──────────────

{
  const devCn = buildMemorySearchQueryVariants('这个板子的型号是什么');
  assert.ok(devCn.length > 1, 'Chinese device query → multiple variants');
  assert.ok(
    devCn.some((v) => v.includes('设备')),
    'includes Chinese device anchor'
  );
  assert.ok(
    devCn.some((v) => v.includes('device')),
    'includes English device anchor for CN query'
  );

  // Empty query → empty variants
  const empty = buildMemorySearchQueryVariants('');
  assert.equal(empty.length, 0, 'empty query → no variants');
}

console.log('✓ memory-search.spec.mjs — all assertions passed');
