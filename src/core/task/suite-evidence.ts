/**
 * One passing (or failing) test/build run is evidence for every acceptance
 * item that run covers. The harness writes the suite metrics; acceptance
 * reads them and applies them to those items, so a small goal does not need
 * a model turn per criterion.
 */
import type { AcceptanceCriterion, TaskContract } from '../../contracts/task.js';
import type { EvidenceRecord } from '../../contracts/evidence.js';
import { appendEvidenceRecord, listTaskRecords } from '../task-runtime/artifacts.js';
import { findLatestLiveTaskSnapshot, getTaskStateSnapshot } from './task-store.js';
import { classifyGoalScale, countRepoFiles, type GoalScale } from './goal-scale.js';

export const HARNESS_SUITE_SOURCES = new Set(['run_tests', 'verify_fix', 'acceptance_command']);

const DEVICE_METRIC =
  /camera|fps|gpio|temperature|topic_hz|\bros\b|imu|voltage|deploy|firmware|latency/i;

export interface HarnessSuite {
  source: string;
  timestamp: number;
  output: string;
  tests?: boolean;
  build?: boolean;
  typecheck?: boolean;
}

function isDeviceCriterion(criterion: AcceptanceCriterion): boolean {
  return DEVICE_METRIC.test(criterion.metric) || DEVICE_METRIC.test(criterion.description ?? '');
}

/** True when this suite result is the proof for the criterion. */
export function suiteApplies(
  criterion: AcceptanceCriterion,
  suite: HarnessSuite,
  scale: GoalScale
): boolean {
  if (isDeviceCriterion(criterion)) return false;
  const metric = criterion.metric.toLowerCase();
  if (metric === 'tests_pass' || /(?:^|_)tests?(?:_|$)|suite|spec/.test(metric)) {
    return suite.tests !== undefined;
  }
  if (metric === 'build_ok' || /build|compile/.test(metric)) {
    return suite.build !== undefined || suite.tests !== undefined;
  }
  if (metric === 'typecheck_ok' || /typecheck|tsc/.test(metric)) {
    return suite.typecheck !== undefined;
  }
  if (scale !== 'light') return false;
  const expected = criterion.expected.trim().toLowerCase();
  return expected === 'exists' || expected === '==true' || expected === '==pass';
}

function passedFor(criterion: AcceptanceCriterion, suite: HarnessSuite): boolean {
  const metric = criterion.metric.toLowerCase();
  if (metric === 'build_ok' || (/build|compile/.test(metric) && !/test/.test(metric))) {
    return suite.build === true || (suite.build === undefined && suite.tests === true);
  }
  if (metric === 'typecheck_ok' || /typecheck|tsc/.test(metric)) {
    return suite.typecheck === true;
  }
  return suite.tests === true;
}

function observedFor(
  criterion: AcceptanceCriterion,
  passed: boolean,
  output: string
): string | boolean {
  const expected = criterion.expected.trim();
  if (!passed) {
    if (/^==\s*true$/i.test(expected)) return false;
    if (/^exists$/i.test(expected)) return 'missing';
    return 'failed';
  }
  if (/^==\s*true$/i.test(expected)) return true;
  if (/^==\s*pass$/i.test(expected)) return 'pass';
  if (/^exists$/i.test(expected)) return 'exists';
  const contains = /^contains\s+(.+)$/i.exec(expected);
  if (contains?.[1] && output.includes(contains[1])) return contains[1];
  const eq = /^==\s*(.+)$/.exec(expected);
  if (eq?.[1] && !Number.isFinite(Number(eq[1])) && output.includes(eq[1])) return eq[1];
  return true;
}

function latestByMetric(evidence: readonly EvidenceRecord[], taskId: string): HarnessSuite | null {
  let tests: EvidenceRecord | undefined;
  let build: EvidenceRecord | undefined;
  let typecheck: EvidenceRecord | undefined;
  for (const record of evidence) {
    if (record.taskId && record.taskId !== taskId) continue;
    if (!HARNESS_SUITE_SOURCES.has(record.source)) continue;
    const take = (current: EvidenceRecord | undefined): EvidenceRecord | undefined =>
      !current || record.timestamp >= current.timestamp ? record : current;
    if (record.metric === 'tests_pass') tests = take(tests);
    else if (record.metric === 'build_ok') build = take(build);
    else if (record.metric === 'typecheck_ok') typecheck = take(typecheck);
  }
  const newest = [tests, build, typecheck]
    .filter((record): record is EvidenceRecord => record !== undefined)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  if (!newest) return null;
  const flag = (record: EvidenceRecord | undefined): boolean | undefined =>
    record ? record.result === 'pass' : undefined;
  return {
    source: newest.source,
    timestamp: newest.timestamp,
    output: newest.details ?? '',
    ...(tests ? { tests: flag(tests) } : {}),
    ...(build ? { build: flag(build) } : {}),
    ...(typecheck ? { typecheck: flag(typecheck) } : {}),
  };
}

/**
 * Virtual evidence so acceptance can consume a suite run that was recorded
 * under tests_pass / build_ok / typecheck_ok. A later per-metric record still
 * wins.
 */
export function expandSuiteEvidence(
  task: TaskContract,
  evidence: readonly EvidenceRecord[],
  scale: GoalScale
): EvidenceRecord[] {
  const suite = latestByMetric(evidence, task.taskId);
  if (!suite) return [...evidence];
  const extra: EvidenceRecord[] = [];
  for (const criterion of task.acceptanceCriteria) {
    if (!suiteApplies(criterion, suite, scale)) continue;
    const existing = evidence.reduce<EvidenceRecord | undefined>((latest, record) => {
      if (record.taskId && record.taskId !== task.taskId) return latest;
      if (record.metric !== criterion.metric) return latest;
      if (!latest || record.timestamp >= latest.timestamp) return record;
      return latest;
    }, undefined);
    if (existing && existing.timestamp > suite.timestamp) continue;
    if (
      existing &&
      existing.timestamp === suite.timestamp &&
      existing.metric === criterion.metric &&
      existing.source !== suite.source
    ) {
      continue;
    }
    const passed = passedFor(criterion, suite);
    extra.push({
      evidenceId: `ev_suite_${criterion.metric}_${suite.timestamp}`,
      taskId: task.taskId,
      source: suite.source,
      metric: criterion.metric,
      expected: criterion.expected,
      observed: observedFor(criterion, passed, suite.output),
      result: passed ? 'pass' : 'fail',
      timestamp: suite.timestamp,
      ...(suite.output ? { details: suite.output.slice(0, 500) } : {}),
    });
  }
  return extra.length > 0 ? [...evidence, ...extra] : [...evidence];
}

async function scaleForTask(workspaceDir: string, task: TaskContract): Promise<GoalScale> {
  const snapshot = await getTaskStateSnapshot(workspaceDir, task.taskId);
  const planSteps = snapshot && snapshot.plan.length > 0 ? snapshot.plan.length : undefined;
  const repoFileCount = planSteps === undefined ? await countRepoFiles(workspaceDir) : 0;
  return classifyGoalScale({
    goal: task.goal,
    repoFileCount,
    ...(planSteps !== undefined ? { planSteps } : {}),
  });
}

function evidenceId(metric: string): string {
  return `ev_${Date.now().toString(36)}_${metric}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Persist the suite result and one row per covered acceptance item.
 * No live task means ordinary chat: write nothing.
 */
export async function recordHarnessSuiteEvidence(input: {
  workspaceDir: string;
  taskId?: string;
  source: 'run_tests' | 'verify_fix' | 'acceptance_command';
  testsPassed?: boolean;
  buildPassed?: boolean;
  typecheckPassed?: boolean;
  output?: string;
}): Promise<number> {
  try {
    const taskId = input.taskId ?? (await findLatestLiveTaskSnapshot(input.workspaceDir))?.taskId;
    if (!taskId) return 0;
    const tasks = await listTaskRecords(input.workspaceDir);
    const task = tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) return 0;
    const scale = await scaleForTask(input.workspaceDir, task);
    const output = (input.output ?? '').slice(0, 500);
    const base = Date.now();
    const canonical: Array<{ metric: string; passed: boolean }> = [];
    if (input.testsPassed !== undefined) {
      canonical.push({ metric: 'tests_pass', passed: input.testsPassed });
    }
    if (input.buildPassed !== undefined) {
      canonical.push({ metric: 'build_ok', passed: input.buildPassed });
    }
    if (input.typecheckPassed !== undefined) {
      canonical.push({ metric: 'typecheck_ok', passed: input.typecheckPassed });
    }
    if (canonical.length === 0) return 0;
    const suite: HarnessSuite = {
      source: input.source,
      timestamp: base,
      output,
      ...(input.testsPassed !== undefined ? { tests: input.testsPassed } : {}),
      ...(input.buildPassed !== undefined ? { build: input.buildPassed } : {}),
      ...(input.typecheckPassed !== undefined ? { typecheck: input.typecheckPassed } : {}),
    };
    const rows: EvidenceRecord[] = canonical.map((row, index) => ({
      evidenceId: evidenceId(row.metric),
      taskId,
      source: input.source,
      metric: row.metric,
      expected: '==true',
      observed: row.passed,
      result: row.passed ? 'pass' : 'fail',
      timestamp: base + index,
      ...(output ? { details: output } : {}),
    }));
    let offset = canonical.length;
    for (const criterion of task.acceptanceCriteria) {
      if (canonical.some((row) => row.metric === criterion.metric)) continue;
      if (!suiteApplies(criterion, suite, scale)) continue;
      const passed = passedFor(criterion, suite);
      rows.push({
        evidenceId: evidenceId(criterion.metric),
        taskId,
        source: input.source,
        metric: criterion.metric,
        expected: criterion.expected,
        observed: observedFor(criterion, passed, output),
        result: passed ? 'pass' : 'fail',
        timestamp: base + offset,
        ...(output ? { details: output } : {}),
      });
      offset += 1;
    }
    for (const row of rows) {
      await appendEvidenceRecord(input.workspaceDir, row);
    }
    return rows.length;
  } catch {
    return 0;
  }
}

export async function goalScaleForWorkspace(
  workspaceDir: string,
  task: TaskContract
): Promise<GoalScale> {
  return scaleForTask(workspaceDir, task);
}
