import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AcceptPredicateName, AcceptSpec } from './types.js';
import type { PredicateEvalOutput } from './predicate-evaluator.js';
import type { TerminalVerdictEntry } from './terminal-verdict-log.js';
import { isPromotionEligibleTerminalEntry } from './terminal-verdict-log.js';
import type { EvidenceTrustBoundary } from '../memory/evidence-trust.js';
import { isRealEvidenceEligible } from '../memory/evidence-trust.js';
import { defaultWriteChain } from '../utils/write-chain.js';

export type CrossSignalChannel =
  | 'process-exit'
  | 'execution-stdout'
  | 'artifact-existence'
  | 'artifact-size'
  | 'artifact-digest'
  | 'artifact-mime'
  | 'device-telemetry'
  | 'sensor';

export interface CrossSignalObservation extends EvidenceTrustBoundary {
  schemaVersion: 1;
  id: string;
  skill: string;
  taskId: string;
  runId: string;
  evidenceId: string;
  environmentFingerprint: string;
  channel: CrossSignalChannel;
  sourceDigest: string;
  verdict: 'pass' | 'fail' | 'unknown';
  reasonCode: string;
  timestamp: string;
}

function channelForPredicate(name: AcceptPredicateName): CrossSignalChannel {
  switch (name) {
    case 'exit_code_zero':
      return 'process-exit';
    case 'stdout_matches':
      return 'execution-stdout';
    case 'file_exist':
      return 'artifact-existence';
    case 'file_nonempty':
    case 'file_created_after':
    case 'file_fresh_nonempty':
      return 'artifact-size';
    case 'artifact_digest_changed':
      return 'artifact-digest';
    case 'image_decodable':
    case 'image_dimensions':
    case 'image_content_nontrivial':
      return 'artifact-mime';
    case 'pose_error_within':
    case 'force_below':
    case 'joint_at':
      return 'sensor';
    case 'process_running':
    case 'video_fps_above':
      return 'device-telemetry';
  }
}

function channelGroup(
  channel: CrossSignalChannel
): 'execution' | 'artifact' | 'telemetry' | 'sensor' {
  if (channel === 'process-exit' || channel === 'execution-stdout') return 'execution';
  if (channel.startsWith('artifact-')) return 'artifact';
  return channel === 'sensor' ? 'sensor' : 'telemetry';
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function observationsFromTerminal(input: {
  terminal: TerminalVerdictEntry;
  specs: AcceptSpec[];
  results: PredicateEvalOutput[];
}): CrossSignalObservation[] {
  if (
    input.terminal.schemaVersion !== 2 ||
    !input.terminal.taskId ||
    !input.terminal.runId ||
    !input.terminal.evidenceId ||
    input.terminal.skill === 'unknown'
  )
    return [];
  return input.specs.flatMap((spec, index) => {
    const result = input.results[index];
    if (!result) return [];
    const channel = channelForPredicate(spec.name);
    return [
      {
        schemaVersion: 1 as const,
        id: `cross:${digest([input.terminal.taskId, input.terminal.runId, input.terminal.evidenceId, channel, index]).slice(7, 31)}`,
        skill: input.terminal.skill,
        taskId: input.terminal.taskId!,
        runId: input.terminal.runId!,
        evidenceId: input.terminal.evidenceId!,
        environmentFingerprint: input.terminal.environmentFingerprint ?? 'unknown',
        channel,
        sourceDigest: digest([spec.name, result.evidence ?? result.reasonCode]),
        verdict: result.verdict,
        reasonCode: result.reasonCode ?? 'unknown',
        executionDomain: input.terminal.executionDomain,
        realEvidenceEligible: input.terminal.realEvidenceEligible,
        timestamp: input.terminal.timestamp,
      },
    ];
  });
}

export class CrossSignalLog {
  private readonly filePath: string;
  private readonly chain = defaultWriteChain;

  constructor(opts: { baseDir: string; filename?: string }) {
    this.filePath = path.join(opts.baseDir, opts.filename ?? 'cross-signals.jsonl');
  }

  get path(): string {
    return this.filePath;
  }

  async appendMany(records: CrossSignalObservation[]): Promise<void> {
    if (!records.length) return;
    await this.chain.enqueue(this.filePath, async () => {
      const existing = new Set((await this.readAll()).map((entry) => entry.id));
      const fresh = records.filter((entry) => !existing.has(entry.id));
      if (!fresh.length) return;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(
        this.filePath,
        fresh.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
        'utf8'
      );
    });
  }

  async readAll(): Promise<CrossSignalObservation[]> {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      return text.split('\n').flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const value = JSON.parse(line) as CrossSignalObservation;
          return value.schemaVersion === 1 && value.id && value.taskId && value.runId
            ? [value]
            : [];
        } catch {
          return [];
        }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

export async function hasIndependentCrossSignal(input: {
  skill: string;
  terminalEntries: TerminalVerdictEntry[];
  crossSignals: CrossSignalObservation[];
}): Promise<boolean> {
  const terminals = input.terminalEntries.filter(
    (entry) =>
      entry.skill === input.skill &&
      entry.verdict === 'pass' &&
      isPromotionEligibleTerminalEntry(entry) &&
      isRealEvidenceEligible(entry)
  );
  for (const terminal of terminals) {
    const linked = input.crossSignals.filter(
      (signal) =>
        signal.skill === input.skill &&
        signal.taskId === terminal.taskId &&
        signal.runId === terminal.runId &&
        signal.evidenceId === terminal.evidenceId &&
        signal.environmentFingerprint === terminal.environmentFingerprint &&
        signal.verdict === 'pass' &&
        isRealEvidenceEligible({
          ...signal,
          environmentCompleteness: terminal.environmentCompleteness,
        })
    );
    const groups = new Set(linked.map((signal) => channelGroup(signal.channel)));
    const sources = new Set(linked.map((signal) => signal.sourceDigest));
    if (groups.size >= 2 && sources.size >= 2) return true;
  }
  return false;
}
