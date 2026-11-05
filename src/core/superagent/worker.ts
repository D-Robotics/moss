import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnProcess } from '../../utils/run-process.js';
import { ErrorCode, MossError } from '../../errors.js';
import type {
  SuperagentAssessment,
  SuperagentWorkRequest,
  SuperagentWorkerInput,
  SuperagentWorkerResult,
  SuperagentRule,
} from '../../contracts/superagent.js';

export interface SuperagentWorker {
  run(
    request: SuperagentWorkRequest,
    signal: AbortSignal,
    onTask: (taskId: string) => void
  ): Promise<SuperagentWorkerResult>;
  deliver(assignmentId: string, inputs: SuperagentWorkerInput[]): Promise<string[]>;
}
export interface SuperagentAssessorRequest {
  text: string;
  rules: SuperagentRule[];
}
export interface WorkerJob {
  kind: 'run' | 'assess';
  request?: SuperagentWorkRequest;
  assessment?: SuperagentAssessorRequest;
}
interface Running {
  child: ChildProcess;
  ready: boolean;
  deliveries: Map<string, { resolve(ids: string[]): void; reject(error: Error): void }>;
}
function failure(message: string): MossError {
  return new MossError({ code: ErrorCode.TOOL_EXECUTION_FAILED, message });
}

/** Boots the normal Moss CLI in a separate process; models and tools are not reimplemented here. */
export class NativeMossWorker implements SuperagentWorker {
  private readonly running = new Map<string, Running>();
  constructor(
    private readonly options: {
      env?: NodeJS.ProcessEnv;
      cliPath?: string;
      startupMs?: number;
      configFile?: string;
      readOnly?: boolean;
    } = {}
  ) {}

  run(
    request: SuperagentWorkRequest,
    signal: AbortSignal,
    onTask: (taskId: string) => void
  ): Promise<SuperagentWorkerResult> {
    return this.launch(
      { kind: 'run', request },
      request.workspaceDir,
      request.sessionKey,
      signal,
      onTask
    ) as Promise<SuperagentWorkerResult>;
  }
  assess(
    request: SuperagentAssessorRequest,
    workspace: string,
    signal: AbortSignal
  ): Promise<SuperagentAssessment> {
    return this.launch(
      { kind: 'assess', assessment: request },
      workspace,
      `superagent-assess-${randomUUID()}`,
      signal,
      () => {}
    ) as Promise<SuperagentAssessment>;
  }
  private launch(
    job: WorkerJob,
    cwd: string,
    sessionKey: string,
    signal: AbortSignal,
    onTask: (id: string) => void
  ): Promise<SuperagentWorkerResult | SuperagentAssessment> {
    if (signal.aborted) return Promise.reject(failure('Super-agent work was cancelled'));
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env), MOSS_NO_TUI: '1' };
    delete env.NODE_OPTIONS;
    const id = job.request?.assignmentId ?? sessionKey;
    const args = [
      this.options.cliPath ?? fileURLToPath(new URL('../../cli.js', import.meta.url)),
      'superagent',
      'worker',
      '-C',
      cwd,
      '--session',
      sessionKey,
      // B150: a worker is non-interactive, and `--workspace-write` maps to the
      // `manual` interaction mode, so every mutating tool was denied
      // ("requires approval, but Moss is running non-interactively") and the
      // ticket could never finish. Run jobs now inherit the operator's
      // resolved mode through the policy file (assess stays read-only): the
      // worktree isolation and the parent's safety settings still bound it.
      ...(job.kind === 'assess' || this.options.readOnly ? ['--read-only'] : []),
      ...(this.options.configFile ? ['--config-file', this.options.configFile] : []),
    ];
    const child = spawnProcess(process.execPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    // Do not retain CLI stdout/stderr: the IPC result is the only machine contract.
    child.stdout?.resume();
    child.stderr?.resume();
    const active: Running = { child, ready: false, deliveries: new Map() };
    this.running.set(id, active);
    return new Promise((resolve, reject) => {
      let result: unknown;
      let protocolError: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        if (child.connected) child.send({ type: 'cancel' }, () => {});
        killTimer ??= setTimeout(() => child.kill(), 10_000);
      };
      const startup = setTimeout(() => {
        protocolError = failure('Moss worker did not initialize');
        cancel();
      }, this.options.startupMs ?? 30_000);
      signal.addEventListener('abort', cancel, { once: true });
      child.on('message', (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const row = value as Record<string, unknown>;
        if (row.type === 'ready') {
          clearTimeout(startup);
          active.ready = true;
          child.send({ type: 'start', job }, (error) => {
            if (error) {
              protocolError = failure('Moss worker IPC failed');
              cancel();
            }
          });
          if (signal.aborted) cancel();
        } else if (row.type === 'task' && typeof row.taskId === 'string') {
          try {
            onTask(row.taskId);
          } catch {
            protocolError = failure('Native task acknowledgement failed');
            cancel();
          }
        } else if (row.type === 'result') result = row.result;
        else if (
          row.type === 'delivered' &&
          typeof row.id === 'string' &&
          Array.isArray(row.ids) &&
          row.ids.every((x) => typeof x === 'string')
        ) {
          active.deliveries.get(row.id)?.resolve(row.ids as string[]);
          active.deliveries.delete(row.id);
        }
      });
      const cleanup = () => {
        clearTimeout(startup);
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener('abort', cancel);
        this.running.delete(id);
        for (const waiter of active.deliveries.values())
          waiter.reject(failure('Moss worker stopped before input acknowledgement'));
      };
      child.once('error', (error) => {
        cleanup();
        reject(
          new MossError({
            code: ErrorCode.TOOL_EXECUTION_FAILED,
            message: 'Moss worker could not start',
            cause: error,
          })
        );
      });
      child.once('exit', (code) => {
        cleanup();
        if (
          protocolError ||
          signal.aborted ||
          code !== 0 ||
          !result ||
          typeof result !== 'object'
        ) {
          reject(
            protocolError ??
              failure(
                signal.aborted
                  ? 'Moss worker cancelled'
                  : 'Moss worker failed without a verified result'
              )
          );
          return;
        }
        resolve(result as SuperagentWorkerResult | SuperagentAssessment);
      });
    });
  }
  async deliver(assignmentId: string, inputs: SuperagentWorkerInput[]): Promise<string[]> {
    const active = this.running.get(assignmentId);
    if (!active?.ready || !active.child.connected)
      throw failure('Moss worker is not ready for follow-ups');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        active.deliveries.delete(id);
        reject(failure('Moss input delivery timed out'));
      }, 5_000);
      active.deliveries.set(id, {
        resolve: (ids) => {
          clearTimeout(timer);
          resolve(ids);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      active.child.send({ type: 'inputs', id, inputs }, (error) => {
        if (error) {
          clearTimeout(timer);
          active.deliveries.delete(id);
          reject(failure('Moss input delivery failed'));
        }
      });
    });
  }
}
