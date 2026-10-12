import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MossAgent, InMemorySessionStore, configureDefaultDeviceTarget } from '../dist/index.js';
import { trackTempDir } from './helpers/temp-home.mjs';

const names = ['device_exec', 'device_file_read', 'device_file_write'];
const root = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-host-device-offer-')));

function makeAgent(owner, { approval = true, child = false } = {}) {
  const workspaceDir = path.join(root, owner);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const state = { calls: 0, childCalls: 0, seen: [], bodies: [], approvals: [] };
  const agent = new MossAgent({
    model: 'host-device-offer',
    workspaceDir,
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'Use the supplied tools.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
    enableFollowUpGuard: false,
    enableSteering: false,
    enableCompaction: false,
    maxAgentTurns: 2,
    hooks: {
      async onBeforeToolExec(request) {
        state.approvals.push({ name: request.tool.name, runId: request.runId });
        return {
          approved: request.tool.name === 'host_probe_child' || approval,
          reason: 'host policy',
        };
      },
    },
    llmProvider: {
      id: 'host-device-offer',
      capabilities: { streaming: false },
      async complete(options) {
        const offered = (options.tools ?? []).map((tool) => tool.name);
        const isChild = child && !offered.includes('host_probe_child');
        const turn = isChild ? state.childCalls++ : state.calls++;
        state.seen.push({ owner, isChild, offered });
        if (turn === 0) {
          const calls = child
            ? isChild
              ? ['device_file_read', 'device_file_write']
              : ['host_probe_child']
            : names;
          return {
            stopReason: 'tool_use',
            content: calls.map((name) => ({
              type: 'tool_use',
              id: `${owner}-${name}`,
              name,
              input: {},
            })),
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'completed host probe' }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    },
  });
  for (const name of names) {
    agent.tools.register({
      name,
      description: `Host-owned ${name}.`,
      metadata: { sideEffectClass: name === 'device_file_write' ? 'device_mutation' : 'readonly' },
      inputSchema: { type: 'object', properties: {} },
      async execute(_input, ctx) {
        state.bodies.push({
          owner,
          name,
          runId: ctx.runId,
          sessionKey: ctx.sessionKey,
          workspaceDir: ctx.workspaceDir,
        });
        return `${owner}:${name}`;
      },
    });
  }
  if (child) {
    agent.tools.register({
      name: 'host_probe_child',
      description: 'Run one bounded device-read child.',
      metadata: { sideEffectClass: 'subagent' },
      inputSchema: { type: 'object', properties: {} },
      async execute(_input, ctx) {
        const result = await ctx.spawnSubagent({
          task: 'Read the bound device; writing is forbidden.',
          scope: 'device-read',
          allowedTools: ['device_file_read'],
          maxTurns: 2,
        });
        return result.summary;
      },
    });
  }
  return { agent, state, workspaceDir };
}

async function withNoGlobalDevice(run) {
  const savedHost = process.env.MOSS_DEVICE_HOST;
  delete process.env.MOSS_DEVICE_HOST;
  configureDefaultDeviceTarget(null);
  try {
    await run();
  } finally {
    configureDefaultDeviceTarget(null);
    if (savedHost === undefined) delete process.env.MOSS_DEVICE_HOST;
    else process.env.MOSS_DEVICE_HOST = savedHost;
  }
}

test('public per-run device offer supports a host binding without process-global state', async () => {
  await withNoGlobalDevice(async () => {
    const { agent, state } = makeAgent('bound');
    try {
      const result = await agent.chat('bound-session', 'Probe my board.', {
        deviceConfigured: true,
        runId: 'bound-run',
      });
      for (const name of names) assert.ok(state.seen[0].offered.includes(name), name);
      assert.deepEqual(
        state.bodies.map((entry) => entry.name),
        names
      );
      assert.ok(
        state.bodies.every((entry) => entry.owner === 'bound' && entry.runId === 'bound-run')
      );
      assert.ok(result.toolResults.every((entry) => !entry.isError));

      state.calls = 0;
      state.seen.length = 0;
      state.bodies.length = 0;
      await agent.chat('unbound-next-session', 'Probe without a binding.', {
        deviceConfigured: false,
      });
      assert.ok(names.every((name) => !state.seen[0].offered.includes(name)));
      assert.equal(state.bodies.length, 0, 'visibility is not sticky across runs');
    } finally {
      await agent.close();
    }
  });
});

test('unset keeps CLI discovery; explicit false, toolFilter and approval remain authoritative', async () => {
  await withNoGlobalDevice(async () => {
    const absent = makeAgent('unset');
    try {
      await absent.agent.chat('unset', 'No device is configured.');
      assert.ok(names.every((name) => !absent.state.seen[0].offered.includes(name)));
      assert.equal(absent.state.bodies.length, 0);
    } finally {
      await absent.agent.close();
    }
    configureDefaultDeviceTarget({
      deviceId: 'cli-board',
      kind: 'linux',
      host: '127.0.0.1',
      user: 'fixture',
    });
    for (const [owner, options, approval, expected] of [
      ['cli-global', {}, true, names],
      ['explicit-hidden', { deviceConfigured: false }, true, []],
      [
        'host-filtered',
        { deviceConfigured: true, toolFilter: (tool) => tool.name !== 'device_file_write' },
        true,
        names.slice(0, 2),
      ],
      ['host-denied', { deviceConfigured: true }, false, []],
    ]) {
      const { agent, state } = makeAgent(owner, { approval });
      try {
        await agent.chat(owner, 'Probe the configured device.', options);
        assert.deepEqual(
          state.bodies.map((entry) => entry.name),
          expected,
          owner
        );
        if (owner === 'explicit-hidden')
          assert.ok(names.every((name) => !state.seen[0].offered.includes(name)));
        if (owner === 'host-filtered')
          assert.ok(!state.seen[0].offered.includes('device_file_write'));
        if (owner === 'host-denied')
          assert.ok(names.every((name) => state.seen[0].offered.includes(name)));
      } finally {
        await agent.close();
      }
    }
  });
});

test('parallel agents cannot inherit another owner device visibility or closure', async () => {
  await withNoGlobalDevice(async () => {
    const bound = makeAgent('owner-a');
    const hidden = makeAgent('owner-b');
    try {
      await Promise.all([
        bound.agent.chat('a', 'Use only A binding.', { deviceConfigured: true }),
        hidden.agent.chat('b', 'There is no B binding.', { deviceConfigured: false }),
      ]);
      assert.deepEqual(
        bound.state.bodies.map((entry) => entry.owner),
        names.map(() => 'owner-a')
      );
      assert.equal(hidden.state.bodies.length, 0);
      assert.ok(names.every((name) => !hidden.state.seen[0].offered.includes(name)));
    } finally {
      await Promise.all([bound.agent.close(), hidden.agent.close()]);
    }
  });
});

test('real child provider and execution retain owner binding, read scope, allowlist and approval', async () => {
  await withNoGlobalDevice(async () => {
    for (const [owner, options, approval, expected] of [
      ['child-bound', { deviceConfigured: true }, true, 1],
      ['child-unbound', { deviceConfigured: false }, true, 0],
      [
        'child-filtered',
        { deviceConfigured: true, toolFilter: (tool) => tool.name !== 'device_file_read' },
        true,
        0,
      ],
      ['child-denied', { deviceConfigured: true }, false, 0],
    ]) {
      const { agent, state, workspaceDir } = makeAgent(owner, { child: true, approval });
      try {
        await agent.chat(owner, 'Run the child device probe.', {
          ...options,
          runId: `${owner}-parent`,
        });
        const childOffer = state.seen.find((entry) => entry.isChild);
        assert.ok(childOffer, 'the actual child provider was called');
        assert.equal(
          childOffer.offered.includes('device_file_read'),
          owner === 'child-bound' || owner === 'child-denied'
        );
        assert.ok(
          !childOffer.offered.includes('device_file_write'),
          'scope/allowlist excludes device writes'
        );
        assert.equal(state.bodies.length, expected, owner);
        for (const body of state.bodies) {
          assert.equal(body.owner, owner);
          assert.equal(body.name, 'device_file_read');
          assert.equal(body.workspaceDir, workspaceDir);
          assert.match(body.runId, new RegExp(`^${owner}-parent/sub-`));
          assert.match(body.sessionKey, /^subagent:/);
          assert.equal(
            state.approvals.find((entry) => entry.name === body.name)?.runId,
            body.runId
          );
        }
      } finally {
        await agent.close();
      }
    }
  });
});
