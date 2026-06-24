#!/usr/bin/env node
/**
 * Durable inbox persistence: save/load round-trips pending admission state and
 * resumes sequence counters; missing/corrupt files degrade to an empty inbox.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionInbox } from '../dist/core/session/session-inbox.js';
import { loadSessionInbox, saveSessionInbox } from '../dist/core/session/session-inbox-store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-inbox-'));
try {
  const file = path.join(tmp, 'nested', 'session.inbox.json');

  // Missing file -> empty inbox (no throw).
  assert.equal(loadSessionInbox(file).hasPendingWork(), false);

  // Round-trip: pending survives, promoted entries stay promoted, counters resume.
  const inbox = new SessionInbox();
  inbox.admit({ id: 'q1', prompt: 'queued', delivery: 'queue' });
  inbox.admit({ id: 's1', prompt: 'steer', delivery: 'steer' });
  inbox.promote('s1');
  saveSessionInbox(file, inbox);
  assert.ok(fs.existsSync(file), 'inbox file written (dirs created)');

  const restored = loadSessionInbox(file);
  assert.equal(restored.hasPendingWork(), true);
  assert.equal(restored.nextQueued().id, 'q1', 'pending queued entry restored');
  assert.equal(restored.admit({ prompt: 'new' }).admittedSeq, 3, 'admission seq resumes after load');

  // Corrupt file -> empty inbox (no throw).
  fs.writeFileSync(file, 'not json{');
  assert.equal(loadSessionInbox(file).hasPendingWork(), false);

  console.log('[PASS] session-inbox-store: durable save/load round-trip + safe degradation');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
