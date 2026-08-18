#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompletionArbiter,
  CompletionReportGenerator,
  InMemoryExecutionStore,
} from '../dist/orchestration/index.js';

function append(store, graphId, input) {
  const graph = store.load(graphId);
  return store.append(graphId, { expectedRevision: graph.revision, ...input });
}

function createVerifyingCase(id, withRequirementEvidence = true) {
  const store = new InMemoryExecutionStore();
  store.create({
    id,
    goal: 'Deliver a reviewed workflow',
    deliveryCase: {
      depth: 'standard',
      riskLevel: 'medium',
      requirements: [{ id: 'req-1', statement: 'Workflow is correct', required: true }],
    },
  });
  append(store, id, {
    type: 'delivery.elaboration_recorded',
    data: {
      round: {
        id: 'round-1',
        index: 1,
        createdAt: 1,
        resolved: true,
        questions: [
          {
            id: 'q-1',
            prompt: 'Is the requirement complete?',
            options: ['Yes', 'No'],
            answer: 'Yes',
            status: 'answered',
          },
        ],
      },
    },
  });
  append(store, id, {
    type: 'delivery.proposal_recorded',
    data: {
      proposal: {
        revision: 1,
        summary: 'Implement the reviewed workflow',
        requirementIds: ['req-1'],
        nodeIds: [],
        requiresApproval: false,
        evidenceIds: [],
      },
    },
  });
  append(store, id, {
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
        reviewedAt: 2,
      },
      fixNodes: [],
    },
  });
  append(store, id, { type: 'delivery.stage_changed', data: { stage: 'executing' } });
  if (withRequirementEvidence) {
    append(store, id, {
      type: 'evidence.recorded',
      data: {
        evidence: {
          id: 'requirement-evidence-1',
          kind: 'verification',
          summary: 'Requirement verified',
          createdAt: 2,
          metadata: { requirementId: 'req-1' },
        },
      },
    });
  }
  append(store, id, { type: 'delivery.stage_changed', data: { stage: 'verifying' } });
  append(store, id, { type: 'graph.resumed' });
  return store;
}

test('standard delivery cannot complete until an independent whole-change review passes', async () => {
  const store = createVerifyingCase('review-pass');
  const missingReview = await new CompletionArbiter(store).decide('review-pass', {
    taskKind: 'analysis',
  });
  assert.equal(missingReview.verdict, 'needs_evidence');
  assert.match(missingReview.reasons.join('\n'), /whole-change review/i);

  let graph = append(store, 'review-pass', { type: 'graph.resumed' });
  graph = append(store, graph.id, {
    type: 'delivery.review_recorded',
    data: {
      review: {
        id: 'review-1',
        scope: 'whole_change',
        round: 1,
        verdict: 'PASS_WITH_NOTES',
        roleId: 'independent-reviewer',
        independent: true,
        readOnly: true,
        blockers: [],
        notes: ['Document the rollout'],
        evidenceIds: [],
        reviewedAt: 20,
      },
      fixNodes: [],
    },
  });
  const accepted = await new CompletionArbiter(store).decide(graph.id, { taskKind: 'analysis' });
  assert.equal(accepted.verdict, 'verified');

  const acceptedRevision = store.load(graph.id).revision;
  append(store, graph.id, { type: 'budget.updated', data: { usedTokens: 1 } });
  assert.throws(
    () =>
      new CompletionReportGenerator(store).generate(
        graph.id,
        {
          summary: 'Stale report must not publish.',
          metrics: { humanInterventions: 1 },
        },
        acceptedRevision
      ),
    /revision/
  );
  graph = new CompletionReportGenerator(store).generate(graph.id, {
    summary: 'The reviewed workflow shipped.',
    knownLimitations: [],
    metrics: { humanInterventions: 1 },
    createdAt: 30,
  });
  assert.equal(graph.deliveryCase.stage, 'completed');
  assert.equal(graph.deliveryCase.completionReport.id, `report-${graph.id}-${graph.revision}`);
  assert.deepEqual(graph.deliveryCase.completionReport.requirementCoverage, [
    { requirementId: 'req-1', covered: true, evidenceIds: ['requirement-evidence-1'] },
  ]);
});

test('a third partial whole-change review blocks for manual intervention', () => {
  const store = createVerifyingCase('review-partial-limit');
  for (let round = 1; round <= 3; round += 1) {
    const fixNodes =
      round < 3
        ? [
            {
              id: `partial-fix-${round}`,
              kind: 'implementation',
              title: `Fix partial review ${round}`,
              dependencies: [],
              writePaths: [`src/fix-${round}`],
              acceptanceCriteria: [`Partial review ${round} is resolved`],
            },
          ]
        : [];
    append(store, 'review-partial-limit', {
      type: 'delivery.review_recorded',
      data: {
        review: {
          id: `review-partial-${round}`,
          scope: 'whole_change',
          round,
          verdict: 'PARTIAL',
          roleId: 'independent-reviewer',
          independent: true,
          readOnly: true,
          blockers: [`Gap ${round}`],
          notes: [],
          evidenceIds: [],
          reviewedAt: 20 + round,
        },
        fixNodes,
      },
    });
  }
  assert.equal(store.load('review-partial-limit').deliveryCase.stage, 'blocked');
});

test('failed review atomically records blockers and creates acceptance-bound fix nodes', () => {
  const store = createVerifyingCase('review-fail');
  const graph = append(store, 'review-fail', {
    type: 'delivery.review_recorded',
    data: {
      review: {
        id: 'review-fail-1',
        scope: 'whole_change',
        round: 1,
        verdict: 'FAIL',
        roleId: 'independent-reviewer',
        independent: true,
        readOnly: true,
        blockers: ['Integration contract is inconsistent'],
        notes: [],
        evidenceIds: [],
        reviewedAt: 20,
      },
      fixNodes: [
        {
          id: 'review-fix-1',
          kind: 'implementation',
          title: 'Fix integration contract',
          dependencies: [],
          writePaths: ['src/'],
          acceptanceCriteria: ['Integration contract is consistent'],
        },
      ],
    },
  });
  assert.equal(
    graph.deliveryCase.reviews.find((review) => review.scope === 'whole_change').verdict,
    'FAIL'
  );
  assert.equal(graph.nodes['review-fix-1'].status, 'pending');
});

test('completion report generation rejects a required requirement without graph evidence', async () => {
  const store = createVerifyingCase('report-uncovered', false);
  let graph = store.load('report-uncovered');
  graph = append(store, graph.id, {
    type: 'delivery.review_recorded',
    data: {
      review: {
        id: 'review-uncovered',
        scope: 'whole_change',
        round: 1,
        verdict: 'PASS',
        roleId: 'independent-reviewer',
        independent: true,
        readOnly: true,
        blockers: [],
        notes: [],
        evidenceIds: [],
        reviewedAt: 20,
      },
      fixNodes: [],
    },
  });
  await new CompletionArbiter(store).decide(graph.id, { taskKind: 'analysis' });
  assert.throws(
    () =>
      new CompletionReportGenerator(store).generate(graph.id, {
        summary: 'Must not publish',
        metrics: { humanInterventions: 0 },
      }),
    /lacks evidence/
  );
  graph = store.load(graph.id);
  assert.throws(
    () =>
      store.append(graph.id, {
        expectedRevision: graph.revision,
        type: 'delivery.reported',
        data: {
          report: {
            id: 'forged-report',
            summary: 'Forged coverage',
            requirementCoverage: [
              { requirementId: 'req-1', covered: true, evidenceIds: ['missing-evidence'] },
            ],
            decisions: [],
            changedArtifacts: [],
            verificationEvidenceIds: graph.verification.evidenceIds,
            reviewIds: ['review-uncovered'],
            knownLimitations: [],
            followUps: [],
            metrics: { humanInterventions: 0 },
            createdAt: 30,
          },
        },
      }),
    /unknown requirement evidence/
  );
});
