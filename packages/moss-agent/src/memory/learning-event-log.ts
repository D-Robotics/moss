import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultWriteChain } from '../utils/write-chain.js';
import type { EvidenceTrustBoundary } from './evidence-trust.js';

export type LearningOutcome = 'failed' | 'recovered' | 'passed' | 'unknown';
export type LearningFailureClass =
  | 'execution_failure'
  | 'acceptance_failure'
  | 'contract_drift'
  | 'environment_change'
  | 'insufficient_evidence';

export interface LearningEvent extends EvidenceTrustBoundary {
  schemaVersion: 1;
  id: string;
  sessionKey: string;
  taskId: string;
  runId: string;
  turn: number;
  planVersion: number;
  skill?: string;
  skills: string[];
  attribution: 'single-skill' | 'single-owner-step' | 'multi-skill' | 'none';
  attributedStepIds?: string[];
  environmentFingerprint: string;
  environmentIdentityVersion?: 1;
  environmentCompleteness?: 'complete' | 'incomplete' | 'legacy';
  outcome: LearningOutcome;
  failureClass?: LearningFailureClass;
  evidenceId: string;
  experienceIds: string[];
  previousFailureId?: string;
  reasonCode: string;
  /** Sanitized tool names only; never raw commands or output. */
  toolSequence?: string[];
  timestamp: string;
}

export class LearningEventLog {
  private readonly filePath: string;
  private readonly chain = defaultWriteChain;

  constructor(opts: { baseDir: string; filename?: string }) {
    this.filePath = path.join(opts.baseDir, opts.filename ?? 'learning-events.jsonl');
  }

  get path(): string {
    return this.filePath;
  }

  async append(entry: LearningEvent): Promise<boolean> {
    if (entry.schemaVersion !== 1) throw new Error('LearningEventLog.append: schemaVersion must be 1');
    let appended = false;
    await this.chain.enqueue(this.filePath, async () => {
      const existing = await this.readAll();
      if (existing.some((candidate) => candidate.id === entry.id)) return;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
      appended = true;
    });
    return appended;
  }

  async readAll(): Promise<LearningEvent[]> {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      const entries: LearningEvent[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as LearningEvent;
          if (parsed.schemaVersion === 1 && parsed.id && parsed.taskId && parsed.runId) entries.push(parsed);
        } catch {
          // Append-only logs tolerate malformed legacy/torn lines.
        }
      }
      return entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
