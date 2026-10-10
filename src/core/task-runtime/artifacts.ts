/**
 * Task artifact store (robotics closed loop) — the canonical reader/writer
 * layer for the workspace `.moss/` JSONL artifacts (tasks, evidence,
 * acceptance; deployments delegate to the device layer). Lives in core so the
 * TUI, REPL and headless task runtimes all read the same data through one
 * implementation; tools re-export these to keep the SDK surface stable.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DeploymentRecord } from '../../contracts/deployment.js';
import type { EvidenceRecord } from '../../contracts/evidence.js';
import type { AcceptanceVerdict, TaskContract } from '../../contracts/task.js';
import { listDeploymentRecords } from '../../device/deployment.js';
import { getRootLogger } from '../../logger.js';
import { redactEgress } from '../../safety/tool-output-redact.js';
import { ensureMossRuntimeGitignore } from '../../utils/workspace-paths.js';
import { withTaskEventLock } from '../task/task-store.js';

const jsonlLog = getRootLogger().child('task-jsonl');

/** One warn per file per process; later reads of the same torn file are debug. */
const jsonlParseWarned = new Set<string>();

function redactEvidenceRecord(record: EvidenceRecord): EvidenceRecord {
  const observed =
    typeof record.observed === 'string' ? redactEgress(record.observed) : record.observed;
  return {
    ...record,
    ...(record.expected !== undefined ? { expected: redactEgress(record.expected) } : {}),
    ...(observed !== undefined ? { observed } : {}),
    ...(record.details !== undefined ? { details: redactEgress(record.details) } : {}),
  };
}

export interface TaskArtifacts {
  /** Latest contract version per taskId, in first-definition order. */
  tasks: TaskContract[];
  /** Newest first. */
  evidence: EvidenceRecord[];
  /** Newest first. */
  deployments: DeploymentRecord[];
  /** File order (oldest first) — verdict history matters for repair cycles. */
  acceptance: AcceptanceVerdict[];
}

/**
 * Read a JSONL file line by line. A torn or non-JSON line is skipped so one
 * bad line cannot hide every earlier record. Missing files are empty.
 * The first skip for a file warns once; later reads only debug.
 */
export async function readJsonlFile<T>(file: string): Promise<T[]> {
  const before = await readPendingAppend(file);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  // An interrupted writer retains a durable prepare record. Never replay its
  // uncertain tail, including when both the original sync and rollback failed.
  const after = await readPendingAppend(file);
  const pending =
    before === undefined ? after : after === undefined ? before : Math.min(before, after);
  if (pending !== undefined) {
    const bytes = Buffer.from(raw);
    if (pending > bytes.length) throw new Error(`unconfirmed task append: ${file}`);
    raw = bytes.subarray(0, pending).toString('utf8');
  }
  const rows: T[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    const key = path.resolve(file);
    const payload = { file: key, skipped };
    if (jsonlParseWarned.has(key)) {
      jsonlLog.debug('skipping unparseable jsonl line', payload);
    } else {
      jsonlParseWarned.add(key);
      jsonlLog.warn('skipping unparseable jsonl line', payload);
    }
  }
  return rows;
}

async function readPendingAppend(file: string): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(`${file}.pending`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const pending = JSON.parse(raw) as { originalSize?: unknown };
  if (!Number.isSafeInteger(pending.originalSize) || Number(pending.originalSize) < 0) {
    throw new Error(`unconfirmed task append: ${file}`);
  }
  return Number(pending.originalSize);
}

async function syncParentDirectory(file: string): Promise<void> {
  // Windows does not expose directory fsync through Node. File barriers still
  // run on Windows; POSIX additionally persists directory entries.
  if (process.platform === 'win32') return;
  const directory = await fs.open(path.dirname(file), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function prepareAppend(file: string, originalSize: number): Promise<void> {
  const prepare = await fs.open(file, 'wx');
  try {
    await prepare.writeFile(JSON.stringify({ originalSize }), 'utf8');
    await prepare.sync();
    await syncParentDirectory(file);
  } finally {
    await prepare.close();
  }
}

async function readJsonl<T>(file: string): Promise<T[]> {
  return readJsonlFile<T>(file);
}

/**
 * Append one JSONL record. If the file does not end in a newline, write one
 * first so a torn trailing line is not glued to the new record. Callers that
 * share a file across processes must hold their own lock around this; the
 * task-event lock is not re-entrant.
 */
export async function appendJsonlFile(
  file: string,
  record: unknown,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  if ((await readPendingAppend(file)) !== undefined) {
    throw new Error(`unconfirmed task append requires recovery: ${file}`);
  }
  await ensureTrailingNewline(file);
  signal?.throwIfAborted();
  const previous = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const originalSize = previous?.size ?? 0;
  const pendingFile = `${file}.pending`;
  await prepareAppend(pendingFile, originalSize);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    signal?.throwIfAborted();
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    handle = await fs.open(file, 'r+');
    await handle.sync();
    if (!previous) await syncParentDirectory(file);
    await handle.close();
    handle = undefined;
    await fs.unlink(pendingFile);
    await syncParentDirectory(pendingFile);
  } catch (error) {
    // Callers hold the workspace write lock. A failed sync must not leave a
    // process-visible accepted record which replay would mistake for success.
    // If the final directory barrier failed after unlink, restore the bounded
    // prepare record before attempting compensation.
    await readPendingAppend(file)
      .then(async (pending) => {
        if (pending === undefined) await prepareAppend(pendingFile, originalSize);
      })
      .catch(() => {});
    const rollback = handle ?? (await fs.open(file, 'r+').catch(() => undefined));
    try {
      if (rollback) {
        await rollback.truncate(originalSize);
        await rollback.sync();
        await fs.unlink(pendingFile).catch((unlinkError: NodeJS.ErrnoException) => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        });
        await syncParentDirectory(pendingFile);
      }
    } catch {
      // Preserve the original IO failure; failed compensation never attests PASS.
    } finally {
      if (rollback !== handle) await rollback?.close().catch(() => {});
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function ensureTrailingNewline(file: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, 'r+');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (stat.size === 0) return;
    const buf = Buffer.alloc(1);
    const { bytesRead } = await handle.read(buf, 0, 1, stat.size - 1);
    if (bytesRead === 1 && buf[0] !== 0x0a) {
      await handle.write(Buffer.from('\n'), 0, 1, stat.size);
    }
  } finally {
    await handle.close();
  }
}

async function appendJsonl(
  workspaceDir: string,
  name: string,
  record: unknown,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  await withTaskEventLock(workspaceDir, async () => {
    ensureMossRuntimeGitignore(workspaceDir);
    const dir = path.join(workspaceDir, '.moss');
    await appendJsonlFile(path.join(dir, name), record, signal);
  });
}

export async function appendTaskRecord(
  workspaceDir: string,
  task: TaskContract,
  signal?: AbortSignal
): Promise<void> {
  await appendJsonl(workspaceDir, 'tasks.jsonl', task, signal);
}

export async function listTaskRecords(workspaceDir: string, limit = 50): Promise<TaskContract[]> {
  const parsed = await readJsonl<TaskContract>(path.join(workspaceDir, '.moss', 'tasks.jsonl'));
  if (parsed.length === 0) return [];
  // Latest version of each taskId wins (contracts are re-defined as they evolve).
  const byId = new Map(parsed.map((task) => [task.taskId, task]));
  return [...byId.values()].slice(-limit);
}

export async function appendEvidenceRecord(
  workspaceDir: string,
  record: EvidenceRecord
): Promise<void> {
  await appendJsonl(workspaceDir, 'evidence.jsonl', redactEvidenceRecord(record));
}

export async function listEvidenceRecords(
  workspaceDir: string,
  limit = 100
): Promise<EvidenceRecord[]> {
  const parsed = await readJsonl<EvidenceRecord>(
    path.join(workspaceDir, '.moss', 'evidence.jsonl')
  );
  return parsed.slice(-limit).reverse();
}

export async function appendAcceptanceVerdict(
  workspaceDir: string,
  verdict: AcceptanceVerdict,
  signal?: AbortSignal
): Promise<void> {
  await appendJsonl(workspaceDir, 'acceptance.jsonl', verdict, signal);
}

export async function listAcceptanceVerdicts(
  workspaceDir: string,
  limit = 200
): Promise<AcceptanceVerdict[]> {
  const parsed = await readJsonl<AcceptanceVerdict>(
    path.join(workspaceDir, '.moss', 'acceptance.jsonl')
  );
  return parsed.slice(-limit);
}

/** Load all task artifacts for a workspace in one pass. */
export async function loadTaskArtifacts(workspaceDir: string): Promise<TaskArtifacts> {
  const [tasks, evidence, deployments, acceptance] = await Promise.all([
    listTaskRecords(workspaceDir, 200),
    listEvidenceRecords(workspaceDir, 1000),
    listDeploymentRecords(workspaceDir, 100),
    listAcceptanceVerdicts(workspaceDir, 200),
  ]);
  return { tasks, evidence, deployments, acceptance };
}
