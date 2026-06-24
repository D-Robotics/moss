#!/usr/bin/env node
/**
 * Durable session events: append-only log with gap-free per-aggregate sequencing,
 * cursor replay, and JSONL persistence (append + reload, corrupt-line tolerant).
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionEventLog, SessionEventSequenceError } from '../dist/core/session/session-event.js';
import {
  appendSessionEvent,
  loadSessionEventLog,
  writeSessionEventLog,
} from '../dist/core/session/session-event-store.js';

// --- append assigns gap-free 1-based sequences scoped to the aggregate ---
const log = new SessionEventLog('ses-1');
const e1 = log.append({ type: 'prompt.admitted', data: { prompt: 'hi' } });
const e2 = log.append({ type: 'step.started', data: { model: 'm' } });
const e3 = log.append({ type: 'step.ended', data: { tokens: 10 } });
assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 3]);
assert.equal(e1.aggregateId, 'ses-1');
assert.equal(e1.version, 1, 'default schema version is 1');
assert.equal(log.latestSeq(), 3);

// --- cursor replay returns only events after a sequence ---
assert.deepEqual(log.all(1).map((e) => e.type), ['step.started', 'step.ended']);
assert.equal(log.all().length, 3);

// --- a gap / foreign aggregate is rejected on rebuild ---
assert.throws(
  () => SessionEventLog.fromEvents('ses-1', [{ ...e1, seq: 2 }]),
  SessionEventSequenceError,
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-events-'));
try {
  const file = path.join(tmp, 'nested', 'ses-1.events.jsonl');
  // Missing file -> empty log.
  assert.equal(loadSessionEventLog('ses-1', file).latestSeq(), 0);

  // Append-only persistence round-trips and replays in order.
  for (const e of log.toEvents()) appendSessionEvent(file, e);
  const reloaded = loadSessionEventLog('ses-1', file);
  assert.equal(reloaded.latestSeq(), 3);
  assert.deepEqual(reloaded.all().map((e) => e.type), ['prompt.admitted', 'step.started', 'step.ended']);

  // A corrupt/partial trailing line is skipped, not fatal.
  fs.appendFileSync(file, '{ partial json');
  assert.equal(loadSessionEventLog('ses-1', file).latestSeq(), 3);

  // writeSessionEventLog rewrites the whole log atomically.
  log.append({ type: 'compaction.ended', data: { summary: 's' } });
  writeSessionEventLog(file, log);
  assert.equal(loadSessionEventLog('ses-1', file).latestSeq(), 4);

  console.log('[PASS] session events: append-only log + sequencing + JSONL persistence');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
