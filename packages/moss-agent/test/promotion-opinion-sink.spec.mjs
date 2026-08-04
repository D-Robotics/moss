#!/usr/bin/env node
/**
 * promotion-opinion-sink — 把升层决策沉淀为 trust=observation 的 Opinion。
 * 验:每决策一条 Opinion + trust=observation + 记录决策细节 + promotable 路径不死。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryManager } from '../dist/core/index.js';
import { createOpinionSink } from '../dist/acceptance/promotion-opinion-sink.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-sink-'));
const mm = new MemoryManager(tmp);
const sink = createOpinionSink({ memoryManager: mm });

const candidate = {
  id: 'term_rdk-device',
  targetSkill: 'rdk-device',
  provenance: { layer: 'L2', kind: 'explicit-proposal', source: 'terminal-hard-signal', proposalRef: 'terminal://rdk-device?proof=12&rate=0.92' },
};
// statistics passed but cross-signal failed (production outcome)
const decision = { promotable: false, reason: 'statistics pass, cross-signal not confirmed', statisticalPassed: true, crossSignalPassed: false };

await sink({ candidate, decision });

const all = await mm.getAll();
assert.equal(all.length, 1, 'one Opinion written');
const entry = all[0];
assert.equal(entry.trust, 'observation', 'trust=observation (evolvable, not world)');
assert.ok(entry.content.includes('rdk-device'));
assert.ok(entry.content.includes('statisticalPassed=true'));
assert.ok(entry.content.includes('crossSignalPassed=false'));
assert.ok(entry.content.includes('promotable=false'));

// a promotable decision also lands (path not dead) but still observation trust
await sink({ candidate, decision: { promotable: true, reason: 'both gates pass', statisticalPassed: true, crossSignalPassed: true } });
const all2 = await mm.getAll();
assert.ok(all2.length >= 2);
assert.ok(all2.some((e) => e.trust === 'observation' && e.content.includes('promotable')));

await fs.rm(tmp, { recursive: true, force: true });
console.log('✅ promotion-opinion-sink: one Opinion per decision, trust=observation, records decision detail');
