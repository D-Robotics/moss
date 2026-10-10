/**
 * A test, build, or typecheck run is evidence only for the metric it
 * measured: tests_pass, build_ok, or typecheck_ok, by exact name. Other
 * acceptance items still need record_evidence.
 *
 * Ordinary chat writes nothing. A task id, or a goal/task engine turn,
 * is required so run_tests cannot close an unfinished goal.
 */
import type { EvidenceRecord } from '../../contracts/evidence.js';
import { appendEvidenceRecord } from '../task-runtime/artifacts.js';
import { findLatestLiveTaskSnapshot } from './task-store.js';

function evidenceId(metric: string): string {
  return `ev_${Date.now().toString(36)}_${metric}_${Math.random().toString(36).slice(2, 6)}`;
}

export async function recordHarnessSuiteEvidence(input: {
  workspaceDir: string;
  taskId?: string;
  /** True only inside a goal/task engine turn. */
  taskTurn?: boolean;
  source: 'run_tests' | 'verify_fix' | 'acceptance_command';
  testsPassed?: boolean;
  buildPassed?: boolean;
  typecheckPassed?: boolean;
  output?: string;
}): Promise<number> {
  try {
    const taskId =
      input.taskId ??
      (input.taskTurn === true
        ? (await findLatestLiveTaskSnapshot(input.workspaceDir))?.taskId
        : undefined);
    if (!taskId) return 0;
    const rows: Array<{ metric: string; passed: boolean }> = [];
    if (input.testsPassed !== undefined) {
      rows.push({ metric: 'tests_pass', passed: input.testsPassed });
    }
    if (input.buildPassed !== undefined) {
      rows.push({ metric: 'build_ok', passed: input.buildPassed });
    }
    if (input.typecheckPassed !== undefined) {
      rows.push({ metric: 'typecheck_ok', passed: input.typecheckPassed });
    }
    if (rows.length === 0) return 0;
    const output = (input.output ?? '').slice(0, 500);
    const base = Date.now();
    for (const [index, row] of rows.entries()) {
      const record: EvidenceRecord = {
        evidenceId: evidenceId(row.metric),
        taskId,
        source: input.source,
        metric: row.metric,
        expected: '==true',
        observed: row.passed,
        result: row.passed ? 'pass' : 'fail',
        timestamp: base + index,
        ...(output ? { details: output } : {}),
      };
      await appendEvidenceRecord(input.workspaceDir, record);
    }
    return rows.length;
  } catch {
    return 0;
  }
}
