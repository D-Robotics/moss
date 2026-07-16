#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createInMemoryMossAsyncTaskRegistry } from '@rdk-moss/core/contracts/async-task';

function timeout(ms, label) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms));
}

test('close aborts an active provider call and waits for the run to settle', async () => {
  let started;
  const startedGate = new Promise((resolve) => { started = resolve; });
  const provider = {
    id: 'shutdown-provider',
    capabilities: { streaming: true },
    async complete(options) {
      started();
      await new Promise((resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal.reason), { once: true });
      });
    },
    async stream(options) { return this.complete(options); },
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
    async complete() { return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] }; },
    async stream(options, onEvent) { const result = await this.complete(options); onEvent({ type: 'message_stop' }); return result; },
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
      await new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      return { success: false, summary: 'aborted' };
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await agent.close();
  assert.equal(aborted, true);
  assert.equal(agent.asyncTasks.readCompletion('owned-task')?.status, 'cancelled');
});

test('close aborts a run waiting in the input guardrail', async () => {
  let started;
  const startedGate = new Promise((resolve) => { started = resolve; });
  const provider = {
    id: 'guardrail-shutdown-provider',
    async complete() { throw new Error('provider must not run'); },
    async stream() { throw new Error('provider must not run'); },
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
    async complete() { return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] }; },
    async stream(options, onEvent) { const result = await this.complete(options); onEvent({ type: 'message_stop' }); return result; },
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
  registry.start(
    { taskId: 'shared-task', kind: 'host_task', payload: {} },
    async () => {
      await new Promise((resolve) => { release = resolve; });
      return { success: true, summary: 'done' };
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await agent.close();
  assert.equal(registry.status('shared-task')?.status, 'running');
  release();
  assert.equal((await registry.wait('shared-task')).status, 'completed');
});

test('disposed agents reject new chat calls with a stable error code', async () => {
  const provider = {
    id: 'disposed-provider',
    async complete() { return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] }; },
    async stream(options, onEvent) { const result = await this.complete(options); onEvent({ type: 'message_stop' }); return result; },
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
  await assert.rejects(() => agent.chat('disposed', 'hello'), (error) => error?.code === 'AGENT_DISPOSED');
  await agent.close();
  await agent.close();
});

test('close does not wait for a consumer paused on a yielded stream event', async () => {
  const provider = {
    id: 'paused-consumer-provider',
    async complete() { return { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] }; },
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
  const afterClose = await Promise.race([stream.next(), timeout(500, 'paused stream did not close')]);
  assert.equal(afterClose.done, true);
});
