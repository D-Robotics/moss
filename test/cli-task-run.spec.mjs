#!/usr/bin/env node
/**
 * Task OS M5 — CLI wiring: `moss task run/resume/status/timeline` drive the
 * same engine as every other interface, exit code 0 only on accepted, arg
 * tokenizer honors quoted --accept commands.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runTaskCommand, splitCommandArgs } from '../dist/cli/task-run.js';
import {
  createDraftTask,
  appendTaskEvent,
  getTaskStateSnapshot,
} from '../dist/core/task/task-store.js';
import { appendTaskRecord, appendEvidenceRecord } from '../dist/core/task-runtime/artifacts.js';

async function tmpWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-cli-task-'));
}

function captureStdout() {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

function scriptedAgent(workspaceRef, script) {
  let call = 0;
  return {
    chat: async (_sessionKey, prompt) => {
      const action = script[call] ?? (() => {});
      call += 1;
      await action(workspaceRef.ws);
      return { response: `turn ${call} done`, stopReason: 'end_turn' };
    },
  };
}

test('splitCommandArgs honors quoted segments', () => {
  assert.deepEqual(splitCommandArgs('run make it pass --accept "npm test && npm run check"'), [
    'run',
    'make',
    'it',
    'pass',
    '--accept',
    'npm test && npm run check',
  ]);
  assert.deepEqual(splitCommandArgs(''), []);
  assert.deepEqual(splitCommandArgs('status'), ['status']);
});

test('moss task run exits 0 only on acceptance, printing the real summary', async () => {
  const ws = await tmpWorkspace();
  const ref = { ws };
  let taskId;
  const agent = scriptedAgent(ref, [
    // planning: define contract
    async (dir) => {
      const { listTaskEvents } = await import('../dist/core/task/task-store.js');
      const events = await listTaskEvents(dir);
      taskId = events[0].taskId;
      await appendTaskRecord(dir, {
        taskId,
        goal: 'create marker file',
        acceptanceCriteria: [{ metric: 'file_content', expected: 'contains task-os-m5' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    // execution: record evidence
    async (dir) => {
      await appendEvidenceRecord(dir, {
        evidenceId: `ev_${Date.now()}`,
        taskId,
        source: 'exec',
        metric: 'file_content',
        expected: 'contains task-os-m5',
        observed: 'task-os-m5',
        result: 'pass',
        timestamp: Date.now(),
      });
    },
  ]);
  const out = captureStdout();
  try {
    const code = await runTaskCommand(['run', 'create marker file'], {
      agent,
      workspace: ws,
      sessionKey: 'cli-task-test',
    });
    assert.equal(code, 0);
  } finally {
    out.restore();
  }
  const text = out.text();
  assert.match(text, /— PASS/);
  assert.match(text, /phase: accepted/);
  assert.match(text, /Timeline \(tail\):/);
  const snapshot = await getTaskStateSnapshot(ws, taskId);
  assert.equal(snapshot.phase, 'accepted');
});

test('moss task run exits 1 on honest failure', async () => {
  const ws = await tmpWorkspace();
  const ref = { ws };
  const agent = scriptedAgent(ref, [
    async (dir) => {
      const { listTaskEvents } = await import('../dist/core/task/task-store.js');
      const events = await listTaskEvents(dir);
      await appendTaskRecord(dir, {
        taskId: events[0].taskId,
        goal: 'unsatisfiable',
        acceptanceCriteria: [{ metric: 'x', expected: '>=1' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    () => {},
    () => {},
  ]);
  const code = await runTaskCommand(['run', 'unsatisfiable', '--max-repairs', '0'], {
    agent,
    workspace: ws,
    sessionKey: 'cli-task-test',
  });
  assert.equal(code, 1);
});

test('moss task run without a goal exits 2 with usage', async () => {
  const ws = await tmpWorkspace();
  const code = await runTaskCommand(['run'], {
    agent: { chat: async () => ({ response: 'never' }) },
    workspace: ws,
    sessionKey: 'cli-task-test',
  });
  assert.equal(code, 2);
});

test('moss task status renders the snapshot view', async () => {
  const ws = await tmpWorkspace();
  const { taskId } = await createDraftTask(ws, 'rendered goal');
  await appendTaskEvent(ws, taskId, 'execution_started');
  const out = captureStdout();
  try {
    const code = await runTaskCommand(['status', taskId], {
      agent: {},
      workspace: ws,
      sessionKey: 'x',
    });
    assert.equal(code, 0);
  } finally {
    out.restore();
  }
  const text = out.text();
  assert.match(text, /TASK {6}task_/);
  assert.match(text, /GOAL {6}rendered goal/);
  assert.match(text, /PHASE {5}executing \(executing\)/);
  assert.match(text, /TIMELINE/);
  assert.match(text, /Execution started/);
});

test('moss task unknown subcommand exits 2', async () => {
  const ws = await tmpWorkspace();
  const code = await runTaskCommand(['bogus'], {
    agent: {},
    workspace: ws,
    sessionKey: 'x',
  });
  assert.equal(code, 2);
});
