import fs from 'node:fs/promises';
import path from 'node:path';
import type { ObservationStats } from '../memory/observation-aggregator.js';
import { memoryWarn } from '../memory/logger.js';
import type { EvidenceTrustBoundary } from '../memory/evidence-trust.js';
import { isRealEvidenceEligible, requiresRealDeviceEvidence } from '../memory/evidence-trust.js';

/**
 * 终局硬信号日志(append-only)— T3.4 候选触发的可信根安全统计源。
 *
 * 记录每个任务终态判定(Plan.terminalAccept 产物级硬信号)按 skill 标记,
 * 供 promotion candidateSource 聚合。关键:这是**任务级终态**信号,不是
 * 验证器自报的 contractSkill pass(D5:验证器不得用自报成败作为升层依据,
 * 那是循环)。终态判定读最终产物内容(客观硬信号,非模型文本)。
 *
 * 复用 ExperienceLog 的设计:append-only JSONL,串行写,失败只 warn 不抛
 * (副作用式,不影响主流程)。
 *
 * 见 docs/self-evolution-loop.md §5.3 / D1 / D6 / T3.4 closure spec。
 */

export interface TerminalVerdictEntry extends EvidenceTrustBoundary {
  schemaVersion?: 2;
  id: string;
  taskId?: string;
  attemptId?: string;
  evidenceId?: string;
  skill: string;
  verdict: 'pass' | 'fail' | 'unknown';
  reason: string;
  sessionKey: string;
  timestamp: string;
  runId?: string;
  turn?: number;
  planVersion?: number;
  skills?: string[];
  attribution?: 'single-skill' | 'single-owner-step' | 'multi-skill' | 'none';
  attributedStepIds?: string[];
  environmentFingerprint?: string;
  environmentIdentityVersion?: 1;
  environmentCompleteness?: 'complete' | 'incomplete' | 'legacy';
  correctionCount?: number;
  safetyFailed?: boolean;
  safetyReasonCode?: string;
}

export function isPromotionEligibleTerminalEntry(entry: TerminalVerdictEntry): boolean {
  const attributionEligible = entry.attribution === 'single-skill' || entry.attribution === 'single-owner-step';
  return entry.schemaVersion === 2
    && (entry.verdict === 'pass' || entry.verdict === 'fail')
    && attributionEligible
    && Boolean(entry.skill && entry.skill !== 'unknown')
    && (!requiresRealDeviceEvidence(entry.skill) || isRealEvidenceEligible(entry));
}

export interface TerminalVerdictLogOptions {
  baseDir: string;
  filename?: string;
}

export class TerminalVerdictLog {
  private readonly filePath: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: TerminalVerdictLogOptions) {
    this.filePath = path.join(opts.baseDir, opts.filename ?? 'terminal-verdicts.jsonl');
  }

  get path(): string {
    return this.filePath;
  }

  async append(entry: TerminalVerdictEntry): Promise<void> {
    if (entry.verdict !== 'pass' && entry.verdict !== 'fail' && entry.verdict !== 'unknown') {
      throw new Error(`TerminalVerdictLog.append: verdict must be pass/fail/unknown, got ${String(entry.verdict)}`);
    }
    this.chain = this.chain.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
      } catch (err) {
        memoryWarn('terminal verdict log append failed:', err);
      }
    });
    await this.chain;
  }

  async readAll(): Promise<TerminalVerdictEntry[]> {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      const out: TerminalVerdictEntry[] = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
      }
      return out;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      memoryWarn('terminal verdict log read failed:', err);
      return [];
    }
  }
}

/**
 * Uses chronological terminal state when both timestamps are valid; otherwise
 * append order is the deterministic fallback for legacy or malformed records.
 */
function isLater(
  entry: TerminalVerdictEntry,
  index: number,
  previousEntry: TerminalVerdictEntry,
  previousIndex: number,
): boolean {
  const timestamp = Date.parse(entry.timestamp);
  const previousTimestamp = Date.parse(previousEntry.timestamp);
  if (Number.isFinite(timestamp) && Number.isFinite(previousTimestamp) && timestamp !== previousTimestamp) {
    return timestamp > previousTimestamp;
  }
  return index > previousIndex;
}

/**
 * Collapses append-only terminal records to one latest state per attempt, then
 * one latest state per evidence item. Invalid records cannot become proof.
 */
export function canonicalizeTerminalEntries(entries: TerminalVerdictEntry[]): TerminalVerdictEntry[] {
  const byAttempt = new Map<string, { entry: TerminalVerdictEntry; index: number }>();
  entries.forEach((entry, index) => {
    if (!entry.id || !entry.skill) return;
    const attemptKey = JSON.stringify(entry.attemptId
      ? [entry.skill, 'attempt', entry.attemptId]
      : [entry.skill, 'legacy', entry.id]);
    const previous = byAttempt.get(attemptKey);
    if (!previous || isLater(entry, index, previous.entry, previous.index)) {
      byAttempt.set(attemptKey, { entry, index });
    }
  });

  const byEvidence = new Map<string, { entry: TerminalVerdictEntry; index: number }>();
  for (const value of byAttempt.values()) {
    const entry = value.entry;
    const evidenceKey = JSON.stringify(entry.evidenceId
      ? [entry.skill, 'evidence', entry.evidenceId]
      : [entry.skill, 'record', entry.attemptId ?? entry.id]);
    const previous = byEvidence.get(evidenceKey);
    if (!previous || isLater(entry, value.index, previous.entry, previous.index)) {
      byEvidence.set(evidenceKey, value);
    }
  }

  return [...byEvidence.values()]
    .sort((a, b) => a.index - b.index)
    .map((value) => value.entry);
}

/**
 * 按终局信号聚合(每个 skill 的任务级终态 pass/fail/unknown)。
 * proofCount = pass+fail(decided);unknown 不计(未判定不算证据)。
 * 这与 aggregateBySkill 的 contractSkill 路径完全独立 —— 这里统计的是
 * 任务终局硬信号,不是验证器自报的契约 verdict。
 */
export function aggregateTerminalBySkill(entries: TerminalVerdictEntry[]): Map<string, ObservationStats> {
  const bySkill = new Map<string, ObservationStats>();
  for (const e of canonicalizeTerminalEntries(entries)) {
    let stats = bySkill.get(e.skill);
    if (!stats) {
      stats = { skill: e.skill, total: 0, pass: 0, fail: 0, unknown: 0, successRate: 0, proofCount: 0, failureReasons: {} };
      bySkill.set(e.skill, stats);
    }
    stats.total += 1;
    if (e.verdict === 'pass') stats.pass += 1;
    else if (e.verdict === 'fail') {
      stats.fail += 1;
      const reason = e.reason || 'unknown_reason';
      stats.failureReasons[reason] = (stats.failureReasons[reason] ?? 0) + 1;
    } else stats.unknown += 1;
  }
  for (const stats of bySkill.values()) {
    const decided = stats.pass + stats.fail;
    stats.successRate = decided > 0 ? stats.pass / decided : 0;
    stats.proofCount = decided;
  }
  return bySkill;
}

export function aggregatePromotionProofBySkill(entries: TerminalVerdictEntry[]): Map<string, ObservationStats> {
  return aggregateTerminalBySkill(entries.filter(isPromotionEligibleTerminalEntry));
}
