import { CandidatePatchLog, type CandidatePatchRecord } from './candidate-patch-log.js';
import {
  PatchExperimentLog,
  type PatchExperimentAssignment,
  type PatchExperimentDecision,
  type PatchExperimentExposure,
  type PatchExperimentOutcome,
  type PatchExperimentRecord,
} from './patch-experiment-log.js';
import { CrossSignalLog, type CrossSignalObservation } from '../acceptance/cross-signal-log.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';

export interface SelfEvolutionSnapshot {
  patches: CandidatePatchRecord[];
  records: PatchExperimentRecord[];
  crossSignals: CrossSignalObservation[];
}

export async function readSelfEvolutionSnapshot(workspaceDir: string): Promise<SelfEvolutionSnapshot> {
  const memoryDir = getMossWorkspacePaths(workspaceDir).memoryDir;
  const patchLog = new CandidatePatchLog({ baseDir: memoryDir });
  const experimentLog = new PatchExperimentLog({ baseDir: memoryDir });
  const crossSignalLog = new CrossSignalLog({ baseDir: memoryDir });
  return { patches: await patchLog.latest(), records: await experimentLog.readAll(), crossSignals: await crossSignalLog.readAll() };
}

function countBy<T extends string>(values: T[]): string {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].map(([key, value]) => `${key}=${value}`).join(', ') || 'none';
}

function latestDecisions(records: PatchExperimentRecord[]): PatchExperimentDecision[] {
  const map = new Map<string, PatchExperimentDecision>();
  for (const record of records) {
    if (record.kind !== 'decision') continue;
    const previous = map.get(record.patchId);
    if (!previous || record.revision >= previous.revision) map.set(record.patchId, record);
  }
  return [...map.values()];
}

export function formatSelfEvolutionStatus(snapshot: SelfEvolutionSnapshot): string {
  const assignments = snapshot.records.filter((record): record is PatchExperimentAssignment => record.kind === 'assignment');
  const exposures = snapshot.records.filter((record): record is PatchExperimentExposure => record.kind === 'exposure');
  const outcomes = snapshot.records.filter((record): record is PatchExperimentOutcome => record.kind === 'outcome');
  const decisions = latestDecisions(snapshot.records);
  return [
    'Trusted self-evolution status',
    `  patches: ${snapshot.patches.length} (${countBy(snapshot.patches.map((patch) => patch.state))})`,
    `  experiments: assignments=${assignments.length}, exposureReceipts=${exposures.length}, outcomes=${outcomes.length}, eligible=${outcomes.filter((entry) => entry.eligible).length}, excluded=${outcomes.filter((entry) => !entry.eligible).length}`,
    `  lifecycle: ${countBy(decisions.map((decision) => decision.state))}`,
    `  safety failures: ${outcomes.filter((entry) => entry.safetyFailed).length}`,
    `  cross signals: ${snapshot.crossSignals.length}`,
    `  logs: candidates=${snapshot.patches.length ? 'available' : 'empty'}, experiments=${snapshot.records.length ? 'available' : 'empty'}`,
  ].join('\n');
}

export function formatSelfEvolutionExperiments(snapshot: SelfEvolutionSnapshot): string {
  const decisions = latestDecisions(snapshot.records);
  if (!snapshot.patches.length) return 'No trusted self-evolution patches found.';
  const lines = ['Trusted self-evolution experiments'];
  for (const patch of snapshot.patches.sort((a, b) => a.id.localeCompare(b.id))) {
    const decision = decisions.find((entry) => entry.patchId === patch.id);
    const assignments = snapshot.records.filter((entry) => entry.kind === 'assignment' && entry.patchId === patch.id) as PatchExperimentAssignment[];
    const outcomes = snapshot.records.filter((entry) => entry.kind === 'outcome' && entry.patchId === patch.id) as PatchExperimentOutcome[];
    lines.push(`  ${patch.id} skill=${patch.skill} domain=${patch.executionDomain ?? 'legacy'} patch=${patch.state} experiment=${decision?.state ?? 'not-started'} assignments=${assignments.length} exposed=${assignments.filter((entry) => entry.exposed).length} outcomes=${outcomes.length} eligible=${outcomes.filter((entry) => entry.eligible).length} excluded=${outcomes.filter((entry) => !entry.eligible).length}`);
  }
  return lines.join('\n');
}

function armLine(label: string, arm: PatchExperimentDecision['control']): string {
  const cost = arm.averageCostUsd === undefined ? 'n/a' : `$${arm.averageCostUsd.toFixed(6)}`;
  return `  ${label}: n=${arm.total}, excluded=${arm.excluded ?? 0}, success=${(arm.successRate * 100).toFixed(1)}% CI=[${(arm.wilsonLow * 100).toFixed(1)},${(arm.wilsonHigh * 100).toFixed(1)}], retries=${arm.averageRetries.toFixed(2)}, corrections=${arm.averageCorrections?.toFixed(2) ?? 'n/a'}, tools=${arm.averageToolCalls.toFixed(2)}, durationMs=${arm.averageDurationMs.toFixed(0)}, tokens=${(arm.averageInputTokens + arm.averageOutputTokens).toFixed(0)}, cost=${cost}, safety=${arm.safetyFailures}, newFailures=${arm.newFailureClasses?.join(',') || 'none'}`;
}

export function formatSelfEvolutionPatch(snapshot: SelfEvolutionSnapshot, patchId: string): string | null {
  const patch = snapshot.patches.find((entry) => entry.id === patchId);
  if (!patch) return null;
  const decisions = latestDecisions(snapshot.records);
  const decision = decisions.find((entry) => entry.patchId === patchId);
  const assignments = snapshot.records.filter((entry): entry is PatchExperimentAssignment => entry.kind === 'assignment' && entry.patchId === patchId);
  const outcomes = snapshot.records.filter((entry): entry is PatchExperimentOutcome => entry.kind === 'outcome' && entry.patchId === patchId);
  return [
    `Trusted patch ${patch.id}`,
    `  skill: ${patch.skill}`,
    `  patch state: ${patch.state}`,
    `  environment: ${patch.environmentFingerprint}`,
    `  execution domain: ${patch.executionDomain ?? 'legacy'} (realEligible=${patch.realEvidenceEligible === true})`,
    `  assignments: ${assignments.length} (exposed=${assignments.filter((entry) => entry.exposed).length})`,
    `  outcomes: ${outcomes.length}`,
    `  eligible outcomes: ${outcomes.filter((entry) => entry.eligible).length} (excluded=${outcomes.filter((entry) => !entry.eligible).length})`,
    `  exclusions: ${countBy(outcomes.flatMap((entry) => entry.exclusionReason ? [entry.exclusionReason] : []))}`,
    `  decision: ${decision?.state ?? 'not-started'} (${decision?.reasonCode ?? 'no_decision'})`,
    `  hypothesis: ${decision?.hypothesis ?? 'legacy_success_superiority'}`,
    `  improved cost metrics: ${decision?.improvedCostMetrics?.join(',') || 'none'}`,
    ...(decision ? [armLine('control', decision.control), armLine('treatment', decision.treatment)] : []),
    `  failure classes: ${countBy(outcomes.flatMap((entry) => entry.failureClasses))}`,
    `  rollback: ${decision?.rollbackApplied === undefined ? 'not-requested' : decision.rollbackApplied ? 'applied' : 'failed'}`,
  ].join('\n');
}
