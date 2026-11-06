/**
 * One ledger for every autonomous run (B129 slice 1).
 *
 * The engines grew their own ledgers (`.moss/goals.jsonl`, `task-events.jsonl`,
 * `.moss/loops/*`, workflow state), so "what ran, how did it end, what do I do
 * next" had no single answer. Every run now also writes
 * `.moss/runs/<runId>/run.json` with the same status vocabulary the completion
 * gate already uses (`completed` / `incomplete` / `verify_failed` / `blocked` /
 * `unverified`), plus `interrupted` for a paused run that stays resumable.
 *
 * The record is an index, not a copy: artifacts stay in their own ledgers and
 * are referenced by path so nothing rewrites history.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RunOutcomeStatus } from '../cli/run-outcome.js';

/** Which engine produced the run. New engines add a kind here, not a ledger. */
export type RunKind = 'task' | 'loop' | 'workflow' | 'superagent' | 'chat';

/** One completion-gate hold recorded for a run (B155). */
export interface RunGate {
  /** acceptance / verification / review / plan / background / host. */
  gate: string;
  kind?: string;
  reason: string;
  turn?: number;
}

/** Token/cost summary for one run (B155). */
export interface RunRecordUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Estimated USD when every model call had a known price. */
  costUsd?: number;
}

/** Gate vocabulary plus `interrupted` (paused, resumable — not a failure). */
export type RunRecordStatus = RunOutcomeStatus | 'interrupted' | 'running';

export interface RunRecord {
  version: 1;
  /** Engine-native id (`task_…`, `goal-…`, `loop-…`); the directory name. */
  runId: string;
  kind: RunKind;
  status: RunRecordStatus;
  exitCode: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /** What was asked for, one line, already truncated by the caller. */
  goal: string;
  taskId?: string;
  sessionKey?: string;
  /** Model id the run used, when the engine knows it (B167: per-model summary). */
  model?: string;
  acceptanceCommand?: string;
  attempts?: number;
  repairs?: number;
  failures?: number;
  turns?: number;
  /** Why it ended the way it did (engine record / blocked reason). */
  reason?: string;
  /** The single command that moves it forward (`moss task resume …`). */
  next?: string;
  /** Workspace-relative paths of the engine ledgers that hold the details. */
  /** Process that owns a `running` row, so a crash can be reconciled (B179). */
  pid?: number;
  /** Hostname of the owning process; a pid is only meaningful on its host. */
  host?: string;
  /** Completion-gate holds: which gate stopped the answer, and why (B155). */
  gates?: RunGate[];
  /** Token/cost summary for the run, when the engine collected one (B155). */
  usage?: RunRecordUsage;
  artifacts?: {
    taskEvents?: string;
    evidence?: string;
    acceptance?: string;
    superagentState?: string;
    /** Isolated worktree the ticket ran in (superagent only). */
    workspace?: string;
    loopLedger?: string;
    /** Headless chat runs: the session transcript. */
    session?: string;
    /** Workflow runs: the step state file. */
    workflowState?: string;
  };
}

const RUNS_DIR = path.join('.moss', 'runs');
const RECORD_FILE = 'run.json';
const DEFAULT_KEEP = 50;
const GOAL_LIMIT = 200;

function runsDir(workspaceDir: string): string {
  return path.join(workspaceDir, RUNS_DIR);
}

export function runRecordDir(workspaceDir: string, runId: string): string {
  return path.join(runsDir(workspaceDir), runId);
}

export function runRecordPath(workspaceDir: string, runId: string): string {
  return path.join(runRecordDir(workspaceDir, runId), RECORD_FILE);
}

/** `/` and `\` would escape the runs directory; ids are engine-generated, but be strict. */
function isSafeRunId(runId: string): boolean {
  return (
    runId.length > 0 &&
    !runId.includes('/') &&
    !runId.includes('\\') &&
    runId !== '.' &&
    runId !== '..'
  );
}

function truncate(text: string, limit = GOAL_LIMIT): string {
  const oneLine = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`;
}

/** Record ids are engine ids; a prefix collision would overwrite evidence. */
function requireValidId(runId: string): void {
  if (!isSafeRunId(runId)) throw new Error(`invalid run id: ${runId}`);
}

/** Write (or replace) one run record. Atomic: temp file + rename. */
export async function writeRunRecord(workspaceDir: string, record: RunRecord): Promise<string> {
  requireValidId(record.runId);
  const dir = runRecordDir(workspaceDir, record.runId);
  await fs.mkdir(dir, { recursive: true });
  const normalized: RunRecord = {
    ...record,
    goal: truncate(record.goal),
    ...(record.reason ? { reason: truncate(record.reason, 400) } : {}),
  };
  const target = path.join(dir, RECORD_FILE);
  const temp = `${target}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  await fs.rename(temp, target);
  return path.relative(workspaceDir, target);
}

/** Parse defensively: a half-written or hand-edited record must not break `runs list`. */
function parseRecord(text: string): RunRecord | null {
  try {
    const value = JSON.parse(text) as Partial<RunRecord>;
    if (!value || value.version !== 1) return null;
    if (typeof value.runId !== 'string' || typeof value.kind !== 'string') return null;
    if (typeof value.status !== 'string' || typeof value.startedAt !== 'number') return null;
    return {
      ...(value as RunRecord),
      goal: typeof value.goal === 'string' ? value.goal : '',
      endedAt: typeof value.endedAt === 'number' ? value.endedAt : value.startedAt,
      durationMs:
        typeof value.durationMs === 'number'
          ? value.durationMs
          : Math.max(0, (value.endedAt ?? value.startedAt) - value.startedAt),
      exitCode: typeof value.exitCode === 'number' ? value.exitCode : 0,
    };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as { code?: string }).code === 'EPERM';
  }
}

/**
 * A `running` row whose owning process is gone is not running any more: a crashed
 * `moss superagent work` used to leave it "in progress" forever. Only reconcile
 * when the record names this host and a pid; a foreign host or a missing pid is
 * genuinely unknown and stays `running`.
 */
function reconcileStaleRunning(record: RunRecord): RunRecord {
  if (record.status !== 'running' || typeof record.pid !== 'number') return record;
  if (record.host !== os.hostname()) return record;
  if (pidAlive(record.pid)) return record;
  return {
    ...record,
    status: 'interrupted',
    // Same convention as a Ctrl+C pause: interrupted runs do not claim success.
    exitCode: 130,
    reason: 'the run process is gone (crashed or killed while running)',
  };
}

/** All readable records, newest first. Unreadable entries are skipped, not fatal. */
export async function listRunRecords(workspaceDir: string): Promise<RunRecord[]> {
  const dir = runsDir(workspaceDir);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const text = await fs.readFile(path.join(dir, entry.name, RECORD_FILE), 'utf8');
      const record = parseRecord(text);
      if (record) records.push(reconcileStaleRunning(record));
    } catch {
      /* a missing record is a run that predates the ledger, not an error */
    }
  }
  records.sort(
    (left, right) => right.endedAt - left.endedAt || left.runId.localeCompare(right.runId)
  );
  return records;
}

/**
 * Write the `running` row for an engine whose run id is known up front (loop,
 * workflow). The final write with the same id overwrites it. `pid`/`host` let a
 * later read reconcile a crashed owner (B179).
 */
export async function writeRunningRecord(
  workspaceDir: string,
  input: {
    runId: string;
    kind: RunKind;
    goal: string;
    startedAt?: number;
    next?: string;
    acceptanceCommand?: string;
    taskId?: string;
    model?: string;
  }
): Promise<void> {
  const startedAt = input.startedAt ?? Date.now();
  await writeRunRecord(workspaceDir, {
    version: 1,
    runId: input.runId,
    kind: input.kind,
    status: 'running',
    exitCode: 0,
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    goal: input.goal,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.acceptanceCommand ? { acceptanceCommand: input.acceptanceCommand } : {}),
    ...(input.next ? { next: input.next } : {}),
    ...(input.model ? { model: input.model } : {}),
    pid: process.pid,
    host: os.hostname(),
  });
}

/** Read one record by id, or the newest one for `latest` / an empty id. */
export async function readRunRecord(
  workspaceDir: string,
  runId?: string
): Promise<RunRecord | null> {
  if (!runId || runId === 'latest') {
    const records = await listRunRecords(workspaceDir);
    return records[0] ?? null;
  }
  if (!isSafeRunId(runId)) return null;
  try {
    const text = await fs.readFile(runRecordPath(workspaceDir, runId), 'utf8');
    const record = parseRecord(text);
    return record ? reconcileStaleRunning(record) : null;
  } catch {
    return null;
  }
}

export interface PruneRunRecordsResult {
  /** Ids removed (or that would be removed with `dryRun`). */
  removed: string[];
  kept: number;
  bytes: number;
}

/**
 * Keep the newest `keep` records; remove the rest. `dryRun` reports the same
 * numbers without touching disk so `runs prune --dry-run` is safe to ship.
 */
export async function pruneRunRecords(
  workspaceDir: string,
  options: { keep?: number; dryRun?: boolean } = {}
): Promise<PruneRunRecordsResult> {
  const keep = options.keep ?? DEFAULT_KEEP;
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be a positive integer');
  const records = await listRunRecords(workspaceDir);
  const doomed = records.slice(keep);
  let bytes = 0;
  const removed: string[] = [];
  for (const record of doomed) {
    const dir = runRecordDir(workspaceDir, record.runId);
    for (const file of [RECORD_FILE]) {
      try {
        const stat = await fs.stat(path.join(dir, file));
        bytes += stat.size;
      } catch {
        /* already gone */
      }
    }
    removed.push(record.runId);
    if (!options.dryRun) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  return { removed, kept: Math.min(keep, records.length), bytes };
}
