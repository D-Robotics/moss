#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryExecutionStore,
  StoreExecutionActionController,
} from '../dist/orchestration/index.js';

test('execution actions advance elaboration, proposal approval, and delivery stage with CAS', () => {
  const store = new InMemoryExecutionStore();
  let graph = store.create({
    id: 'action-case',
    goal: 'Operate delivery through one product-neutral seam',
    deliveryCase: {
      depth: 'standard',
      riskLevel: 'medium',
      requirements: [{ id: 'req-1', statement: 'Actions are durable', required: true }],
    },
  });
  const actions = new StoreExecutionActionController(store);
  graph = actions.execute(graph.id, graph.revision, {
    type: 'record_elaboration',
    round: {
      id: 'round-1',
      index: 1,
      createdAt: 1,
      resolved: true,
      questions: [
        {
          id: 'q-1',
          prompt: 'Proceed?',
          options: ['Yes', 'No'],
          answer: 'Yes',
          status: 'answered',
        },
      ],
    },
  });
  graph = actions.execute(graph.id, graph.revision, {
    type: 'record_proposal',
    proposal: {
      revision: 1,
      summary: 'Use the shared action seam',
      requirementIds: ['req-1'],
      nodeIds: [],
      requiresApproval: true,
      evidenceIds: [],
    },
  });
  graph = actions.execute(graph.id, graph.revision, {
    type: 'approve_proposal',
    evidenceId: 'approval-1',
  });
  graph = actions.execute(graph.id, graph.revision, {
    type: 'transition_delivery',
    stage: 'executing',
  });
  assert.equal(graph.deliveryCase.stage, 'executing');
  assert.equal(graph.deliveryCase.proposal.approvalEvidenceId, 'approval-1');
  assert.throws(
    () => actions.execute(graph.id, 1, { type: 'transition_delivery', stage: 'verifying' }),
    /revision/
  );
});
