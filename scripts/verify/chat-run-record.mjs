#!/usr/bin/env node
/**
 * Headless chat run-record probe (offline, B134).
 *
 * `moss -p` is an autonomous run, so it writes the unified ledger record with
 * the completion-gate status (`completed / incomplete / verify_failed / blocked
 * / unverified`) and a next-step hint. Interactive REPL turns must not write
 * rows. This locks the mapping, the `next` hints and the ledger round-trip.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { buildChatRunRecord, nextStepForChatOutcome } = await load('dist/cli/chat-run-record.js');
const { writeRunRecord, listRunRecords, readRunRecord } = await load('dist/core/run-ledger.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[chat-run-record] ok ${name}`);
};

const base = {
  runId: 'chat_abc',
  status: 'completed',
  exitCode: 0,
  reason: 'honest finish',
  prompt: 'reply with OK',
  sessionKey: 'cli-20261106031000-abcdef',
  startedAt: 1_000,
  endedAt: 4_000,
};

// 1. A completed run: exit 0, no reason/next, session artifact.
{
  const record = buildChatRunRecord(base);
  assert.equal(record.kind, 'chat');
  assert.equal(record.status, 'completed');
  assert.equal(record.exitCode, 0);
  assert.equal(record.reason, undefined);
  assert.equal(record.next, undefined);
  assert.equal(record.durationMs, 3_000);
  assert.equal(record.sessionKey, base.sessionKey);
  assert.equal(record.artifacts.session, `.moss/sessions/${base.sessionKey}.jsonl`);
  ok('a completed headless run is completed with its session artifact and no hints');
}

// 2. Every non-completed outcome keeps its gate status and gets a next step.
for (const status of ['incomplete', 'verify_failed', 'blocked', 'unverified']) {
  const record = buildChatRunRecord({ ...base, status, exitCode: status === 'blocked' ? 9 : 1 });
  assert.equal(record.status, status, status);
  assert.ok(record.reason, `${status} must keep the gate reason`);
  assert.ok(record.next, `${status} must carry a next step`);
  assert.ok(nextStepForChatOutcome(status), `nextStepForChatOutcome(${status})`);
}
assert.equal(nextStepForChatOutcome('completed'), undefined);
assert.match(nextStepForChatOutcome('unverified'), /actually perform the check/);
assert.match(nextStepForChatOutcome('verify_failed'), /fix the failing verification/);
ok('non-completed outcomes keep the gate status, reason and an actionable next step');

// 3. Round-trip through the real ledger and CLI read path.
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-chat-run-'));
  const ws = path.join(tmp, 'ws');
  const configDir = path.join(tmp, 'config');
  await fs.mkdir(ws, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
  try {
    await writeRunRecord(ws, { ...buildChatRunRecord({ ...base, runId: 'chat_old' }) });
    await writeRunRecord(
      ws,
      buildChatRunRecord({
        ...base,
        runId: 'chat_new',
        status: 'unverified',
        exitCode: 9,
        startedAt: 9_000,
        endedAt: 10_000,
      })
    );
    const records = await listRunRecords(ws);
    assert.deepEqual(
      records.map((record) => [record.runId, record.kind, record.status]),
      [
        ['chat_new', 'chat', 'unverified'],
        ['chat_old', 'chat', 'completed'],
      ]
    );
    assert.equal((await readRunRecord(ws, 'chat_new'))?.exitCode, 9);

    const { captureProcess } = await load('scripts/verify/lib/proc.mjs');
    const listed = await captureProcess(
      process.execPath,
      [path.join(root, 'dist', 'cli.js'), 'runs', 'list', '--status', 'unverified', '--json'],
      {
        cwd: ws,
        env: {
          ...process.env,
          MOSS_CONFIG_DIR: configDir,
          MOSS_NO_RDK_DOCS: '1',
          MOSS_NO_TUI: '1',
          MOSS_LANG: 'en',
        },
        timeoutMs: 60_000,
      }
    );
    assert.equal(listed.status, 0, listed.stderr);
    const parsed = JSON.parse(listed.stdout);
    assert.equal(parsed.runs.length, 1);
    assert.equal(parsed.runs[0].kind, 'chat');
    assert.equal(parsed.runs[0].status, 'unverified');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  ok('chat records round-trip through .moss/runs and `moss runs --status unverified`');
}

console.log(`[chat-run-record] ${checks}/${checks} checks passed`);
