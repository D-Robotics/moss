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

import {
  formatTaskStatus,
  interactiveTaskUsageLines,
  quoteCommandArg,
  runTaskCommand,
  splitCommandArgs,
} from '../dist/cli/task-run.js';
import { goalRunArgs } from '../dist/cli/commands/goal-propose.js';
import {
  createDraftTask,
  appendTaskEvent,
  getTaskStateSnapshot,
} from '../dist/core/task/task-store.js';
import { appendTaskRecord, appendEvidenceRecord } from '../dist/core/task-runtime/artifacts.js';

test('bare /task usage names verify and view', () => {
  const text = interactiveTaskUsageLines().join('\n');
  assert.match(text, /\/task verify \[id\]/);
  assert.match(text, /\/task view \[kind\]/);
  assert.match(text, /\/task run /);
  assert.match(text, /\/task resume \[id\]/);
  assert.match(text, /\/task status\|timeline \[id\]/);
});

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
  assert.deepEqual(splitCommandArgs('run "say \\"hi\\""'), ['run', 'say "hi"']);
});

test('goalRunArgs round-trips goals and acceptance commands that contain spaces and quotes', () => {
  const line = goalRunArgs('ship --accept the design', {
    acceptance: 'npm test && echo "ok"',
  });
  const args = splitCommandArgs(line);
  assert.equal(args[0], 'run');
  assert.equal(args[1], 'ship --accept the design');
  assert.equal(args[2], '--accept');
  assert.equal(args[3], 'npm test && echo "ok"');
  assert.equal(quoteCommandArg('npm'), 'npm');
});

test('a goal whose text is --accept stays the goal', async () => {
  assert.deepEqual(splitCommandArgs(goalRunArgs('--accept')), ['run', '--', '--accept']);
  assert.deepEqual(splitCommandArgs(goalRunArgs('--accept', { acceptance: 'true' })), [
    'run',
    '--accept',
    'true',
    '--',
    '--accept',
  ]);
  const ws = await tmpWorkspace();
  const chunks = [];
  const code = await runTaskCommand(splitCommandArgs(goalRunArgs('--accept')), {
    agent: {
      chat: async () => ({ response: 'noted', stopReason: 'end_turn' }),
    },
    workspace: ws,
    sessionKey: 'dashdash-goal',
    onOutput: (_stream, text) => chunks.push(text),
  });
  const text = chunks.join('\n');
  assert.notEqual(code, 2, text);
  assert.doesNotMatch(text, /a goal is required/);
  assert.match(text, /--accept/);
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

test('moss task run prints llm_usage when the agent reports tokens', async () => {
  const ws = await tmpWorkspace();
  const ref = { ws };
  let taskId;
  const agent = {
    async *streamChat() {
      const { listTaskEvents } = await import('../dist/core/task/task-store.js');
      const events = await listTaskEvents(ref.ws);
      if (!taskId) {
        taskId = events[0].taskId;
        await appendTaskRecord(ref.ws, {
          taskId,
          goal: 'create marker file',
          acceptanceCriteria: [{ metric: 'file_content', expected: 'contains task-os-m5' }],
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      } else {
        await appendEvidenceRecord(ref.ws, {
          evidenceId: `ev_${Date.now()}`,
          taskId,
          source: 'exec',
          metric: 'file_content',
          expected: 'contains task-os-m5',
          observed: 'task-os-m5',
          result: 'pass',
          timestamp: Date.now(),
        });
      }
      yield { type: 'llm_usage', inputTokens: 11, outputTokens: 7 };
      yield { type: 'done', result: { response: 'done', stopReason: 'end_turn' } };
    },
  };
  const out = captureStdout();
  try {
    const code = await runTaskCommand(['run', 'create marker file'], {
      agent,
      workspace: ws,
      sessionKey: 'cli-task-usage',
    });
    assert.equal(code, 0);
  } finally {
    out.restore();
  }
  const text = out.text();
  assert.match(text, /"type":"llm_usage"/);
  const input = /"input_tokens":(\d+)/.exec(text);
  const output = /"output_tokens":(\d+)/.exec(text);
  assert.ok(input && Number(input[1]) >= 11 && Number(input[1]) % 11 === 0);
  assert.ok(output && Number(output[1]) >= 7 && Number(output[1]) % 7 === 0);
});

test('moss task run passes the CLI locale into the summary (zh)', async () => {
  const ws = await tmpWorkspace();
  const ref = { ws };
  let taskId;
  const agent = scriptedAgent(ref, [
    async (dir) => {
      const { listTaskEvents } = await import('../dist/core/task/task-store.js');
      taskId = (await listTaskEvents(dir))[0].taskId;
      await appendTaskRecord(dir, {
        taskId,
        goal: '创建标记文件',
        acceptanceCriteria: [{ metric: 'file_content', expected: 'contains x' }],
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    },
    async (dir) => {
      await appendEvidenceRecord(dir, {
        evidenceId: `ev_${Date.now()}`,
        taskId,
        source: 'exec',
        metric: 'file_content',
        expected: 'contains x',
        observed: 'x',
        result: 'pass',
        timestamp: Date.now(),
      });
    },
  ]);
  const saved = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LC_MESSAGES: process.env.LC_MESSAGES,
  };
  const out = captureStdout();
  try {
    process.env.LANG = 'zh_CN.UTF-8';
    process.env.LC_ALL = 'zh_CN.UTF-8';
    delete process.env.LC_MESSAGES;
    const code = await runTaskCommand(['run', '创建标记文件'], {
      agent,
      workspace: ws,
      sessionKey: 'cli-task-zh',
    });
    assert.equal(code, 0);
  } finally {
    out.restore();
    if (saved.LANG === undefined) delete process.env.LANG;
    else process.env.LANG = saved.LANG;
    if (saved.LC_ALL === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = saved.LC_ALL;
    if (saved.LC_MESSAGES === undefined) delete process.env.LC_MESSAGES;
    else process.env.LC_MESSAGES = saved.LC_MESSAGES;
  }
  const text = out.text();
  assert.match(text, /任务 task_\S+ — PASS/, 'zh summary label + verbatim outcome token');
  assert.match(text, /目标：创建标记文件/);
  assert.match(text, /阶段：accepted/);
  assert.match(text, /时间线（末尾）：/);
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

test('moss task speaks the user locale (zh)', async () => {
  const ws = await tmpWorkspace();
  const savedLang = process.env.LANG;
  const savedLcAll = process.env.LC_ALL;
  const savedLcMsg = process.env.LC_MESSAGES;
  const capture = (stream) => {
    const chunks = [];
    return {
      onOutput: (s, text) => {
        if (s === stream) chunks.push(text);
      },
      text: () => chunks.join(''),
    };
  };
  try {
    process.env.LANG = 'zh_CN.UTF-8';
    process.env.LC_ALL = 'zh_CN.UTF-8';
    delete process.env.LC_MESSAGES;

    // error paths: missing goal, unknown subcommand — with zh usage
    const goalErr = capture('stderr');
    let code = await runTaskCommand(['run'], {
      agent: {},
      workspace: ws,
      sessionKey: 'x',
      onOutput: goalErr.onOutput,
    });
    assert.equal(code, 2);
    assert.ok(goalErr.text().includes('需要一个目标'), 'zh missing-goal error');
    assert.ok(goalErr.text().includes('用法：moss task'), 'zh usage block');

    const subErr = capture('stderr');
    code = await runTaskCommand(['bogus'], {
      agent: {},
      workspace: ws,
      sessionKey: 'x',
      onOutput: subErr.onOutput,
    });
    assert.equal(code, 2);
    assert.ok(subErr.text().includes('未知 task 子命令'), 'zh unknown-subcommand error');

    // empty state
    const emptyOut = capture('stdout');
    code = await runTaskCommand(['status'], {
      agent: {},
      workspace: ws,
      sessionKey: 'x',
      onOutput: emptyOut.onOutput,
    });
    assert.equal(code, 0);
    assert.ok(emptyOut.text().includes('本工作区尚无任务'), 'zh empty-status message');

    // status view: zh column labels against a real snapshot
    const { taskId } = await createDraftTask(ws, '渲染目标');
    await appendTaskEvent(ws, taskId, 'execution_started');
    const snapshot = await getTaskStateSnapshot(ws, taskId);
    const zhView = formatTaskStatus(snapshot, '');
    assert.match(zhView, /任务 {6}task_/);
    assert.match(zhView, /目标 {6}渲染目标/);
    assert.match(zhView, /阶段/);
    assert.match(zhView, /尝试/);
    const enView = formatTaskStatus(snapshot, '', false);
    assert.match(enView, /TASK {6}task_/, 'explicit en view keeps English labels');

    await appendTaskEvent(ws, taskId, 'task_failed', { detail: 'aborted' });
    const aborted = await getTaskStateSnapshot(ws, taskId);
    assert.equal(aborted?.outcome, 'aborted');
    assert.equal(aborted?.phase, 'failed');
    const abortedEn = formatTaskStatus(aborted, '', false);
    assert.match(abortedEn, /PHASE {5}aborted$/m);
    assert.doesNotMatch(abortedEn, /failed/);
    assert.doesNotMatch(abortedEn, /\/task resume/);
    const abortedZh = formatTaskStatus(aborted, '', true);
    assert.match(abortedZh, /阶段 {6}已中止/);
    assert.doesNotMatch(abortedZh, /failed/);
  } finally {
    if (savedLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = savedLcAll;
    if (savedLang === undefined) delete process.env.LANG;
    else process.env.LANG = savedLang;
    if (savedLcMsg === undefined) delete process.env.LC_MESSAGES;
    else process.env.LC_MESSAGES = savedLcMsg;
  }
});
