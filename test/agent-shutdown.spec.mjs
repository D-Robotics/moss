#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createInMemoryMossAsyncTaskRegistry } from '../dist/contracts/async-task.js';
import { execBackgroundTool } from '../dist/tools/background-exec.js';
import {
  backgroundProcesses,
  clearBackgroundRegistryForTests,
} from '../dist/core/tools/background-process-registry.js';
import { resolveHostShell } from '../dist/utils/host-shell.js';

function timeout(ms, label) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms));
}

async function withBackgroundProcess(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-close-background-'));
  try {
    const script = path.join(root, 'job.cjs');
    await fs.writeFile(script, 'console.log("ready"); setInterval(() => {}, 1000);');
    const quote = (value) =>
      process.platform === 'win32'
        ? `"${value.replaceAll('"', '""')}"`
        : `'${value.replaceAll("'", "'\\''")}'`;
    const prefix = process.platform === 'win32' && resolveHostShell().kind === 'pwsh' ? '& ' : '';
    const output = await execBackgroundTool.execute(
      { command: `${prefix}${quote(process.execPath)} ${quote(script)}`, settle_ms: 0 },
      { abortSignal: new AbortController().signal, sessionKey: 'host-owned-job' }
    );
    const id = output.match(/bg_\d+/)?.[0];
    assert.ok(id, output);
    const proc = backgroundProcesses.get(id);
    assert.ok(proc?.child.pid, 'the fixture is a real registered child process');
    const readyBy = Date.now() + 5000;
    while (!proc.buffer.includes('ready') && Date.now() < readyBy)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(proc.buffer, /ready/, 'the background command started before close');
    const closed = new Promise((resolve) => proc.child.once('close', resolve));
    await run(proc, closed);
  } finally {
    clearBackgroundRegistryForTests();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('default close stops a real background process', async () => {
  await withBackgroundProcess(async (proc, closed) => {
    const agent = new MossAgent({
      sessionStore: new InMemorySessionStore(),
      llmProvider: {
        id: 'background-close-provider',
        async complete() {
          throw new Error('close must not call the provider');
        },
      },
    });
    await agent.close();
    await Promise.race([closed, timeout(5000, 'default close did not stop the child')]);
    assert.notEqual(proc.status, 'running');
    assert.ok(proc.child.exitCode !== null || proc.child.signalCode !== null);
  });
});

test('embedded close preserves an unrelated real background process and cleans up the agent', async () => {
  await withBackgroundProcess(async (proc) => {
    let started;
    const startedGate = new Promise((resolve) => {
      started = resolve;
    });
    const provider = {
      id: 'embedded-close-provider',
      async complete(options) {
        started();
        await new Promise((resolve, reject) => {
          options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason), {
            once: true,
          });
        });
      },
      async stream(options) {
        return this.complete(options);
      },
    };
    const agent = new MossAgent({
      llmProvider: provider,
      sessionStore: new InMemorySessionStore(),
      domainPrompt: false,
      enableSteering: false,
      enableFollowUpGuard: false,
    });
    let taskStarted;
    const taskStartedGate = new Promise((resolve) => {
      taskStarted = resolve;
    });
    agent.asyncTasks.start(
      { taskId: 'embedded-task', kind: 'host_task', payload: {} },
      async (_request, signal) => {
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve, { once: true });
          taskStarted();
        });
        return { success: false, summary: 'aborted' };
      }
    );
    const chat = agent.chat('embedded-close', 'wait').catch((error) => error);
    await Promise.all([startedGate, taskStartedGate]);
    const closing = agent.close({ stopBackgroundProcesses: false });
    assert.equal(agent.close(), closing, 'the first close options govern repeated calls');
    await Promise.race([closing, timeout(500, 'embedded close did not settle')]);
    assert.equal((await chat).stopReason, 'aborted_by_user');
    assert.equal(agent.asyncTasks.readCompletion('embedded-task')?.status, 'cancelled');
    await assert.rejects(
      () => agent.chat('closed', 'no'),
      (error) => error?.code === 'AGENT_DISPOSED'
    );
    assert.equal(proc.killRequested, undefined, 'the unrelated job was never signaled');
    assert.equal(proc.status, 'running');
    assert.doesNotThrow(() => process.kill(proc.child.pid, 0), 'the real child remains alive');
  });
});

test('close aborts an active provider call and waits for the run to settle', async () => {
  let started;
  const startedGate = new Promise((resolve) => {
    started = resolve;
  });
  const provider = {
    id: 'shutdown-provider',
    capabilities: { streaming: true },
    async complete(options) {
      started();
      await new Promise((resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal.reason), {
          once: true,
        });
      });
    },
    async stream(options) {
      return this.complete(options);
    },
  };
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'test',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
  });

  const chat = agent.chat('shutdown', 'wait forever').catch((error) => error);
  await startedGate;
  await Promise.race([agent.close(), timeout(500, 'close did not settle the active run')]);
  const result = await Promise.race([chat, timeout(500, 'chat remained pending after close')]);
  assert.equal(result?.stopReason, 'aborted_by_user');
});

test('close cancels tasks in the registry owned by the agent', async () => {
  const provider = {
    id: 'shutdown-task-provider',
    async complete() {
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    },
    async stream(options, onEvent) {
      const result = await this.complete(options);
      onEvent({ type: 'message_stop' });
      return result;
    },
  };
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'test',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
  });
  let aborted = false;
  agent.asyncTasks.start(
    { taskId: 'owned-task', kind: 'host_task', payload: {} },
    async (_request, signal) => {
      await new Promise((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true }
        )
      );
      return { success: false, summary: 'aborted' };
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await agent.close();
  assert.equal(aborted, true);
  assert.equal(agent.asyncTasks.readCompletion('owned-task')?.status, 'cancelled');
});

test('close aborts a run waiting in the input guardrail', async () => {
  let started;
  const startedGate = new Promise((resolve) => {
    started = resolve;
  });
  const provider = {
    id: 'guardrail-shutdown-provider',
    async complete() {
      throw new Error('provider must not run');
    },
    async stream() {
      throw new Error('provider must not run');
    },
  };
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'test',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    hooks: {
      async onInputGuardrail() {
        started();
        return new Promise(() => {});
      },
    },
  });
  const chat = agent.chat('guardrail-shutdown', 'wait forever').catch((error) => error);
  await startedGate;
  await Promise.race([agent.close(), timeout(500, 'close did not settle the guardrail')]);
  const result = await Promise.race([chat, timeout(500, 'guardrail chat remained pending')]);
  assert.ok(result instanceof Error);
  assert.equal(result.code, 'USER_ABORTED');
});

test('close does not cancel tasks in a host-injected registry', async () => {
  const registry = createInMemoryMossAsyncTaskRegistry();
  const provider = {
    id: 'shared-task-provider',
    async complete() {
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    },
    async stream(options, onEvent) {
      const result = await this.complete(options);
      onEvent({ type: 'message_stop' });
      return result;
    },
  };
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    asyncTaskRegistry: registry,
    baseSystemPrompt: 'test',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
  });
  let release;
  registry.start({ taskId: 'shared-task', kind: 'host_task', payload: {} }, async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return { success: true, summary: 'done' };
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await agent.close();
  assert.equal(registry.status('shared-task')?.status, 'running');
  release();
  assert.equal((await registry.wait('shared-task')).status, 'completed');
});

test('disposed agents reject new chat calls with a stable error code', async () => {
  const provider = {
    id: 'disposed-provider',
    async complete() {
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    },
    async stream(options, onEvent) {
      const result = await this.complete(options);
      onEvent({ type: 'message_stop' });
      return result;
    },
  };
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'test',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
  });
  agent.dispose();
  await assert.rejects(
    () => agent.chat('disposed', 'hello'),
    (error) => error?.code === 'AGENT_DISPOSED'
  );
  await agent.close();
  await agent.close();
});

test('close does not wait for a consumer paused on a yielded stream event', async () => {
  const provider = {
    id: 'paused-consumer-provider',
    async complete() {
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    },
    async stream(_options, onEvent) {
      onEvent({ type: 'text_delta', delta: 'partial' });
      onEvent({ type: 'message_stop' });
      return this.complete();
    },
  };
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'test',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
  });
  const stream = agent.streamChat('paused-consumer', 'hello');
  const first = await stream.next();
  assert.equal(first.done, false);
  await Promise.race([agent.close(), timeout(500, 'close waited for the paused consumer')]);
  const afterClose = await Promise.race([
    stream.next(),
    timeout(500, 'paused stream did not close'),
  ]);
  assert.equal(afterClose.done, true);
});
