import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultWriteChain } from '../utils/write-chain.js';
import type { EvidenceTrustBoundary } from './evidence-trust.js';

export type PatchExperimentVariant = 'control' | 'treatment';
export type PatchExperimentLifecycle = 'shadow' | 'active' | 'demoted';
export type PatchExperimentHypothesis =
  | 'success_superiority'
  | 'success_noninferiority_cost_superiority';
export type PatchExperimentCostMetric = 'retries' | 'toolCalls' | 'durationMs' | 'tokens';

interface PatchExperimentBase extends EvidenceTrustBoundary {
  schemaVersion: 1;
  id: string;
  patchId: string;
  patchRevision: number;
  skill: string;
  environmentFingerprint: string;
  environmentIdentityVersion?: 1;
  environmentCompleteness?: 'complete' | 'incomplete' | 'legacy';
  timestamp: string;
  hypothesis?: PatchExperimentHypothesis;
  experimentConfigHash?: string;
  costMetrics?: PatchExperimentCostMetric[];
}

export interface PatchExperimentAssignment extends PatchExperimentBase {
  kind: 'assignment';
  sessionKey: string;
  runId: string;
  taskSignature: string;
  variant: PatchExperimentVariant;
  exposed: boolean;
  exposureId: string;
  guidanceHash?: string;
  exposureReceiptId?: string;
  /** Frozen machine checks visible to the Treatment guidance for this run. */
  terminalAcceptNames?: string[];
}

export interface PatchExperimentExposure extends PatchExperimentBase {
  kind: 'exposure';
  assignmentId: string;
  sessionKey: string;
  runId: string;
  exposureId: string;
  variant: PatchExperimentVariant;
  injected: boolean;
  location: 'memory-context';
  guidanceHash?: string;
}

export interface PatchExperimentOutcome extends PatchExperimentBase {
  kind: 'outcome';
  outcomeSource?: 'terminal-v2' | 'agent-process';
  processFinishedAt?: string;
  assignmentId: string;
  sessionKey: string;
  taskId: string;
  runId: string;
  evidenceId: string;
  variant: PatchExperimentVariant;
  terminalVerdict: 'pass' | 'fail' | 'unknown';
  success: boolean;
  retries: number;
  toolCalls: number;
  corrections: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd?: number;
  failureClasses: string[];
  safetyFailed: boolean;
  eligible: boolean;
  exclusionReason?: string;
  exposureReceiptId?: string;
}

export interface PatchExperimentArmSummary {
  total: number;
  passed: number;
  failed: number;
  unknown: number;
  successRate: number;
  wilsonLow: number;
  wilsonHigh: number;
  averageRetries: number;
  averageCorrections?: number;
  averageToolCalls: number;
  averageDurationMs: number;
  averageInputTokens: number;
  averageOutputTokens: number;
  averageCostUsd?: number;
  safetyFailures: number;
  failureClasses: Record<string, number>;
  excluded?: number;
  newFailureClasses?: string[];
}

export interface PatchExperimentDecision extends PatchExperimentBase {
  kind: 'decision';
  revision: number;
  state: PatchExperimentLifecycle;
  reasonCode: string;
  control: PatchExperimentArmSummary;
  treatment: PatchExperimentArmSummary;
  sourceOutcomeIds: string[];
  rollbackApplied?: boolean;
  improvedCostMetrics?: string[];
}

export type PatchExperimentRecord =
  | PatchExperimentAssignment
  | PatchExperimentExposure
  | PatchExperimentOutcome
  | PatchExperimentDecision;

export class PatchExperimentLog {
  private readonly filePath: string;
  private readonly chain = defaultWriteChain;

  constructor(opts: { baseDir: string; filename?: string }) {
    this.filePath = path.join(opts.baseDir, opts.filename ?? 'patch-experiments.jsonl');
  }

  get path(): string {
    return this.filePath;
  }

  async append(record: PatchExperimentRecord): Promise<boolean> {
    if (record.schemaVersion !== 1) throw new Error('PatchExperimentLog: schemaVersion must be 1');
    let appended = false;
    await this.chain.enqueue(this.filePath, async () => {
      const existing = await this.readAll();
      if (existing.some((entry) => entry.id === record.id)) return;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
      appended = true;
    });
    return appended;
  }

  async readAll(): Promise<PatchExperimentRecord[]> {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      return text.split('\n').flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const value = JSON.parse(line) as PatchExperimentRecord;
          if (value.schemaVersion !== 1 || !value.id || !value.patchId) return [];
          if (
            value.kind !== 'assignment' &&
            value.kind !== 'exposure' &&
            value.kind !== 'outcome' &&
            value.kind !== 'decision'
          )
            return [];
          return [value];
        } catch {
          return [];
        }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async assignmentForRun(runId: string): Promise<PatchExperimentAssignment | undefined> {
    return (await this.readAll()).find(
      (record): record is PatchExperimentAssignment =>
        record.kind === 'assignment' && record.runId === runId
    );
  }

  async exposureForRun(runId: string): Promise<PatchExperimentExposure | undefined> {
    return (await this.readAll()).find(
      (record): record is PatchExperimentExposure =>
        record.kind === 'exposure' && record.runId === runId
    );
  }

  async latestDecision(patchId: string): Promise<PatchExperimentDecision | undefined> {
    return (await this.readAll())
      .filter(
        (record): record is PatchExperimentDecision =>
          record.kind === 'decision' && record.patchId === patchId
      )
      .sort((left, right) => left.revision - right.revision)
      .at(-1);
  }
}
