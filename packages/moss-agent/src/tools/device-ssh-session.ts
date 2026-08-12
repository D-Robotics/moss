import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunProcessResult } from '../utils/run-process.js';
import { runProcess, runProcessSync } from '../utils/run-process.js';
import type { DeviceSshConfig } from './device-ssh.js';
import { expandHomePath, resolveSshInvocation, runSsh } from './ssh-utils.js';

export interface DeviceSshRunOptions {
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
}

export interface DeviceSshExecutor {
  run(remoteCommand: string, options?: DeviceSshRunOptions): Promise<RunProcessResult>;
}

function sessionId(config: DeviceSshConfig): string {
  return crypto
    .createHash('sha256')
    .update(
      `${config.user || 'root'}@${config.host}:${config.port || 22}:${process.pid}:${Date.now()}`
    )
    .digest('hex')
    .slice(0, 16);
}

export class DeviceSshSession implements DeviceSshExecutor {
  private readonly sessionDir: string;
  private readonly controlPath: string;
  private readonly isWindows: boolean;
  private connectPromise?: Promise<void>;
  private connected = false;
  private closed = false;
  private readonly cleanupOnExit = () => this.closeSync();

  constructor(private readonly config: DeviceSshConfig) {
    this.sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-ssh-'));
    fs.chmodSync(this.sessionDir, 0o700);
    this.controlPath = path.join(this.sessionDir, sessionId(config));
    // Windows OpenSSH does not support ControlMaster multiplexing — it fails
    // with "getsockname failed: Not a socket". On win32 the session skips the
    // master connection and runs each command as a standalone ssh invocation.
    this.isWindows = (config.platformOverride ?? process.platform) === 'win32';
    process.once('exit', this.cleanupOnExit);
  }

  private baseArgs(connectTimeout = 10): string[] {
    const args = [
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      `ConnectTimeout=${connectTimeout}`,
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
    ];
    // ControlPath is only meaningful with ControlMaster multiplexing, which
    // win32 does not use. Omit it on win32 to avoid a dead socket-path arg.
    if (!this.isWindows) args.push('-o', `ControlPath=${this.controlPath}`);
    if (this.config.keyPath) args.push('-i', expandHomePath(this.config.keyPath));
    args.push('-p', String(this.config.port || 22));
    return args;
  }

  private target(): string {
    return `${this.config.user || 'root'}@${this.config.host}`;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.closed) throw new Error('Device SSH session is closed. Run /connect again.');
    if (!this.connectPromise) {
      // Win32 has no ControlMaster master to establish, but connect() must still
      // perform a real SSH handshake. Share the pending handshake so concurrent
      // first commands cannot trigger duplicate password authentication.
      const connectArgs = this.isWindows
        ? [...this.baseArgs(), this.target(), 'true']
        : [
            ...this.baseArgs(),
            '-o',
            'ControlMaster=yes',
            '-o',
            'ControlPersist=yes',
            '-N',
            '-f',
            this.target(),
          ];
      this.connectPromise = runSsh(this.config, connectArgs, {
        timeout: 15_000,
        maxBuffer: this.isWindows ? 64 * 1024 : 256 * 1024,
      }).then(() => {
        this.connected = true;
      });
    }
    try {
      await this.connectPromise;
    } catch (error) {
      this.connectPromise = undefined;
      throw error;
    }
  }

  async run(remoteCommand: string, options: DeviceSshRunOptions = {}): Promise<RunProcessResult> {
    options.signal?.throwIfAborted();
    await this.connect();
    // Win32: no master to probe with `-O check`; run a standalone ssh carrying
    // the remoteCommand. Each invocation authenticates via the askpass helper.
    if (this.isWindows) {
      return runSsh(this.config, [...this.baseArgs(5), this.target(), remoteCommand], {
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        signal: options.signal,
      });
    }
    await runSsh(this.config, [...this.baseArgs(2), '-O', 'check', this.target()], {
      timeout: Math.min(options.timeout ?? 5_000, 5_000),
      maxBuffer: 64 * 1024,
      signal: options.signal,
    });
    return runSsh(this.config, [...this.baseArgs(5), this.target(), remoteCommand], {
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      signal: options.signal,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.connectPromise;
    } catch {
      return;
    }
    if (!this.connected) {
      this.cleanupLocalState();
      return;
    }
    // Win32 has no master connection to tear down with `-O exit`.
    if (this.isWindows) {
      this.connected = false;
      this.cleanupLocalState();
      return;
    }
    try {
      await runSsh(this.config, [...this.baseArgs(5), '-O', 'exit', this.target()], {
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        runner: runProcess,
      });
    } finally {
      this.connected = false;
      this.cleanupLocalState();
    }
  }

  private closeSync(): void {
    if (this.connected && !this.isWindows) {
      try {
        const args = [...this.baseArgs(1), '-O', 'exit', this.target()];
        const invocation = resolveSshInvocation(this.config, args);
        runProcessSync(invocation.bin, invocation.args, { stdio: 'ignore', timeout: 1_000 });
      } catch {
        // Process-exit cleanup is best effort; OpenSSH also closes on transport loss.
      }
    }
    this.cleanupLocalState();
  }

  private cleanupLocalState(): void {
    process.removeListener('exit', this.cleanupOnExit);
    try {
      fs.rmSync(this.sessionDir, { recursive: true, force: true });
    } catch {
      // The OS temp cleaner is the final fallback.
    }
  }
}
