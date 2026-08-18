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
    type: 'record_review',
    review: {
      id: 'proposal-review-1',
      scope: 'proposal',
      round: 1,
      verdict: 'PASS',
      roleId: 'proposal-reviewer',
      independent: true,
      readOnly: true,
      blockers: [],
      notes: [],
      evidenceIds: [],
      reviewedAt: 2,
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

test('shared actions prepare a traceable proposal through an independent built-in reviewer', () => {
  const store = new InMemoryExecutionStore();
  let graph = store.create({
    id: 'prepared-case',
    goal: 'Deliver a safe cross-module change',
    nodes: [{ id: 'work', kind: 'analysis', title: 'Plan work', dependencies: [] }],
    deliveryCase: {
      depth: 'standard',
      riskLevel: 'medium',
      requirements: [{ id: 'req-1', statement: 'The change is delivered', required: true }],
    },
  });
  const actions = new StoreExecutionActionController(store);
  graph = actions.execute(graph.id, graph.revision, {
    type: 'record_elaboration',
    round: {
      id: 'round-1',
      index: 1,
      createdAt: 1,
      resolved: false,
      questions: [
        { id: 'q-1', prompt: 'Outcome?', options: [], status: 'unanswered', required: true },
      ],
    },
  });
  graph = actions.execute(graph.id, graph.revision, {
    type: 'answer_elaboration',
    roundId: 'round-1',
    answers: { 'q-1': 'Observable outcome' },
  });
  graph = actions.execute(graph.id, graph.revision, { type: 'prepare_proposal' });
  assert.equal(graph.deliveryCase.stage, 'proposed');
  assert.deepEqual(graph.deliveryCase.proposal.requirementIds, ['req-1']);
  assert.deepEqual(graph.deliveryCase.proposal.nodeIds, ['work']);
  assert.equal(graph.deliveryCase.reviews[0].scope, 'proposal');
  assert.equal(graph.deliveryCase.reviews[0].roleId, 'builtin:proposal-reviewer');
  assert.equal(graph.deliveryCase.reviews[0].evidenceIds.length, 1);
});

test('requirement steering invalidates the proposal and advances the case revision', () => {
  const store = new InMemoryExecutionStore();
  const actions = new StoreExecutionActionController(store);
  let graph = store.create({
    id: 'requirement-steering',
    goal: 'Deliver one analysis',
    deliveryCase: {
      depth: 'minimal',
      riskLevel: 'low',
      requirements: [{ id: 'before', statement: 'Before', required: true }],
    },
  });
  graph = actions.execute(graph.id, graph.revision, { type: 'prepare_proposal' });
  const previousCaseRevision = graph.deliveryCase.revision;
  graph = actions.execute(graph.id, graph.revision, {
    type: 'revise_requirements',
    requirements: [{ id: 'after', statement: 'After', required: true }],
    reason: 'User changed the success condition',
  });
  assert.equal(graph.deliveryCase.revision, previousCaseRevision + 1);
  assert.equal(graph.deliveryCase.stage, 'intake');
  assert.equal(graph.deliveryCase.proposal, undefined);
  assert.deepEqual(
    graph.deliveryCase.requirements.map((item) => item.id),
    ['after']
  );
});

test('failed review action atomically generates fix nodes when a reviewer omits them', () => {
  const store = new InMemoryExecutionStore();
  const actions = new StoreExecutionActionController(store);
  let graph = store.create({
    id: 'automatic-review-fix',
    goal: 'Review one analysis',
    deliveryCase: { depth: 'minimal', riskLevel: 'low', requirements: [] },
  });
  graph = actions.execute(graph.id, graph.revision, { type: 'prepare_proposal' });
  graph = actions.execute(graph.id, graph.revision, {
    type: 'transition_delivery',
    stage: 'executing',
  });
  graph = actions.execute(graph.id, graph.revision, {
    type: 'transition_delivery',
    stage: 'verifying',
  });
  graph = actions.execute(graph.id, graph.revision, {
    type: 'record_review',
    review: {
      id: 'whole-review-1',
      scope: 'whole_change',
      round: 1,
      verdict: 'FAIL',
      roleId: 'independent-reviewer',
      independent: true,
      readOnly: true,
      blockers: ['Integration evidence is missing'],
      notes: [],
      evidenceIds: [],
      reviewedAt: 2,
    },
  });
  assert.equal(graph.nodes['review-fix-whole_change-1-1'].status, 'pending');
});

test('decisions and reference artifacts retain evidence and requirement traceability', () => {
  const store = new InMemoryExecutionStore();
  const actions = new StoreExecutionActionController(store);
  let graph = store.create({
    id: 'delivery-artifacts',
    goal: 'Retain a reference',
    deliveryCase: {
      depth: 'minimal',
      riskLevel: 'low',
      requirements: [{ id: 'reference', statement: 'Reference is retained', required: true }],
    },
  });
  graph = store.append(graph.id, {
    expectedRevision: graph.revision,
    type: 'evidence.recorded',
    data: {
      evidence: {
        id: 'reference-evidence',
        kind: 'citation',
        summary: 'Reference captured',
        createdAt: 1,
        digest: 'sha256:reference',
      },
    },
  });
  graph = actions.execute(graph.id, graph.revision, {
    type: 'record_decision',
    decision: {
      id: 'decision-1',
      summary: 'Use the reference',
      rationale: 'It covers the requirement',
      createdAt: 2,
    },
  });
  graph = actions.execute(graph.id, graph.revision, {
    type: 'record_artifact',
    artifact: {
      id: 'reference-1',
      kind: 'reference',
      evidenceId: 'reference-evidence',
      digest: 'sha256:reference',
      requirementIds: ['reference'],
    },
  });
  assert.equal(graph.deliveryCase.decisions[0].id, 'decision-1');
  assert.equal(graph.deliveryCase.artifacts[0].evidenceId, 'reference-evidence');
});
