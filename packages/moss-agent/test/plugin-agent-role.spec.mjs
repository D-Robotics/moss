#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMossPluginHost } from '../dist/core/plugins/plugin-host.js';
import { AgentRoleRegistry, AssignmentRouter } from '../dist/orchestration/index.js';

function adapters(registry) {
  return {
    hasTool: () => false,
    registerTool: () => () => {},
    hasSkill: () => false,
    registerSkill: () => () => {},
    hasExpert: () => false,
    registerExpert: () => () => {},
    hasAgentRole: (id) => registry.get(id) !== undefined,
    registerAgentRole: (role) => registry.register(role),
  };
}

const advisor = {
  id: 'plugin-advisor',
  displayName: 'Plugin advisor',
  kind: 'advisor',
  capabilities: ['architecture'],
  instructions: 'Cite architecture evidence.',
  workspaceMode: 'shared-readonly',
  outputContract: 'structured-v1',
};

const implementer = {
  id: 'plugin-implementer',
  displayName: 'Plugin implementer',
  kind: 'implementer',
  capabilities: ['code'],
  instructions: 'Return a patch.',
  workspaceMode: 'isolated-write',
  outputContract: 'structured-v1',
};

test('plugin agent roles install and unload atomically while routed snapshots survive', async () => {
  const registry = new AgentRoleRegistry({ allowIsolatedWrite: true });
  const host = createMossPluginHost(adapters(registry));
  try {
    await host.install({
      id: 'roles/example',
      setup(context) {
        context.registerAgentRole(advisor);
      },
    });
    assert.deepEqual(host.inspect().plugins[0].agentRoles, ['plugin-advisor']);
    const routed = new AssignmentRouter(registry).route({
      id: 'review',
      graphId: 'graph',
      nodeId: 'review',
      goal: 'Review architecture',
      requiredRoleKind: 'advisor',
      requiredCapabilities: ['architecture'],
      inputEvidenceIds: [],
      dependencies: [],
      writePaths: [],
      acceptanceCriteria: ['reviewed'],
    });
    await host.unload('roles/example');
    assert.equal(registry.get('plugin-advisor'), undefined);
    assert.equal(routed.role.id, 'plugin-advisor');
  } finally {
    await host.close();
  }
});

test('unauthorized isolated-write role rolls back every staged plugin contribution', async () => {
  const registry = new AgentRoleRegistry();
  const host = createMossPluginHost(adapters(registry));
  try {
    await assert.rejects(
      host.install({
        id: 'roles/denied',
        setup(context) {
          context.registerAgentRole(advisor);
          context.registerAgentRole(implementer);
        },
      }),
      /isolated-write role authorization/
    );
    assert.deepEqual(registry.list(), []);
    assert.deepEqual(host.inspect().plugins, []);
  } finally {
    await host.close();
  }
});
