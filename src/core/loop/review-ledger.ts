/**
 * Structured review-ledger read for the completion gate.
 *
 * `review_changes` appends one JSON record per review to `.moss/review.jsonl`
 * (schema owned by `src/tools/review-tools.ts`). The completion gate used to
 * decide "did the reviewer fail?" by regexing the tool result prose; that is a
 * guess — a truncated result, a reworded summary, or a PASS record that still
 * carries a critical finding could flip it. `moss review check` already maps
 * the ledger to exit codes, so the gate should read the same truth.
 *
 * This module is deliberately tiny (core layer must not import tools): it reads
 * the tail of the log and projects only what the gate needs.
 */
import fs from 'node:fs';
import path from 'node:path';

export type ReviewLedgerVerdict = 'pass' | 'fail' | 'unknown';

export interface ReviewLedgerSummary {
  id: string;
  /** `createdAt` as epoch ms; the gate compares it with the run's start. */
  createdAtMs: number;
  verdict: ReviewLedgerVerdict;
  findings: { critical: number; important: number; suggestion: number; total: number };
  repairAttempt?: number;
  reviewerSuccess: boolean;
}

const REVIEW_LOG_NAME = 'review.jsonl';
/** Records are small; the tail is enough to find the latest one. */
const TAIL_BYTES = 64 * 1024;

export function reviewLogPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.moss', REVIEW_LOG_NAME);
}

function projectRecord(raw: unknown): ReviewLedgerSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as {
    id?: unknown;
    createdAt?: unknown;
    verdict?: unknown;
    findings?: unknown;
    repairAttempt?: unknown;
    reviewerSuccess?: unknown;
  };
  if (typeof record.id !== 'string') return undefined;
  const createdAtMs = typeof record.createdAt === 'string' ? Date.parse(record.createdAt) : NaN;
  if (!Number.isFinite(createdAtMs)) return undefined;
  const verdict =
    record.verdict === 'pass' || record.verdict === 'fail' || record.verdict === 'unknown'
      ? record.verdict
      : 'unknown';
  const counts = { critical: 0, important: 0, suggestion: 0, total: 0 };
  if (Array.isArray(record.findings)) {
    for (const finding of record.findings) {
      const severity =
        finding && typeof finding === 'object'
          ? (finding as { severity?: unknown }).severity
          : undefined;
      if (severity === 'critical') counts.critical += 1;
      else if (severity === 'important') counts.important += 1;
      else if (severity === 'suggestion') counts.suggestion += 1;
      else continue;
      counts.total += 1;
    }
  }
  return {
    id: record.id,
    createdAtMs,
    verdict,
    findings: counts,
    ...(typeof record.repairAttempt === 'number' ? { repairAttempt: record.repairAttempt } : {}),
    reviewerSuccess: record.reviewerSuccess === true,
  };
}

/**
 * Latest parseable review record, or undefined when the log is absent/empty or
 * every line is torn. Newest-first scan: a half-written trailing line (the
 * process died mid-append) must not hide the record before it.
 */
export function readLatestReviewSummary(workspaceDir: string): ReviewLedgerSummary | undefined {
  const file = reviewLogPath(workspaceDir);
  let handle: number;
  try {
    handle = fs.openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = fs.fstatSync(handle).size;
    if (size === 0) return undefined;
    const readBytes = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(readBytes);
    fs.readSync(handle, buffer, 0, readBytes, size - readBytes);
    const lines = buffer.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!.trim();
      if (line === '') continue;
      // A tail window can start mid-line; only full JSON objects are records.
      if (!line.startsWith('{') || !line.endsWith('}')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const summary = projectRecord(parsed);
      if (summary) return summary;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(handle);
  }
}
