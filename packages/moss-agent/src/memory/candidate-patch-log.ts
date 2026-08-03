import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultWriteChain } from '../utils/write-chain.js';

export type CandidatePatchKind = 'skill-guidance' | 'contract-review' | 'contract-params';
export type CandidatePatchState = 'proposed' | 'validated' | 'rejected' | 'published' | 'rolled_back';

export interface CandidatePatchRecord {
  schemaVersion: 1;
  id: string;
  revision: number;
  kind: CandidatePatchKind;
  state: CandidatePatchState;
  skill: string;
  environmentFingerprint: string;
  environmentIdentityVersion?: 1;
  environmentCompleteness?: 'complete' | 'incomplete' | 'legacy';
  failureClass: string;
  sourceEventIds: string[];
  toolSequences: string[][];
  reasonCode: string;
  validationErrors?: string[];
  artifactPath?: string;
  backupPath?: string;
  timestamp: string;
}

export class CandidatePatchLog {
  private readonly filePath: string;
  private readonly chain = defaultWriteChain;

  constructor(opts: { baseDir: string; filename?: string }) {
    this.filePath = path.join(opts.baseDir, opts.filename ?? 'candidate-patches.jsonl');
  }

  get path(): string { return this.filePath; }

  async append(record: CandidatePatchRecord): Promise<boolean> {
    if (record.schemaVersion !== 1) throw new Error('CandidatePatchLog: schemaVersion must be 1');
    let appended = false;
    await this.chain.enqueue(this.filePath, async () => {
      const all = await this.readAll();
      if (all.some((entry) => entry.id === record.id && entry.revision === record.revision && entry.state === record.state)) return;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
      appended = true;
    });
    return appended;
  }

  async readAll(): Promise<CandidatePatchRecord[]> {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      return text.split('\n').flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const value = JSON.parse(line) as CandidatePatchRecord;
          return value.schemaVersion === 1 && value.id ? [value] : [];
        } catch { return []; }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async latest(id?: string): Promise<CandidatePatchRecord[]> {
    const map = new Map<string, CandidatePatchRecord>();
    for (const record of await this.readAll()) {
      if (id && record.id !== id) continue;
      const previous = map.get(record.id);
      if (!previous || record.revision > previous.revision || record.revision === previous.revision) map.set(record.id, record);
    }
    return [...map.values()];
  }
}
