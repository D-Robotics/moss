import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MossAgent,
  InMemorySessionStore,
  createDraftTask,
  appendTaskEvent,
  appendTaskRecord,
  appendEvidenceRecord,
  taskAcceptanceTool,
  getTaskStateSnapshot,
} from '../dist/index.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

for (const failSync of [false, true])
  test(
    failSync
      ? 'a failed native commit after timeout grants no trusted acceptance stop'
      : 'a tool timeout cannot open a later write while a native acceptance commit is still settling',
    async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-late-acceptance-'));
      const originalOpen = fs.open;
      let release;
      const commitGate = new Promise((resolve) => {
        release = resolve;
      });
      let done;
      const nativeDone = new Promise((resolve) => {
        done = resolve;
      });
      let releaseTimer;
      let timedOut = false;
      let syncReached = false;
      let writes = 0;
      try {
        const task = await createDraftTask(workspaceDir, 'one');
        await appendTaskEvent(workspaceDir, task.taskId, 'execution_started');
        await appendTaskRecord(workspaceDir, {
          ...task,
          status: 'active',
          acceptanceCriteria: [{ metric: 'probe', expected: '==1' }],
        });
        await appendEvidenceRecord(workspaceDir, {
          evidenceId: 'one',
          taskId: task.taskId,
          metric: 'probe',
          observed: 1,
          result: 'pass',
          source: 'exec',
          timestamp: Date.now(),
        });
        fs.open = async function (file, flags, ...args) {
          const handle = await originalOpen.call(this, file, flags, ...args);
          if (
            String(file) === path.join(workspaceDir, '.moss', 'acceptance.jsonl') &&
            flags === 'r+'
          ) {
            const sync = handle.sync.bind(handle);
            let first = true;
            handle.sync = async () => {
              syncReached = true;
              await commitGate;
              if (failSync && first) {
                first = false;
                throw Object.assign(new Error('late native sync failure'), { code: 'EIO' });
              }
              return sync();
            };
          }
          return handle;
        };
        const agent = new MossAgent({
          llmProvider: createMockTranscriptProvider('timeout', 'timeout', [
            {
              toolCalls: [
                { name: 'task_acceptance', input: { task_id: task.taskId } },
                { name: 'write_bad', input: {} },
              ],
            },
            { text: 'later completion' },
          ]),
          sessionStore: new InMemorySessionStore(),
          model: 'timeout',
          workspaceDir,
          domainPrompt: false,
          enableFollowUpGuard: false,
          enableCompaction: false,
          hooks: { onBeforeToolExec: async () => ({ approved: true }) },
        });
        agent.tools.register({
          ...taskAcceptanceTool,
          metadata: { ...taskAcceptanceTool.metadata, timeoutMs: 500 },
          execute: async (input, ctx) => {
            ctx.abortSignal.addEventListener(
              'abort',
              () => {
                timedOut = true;
                releaseTimer = setTimeout(release, 50);
              },
              { once: true }
            );
            try {
              return await taskAcceptanceTool.execute(input, ctx);
            } finally {
              done();
            }
          },
        });
        agent.tools.register({
          name: 'write_bad',
          description: 'later mutation',
          inputSchema: { type: 'object', properties: {} },
          metadata: { sideEffectClass: 'local_write' },
          execute: async () => {
            writes++;
            await fs.writeFile(path.join(workspaceDir, 'bad-write'), 'bad');
            return 'wrote';
          },
        });
        const response = await agent.chat('timeout', 'accept then mutate');
        await nativeDone;
        assert.equal(
          syncReached,
          true,
          'the native PASS reached actual acceptance fsync before its timeout'
        );
        assert.equal(timedOut, true, 'the original per-tool deadline really fired');
        assert.equal(
          (await getTaskStateSnapshot(workspaceDir, task.taskId)).phase,
          failSync ? 'executing' : 'accepted'
        );
        assert.equal(
          writes,
          failSync ? 1 : 0,
          'only a truly settled PASS may suppress the later mutation'
        );
        if (failSync)
          assert.equal(await fs.readFile(path.join(workspaceDir, 'bad-write'), 'utf8'), 'bad');
        assert.notEqual(
          response.stopReason,
          'aborted',
          'completion must not fabricate an operator abort'
        );
      } finally {
        release();
        clearTimeout(releaseTimer);
        fs.open = originalOpen;
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    }
  );

test('an ordinary tool timeout returns under its original budget without a native settlement wait', async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ordinary-timeout-'));
  let writes = 0;
  let timedOut = false;
  const agent = new MossAgent({
    llmProvider: createMockTranscriptProvider('ordinary', 'ordinary', [
      {
        toolCalls: [
          { name: 'ordinary_wait', input: {} },
          { name: 'write_next', input: {} },
        ],
      },
      { text: 'done' },
    ]),
    sessionStore: new InMemorySessionStore(),
    model: 'ordinary',
    workspaceDir,
    domainPrompt: false,
    enableFollowUpGuard: false,
    enableCompaction: false,
    hooks: { onBeforeToolExec: async () => ({ approved: true }) },
  });
  agent.tools.register({
    name: 'ordinary_wait',
    description: 'wait without any native commit',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'runtime_state', timeoutMs: 500 },
    execute: async (_input, ctx) => {
      ctx.abortSignal.addEventListener(
        'abort',
        () => {
          timedOut = true;
        },
        { once: true }
      );
      return new Promise(() => {});
    },
  });
  agent.tools.register({
    name: 'write_next',
    description: 'real write',
    inputSchema: { type: 'object', properties: {} },
    metadata: { sideEffectClass: 'local_write' },
    execute: async () => {
      writes++;
      await fs.writeFile(path.join(workspaceDir, 'next'), 'next');
      return 'wrote';
    },
  });
  try {
    const started = Date.now();
    const response = await agent.chat('ordinary', 'wait then write');
    assert.equal(timedOut, true);
    assert.equal(writes, 1);
    assert.ok(
      Date.now() - started < 2000,
      'ordinary timeout must remain bounded without native persistence'
    );
    assert.equal(await fs.readFile(path.join(workspaceDir, 'next'), 'utf8'), 'next');
    assert.notEqual(response.stopReason, 'aborted');
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('a timed-out tool cannot start native acceptance later from its inherited scope', async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-late-dispatch-'));
  const { createContractVerdictProvider } = await import('../dist/index.js');
  let lateResult;
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let timer;
  try {
    const task = await createDraftTask(workspaceDir, 'late dispatch');
    await appendTaskEvent(workspaceDir, task.taskId, 'execution_started');
    await appendTaskRecord(workspaceDir, {
      ...task,
      status: 'active',
      acceptanceCriteria: [{ metric: 'probe', expected: '==1' }],
    });
    await appendEvidenceRecord(workspaceDir, {
      evidenceId: 'one',
      taskId: task.taskId,
      metric: 'probe',
      observed: 1,
      result: 'pass',
      source: 'exec',
      timestamp: Date.now(),
    });
    const agent = new MossAgent({
      llmProvider: createMockTranscriptProvider('late', 'late', [
        { toolCalls: [{ name: 'late_accept', input: {} }] },
        { text: 'done' },
      ]),
      sessionStore: new InMemorySessionStore(),
      model: 'late',
      workspaceDir,
      domainPrompt: false,
      enableFollowUpGuard: false,
      enableCompaction: false,
      hooks: { onBeforeToolExec: async () => ({ approved: true }) },
    });
    agent.tools.register({
      name: 'late_accept',
      description: 'attempt late native acceptance',
      inputSchema: { type: 'object', properties: {} },
      metadata: { sideEffectClass: 'runtime_state', timeoutMs: 500 },
      execute: async (_input, ctx) => {
        ctx.abortSignal.addEventListener(
          'abort',
          () => {
            timer = setTimeout(release, 50);
          },
          { once: true }
        );
        await gate;
        try {
          await createContractVerdictProvider(workspaceDir).evaluate(task.taskId);
        } catch (error) {
          lateResult = error;
        } finally {
          finish();
        }
        return 'late';
      },
    });
    await agent.chat('late', 'late acceptance');
    await done;
    assert.match(
      String(lateResult),
      /tool execution ended before native acceptance commit dispatch/
    );
    assert.equal((await getTaskStateSnapshot(workspaceDir, task.taskId)).phase, 'executing');
    const raw = await fs
      .readFile(path.join(workspaceDir, '.moss', 'acceptance.jsonl'), 'utf8')
      .catch((error) => {
        assert.equal(error.code, 'ENOENT');
        return '';
      });
    assert.equal(
      raw,
      '',
      'no native acceptance record may be dispatched from the ended tool scope'
    );
  } finally {
    release();
    clearTimeout(timer);
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
