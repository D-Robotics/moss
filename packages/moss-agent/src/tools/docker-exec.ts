
















import type { Tool } from '../core/tools/tool-types.js';
import {
  runProcess,
  ProcessError,
  type RunProcessOptions,
  type RunProcessResult,
} from '../utils/run-process.js';
import { wrapAsMoss, ErrorCode } from '../errors.js';
import { safeChildEnv } from '../utils/safe-child-env.js';

const IS_WIN = process.platform === 'win32';

export interface DockerExecConfig {
  image?: string;
  workspaceDir: string;
  timeoutMs?: number;
  



  runProcessImpl?: (cmd: string, opts: RunProcessOptions) => Promise<RunProcessResult>;
}

async function isDockerAvailable(
  runner: (cmd: string, opts: RunProcessOptions) => Promise<RunProcessResult>,
  signal?: AbortSignal
): Promise<{ available: boolean; reason?: string }> {
  try {
    await runner('docker', {
      args: ['info'],
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      signal,
      env: safeChildEnv(),
    });
    return { available: true };
  } catch (err: any) {
    let reason = 'unknown';
    if (err instanceof ProcessError) {
      const stderr = err.stderr.toLowerCase();
      if (stderr.includes('cannot connect') || stderr.includes('daemon')) {
        reason = 'daemon not running — try: docker daemon or brew services start docker';
      } else if (stderr.includes('permission denied')) {
        reason = 'permission denied — try: sudo usermod -aG docker $USER or run with sudo';
      } else if (err.exitCode === 127 || err.message.includes('ENOENT')) {
        reason = 'not installed — install Docker from docker.com';
      } else {
        reason = err.stderr.trim() || err.message || 'check status';
      }
    }
    return { available: false, reason };
  }
}

export function createDockerExecTool(config: DockerExecConfig): Tool {
  const image = config.image || 'node:20-slim';
  const timeout = config.timeoutMs || 30_000;
  const runner = config.runProcessImpl ?? runProcess;

  return {
    name: 'exec',
    description: `Execute a shell command inside a Docker container (${image}). The workspace is mounted at /workspace. Provides stronger isolation than local execution.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute inside the container' },
        timeout_ms: {
          type: 'number',
          description: `Timeout in milliseconds (default: ${timeout})`,
        },
      },
      required: ['command'],
    },
    async execute(input, ctx) {
      const timeoutMs = Number(input.timeout_ms) || timeout;
      const workDir = ctx.workspaceDir || config.workspaceDir;

      const dockerStatus = await isDockerAvailable(runner, ctx.abortSignal);
      if (!dockerStatus.available) {
        return `Error: Docker is not available — ${dockerStatus.reason || 'unknown reason'}. Alternatives: set MOSS_EXEC_BACKEND=local or install Docker.`;
      }

      const mountPath = IS_WIN ? workDir.replace(/\\/g, '/') : workDir;

      try {
        const result = await runner('docker', {
          args: [
            'run',
            '--rm',
            '-v',
            `${mountPath}:/workspace`,
            '-w',
            '/workspace',
            '--network',
            'none',
            '--memory',
            '512m',
            '--cpus',
            '1',
            image,
            '/bin/sh',
            '-c',
            String(input.command),
          ],
          timeout: timeoutMs + 10_000,
          maxBuffer: 10 * 1024 * 1024,
          signal: ctx.abortSignal,
          env: safeChildEnv(),
        });
        return result.stdout.trim() || '(no output)';
      } catch (err) {
        if (err instanceof ProcessError) {
          const stderr = err.stderr.trim();
          const stdout = err.stdout.trim();
          let errorMsg = '';

          if (err.timedOut) {
            errorMsg = `Command timed out after ${timeoutMs}ms. Increase timeout_ms if needed.`;
          } else {
            errorMsg = `Docker exec failed (exit ${err.exitCode})`;
            const output = [stdout, stderr].filter(Boolean).join('\n');
            if (output) errorMsg += `:\n${output}`;
            else if (err.message) errorMsg += `: ${err.message}`;
          }
          return errorMsg;
        }
        throw wrapAsMoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
          hint: 'Check Docker daemon status and image availability',
          recoverable: true,
        });
      }
    },
  };
}
