/**
 * Task contract (robotics closed loop P0-1/P0-2) — turns a natural-language
 * goal into a machine-checkable object, and defines what "done" means:
 * acceptance criteria evaluated against recorded evidence. An acceptance
 * criterion without matching evidence is NOT met — the agent cannot declare
 * success by assertion.
 */

import type { EvidenceRecord } from './evidence.js';
import { evaluateExpectation } from './evidence.js';

export type TaskContractStatus = 'draft' | 'active' | 'accepted' | 'failed' | 'abandoned';

export interface AcceptanceCriterion {
  /** Evidence metric this criterion checks (e.g. 'camera_fps'). */
  metric: string;
  /** Expectation expression evaluated against the evidence observation ('>=30'). */
  expected: string;
  /** Default true. Optional criteria may miss without failing acceptance. */
  required?: boolean;
  description?: string;
}

export interface TaskContract {
  taskId: string;
  goal: string;
  constraints?: string[];
  targetDeviceId?: string;
  inputs?: string[];
  expectedBehavior?: string;
  acceptanceCriteria: AcceptanceCriterion[];
  /** How the agent intends to verify (steps, commands, probes). */
  verificationPlan?: string[];
  status: TaskContractStatus;
  createdAt: number;
  updatedAt: number;
}

export type CriterionCheckResult = 'pass' | 'fail' | 'no-evidence';

export interface CriterionVerdict {
  metric: string;
  expected: string;
  required: boolean;
  description?: string;
  evidenceId?: string;
  observed?: string | number | boolean;
  result: CriterionCheckResult;
  explanation?: string;
}

export interface AcceptanceVerdict {
  taskId: string;
  verdict: 'pass' | 'fail' | 'partial';
  acceptedAt: number;
  criteriaResults: CriterionVerdict[];
  /** Required criteria that failed or lack evidence. */
  unmetRequired: number;
  evidenceConsidered: number;
}

/**
 * Evaluate a task's acceptance criteria against its recorded evidence.
 * Latest evidence per metric wins — a repaired re-measurement supersedes the
 * earlier failure. Missing evidence for a required criterion is 'no-evidence'
 * and blocks acceptance: no evidence, no success.
 */
export function evaluateAcceptance(
  task: TaskContract,
  evidence: EvidenceRecord[]
): AcceptanceVerdict {
  const taskEvidence = evidence.filter((record) => record.taskId === task.taskId);
  const latestByMetric = new Map<string, EvidenceRecord>();
  for (const record of taskEvidence) {
    const existing = latestByMetric.get(record.metric);
    if (!existing || record.timestamp >= existing.timestamp) {
      latestByMetric.set(record.metric, record);
    }
  }

  const criteriaResults: CriterionVerdict[] = task.acceptanceCriteria.map((criterion) => {
    const required = criterion.required !== false;
    const base = {
      metric: criterion.metric,
      expected: criterion.expected,
      required,
      ...(criterion.description ? { description: criterion.description } : {}),
    };
    const record = latestByMetric.get(criterion.metric);
    if (!record) {
      return { ...base, result: 'no-evidence' as CriterionCheckResult };
    }
    const evaluation = evaluateExpectation(criterion.expected, record.observed);
    const result: CriterionCheckResult =
      evaluation.result === 'inconclusive' ? 'no-evidence' : evaluation.result;
    return {
      ...base,
      evidenceId: record.evidenceId,
      observed: record.observed,
      result,
      ...(evaluation.comparator !== 'none' || evaluation.explanation
        ? { explanation: evaluation.explanation }
        : {}),
    };
  });

  const unmetRequired = criteriaResults.filter((r) => r.required && r.result !== 'pass').length;
  const unmetOptional = criteriaResults.filter((r) => !r.required && r.result !== 'pass').length;

  const verdict: AcceptanceVerdict['verdict'] =
    unmetRequired > 0 ? 'fail' : unmetOptional > 0 ? 'partial' : 'pass';

  return {
    taskId: task.taskId,
    verdict,
    acceptedAt: Date.now(),
    criteriaResults,
    unmetRequired,
    evidenceConsidered: taskEvidence.length,
  };
}

export function formatAcceptanceVerdict(verdict: AcceptanceVerdict, task: TaskContract): string {
  const head =
    `Task acceptance (${verdict.taskId}): ${verdict.verdict.toUpperCase()}\n` +
    `goal: ${task.goal}`;
  const rows = verdict.criteriaResults.map((r) => {
    const flag = r.result === 'pass' ? 'PASS' : r.result === 'fail' ? 'FAIL' : 'NO EVIDENCE';
    const bits = [`  [${flag}] ${r.metric} — expected ${r.expected}`];
    if (r.observed !== undefined) bits.push(`observed ${r.observed}`);
    if (r.evidenceId) bits.push(`(${r.evidenceId})`);
    if (!r.required) bits.push('(optional)');
    if (r.explanation && r.result !== 'pass') bits.push(`— ${r.explanation}`);
    return bits.join(' ');
  });
  const tail = [
    `criteria: ${verdict.criteriaResults.length - verdict.unmetRequired}/${verdict.criteriaResults.length} met (${verdict.unmetRequired} required unmet), evidence records considered: ${verdict.evidenceConsidered}`,
    verdict.verdict === 'pass'
      ? 'FINAL: PASS — acceptance criteria met with recorded evidence.'
      : 'FINAL: not accepted — record evidence for the missing metrics (record_evidence with task_id), repair what failed, then re-run task_acceptance.',
  ].join('\n');
  return [head, ...rows, '', tail].join('\n');
}
