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

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim() !== '');
    return lines.map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

async function appendJsonl(workspaceDir: string, name: string, record: unknown): Promise<void> {
  const dir = path.join(workspaceDir, '.moss');
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, name), `${JSON.stringify(record)}\n`, 'utf8');
}

export async function appendTaskRecord(workspaceDir: string, task: TaskContract): Promise<void> {
  await appendJsonl(workspaceDir, 'tasks.jsonl', task);
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
  await appendJsonl(workspaceDir, 'evidence.jsonl', record);
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
  verdict: AcceptanceVerdict
): Promise<void> {
  await appendJsonl(workspaceDir, 'acceptance.jsonl', verdict);
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
