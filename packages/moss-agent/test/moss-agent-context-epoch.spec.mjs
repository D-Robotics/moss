#!/usr/bin/env node
/**
 * MossAgent system-context epoch: a session keeps one immutable baseline and emits
 * an update message only when a source changes; the epoch persists across instances.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MossAgent } from '../dist/core/index.js';

const makeAgent = (workspaceDir) => Object.assign(Object.create(MossAgent.prototype), { config: { workspaceDir } });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-epoch-'));
try {
  const a1 = makeAgent(tmp);

  // First reconcile initializes the epoch: baseline returned, no update.
  const first = a1.reconcileSessionContext('work', { cwd: '/w', date: '2026-06-24' });
  assert.equal(first.baseline, 'cwd: /w\ndate: 2026-06-24');
  assert.equal(first.update, undefined);
  assert.ok(fs.existsSync(path.join(tmp, '.moss', 'context-epoch')), 'epoch persisted');

  // Unchanged sources -> no update.
  assert.equal(a1.reconcileSessionContext('work', { cwd: '/w', date: '2026-06-24' }).update, undefined);

  // A changed source on a FRESH instance -> one update; baseline stays immutable.
  const a2 = makeAgent(tmp);
  const changed = a2.reconcileSessionContext('work', { cwd: '/w', date: '2026-06-25' });
  assert.equal(changed.baseline, 'cwd: /w\ndate: 2026-06-24', 'baseline immutable across instances');
  assert.match(changed.update, /date is now: 2026-06-25/);

  // The advanced snapshot persisted: reconciling the new value again is now a no-op.
  assert.equal(makeAgent(tmp).reconcileSessionContext('work', { cwd: '/w', date: '2026-06-25' }).update, undefined);

  // No workspace -> in-memory, always initializes (no persistence).
  const mem = makeAgent(undefined);
  assert.equal(mem.reconcileSessionContext('s', { a: '1' }).update, undefined);
  assert.equal(mem.reconcileSessionContext('s', { a: '2' }).update, undefined, 'no persisted snapshot to diff against');

  console.log('[PASS] MossAgent context epoch: immutable baseline + persisted incremental reconciliation');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
