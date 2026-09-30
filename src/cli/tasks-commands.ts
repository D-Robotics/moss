/**
 * `moss tasks` — human-facing visibility into the robotics closed loop
 * artifacts under the workspace: task contracts, recorded evidence,
 * deployments, acceptance verdicts, and the live device target.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listTaskRecords } from '../tools/task-tools.js';
import { listEvidenceRecords, summarizeEvidence } from '../tools/evidence-tools.js';
import { listDeploymentRecords } from '../device/deployment.js';
import { formatDeviceTarget, resolveDefaultDeviceTarget } from '../device/device-target.js';
import { listDeviceConnections } from '../device/device-registry.js';
import { listAcceptanceVerdicts } from '../core/task-runtime/artifacts.js';

function parseJsonl(file: string): unknown[] {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function usage(): string {
  return [
    'Usage: moss tasks [list|evidence|deployments|acceptance|device] [--json]',
    '',
    '  list          task contracts with status and acceptance criteria (default)',
    '  evidence      recorded evidence records (metric / expected / observed / result)',
    '  deployments   deployment lifecycle records',
    '  acceptance    acceptance verdicts history',
    '  device        resolved device target and connection state',
    '  --json        machine-readable output',
  ].join('\n');
}

export async function runTasksCommand(
  commandArgs: string[],
  workspace: string,
  options: { json?: boolean } = {}
): Promise<void> {
  const sub = commandArgs.find((a) => !a.startsWith('--')) ?? 'list';
  const json = options.json ?? commandArgs.includes('--json');
  const mossDir = path.join(workspace, '.moss');

  if (sub === 'list') {
    const tasks = await listTaskRecords(workspace, 50);
    if (json) {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }
    if (tasks.length === 0) {
      console.log('No task contracts in this workspace (agents create them with task_define).');
      return;
    }
    console.log('TASK ID                       STATUS     CRITERIA  GOAL');
    console.log('─'.repeat(96));
    for (const task of tasks) {
      const goal = task.goal.length > 42 ? `${task.goal.slice(0, 39)}…` : task.goal;
      console.log(
        `${task.taskId.padEnd(30)} ${task.status.padEnd(10)} ${String(task.acceptanceCriteria.length).padStart(8)}  ${goal}`
      );
    }
    const evidence = await listEvidenceRecords(workspace, 1000);
    const summary = summarizeEvidence(evidence);
    const deployments = parseJsonl(path.join(mossDir, 'deployments.jsonl')).length;
    const verdicts = parseJsonl(path.join(mossDir, 'acceptance.jsonl')).length;
    console.log(
      `\n  evidence: ${summary.passed} pass / ${summary.failed} fail / ${summary.inconclusive} inconclusive` +
        ` · deployments: ${deployments} · acceptance verdicts: ${verdicts}`
    );
    return;
  }

  if (sub === 'evidence') {
    const records = await listEvidenceRecords(workspace, 200);
    if (json) {
      console.log(JSON.stringify(records, null, 2));
      return;
    }
    if (records.length === 0) {
      console.log('No evidence recorded (agents record it with record_evidence).');
      return;
    }
    console.log('EVIDENCE                    RESULT        METRIC / OBSERVED');
    console.log('─'.repeat(96));
    for (const record of records) {
      const observed = record.observed === undefined ? '?' : String(record.observed).slice(0, 30);
      console.log(
        `${record.evidenceId.padEnd(28)} ${record.result.toUpperCase().padEnd(13)} ${record.metric}` +
          `${record.expected ? ` ${record.expected}` : ''} → ${observed}`
      );
    }
    return;
  }

  if (sub === 'deployments') {
    const records = await listDeploymentRecords(workspace, 50);
    if (json) {
      console.log(JSON.stringify(records, null, 2));
      return;
    }
    if (records.length === 0) {
      console.log('No deployments recorded (agents run device_deploy).');
      return;
    }
    console.log('DEPLOYMENT                   DEVICE            STATUS     REMOTE PATH');
    console.log('─'.repeat(96));
    for (const record of records) {
      const remote =
        record.remotePath.length > 34 ? `…${record.remotePath.slice(-33)}` : record.remotePath;
      console.log(
        `${record.deploymentId.padEnd(28)} ${record.deviceId.padEnd(17)} ${record.status.toUpperCase().padEnd(10)} ${remote}`
      );
    }
    return;
  }

  if (sub === 'acceptance') {
    const verdicts = await listAcceptanceVerdicts(workspace, 500);
    if (json) {
      console.log(JSON.stringify(verdicts, null, 2));
      return;
    }
    if (verdicts.length === 0) {
      console.log('No acceptance verdicts recorded (agents run task_acceptance).');
      return;
    }
    console.log('TASK ID                       VERDICT   UNMET  AT');
    console.log('─'.repeat(96));
    for (const verdict of [...verdicts].reverse()) {
      const at = Number.isFinite(verdict.acceptedAt)
        ? new Date(verdict.acceptedAt).toLocaleString()
        : 'unknown';
      console.log(
        `${verdict.taskId.padEnd(30)} ${verdict.verdict.toUpperCase().padEnd(9)} ${String(verdict.unmetRequired ?? '?').padStart(5)}  ${at}`
      );
    }
    return;
  }

  if (sub === 'device') {
    const target = resolveDefaultDeviceTarget();
    const connections = listDeviceConnections();
    if (json) {
      console.log(JSON.stringify({ target, connections }, null, 2));
      return;
    }
    if (!target) {
      console.log(
        'No device target configured. Set MOSS_DEVICE_HOST (+ auth) in the environment or .env.'
      );
      return;
    }
    console.log(`device target : ${target.deviceId} (kind=${target.kind})`);
    console.log(`endpoint      : ${formatDeviceTarget(target)}`);
    console.log(
      `auth          : ${target.auth?.method === 'private-key' ? 'private key' : target.auth?.method === 'password' ? 'password (env)' : 'none configured'}`
    );
    if (connections.length === 0) {
      console.log('connection    : idle (connects on the first device tool call)');
    } else {
      for (const conn of connections) {
        console.log(
          `connection    : ${conn.target.deviceId} — ${conn.status} (execs: ${conn.execCount})` +
            (conn.lastError ? ` last error: ${conn.lastError}` : '')
        );
      }
    }
    return;
  }

  console.error(`Unknown tasks subcommand "${sub}".\n\n${usage()}`);
}
