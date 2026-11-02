#!/usr/bin/env node
/**
 * Task OS §14 — sub-agents share the live task context: spawned prompts carry
 * the goal/plan/acceptance brief (prepended, not replacing the task), and
 * stay untouched when no live task exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSubagentTool, fanOutSubagentsTool } from '../dist/tools/create-subagent.js';
import { createDraftTask, appendTaskEvent } from '../dist/core/task/task-store.js';
import { createSubAgentRunner } from '../dist/core/subagent/subagent-runner.js';
import { runProcess } from '../dist/utils/run-process.js';
import { MossAgent, InMemorySessionStore } from '../dist/index.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';
import { toolSearchTool } from '../dist/tools/tool-search.js';

function makeCtx(ws, capture) {
  return {
    workspaceDir: ws,
    sessionKey: 'ctx-test',
    spawnSubagent: async (req) => {
      capture(req);
      return {
        runId: 'r-ctx',
        summary: 'looked around',
        success: true,
        turns: 1,
        toolResults: 1,
        durationMs: 4,
      };
    },
  };
}

test('spawned sub-agent prompt carries the live task brief', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ctx-'));
  const contract = await createDraftTask(ws, '优化 RDK 摄像头 FPS 到 30');
  await appendTaskEvent(ws, contract.taskId, 'plan_ready', {
    steps: [
      { stepId: 's1', title: 'Inspect pipeline', status: 'done' },
      { stepId: 's2', title: 'Tune config', status: 'in_progress' },
    ],
  });
  await appendTaskEvent(ws, contract.taskId, 'execution_started');

  let captured;
  const ctx = makeCtx(ws, (req) => {
    captured = req.task;
  });
  const result = await createSubagentTool.execute(
    { task: 'find the camera pipeline config', scope: 'read-only' },
    ctx
  );
  assert.match(result, /SUCCESS/);
  assert.match(captured, /\[Task context you are part of\]/);
  assert.match(captured, /goal: 优化 RDK 摄像头 FPS 到 30/);
  assert.match(captured, /plan: xInspect pipeline \| >Tune config/);
  assert.match(captured, /task_id: task_/);
  assert.match(captured, /---\n\nfind the camera pipeline config/);
  await fs.rm(ws, { recursive: true, force: true });
});

test('current task is used for same-workspace children and omitted from isolated children', async (t) => {
  const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ctx-owned-')));
  t.after(() => fs.rm(ws, { recursive: true, force: true }));
  const taskA = await createDraftTask(ws, 'goal A');
  await createDraftTask(ws, 'newer goal B');
  const captured = [];
  const ctx = { ...makeCtx(ws, (req) => captured.push(req)), taskId: taskA.taskId };
  await createSubagentTool.execute({ task: 'shared job', scope: 'read-only' }, ctx);
  await createSubagentTool.execute(
    { task: 'isolated job', scope: 'read-only', worktree: true },
    ctx
  );
  await createSubagentTool.execute(
    { task: 'missing job', scope: 'read-only' },
    { ...ctx, taskId: 'missing-task' }
  );
  assert.match(captured[0].task, /goal: goal A/);
  assert.match(captured[0].task, new RegExp(`task_id: ${taskA.taskId}`));
  assert.doesNotMatch(captured[0].task, /goal B/);
  assert.equal(captured[1].task, 'isolated job');
  assert.equal(captured[2].task, 'missing job');

  captured.length = 0;
  await fanOutSubagentsTool.execute(
    {
      tasks: [
        { task: 'shared fanout', scope: 'read-only' },
        { task: 'isolated fanout', scope: 'read-only', worktree: true },
      ],
    },
    ctx
  );
  assert.match(captured[0].task, /goal: goal A/);
  assert.equal(captured[1].task, 'isolated fanout');
});

test('child tools inherit task identity only in the parent workspace', async (t) => {
  const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moss-child-owner-')));
  t.after(() => fs.rm(ws, { recursive: true, force: true }));
  await runProcess('git', { args: ['init', '-q'], cwd: ws });
  await fs.writeFile(path.join(ws, '.gitignore'), '.moss/\n');
  await runProcess('git', { args: ['add', '.gitignore'], cwd: ws });
  await runProcess('git', {
    args: [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-q',
      '--no-gpg-sign',
      '-m',
      'fixture',
    ],
    cwd: ws,
  });
  const seen = [];
  const approvals = [];
  const tool = {
    name: 'read_file',
    description: 'Capture the actual child tool context',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'readonly' },
    async execute(_input, ctx) {
      seen.push({ workspaceDir: ctx.workspaceDir, taskId: ctx.taskId });
      return 'observed';
    },
  };
  const modelDef = {
    id: 'local',
    name: 'local',
    api: 'openai-completions',
    provider: 'test',
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: 1024,
  };
  for (const isolated of [false, true]) {
    let calls = 0;
    const runner = createSubAgentRunner({
      parentTools: [tool],
      workspaceDir: ws,
      taskId: 'task-parent',
      modelDef,
      checkToolApproval: async (call) => {
        approvals.push({ workspaceDir: call.workspaceDir, taskId: call.taskId });
        return null;
      },
      systemPrompt: 'Test worker',
      maxOutputTokens: 512,
      contextTokens: 32000,
      streamFn: () => {
        const turn = ++calls;
        return {
          async *[Symbol.asyncIterator]() {
            if (turn === 1)
              yield {
                type: 'toolcall_end',
                toolCall: { id: 'capture', name: 'read_file', arguments: {} },
              };
          },
          async result() {
            return turn === 1
              ? { stopReason: 'toolUse', usage: { input: 1, output: 1 } }
              : {
                  stopReason: 'end',
                  usage: { input: 1, output: 1 },
                  content: [{ type: 'text', text: 'done' }],
                };
          },
          push() {},
          end() {},
        };
      },
    });
    await runner(
      {
        runId: `child-${isolated}`,
        parentRunId: 'parent',
        scope: 'full',
        task: 'inspect',
        maxTurns: 2,
        timeoutMs: 30000,
        ...(isolated ? { worktree: true } : {}),
      },
      new AbortController().signal
    );
  }
  assert.equal(seen.length, 2);
  assert.equal(seen[0].taskId, 'task-parent');
  assert.equal(seen[0].workspaceDir, ws);
  assert.equal(seen[1].taskId, undefined);
  assert.notEqual(seen[1].workspaceDir, ws);
  assert.deepEqual(approvals, seen);
});

test('MossAgent passes its task to a real shared child and its approval hook', async (t) => {
  const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moss-agent-child-')));
  t.after(() => fs.rm(ws, { recursive: true, force: true }));
  const taskA = await createDraftTask(ws, 'goal A');
  await createDraftTask(ws, 'newer goal B');
  const seen = [];
  const approvals = [];
  const provider = createMockTranscriptProvider('local', 'local', [
    { toolCalls: [{ name: 'tool_search', input: { group: 'subagent' } }] },
    { toolCalls: [{ name: 'create_subagent', input: { task: 'inspect', scope: 'explore' } }] },
    { toolCalls: [{ name: 'read_file', input: {} }] },
    { text: 'Child inspected the workspace.' },
    { text: 'The child reported its inspection.' },
  ]);
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    model: 'local',
    workspaceDir: ws,
    domainPrompt: false,
    enableFollowUpGuard: false,
    enableCompaction: false,
    hooks: {
      onBeforeToolExec: async (request) => {
        approvals.push(request);
        return { approved: true };
      },
    },
  });
  agent.tools.register(toolSearchTool);
  agent.tools.register(createSubagentTool);
  agent.tools.register({
    name: 'read_file',
    description: 'Observe child context',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'readonly' },
    async execute(_input, ctx) {
      seen.push(ctx);
      return 'observed';
    },
  });
  await agent.chat('parent', 'delegate inspection', { taskFlow: true, taskId: taskA.taskId });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].agentId, 'subagent:explore');
  assert.equal(seen[0].taskId, taskA.taskId);
  const childApproval = approvals.find((item) => item.tool.name === 'read_file');
  assert.equal(childApproval?.taskId, taskA.taskId);
  assert.equal(childApproval?.workspaceDir, ws);
});

test('no live task → sub-agent prompt unchanged', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ctx-empty-'));
  let captured;
  const ctx = makeCtx(ws, (req) => {
    captured = req.task;
  });
  await createSubagentTool.execute({ task: 'plain job', scope: 'read-only' }, ctx);
  assert.equal(captured, 'plain job');
  await fs.rm(ws, { recursive: true, force: true });
});

test('settled (accepted) tasks are not injected', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ctx-done-'));
  const contract = await createDraftTask(ws, 'done thing');
  await appendTaskEvent(ws, contract.taskId, 'execution_started');
  await appendTaskEvent(ws, contract.taskId, 'verification_started');
  await appendTaskEvent(ws, contract.taskId, 'acceptance_pass');
  let captured;
  const ctx = makeCtx(ws, (req) => {
    captured = req.task;
  });
  await createSubagentTool.execute({ task: 'next job', scope: 'read-only' }, ctx);
  assert.equal(captured, 'next job');
  await fs.rm(ws, { recursive: true, force: true });
});
