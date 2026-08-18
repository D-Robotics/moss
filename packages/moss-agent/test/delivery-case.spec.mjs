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
    type: 'delivery.review_recorded',
    data: {
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
        reviewedAt: 19,
      },
      fixNodes: [],
    },
  });

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

test('elaboration answers resolve only when required answers are valid and conflict-free', () => {
  const store = new InMemoryExecutionStore();
  let graph = store.create({
    id: 'delivery-answers',
    goal: 'Clarify safely',
    deliveryCase: { depth: 'standard', riskLevel: 'medium', requirements: [] },
  });
  graph = append(store, graph.id, {
    type: 'delivery.elaboration_recorded',
    data: {
      round: {
        id: 'round-1',
        index: 1,
        createdAt: 1,
        resolved: false,
        questions: [
          {
            id: 'q-text',
            prompt: 'What outcome?',
            options: [],
            kind: 'text',
            required: true,
            status: 'unanswered',
          },
          {
            id: 'q-risk',
            prompt: 'Confirm risk?',
            options: ['Confirm', 'Revise'],
            kind: 'risk_confirmation',
            required: true,
            status: 'unanswered',
          },
        ],
      },
    },
  });
  graph = append(store, graph.id, {
    type: 'delivery.elaboration_answered',
    data: {
      roundId: 'round-1',
      answers: { 'q-text': 'Observable result', 'q-risk': 'Confirm' },
      conflictQuestionIds: ['q-risk'],
    },
  });
  assert.equal(graph.deliveryCase.elaborationRounds[0].resolved, false);
  assert.deepEqual(graph.deliveryCase.elaborationRounds[0].conflicts, ['q-risk']);
  graph = append(store, graph.id, {
    type: 'delivery.elaboration_answered',
    data: {
      roundId: 'round-1',
      answers: { 'q-risk': 'Confirm' },
      conflictQuestionIds: [],
    },
  });
  assert.equal(graph.deliveryCase.elaborationRounds[0].resolved, true);
  assert.ok(graph.deliveryCase.elaborationRounds[0].resolvedAt);
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

test('direct execution creation receives delivery authority and high-risk work cannot resume early', () => {
  const store = new InMemoryExecutionStore();
  const graph = store.create({
    id: 'direct-secure-task',
    goal: 'Migrate the public plugin permission API and security gate',
    nodes: [],
  });
  assert.equal(graph.deliveryCase.depth, 'comprehensive');
  assert.equal(graph.deliveryCase.stage, 'intake');
  assert.throws(
    () => append(store, graph.id, { type: 'graph.resumed' }),
    /cannot resume while comprehensive delivery is intake/
  );
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

test('acceptance verdict is evidence-bound to the current contract revision and becomes stale', () => {
  const store = new InMemoryExecutionStore();
  let graph = store.create({
    id: 'acceptance-verdict',
    goal: 'Implement evidence-bound output',
    nodes: [
      {
        id: 'work',
        kind: 'implementation',
        title: 'Work',
        dependencies: [],
        writePaths: ['src'],
        acceptanceCriteria: ['Output is verified'],
      },
    ],
  });
  graph = store.append(graph.id, {
    expectedRevision: graph.revision,
    type: 'evidence.recorded',
    nodeId: 'work',
    data: {
      evidence: {
        id: 'criterion-evidence',
        kind: 'verification',
        nodeId: 'work',
        summary: 'Output is verified',
        createdAt: 2,
        metadata: { criterion: 'criterion-1', contractRevision: 1 },
      },
    },
  });
  graph = store.append(graph.id, {
    expectedRevision: graph.revision,
    type: 'acceptance.verdict_recorded',
    nodeId: 'work',
    data: {
      verdict: {
        verdict: 'PASS',
        contractRevision: 1,
        evidenceIds: ['criterion-evidence'],
        reasons: [],
        decidedAt: 3,
      },
    },
  });
  assert.equal(graph.nodes.work.acceptanceVerdict.verdict, 'PASS');
  graph = store.append(graph.id, {
    expectedRevision: graph.revision,
    type: 'acceptance.revised',
    nodeId: 'work',
    data: {
      contract: {
        revision: 2,
        criteria: [
          {
            id: 'criterion-2',
            description: 'Revised output is verified',
            kind: 'deterministic',
            required: true,
          },
        ],
        verificationPolicy: 'all_required',
      },
    },
  });
  assert.equal(graph.nodes.work.acceptanceVerdict.verdict, 'STALE');
  assert.throws(
    () =>
      store.append(graph.id, {
        expectedRevision: graph.revision,
        type: 'acceptance.verdict_recorded',
        nodeId: 'work',
        data: {
          verdict: {
            verdict: 'PASS',
            contractRevision: 1,
            evidenceIds: ['criterion-evidence'],
            reasons: [],
            decidedAt: 4,
          },
        },
      }),
    /revision 2/
  );
});
