#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentRoleRegistry,
  AssignmentRouter,
  synthesizeAgentResults,
} from '../dist/orchestration/index.js';

const architect = {
  id: 'architect',
  displayName: 'Architect',
  kind: 'advisor',
  capabilities: ['architecture', 'security'],
  instructions: 'Review boundaries and cite evidence.',
  workspaceMode: 'shared-readonly',
  outputContract: 'structured-v1',
};

const implementer = {
  id: 'implementer',
  displayName: 'Implementer',
  kind: 'implementer',
  capabilities: ['code', 'test'],
  instructions: 'Return a patch and verification evidence.',
  workspaceMode: 'isolated-write',
  outputContract: 'structured-v1',
};

function assignment(overrides = {}) {
  return {
    id: 'assignment-1',
    graphId: 'graph',
    nodeId: 'node',
    goal: 'Implement safely',
    requiredRoleKind: 'implementer',
    requiredCapabilities: ['code', 'test'],
    inputEvidenceIds: [],
    dependencies: [],
    writePaths: ['src'],
    acceptanceCriteria: ['tests-green'],
    ...overrides,
  };
}

test('implementer roles require explicit isolated-write host authorization', () => {
  const denied = new AgentRoleRegistry();
  assert.throws(() => denied.register(implementer), /isolated-write role authorization/);
  assert.equal(denied.list().length, 0);

  const allowed = new AgentRoleRegistry({ allowIsolatedWrite: true });
  const dispose = allowed.register(implementer);
  assert.equal(allowed.get('implementer')?.kind, 'implementer');
  dispose();
  assert.equal(allowed.get('implementer'), undefined);
});

test('assignment router matches every capability and never expands a preferred role', () => {
  const registry = new AgentRoleRegistry({ allowIsolatedWrite: true });
  registry.register(architect);
  registry.register(implementer);
  const router = new AssignmentRouter(registry);

  const routed = router.route(assignment());
  assert.equal(routed.role.id, 'implementer');
  assert.deepEqual(routed.role.capabilities, ['code', 'test']);
  assert.throws(() => router.route(assignment(), 'architect'), /does not satisfy assignment/);
  assert.throws(
    () => router.route(assignment({ requiredCapabilities: ['code', 'performance'] })),
    /no authorized agent role/
  );
});

test('routed assignments retain an immutable role snapshot across plugin unload', () => {
  const registry = new AgentRoleRegistry({ allowIsolatedWrite: true });
  const dispose = registry.register(implementer);
  const routed = new AssignmentRouter(registry).route(assignment());
  dispose();
  assert.equal(registry.get('implementer'), undefined);
  assert.equal(routed.role.id, 'implementer');
  assert.deepEqual(routed.role.capabilities, ['code', 'test']);
  assert.equal(Object.isFrozen(routed.role), true);
});

test('synthesis keeps partial evidence, exposes gaps, and schedules high-severity conflict verification', () => {
  const result = synthesizeAgentResults({
    assignments: [
      assignment({
        id: 'security-a',
        requiredRoleKind: 'advisor',
        acceptanceCriteria: ['threats'],
      }),
      assignment({
        id: 'security-b',
        requiredRoleKind: 'advisor',
        acceptanceCriteria: ['threats'],
      }),
      assignment({ id: 'tests', acceptanceCriteria: ['tests-green'] }),
    ],
    results: [
      {
        assignmentId: 'security-a',
        roleId: 'architect-a',
        status: 'PASS',
        claims: [
          {
            id: 'claim-a',
            subject: 'auth-boundary',
            conclusion: 'safe',
            severity: 'high',
            evidenceRefs: ['evidence-a'],
          },
        ],
        evidenceRefs: ['evidence-a'],
        unmetCriteria: [],
      },
      {
        assignmentId: 'security-b',
        roleId: 'architect-b',
        status: 'PASS',
        claims: [
          {
            id: 'claim-b',
            subject: 'auth-boundary',
            conclusion: 'unsafe',
            severity: 'high',
            evidenceRefs: ['evidence-b'],
          },
        ],
        evidenceRefs: ['evidence-b'],
        unmetCriteria: [],
      },
      {
        assignmentId: 'tests',
        roleId: 'implementer',
        status: 'PARTIAL',
        claims: [],
        evidenceRefs: ['partial-log'],
        unmetCriteria: ['tests-green'],
      },
    ],
  });

  assert.deepEqual(result.acceptedEvidenceIds.sort(), ['evidence-a', 'evidence-b', 'partial-log']);
  assert.deepEqual(result.missingCriteria, ['tests-green']);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.verifierAssignments.length, 1);
  assert.deepEqual(result.verifierAssignments[0].inputEvidenceIds.sort(), [
    'evidence-a',
    'evidence-b',
  ]);
  assert.ok(result.coverage < 1);
});
