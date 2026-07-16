import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { RunProcessResult } from '../utils/run-process.js';
import { runProcess } from '../utils/run-process.js';
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
    .update(`${config.user || 'root'}@${config.host}:${config.port || 22}:${process.pid}:${Date.now()}`)
    .digest('hex')
    .slice(0, 16);
}

export class DeviceSshSession implements DeviceSshExecutor {
  private readonly sessionDir: string;
  private readonly controlPath: string;
  private connectPromise?: Promise<void>;
  private connected = false;
  private closed = false;
  private readonly cleanupOnExit = () => this.closeSync();

  constructor(private readonly config: DeviceSshConfig) {
    this.sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-ssh-'));
    fs.chmodSync(this.sessionDir, 0o700);
    this.controlPath = path.join(this.sessionDir, sessionId(config));
    process.once('exit', this.cleanupOnExit);
  }

  private baseArgs(connectTimeout = 10): string[] {
    const args = [
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      `ConnectTimeout=${connectTimeout}`,
      '-o',
      `ControlPath=${this.controlPath}`,
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
    ];
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
      this.connectPromise = runSsh(
        this.config,
        [
          ...this.baseArgs(),
          '-o',
          'ControlMaster=yes',
          '-o',
          'ControlPersist=yes',
          '-N',
          '-f',
          this.target(),
        ],
        { timeout: 15_000, maxBuffer: 256 * 1024 }
      ).then(() => {
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

  async run(
    remoteCommand: string,
    options: DeviceSshRunOptions = {}
  ): Promise<RunProcessResult> {
    options.signal?.throwIfAborted();
    await this.connect();
    await runSsh(
      this.config,
      [...this.baseArgs(2), '-O', 'check', this.target()],
      {
        timeout: Math.min(options.timeout ?? 5_000, 5_000),
        maxBuffer: 64 * 1024,
        signal: options.signal,
      }
    );
    return runSsh(
      this.config,
      [...this.baseArgs(5), this.target(), remoteCommand],
      {
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        signal: options.signal,
      }
    );
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
    try {
      await runSsh(
        this.config,
        [...this.baseArgs(5), '-O', 'exit', this.target()],
        { timeout: 5_000, maxBuffer: 64 * 1024, runner: runProcess }
      );
    } finally {
      this.connected = false;
      this.cleanupLocalState();
    }
  }

  private closeSync(): void {
    if (this.connected) {
      try {
        const args = [...this.baseArgs(1), '-O', 'exit', this.target()];
        const invocation = resolveSshInvocation(this.config, args);
        spawnSync(invocation.bin, invocation.args, { stdio: 'ignore', timeout: 1_000 });
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
