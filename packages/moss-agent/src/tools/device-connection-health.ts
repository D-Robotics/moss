import { ErrorCode, MossError, errorMessage } from '../errors.js';
import { ProcessError } from '../utils/run-process.js';
import type { DeviceSshConfig, DeviceSshProbeResult } from './device-ssh.js';

export interface DeviceConnectionSnapshot {
  state: 'connected' | 'disconnected';
  target: string;
  disconnectedAt?: number;
  reason?: string;
}

export interface DeviceConnectionHealthOptions {
  probe: (
    config: DeviceSshConfig,
    options?: { abortSignal?: AbortSignal }
  ) => Promise<DeviceSshProbeResult>;
  onDisconnected?: (snapshot: DeviceConnectionSnapshot) => void;
  /** Extra probe attempts after the first failure before flipping the circuit
   *  to disconnected. On win32 each probe is a standalone ssh (no ControlMaster
   *  reuse), so a single transient failure must not sever the session. 0 = the
   *  historical one-strike behavior. */
  probeRetries?: number;
}

export class DeviceConnectionLostError extends MossError {
  constructor(config: DeviceSshConfig, reason: string, operation?: string) {
    const user = config.user || 'root';
    const port = config.port || 22;
    const target = `${user}@${config.host}:${port}`;
    const retry = `/connect ${user}@${config.host}${port === 22 ? '' : ` --port ${port}`}`;
    super({
      code: ErrorCode.DEVICE_SSH_FAILED,
      message: `Device connection lost: ${target}${operation ? ` while running ${operation}` : ''}. ${reason}`,
      hint: `Reconnect with ${retry}. Device tools will fail fast until the session is reconnected.`,
      recoverable: true,
      context: { host: config.host, user, port, operation },
    });
    this.name = 'DeviceConnectionLostError';
  }
}

function isTransportFailure(config: DeviceSshConfig, error: unknown): boolean {
  if (!(error instanceof ProcessError)) return false;
  if (Boolean(config.password) && error.exitCode === 5) return true;
  const output = `${error.stderr}\n${error.stdout}`.toLowerCase();
  return [
    'connection refused',
    'connection reset',
    'connection closed',
    'connection timed out',
    'no route to host',
    'host is down',
    'host unreachable',
    'network is unreachable',
    'could not resolve hostname',
    'broken pipe',
    'permission denied',
  ].some((pattern) => output.includes(pattern));
}

function connectionFailureReason(error: unknown): string {
  if (error instanceof ProcessError) {
    const output = [error.stderr, error.stdout].filter(Boolean).join('\n').trim();
    if (output) return output;
  }
  return errorMessage(error);
}

export class DeviceConnectionHealth {
  private state: 'connected' | 'disconnected' = 'connected';
  private disconnectedAt?: number;
  private reason?: string;
  private probeInFlight?: Promise<DeviceSshProbeResult>;

  constructor(
    private readonly config: DeviceSshConfig,
    private readonly options: DeviceConnectionHealthOptions
  ) {}

  snapshot(): DeviceConnectionSnapshot {
    return {
      state: this.state,
      target: `${this.config.user || 'root'}@${this.config.host}:${this.config.port || 22}`,
      ...(this.disconnectedAt ? { disconnectedAt: this.disconnectedAt } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }

  async beforeOperation(operation: string): Promise<void> {
    if (this.state !== 'disconnected') return;
    throw new DeviceConnectionLostError(
      this.config,
      this.reason || 'A previous SSH operation established that the transport is unavailable.',
      operation
    );
  }

  async handleFailure(
    error: unknown,
    context: { operation: string; abortSignal?: AbortSignal }
  ): Promise<void> {
    if (this.state === 'disconnected') {
      throw new DeviceConnectionLostError(
        this.config,
        this.reason || errorMessage(error),
        context.operation
      );
    }
    if (isTransportFailure(this.config, error)) {
      this.disconnect(connectionFailureReason(error));
      throw new DeviceConnectionLostError(this.config, this.reason!, context.operation);
    }
    if (
      !(error instanceof ProcessError) ||
      (!error.timedOut && error.exitCode !== 255) ||
      context.abortSignal?.aborted
    ) {
      return;
    }

    const probe = await this.probeWithRetries(context.abortSignal);
    if (probe.ok) return;
    this.disconnect(probe.detail);
    throw new DeviceConnectionLostError(this.config, probe.detail, context.operation);
  }

  private probe(abortSignal?: AbortSignal): Promise<DeviceSshProbeResult> {
    if (!this.probeInFlight) {
      this.probeInFlight = this.options.probe(this.config, { abortSignal }).finally(() => {
        this.probeInFlight = undefined;
      });
    }
    return this.probeInFlight;
  }

  /** Probe with retries. A transient failure (common on win32, where each probe
   *  is a standalone ssh with no ControlMaster reuse) does not sever the
   *  session; only when every attempt fails do we disconnect. */
  private async probeWithRetries(abortSignal?: AbortSignal): Promise<DeviceSshProbeResult> {
    const retries = this.options.probeRetries ?? 0;
    let result = await this.probe(abortSignal);
    for (let attempt = 0; attempt < retries && !result.ok; attempt++) {
      result = await this.probe(abortSignal);
    }
    return result;
  }

  private disconnect(reason: string): void {
    if (this.state === 'disconnected') return;
    this.state = 'disconnected';
    this.disconnectedAt = Date.now();
    this.reason = reason.trim() || 'SSH transport unavailable.';
    this.options.onDisconnected?.(this.snapshot());
  }
}
