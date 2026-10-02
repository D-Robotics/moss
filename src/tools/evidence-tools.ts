import type {
  EvidenceRecord,
  EvidenceResult,
  EvidenceStoreSummary,
} from '../contracts/evidence.js';
import { evaluateExpectation } from '../contracts/evidence.js';
import type { Tool } from '../core/tools/tool-types.js';
import { appendEvidenceRecord, listEvidenceRecords } from '../core/task-runtime/artifacts.js';
import { tryAppendTaskEvent } from '../core/task/task-store.js';

// Canonical artifact IO lives in core (shared task runtime); re-exported here
// to keep the SDK surface stable.
export { appendEvidenceRecord, listEvidenceRecords } from '../core/task-runtime/artifacts.js';

function newEvidenceId(): string {
  return `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * record_evidence (robotics closed loop P0-8): the structured sink for every
 * success/failure claim. "Agent said success" is not task success — a claim
 * reduces to evidence records with an evaluated expectation, persisted to
 * workspace .moss/evidence.jsonl for acceptance and later analysis.
 */

export function summarizeEvidence(records: EvidenceRecord[]): EvidenceStoreSummary {
  const summary: EvidenceStoreSummary = {
    total: records.length,
    passed: 0,
    failed: 0,
    inconclusive: 0,
  };
  for (const record of records) {
    if (record.result === 'pass') summary.passed++;
    else if (record.result === 'fail') summary.failed++;
    else summary.inconclusive++;
  }
  return summary;
}

function formatRecord(record: EvidenceRecord, explanation?: string): string {
  const verdict =
    record.result === 'pass' ? 'PASS' : record.result === 'fail' ? 'FAIL' : 'INCONCLUSIVE';
  const lines = [
    `evidence ${record.evidenceId}: ${verdict} — ${record.metric}` +
      (record.expected !== undefined ? ` (expected ${record.expected})` : '') +
      (record.observed !== undefined ? ` (observed ${record.observed})` : ''),
  ];
  if (explanation) lines.push(`  check: ${explanation}`);
  const origin = [
    record.source,
    record.deviceId ? `device=${record.deviceId}` : '',
    record.taskId ? `task=${record.taskId}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (origin) lines.push(`  origin: ${origin}`);
  if (record.details) lines.push(`  details: ${record.details.slice(0, 400)}`);
  return lines.join('\n');
}

export const recordEvidenceTool: Tool = {
  name: 'record_evidence',
  description:
    'Record one structured piece of verification evidence: metric, expected, observed, verdict — persisted to .moss/evidence.jsonl. Every success claim in a task must be backed by recorded evidence ("No Evidence, No Success"): after running a check (test run, device probe, deploy health check), record what was measured instead of asserting success in prose.\n' +
    '- Give expected + observed to auto-evaluate (e.g. expected ">=30", observed 31.2).\n' +
    '- Give an explicit result only for externally-determined verdicts (e.g. human observation), without expected/observed.\n' +
    '- An explicit result that conflicts with the expected/observed auto-evaluation is recorded as inconclusive with the conflict explained — it is never silently rewritten in either direction.\n' +
    '- source: which check produced this (device_exec, device_deploy, run_tests, exec, human…).',
  metadata: {
    sideEffectClass: 'runtime_state',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      metric: {
        type: 'string',
        description: 'What was measured (e.g. camera_fps, process_alive:app)',
      },
      expected: {
        type: 'string',
        description:
          'Expectation expression: >=30, <=5, ==4, !=1, contains err, not-contains fail, exists, matches ^active$',
      },
      observed: {
        type: 'string',
        description:
          'The observed value (numbers as strings are compared numerically, e.g. "31.2")',
      },
      result: {
        type: 'string',
        description: 'Explicit verdict pass|fail|inconclusive (only when not auto-evaluating)',
        enum: ['pass', 'fail', 'inconclusive'],
      },
      source: {
        type: 'string',
        description: 'Where the observation came from (device_exec, run_tests, human…)',
      },
      device_id: { type: 'string', description: 'Device this evidence was measured on (optional)' },
      task_id: { type: 'string', description: 'Task this evidence belongs to (optional)' },
      details: { type: 'string', description: 'Raw output / extra context (optional)' },
    },
    required: ['metric', 'source'],
  },
  normalizeInput(input, _ctx) {
    if (
      input &&
      typeof input === 'object' &&
      input.observed !== undefined &&
      typeof input.observed !== 'string'
    ) {
      return { ...input, observed: String(input.observed) };
    }
    return input;
  },
  async execute(input, ctx) {
    const metric = String(input.metric ?? '').trim();
    const source = String(input.source ?? '').trim();
    if (!metric) return 'Error: record_evidence: metric is required.';
    if (!source) return 'Error: record_evidence: source is required.';

    const observed =
      input.observed === undefined
        ? undefined
        : typeof input.observed === 'string' ||
            typeof input.observed === 'number' ||
            typeof input.observed === 'boolean'
          ? input.observed
          : String(input.observed);

    const explicitResult =
      input.result === 'pass' || input.result === 'fail' || input.result === 'inconclusive'
        ? (input.result as EvidenceResult)
        : undefined;

    let result: EvidenceResult;
    let explanation: string | undefined;
    let comparator: EvidenceRecord['comparator'];
    const expected =
      input.expected === undefined || input.expected === null ? undefined : String(input.expected);

    if (expected !== undefined && expected.trim() !== '') {
      const evaluation = evaluateExpectation(expected, observed);
      if (evaluation.comparator !== 'none') comparator = evaluation.comparator;
      if (explicitResult !== undefined && explicitResult !== evaluation.result) {
        // F24: a conflict between the caller's explicit verdict and the
        // auto-evaluation is never silently rewritten in either direction —
        // it surfaces as inconclusive with both sides named, so a false PASS
        // cannot be manufactured and an honest FAIL cannot be discarded.
        result = 'inconclusive';
        explanation =
          `explicit result "${explicitResult}" conflicts with auto-evaluation "${evaluation.result}" ` +
          `(${evaluation.explanation}) — recorded inconclusive; re-measure or correct expected/observed`;
      } else {
        result = evaluation.result;
        explanation = evaluation.explanation;
      }
    } else if (explicitResult) {
      result = explicitResult;
    } else if (observed !== undefined) {
      result = 'inconclusive';
      explanation = 'observed value without expectation — no verdict derivable';
    } else {
      return 'Error: record_evidence: give expected+observed (auto-evaluated) or an explicit result.';
    }

    const record: EvidenceRecord = {
      evidenceId: newEvidenceId(),
      source,
      metric,
      result,
      timestamp: Date.now(),
      ...(expected !== undefined ? { expected } : {}),
      ...(observed !== undefined ? { observed } : {}),
      ...(comparator ? { comparator } : {}),
      ...(input.device_id ? { deviceId: String(input.device_id) } : {}),
      ...(input.task_id ? { taskId: String(input.task_id) } : {}),
      ...(input.details ? { details: String(input.details) } : {}),
    };
    try {
      await appendEvidenceRecord(ctx.workspaceDir, record);
    } catch (err) {
      return `Error: record_evidence: cannot persist to .moss/evidence.jsonl: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (record.taskId) {
      // Task OS M4: keep the unified runtime's timeline in sync (info event;
      // no-op when the task is settled or unknown to the runtime).
      await tryAppendTaskEvent(ctx.workspaceDir, record.taskId, 'evidence_recorded', {
        metric: record.metric,
        result: record.result,
      }).catch(() => undefined);
    }
    const summary = summarizeEvidence(await listEvidenceRecords(ctx.workspaceDir));
    return (
      formatRecord(record, explanation) +
      `\n  workspace evidence: ${summary.passed} pass / ${summary.failed} fail / ${summary.inconclusive} inconclusive of ${summary.total}`
    );
  },
};

export const evidenceTools: Tool[] = [recordEvidenceTool];
