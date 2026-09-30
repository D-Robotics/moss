import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  DeploymentHealthCheck,
  DeploymentPlan,
  DeploymentRecord,
  DeploymentStepLog,
} from '../contracts/deployment.js';
import type { DeviceConnection } from '../contracts/device.js';
import { isCommandDangerous } from '../safety/channel-safety.js';

/**
 * Deployment lifecycle runner (robotics closed loop P0-5): one place that
 * takes an artifact to a device, optionally starts it, proves it is alive,
 * and records every step so later verification has evidence to build on.
 */

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const OUTPUT_PREVIEW_CHARS = 300;

function preview(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > OUTPUT_PREVIEW_CHARS
    ? `${trimmed.slice(0, OUTPUT_PREVIEW_CHARS)}…`
    : trimmed;
}

function remoteDir(remotePath: string): string {
  const dir = path.posix.dirname(remotePath);
  return dir === remotePath ? '/' : dir;
}

function newDeploymentId(): string {
  return `deploy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface RunDeploymentOptions {
  signal?: AbortSignal;
}

export async function runDeployment(
  conn: DeviceConnection,
  plan: DeploymentPlan,
  options: RunDeploymentOptions = {}
): Promise<DeploymentRecord> {
  const record: DeploymentRecord = {
    deploymentId: newDeploymentId(),
    deviceId: conn.target.deviceId,
    artifactPath: plan.artifactPath,
    remotePath: plan.remotePath,
    status: 'pending',
    startedAt: Date.now(),
    steps: [],
  };
  const timeoutMs = plan.timeoutMs ?? 60_000;

  const step = (log: DeploymentStepLog): void => {
    record.steps.push(log);
  };
  const fail = (log: DeploymentStepLog, error: string): DeploymentRecord => {
    step(log);
    record.status = 'failed';
    record.error = error;
    record.completedAt = Date.now();
    return record;
  };

  // 1. prepare-dir
  record.status = 'uploading';
  const prepareCmd = `mkdir -p ${shellQuote(remoteDir(plan.remotePath))}`;
  try {
    const prepared = await conn.exec(prepareCmd, {
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (prepared.exitCode !== 0) {
      return fail(
        {
          step: 'prepare-dir',
          status: 'failed',
          exitCode: prepared.exitCode,
          durationMs: prepared.durationMs,
          ...(preview(prepared.stderr) ? { outputPreview: preview(prepared.stderr) } : {}),
        },
        `mkdir -p failed (exit ${prepared.exitCode}): ${preview(prepared.stderr) ?? '(no output)'}`
      );
    }
    step({ step: 'prepare-dir', status: 'ok', exitCode: 0, durationMs: prepared.durationMs });
  } catch (err) {
    return fail({ step: 'prepare-dir', status: 'failed' }, String(err));
  }

  // 2. upload
  const uploadStarted = Date.now();
  try {
    await conn.writeFile(plan.remotePath, { localPath: plan.artifactPath });
    step({ step: 'upload', status: 'ok', durationMs: Date.now() - uploadStarted });
  } catch (err) {
    return fail({ step: 'upload', status: 'failed' }, `SFTP upload failed: ${String(err)}`);
  }
  record.status = 'uploaded';

  // 3. chmod (optional)
  if (plan.executable) {
    try {
      const chmod = await conn.exec(`chmod +x ${shellQuote(plan.remotePath)}`, {
        timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (chmod.exitCode !== 0) {
        return fail(
          { step: 'chmod', status: 'failed', exitCode: chmod.exitCode },
          `chmod +x failed (exit ${chmod.exitCode}): ${preview(chmod.stderr) ?? '(no output)'}`
        );
      }
      step({ step: 'chmod', status: 'ok', exitCode: 0 });
    } catch (err) {
      return fail({ step: 'chmod', status: 'failed' }, String(err));
    }
  } else {
    step({ step: 'chmod', status: 'skipped' });
  }

  // 4. start (optional)
  if (plan.startCommand) {
    const dangerous = isCommandDangerous(plan.startCommand);
    if (dangerous.blocked) {
      return fail(
        { step: 'start', status: 'failed' },
        `start command blocked by safety policy: ${dangerous.reason}`
      );
    }
    record.status = 'starting';
    try {
      const started = await conn.exec(plan.startCommand, {
        timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (started.exitCode !== 0) {
        return fail(
          {
            step: 'start',
            status: 'failed',
            exitCode: started.exitCode,
            ...(preview(started.stderr || started.stdout)
              ? { outputPreview: preview(started.stderr || started.stdout) }
              : {}),
          },
          `start command failed (exit ${started.exitCode}): ${preview(started.stderr || started.stdout) ?? '(no output)'}`
        );
      }
      step({
        step: 'start',
        status: 'ok',
        exitCode: 0,
        ...(preview(started.stdout) ? { outputPreview: preview(started.stdout) } : {}),
      });
    } catch (err) {
      return fail({ step: 'start', status: 'failed' }, String(err));
    }
  } else {
    step({ step: 'start', status: 'skipped' });
  }

  // 5. health check (optional)
  if (plan.healthCommand) {
    const dangerous = isCommandDangerous(plan.healthCommand);
    if (dangerous.blocked) {
      return fail(
        { step: 'health-check', status: 'failed' },
        `health command blocked by safety policy: ${dangerous.reason}`
      );
    }
    try {
      const health = await conn.exec(plan.healthCommand, {
        timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const exitOk = health.exitCode === 0 && !health.timedOut;
      // Line-anchored matching (grep semantics): device output almost always
      // ends with a newline, so `^active$` must match "active\n".
      const expectOk = plan.healthExpect
        ? new RegExp(plan.healthExpect, 'm').test(health.stdout)
        : true;
      const passed = exitOk && expectOk;
      const check: DeploymentHealthCheck = {
        command: plan.healthCommand,
        passed,
        checkedAt: Date.now(),
        exitCode: health.exitCode,
        ...(preview(health.stdout || health.stderr)
          ? { outputPreview: preview(health.stdout || health.stderr) }
          : {}),
      };
      record.healthCheck = check;
      step({ step: 'health-check', status: passed ? 'ok' : 'failed', exitCode: health.exitCode });
      record.status = passed ? 'running' : 'failed';
      record.completedAt = Date.now();
      if (!passed) {
        record.error = `health check failed (exit=${health.exitCode}, expect=${expectOk ? 'ok' : 'mismatch'}): ${check.outputPreview ?? '(no output)'}`;
      }
      return record;
    } catch (err) {
      step({ step: 'health-check', status: 'failed' });
      record.status = 'failed';
      record.error = String(err);
      record.completedAt = Date.now();
      return record;
    }
  }

  step({ step: 'health-check', status: 'skipped' });
  record.status = plan.startCommand ? 'running' : 'uploaded';
  record.completedAt = Date.now();
  return record;
}

// ---- Record persistence (workspace .moss/deployments.jsonl) ----

export async function appendDeploymentRecord(
  workspaceDir: string,
  record: DeploymentRecord
): Promise<void> {
  const dir = path.join(workspaceDir, '.moss');
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, 'deployments.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
}

export async function listDeploymentRecords(
  workspaceDir: string,
  limit = 20
): Promise<DeploymentRecord[]> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, '.moss', 'deployments.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim() !== '');
    return lines
      .slice(-limit)
      .map((line) => JSON.parse(line) as DeploymentRecord)
      .reverse();
  } catch {
    return [];
  }
}

export function formatDeploymentRecord(record: DeploymentRecord): string {
  const lines = [
    `deployment ${record.deploymentId} on ${record.deviceId}: ${record.status.toUpperCase()}`,
    `artifact: ${record.artifactPath} → ${record.remotePath}`,
  ];
  for (const s of record.steps) {
    const bits = [`  ${s.step}: ${s.status}`];
    if (s.exitCode !== undefined && s.exitCode !== null) bits.push(`exit=${s.exitCode}`);
    if (s.durationMs !== undefined) bits.push(`${s.durationMs}ms`);
    if (s.outputPreview) bits.push(`— ${s.outputPreview.split('\n')[0]}`);
    lines.push(bits.join(' '));
  }
  if (record.healthCheck) {
    lines.push(
      `  health: ${record.healthCheck.passed ? 'PASS' : 'FAIL'} (${record.healthCheck.command})` +
        (record.healthCheck.outputPreview
          ? ` — ${record.healthCheck.outputPreview.split('\n')[0]}`
          : '')
    );
  }
  if (record.error) lines.push(`  error: ${record.error}`);
  return lines.join('\n');
}
