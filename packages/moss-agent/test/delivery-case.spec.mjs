#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryExecutionStore } from '../dist/orchestration/index.js';

function append(store, graphId, input) {
  const graph = store.load(graphId);
  return store.append(graphId, { expectedRevision: graph.revision, ...input });
}

test('delivery case persists elaboration and enforces proposal approval before execution', () => {
  const store = new InMemoryExecutionStore();
  let graph = store.create({
    id: 'delivery-standard',
    goal: 'Deliver a user-visible workflow',
    deliveryCase: {
      depth: 'standard',
      riskLevel: 'medium',
      requirements: [{ id: 'req-ui', statement: 'The workflow is visible in Web', required: true }],
    },
  });
  assert.equal(graph.deliveryCase.stage, 'intake');
  assert.equal(graph.deliveryCase.requirements[0].id, 'req-ui');

  graph = append(store, graph.id, {
    type: 'delivery.elaboration_recorded',
    data: {
      round: {
        id: 'round-1',
        index: 1,
        createdAt: 10,
        resolved: true,
        questions: [
          {
            id: 'q-approval',
            prompt: 'Should the proposal require approval?',
            options: ['Yes', 'No'],
            answer: 'Yes',
            status: 'answered',
          },
        ],
      },
    },
  });
  assert.equal(graph.deliveryCase.stage, 'elaborating');

  graph = append(store, graph.id, {
    type: 'delivery.proposal_recorded',
    data: {
      proposal: {
        revision: 1,
        summary: 'Implement and verify the Web workflow',
        requirementIds: ['req-ui'],
        nodeIds: [],
        requiresApproval: true,
        evidenceIds: [],
      },
    },
  });
  assert.equal(graph.deliveryCase.stage, 'proposed');
  assert.throws(
    () =>
      append(store, graph.id, {
        type: 'delivery.stage_changed',
        data: { stage: 'executing' },
      }),
    /proposal approval/
  );

  graph = append(store, graph.id, {
    type: 'delivery.proposal_approved',
    data: { approvedAt: 20, evidenceId: 'approval-1' },
  });
  graph = append(store, graph.id, {
    type: 'delivery.stage_changed',
    data: { stage: 'executing' },
  });
  assert.equal(graph.deliveryCase.stage, 'executing');
  assert.equal(graph.deliveryCase.proposal.approvalEvidenceId, 'approval-1');
});

test('standard delivery cannot create a proposal while elaboration remains unresolved', () => {
  const store = new InMemoryExecutionStore();
  const graph = store.create({
    id: 'delivery-unresolved',
    goal: 'Clarify before proposing',
    deliveryCase: {
      depth: 'standard',
      riskLevel: 'medium',
      requirements: [],
    },
  });
  assert.throws(
    () =>
      append(store, graph.id, {
        type: 'delivery.proposal_recorded',
        data: {
          proposal: {
            revision: 1,
            summary: 'Premature proposal',
            requirementIds: [],
            nodeIds: [],
            requiresApproval: false,
            evidenceIds: [],
          },
        },
      }),
    /resolved elaboration round/
  );
});

test('risk policy upgrades delivery depth and cannot be lowered by the caller', () => {
  const store = new InMemoryExecutionStore();
  const medium = store.create({
    id: 'delivery-medium-risk',
    goal: 'Change a user-visible workflow',
    deliveryCase: { depth: 'minimal', riskLevel: 'medium', requirements: [] },
  });
  const high = store.create({
    id: 'delivery-high-risk',
    goal: 'Change a public security interface',
    deliveryCase: { depth: 'standard', riskLevel: 'high', requirements: [] },
  });
  assert.equal(medium.deliveryCase.depth, 'standard');
  assert.equal(high.deliveryCase.depth, 'comprehensive');
});

test('proposal covers required requirements, references real nodes, and comprehensive approval cannot be disabled', () => {
  const store = new InMemoryExecutionStore();
  let graph = store.create({
    id: 'delivery-comprehensive-proposal',
    goal: 'Protect the proposal boundary',
    nodes: [{ id: 'verify', kind: 'verification', title: 'Verify', dependencies: [] }],
    deliveryCase: {
      depth: 'comprehensive',
      riskLevel: 'high',
      requirements: [{ id: 'req-safe', statement: 'The change remains safe', required: true }],
    },
  });
  graph = append(store, graph.id, {
    type: 'delivery.elaboration_recorded',
    data: {
      round: {
        id: 'round-1',
        index: 1,
        createdAt: 1,
        resolved: true,
        questions: [
          {
            id: 'q-risk',
            prompt: 'Is the risk understood?',
            options: ['Yes'],
            answer: 'Yes',
            status: 'answered',
          },
        ],
      },
    },
  });
  assert.throws(
    () =>
      append(store, graph.id, {
        type: 'delivery.proposal_recorded',
        data: {
          proposal: {
            revision: 1,
            summary: 'Incomplete proposal',
            requirementIds: [],
            nodeIds: ['verify'],
            requiresApproval: false,
            evidenceIds: [],
          },
        },
      }),
    /omits required requirements/
  );
  assert.throws(
    () =>
      append(store, graph.id, {
        type: 'delivery.proposal_recorded',
        data: {
          proposal: {
            revision: 1,
            summary: 'Unknown node proposal',
            requirementIds: ['req-safe'],
            nodeIds: ['missing'],
            requiresApproval: false,
            evidenceIds: [],
          },
        },
      }),
    /unknown execution nodes/
  );
  graph = append(store, graph.id, {
    type: 'delivery.proposal_recorded',
    data: {
      proposal: {
        revision: 1,
        summary: 'Complete proposal',
        requirementIds: ['req-safe'],
        nodeIds: ['verify'],
        requiresApproval: false,
        evidenceIds: [],
      },
    },
  });
  assert.equal(graph.deliveryCase.proposal.requiresApproval, true);
});
