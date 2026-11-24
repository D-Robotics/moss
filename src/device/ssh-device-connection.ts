import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Client } from 'ssh2';
import type {
  DeviceCommandResult,
  DeviceConnection,
  DeviceConnectionStatus,
  DeviceExecOptions,
  DeviceFileEntry,
  DeviceReadFileOptions,
  DeviceTarget,
  DeviceWriteFileOptions,
} from '../contracts/device.js';
import { ErrorCode, MossError } from '../errors.js';
import { uiText } from '../utils/ui-language.js';
import { classifyDeviceConnectError, formatDeviceConnectError } from './device-connect-error.js';
import {
  buildRosSourceCommand,
  buildShellInit,
  frameShellCommand,
  makeShellSentinel,
  parseSourcedRosSetup,
  parseShellFrame,
} from './shell-protocol.js';

/**
 * B18: `ssh2` (27 CommonJS modules incl. tweetnacl/asn1/bcrypt-pbkdf) was
 * imported at module load, so every `moss` process paid ~38 ms of startup even
 * with no device configured. It is only needed once a device connection is
 * actually established, so load it here and cache the constructor.
 */
type Ssh2Module = typeof import('ssh2');
let ssh2ModulePromise: Promise<Ssh2Module> | null = null;
async function loadSsh2(): Promise<Ssh2Module> {
  if (!ssh2ModulePromise) ssh2ModulePromise = import('ssh2');
  return await ssh2ModulePromise;
}

/** Max simultaneous remote channels (exec streams / sftp sessions). */
const MAX_INFLIGHT = 4;
/** Bound the TCP+handshake wait. A blackhole route otherwise sits in SYN_SENT for minutes. */
export const DEVICE_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const STREAM_CAP_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_MAX_BYTES = 256 * 1024;

function capBuffer(chunks: Buffer[], cap = STREAM_CAP_BYTES): Buffer {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total <= cap) return Buffer.concat(chunks);
  return Buffer.concat(chunks, cap);
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }
  release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

/**
 * B20: device exec/sftp failures are recoverable, so they carry the next step
 * instead of only the raw ssh2 message. Kept as one bilingual constant so every
 * runtime failure on the device connection says the same thing.
 */
const DEVICE_RUNTIME_FAILURE_HINT = {
  en: 'Re-check the device with device_probe (reachability, command exists), then retry; a dropped connection is re-established automatically.',
  zh: '先用 device_probe 复查设备连通性与命令是否存在，再重试；连接断开时重试会自动重连。',
} as const;

interface SshAuth {
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** Path to the host's ssh-agent socket (`ssh-agent` method). */
  agent?: string;
}

async function resolveAuth(target: DeviceTarget): Promise<SshAuth> {
  const username = target.user || 'root';
  const auth = target.auth;
  if (!auth) return { username };
  if (auth.method === 'ssh-agent') {
    const agent = process.env.SSH_AUTH_SOCK?.trim();
    const passphrase = auth.passphraseEnvVar ? process.env[auth.passphraseEnvVar] : undefined;
    // An explicit key file is tried before the agent (ssh2 order: password,
    // publickey, agent), so ~/.ssh/config-style setups work with an empty agent.
    if (auth.privateKeyPath) {
      const privateKey = await fs.readFile(expandHome(auth.privateKeyPath), 'utf8');
      return {
        username,
        privateKey,
        ...(passphrase ? { passphrase } : {}),
        ...(agent ? { agent } : {}),
      };
    }
    if (!agent) {
      throw new MossError({
        code: ErrorCode.CONFIG_IO_FAILED,
        message: uiText(
          'Device auth is ssh-agent but SSH_AUTH_SOCK is not set on the moss host.',
          '设备认证方式为 ssh-agent，但 moss 宿主机未设置 SSH_AUTH_SOCK。'
        ),
        hint: uiText(
          'Start the agent (ssh-add) or configure MOSS_DEVICE_KEY for a key file.',
          '先启动 ssh-agent（ssh-add），或改用 MOSS_DEVICE_KEY 指定密钥文件。'
        ),
        recoverable: true,
      });
    }
    return { username, agent };
  }
  if (auth.method === 'private-key') {
    if (!auth.privateKeyPath) return { username };
    const keyPath = expandHome(auth.privateKeyPath);
    const privateKey = await fs.readFile(keyPath, 'utf8');
    const passphrase = auth.passphraseEnvVar ? process.env[auth.passphraseEnvVar] : undefined;
    return { username, privateKey, ...(passphrase ? { passphrase } : {}) };
  }
  const password = auth.passwordEnvVar ? process.env[auth.passwordEnvVar] : undefined;
  return { username, ...(password ? { password } : {}) };
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export interface SshConnectOptions {
  /** Overrides the 10s connect bound. Tests use a short value. */
  connectTimeoutMs?: number;
}

/** Sourcing a TROS/ROS overlay chains dozens of setup scripts on an embedded board (seconds, not ms). */
export const ROS_SOURCE_TIMEOUT_MS = 60_000;
/** Bound for the shell's own startup frame. */
const SHELL_READY_TIMEOUT_MS = 20_000;
const SHELL_OUTPUT_CAP_BYTES = STREAM_CAP_BYTES;

type ShellStream = import('ssh2').ClientChannel;

interface PendingFrame {
  sentinel: string;
  resolve: (result: DeviceCommandResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
  command: string;
  startedAt: number;
  timedOut: boolean;
  abortHandler?: () => void;
  signal?: AbortSignal;
}

/**
 * One long-lived remote bash for a connection. Commands run strictly one at a
 * time; state (`cd`, `export`, `source`) persists between them. The robotics
 * overlay is sourced lazily — only when a command actually needs it — and only
 * once per shell.
 */
export class PersistentDeviceShell {
  private stream: ShellStream | null = null;
  private opening: Promise<void> | null = null;
  private readonly sentinel = makeShellSentinel();
  private buffer = '';
  private pending: PendingFrame | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private rosSetup: string | null = null;
  private rosAnnounced = false;
  private readonly readyTimeoutMs: number;

  constructor(
    private readonly client: Client,
    options: { readyTimeoutMs?: number } = {}
  ) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? SHELL_READY_TIMEOUT_MS;
  }

  /** Which overlay the shell has sourced, when any. */
  get sourcedRosSetup(): string | null {
    return this.rosSetup;
  }

  async run(command: string, options: DeviceExecOptions = {}): Promise<DeviceCommandResult> {
    const run = this.queue.then(async () => {
      const result = await this.runExclusive(command, options);
      if (this.rosSetup && !this.rosAnnounced) {
        this.rosAnnounced = true;
        return { ...result, stdout: `${result.stdout}\n[ROS_ENV_SOURCED ${this.rosSetup}]` };
      }
      return result;
    });
    // Keep the chain alive after a failure so the next command still runs.
    this.queue = run.catch(() => undefined);
    return await run;
  }

  close(): void {
    this.failPending(new Error('device shell closed'));
    const stream = this.stream;
    this.stream = null;
    this.opening = null;
    if (stream) {
      try {
        stream.close();
      } catch {
        // Already gone.
      }
    }
  }

  private failPending(err: Error): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.signal && pending.abortHandler)
        pending.signal.removeEventListener('abort', pending.abortHandler);
      pending.reject(err);
    }
  }

  private async open(): Promise<void> {
    if (this.stream) return;
    if (this.opening) return await this.opening;
    this.opening = (async () => {
      this.buffer = '';
      this.rosSetup = null;
      this.rosAnnounced = false;
      // `false` = no pty-req: nothing echoes, nothing paginates, no program
      // switches into interactive mode because it sees a terminal.
      const stream = await new Promise<ShellStream>((resolve, reject) => {
        this.client.shell(false, (err, s) => (err ? reject(err) : resolve(s)));
      });
      this.stream = stream;
      stream.on('data', (chunk: Buffer) => this.onData(chunk));
      stream.once('close', () => {
        if (this.stream === stream) {
          this.stream = null;
          this.failPending(new Error('device shell closed by remote'));
        }
      });
      stream.once('error', (err: Error) => {
        if (this.stream === stream) {
          this.stream = null;
          this.failPending(err);
        }
      });
      // Startup frame: same sentinel, READY marker, exit code 0.
      const ready = await this.exchange(buildShellInit(), this.readyTimeoutMs);
      if (!/READY/.test(ready.stdout)) {
        this.close();
        throw new Error(`device shell did not report READY (got: ${ready.stdout.slice(0, 120)})`);
      }
      // Parity with the developer's interactive shell: `python3 -c "import rclpy"`
      // fails on the board until the overlay is sourced. Done once per shell,
      // before the first command, so no task ever loses a round trip to it.
      await this.ensureRosEnv();
    })();
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > SHELL_OUTPUT_CAP_BYTES) {
      // Keep the tail: the sentinel is always at the end.
      this.buffer = this.buffer.slice(-Math.floor(SHELL_OUTPUT_CAP_BYTES / 2));
    }
    this.trySettle();
  }

  private trySettle(): void {
    const pending = this.pending;
    if (!pending) return;
    const frame = parseShellFrame(this.buffer, pending.sentinel);
    if (!frame) return;
    this.buffer = frame.rest;
    this.pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler)
      pending.signal.removeEventListener('abort', pending.abortHandler);
    pending.resolve({
      command: pending.command,
      exitCode: pending.timedOut ? null : frame.exitCode,
      stdout: frame.stdout,
      stderr: '',
      timedOut: pending.timedOut,
      durationMs: Date.now() - pending.startedAt,
    });
  }

  private exchange(
    command: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<DeviceCommandResult> {
    return new Promise<DeviceCommandResult>((resolve, reject) => {
      const stream = this.stream;
      if (!stream) {
        reject(new Error('device shell is not open'));
        return;
      }
      const pending: PendingFrame = {
        sentinel: this.sentinel,
        resolve,
        reject,
        timer: null,
        command,
        startedAt: Date.now(),
        timedOut: false,
        signal,
      };
      if (signal) {
        if (signal.aborted) {
          reject(new Error('device shell command aborted'));
          return;
        }
        pending.abortHandler = () => this.abortPending(pending);
        signal.addEventListener('abort', pending.abortHandler, { once: true });
      }
      pending.timer = setTimeout(() => {
        if (this.pending !== pending) return;
        pending.timedOut = true;
        // Without a PTY there is no Ctrl-C to send; tearing the shell down is
        // what stops the remote command (sshd delivers SIGHUP to the session).
        this.failPendingWithTimeout(pending);
        this.close();
      }, timeoutMs);
      this.pending = pending;
      stream.write(`${frameShellCommand(command, this.sentinel)}\n`);
    });
  }

  private abortPending(pending: PendingFrame): void {
    if (this.pending !== pending) return;
    this.failPending(new Error('device shell command aborted'));
    this.close();
  }

  private failPendingWithTimeout(pending: PendingFrame): void {
    if (this.pending !== pending) return;
    this.pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler)
      pending.signal.removeEventListener('abort', pending.abortHandler);
    pending.resolve({
      command: pending.command,
      exitCode: null,
      stdout: this.buffer,
      stderr: '',
      timedOut: true,
      durationMs: Date.now() - pending.startedAt,
    });
  }

  private async runExclusive(
    command: string,
    options: DeviceExecOptions
  ): Promise<DeviceCommandResult> {
    await this.open();
    return await this.exchange(
      command,
      options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      options.signal
    );
  }

  /**
   * Source the robotics overlay once. A failure is not fatal: the command runs
   * anyway and the model sees the overlay is missing from the command output.
   */
  private async ensureRosEnv(): Promise<void> {
    try {
      const result = await this.exchange(buildRosSourceCommand(), ROS_SOURCE_TIMEOUT_MS);
      const setup = parseSourcedRosSetup(result.stdout);
      if (result.exitCode === 0 && setup) this.rosSetup = setup;
    } catch (err) {
      if (!(err instanceof Error && /closed|aborted/.test(err.message))) throw err;
    }
  }
}

export class SshDeviceConnection implements DeviceConnection {
  readonly target: DeviceTarget;
  private client: Client | null = null;
  private readyPromise: Promise<Client> | null = null;
  private readonly inflight = new Semaphore(MAX_INFLIGHT);
  private readonly connectTimeoutMs: number;
  private _status: DeviceConnectionStatus = 'disconnected';
  private _lastError: string | undefined;
  private shell: PersistentDeviceShell | null = null;
  private shellClient: Client | null = null;
  execCount = 0;
  lastActiveAt: number | undefined;

  constructor(target: DeviceTarget, options: SshConnectOptions = {}) {
    this.target = target;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEVICE_CONNECT_TIMEOUT_MS;
  }

  get status(): DeviceConnectionStatus {
    return this._status;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (this.readyPromise) return this.readyPromise;
    this._status = 'connecting';
    this.readyPromise = (async () => {
      const auth = await resolveAuth(this.target);
      if (!auth.password && !auth.privateKey && !auth.agent) {
        const where = `${this.target.host}:${this.target.port ?? 22}`;
        const copy = formatDeviceConnectError({
          kind: 'credentials',
          where,
          host: this.target.host,
        });
        throw new MossError({
          code: ErrorCode.CONFIG_IO_FAILED,
          message: copy.message,
          hint: copy.hint,
          recoverable: true,
        });
      }
      const { Client } = await loadSsh2();
      const client = new Client();
      const timeoutMs = this.connectTimeoutMs;
      return await new Promise<Client>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          fail(new Error(`Timed out while waiting for handshake (${timeoutMs}ms)`));
        }, timeoutMs);
        const cleanup = () => {
          client.removeListener('ready', onReady);
        };
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
          cleanup();
        };
        const fail = (err: Error) => {
          finish(() => {
            this.handleDown(err.message);
            try {
              client.destroy();
            } catch {
              // The socket may not exist yet when the timer wins the race.
            }
            const where = `${this.target.host}:${this.target.port ?? 22}`;
            const kind = classifyDeviceConnectError(err.message);
            const copy = formatDeviceConnectError({
              kind,
              where: kind === 'other' ? `${this.target.user || 'root'}@${where}` : where,
              host: this.target.host,
              timeoutMs,
              ...(kind === 'other' ? { detail: err.message } : {}),
            });
            reject(
              new MossError({
                code: ErrorCode.TOOL_EXECUTION_FAILED,
                message: copy.message,
                hint: copy.hint,
                recoverable: true,
                context: {
                  deviceId: this.target.deviceId,
                  host: this.target.host,
                  port: this.target.port ?? 22,
                },
              })
            );
          });
        };
        const onReady = () => {
          finish(() => {
            this.client = client;
            this._status = 'connected';
            this._lastError = undefined;
            client.on('close', () => this.handleDown(uiText('connection closed', '连接已关闭')));
            client.on('error', (err: Error) => this.handleDown(err.message));
            resolve(client);
          });
        };
        const onError = (err: Error) => {
          if (settled) return;
          fail(err);
        };
        client.once('ready', onReady);
        client.on('error', onError);
        client.connect({
          host: this.target.host,
          port: this.target.port ?? 22,
          username: auth.username,
          ...(auth.password ? { password: auth.password } : {}),
          ...(auth.privateKey ? { privateKey: auth.privateKey } : {}),
          ...(auth.passphrase ? { passphrase: auth.passphrase } : {}),
          ...(auth.agent ? { agent: auth.agent } : {}),
          readyTimeout: timeoutMs,
          keepaliveInterval: 15_000,
        });
      });
    })();
    this.readyPromise.catch(() => {
      // Allow a later call to retry the connection instead of caching failure.
      this.readyPromise = null;
      this._status = 'error';
    });
    return this.readyPromise;
  }

  private handleDown(reason: string): void {
    this.client = null;
    this.readyPromise = null;
    this._status = 'error';
    this._lastError = reason;
    this.teardownShell();
  }

  private teardownShell(): void {
    const shell = this.shell;
    this.shell = null;
    this.shellClient = null;
    if (shell) shell.close();
  }

  /**
   * Persistent shell per connection: `cd` / `export` / `source` persist across
   * calls and the ROS overlay is sourced once. Falls back to one-shot exec when
   * the server refuses a shell channel.
   */
  async execPersistent(
    command: string,
    options: DeviceExecOptions = {}
  ): Promise<DeviceCommandResult> {
    const startedAt = Date.now();
    this.execCount++;
    let client: Client;
    try {
      client = await this.connect();
    } catch (err) {
      this.execCount--;
      throw err;
    }
    if (!this.shell || this.shellClient !== client) {
      this.teardownShell();
      this.shell = new PersistentDeviceShell(client);
      this.shellClient = client;
    }
    try {
      const result = await this.shell.run(command, options);
      this.lastActiveAt = Date.now();
      return { ...result, durationMs: Date.now() - startedAt };
    } catch (err) {
      // A dropped shell is recoverable: the next call opens a fresh one. Report
      // the same bilingual hint the one-shot path uses.
      this.teardownShell();
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: uiText(
          `Device shell failed on ${this.target.deviceId}: ${err instanceof Error ? err.message : String(err)}`,
          `设备 ${this.target.deviceId} 的持久 shell 失败：${err instanceof Error ? err.message : String(err)}`
        ),
        hint: uiText(DEVICE_RUNTIME_FAILURE_HINT.en, DEVICE_RUNTIME_FAILURE_HINT.zh),
        recoverable: true,
        context: { deviceId: this.target.deviceId, command },
      });
    }
  }

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.connect();
    await this.inflight.acquire();
    try {
      return await fn(client);
    } finally {
      this.inflight.release();
      this.lastActiveAt = Date.now();
    }
  }

  async exec(command: string, options: DeviceExecOptions = {}): Promise<DeviceCommandResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const startedAt = Date.now();
    this.execCount++;
    return await this.withClient(
      (client) =>
        new Promise<DeviceCommandResult>((resolve, reject) => {
          client.exec(command, (err, stream) => {
            if (err) {
              reject(
                new MossError({
                  code: ErrorCode.TOOL_EXECUTION_FAILED,
                  message: uiText(
                    `Device exec failed on ${this.target.deviceId}: ${err.message}`,
                    `设备 ${this.target.deviceId} 执行失败：${err.message}`
                  ),
                  hint: uiText(DEVICE_RUNTIME_FAILURE_HINT.en, DEVICE_RUNTIME_FAILURE_HINT.zh),
                  recoverable: true,
                  context: { deviceId: this.target.deviceId, command },
                })
              );
              return;
            }
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];
            let settled = false;
            let timedOut = false;
            stream.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
            stream.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
            const onAbort = () => {
              if (settled) return;
              timedOut = true;
              stream.close();
            };
            options.signal?.addEventListener('abort', onAbort, { once: true });
            const timer = setTimeout(() => {
              timedOut = true;
              stream.close();
            }, timeoutMs);
            stream.once('close', (code: number | null) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              options.signal?.removeEventListener('abort', onAbort);
              resolve({
                command,
                exitCode: timedOut ? null : (code ?? null),
                stdout: capBuffer(stdoutChunks).toString('utf8'),
                stderr: capBuffer(stderrChunks).toString('utf8'),
                timedOut,
                durationMs: Date.now() - startedAt,
              });
            });
            stream.once('error', (streamErr: Error) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              options.signal?.removeEventListener('abort', onAbort);
              reject(
                new MossError({
                  code: ErrorCode.TOOL_EXECUTION_FAILED,
                  message: uiText(
                    `Device exec stream error on ${this.target.deviceId}: ${streamErr.message}`,
                    `设备 ${this.target.deviceId} 执行流错误：${streamErr.message}`
                  ),
                  hint: uiText(DEVICE_RUNTIME_FAILURE_HINT.en, DEVICE_RUNTIME_FAILURE_HINT.zh),
                  recoverable: true,
                  context: { deviceId: this.target.deviceId, command },
                })
              );
            });
          });
        })
    );
  }

  private async sftp<T>(fn: (sftp: import('ssh2').SFTPWrapper) => Promise<T>): Promise<T> {
    return await this.withClient(
      (client) =>
        new Promise<T>((resolve, reject) => {
          client.sftp((err, sftp) => {
            if (err) {
              reject(
                new MossError({
                  code: ErrorCode.TOOL_EXECUTION_FAILED,
                  message: uiText(
                    `SFTP session failed on ${this.target.deviceId}: ${err.message}`,
                    `设备 ${this.target.deviceId} 的 SFTP 会话失败：${err.message}`
                  ),
                  hint: uiText(DEVICE_RUNTIME_FAILURE_HINT.en, DEVICE_RUNTIME_FAILURE_HINT.zh),
                  recoverable: true,
                  context: { deviceId: this.target.deviceId },
                })
              );
              return;
            }
            fn(sftp).then(
              (value) => {
                sftp.end();
                resolve(value);
              },
              (fnErr) => {
                sftp.end();
                reject(fnErr);
              }
            );
          });
        })
    );
  }

  async readFile(remotePath: string, options: DeviceReadFileOptions = {}): Promise<string> {
    const maxBytes = options.maxBytes ?? DEFAULT_READ_MAX_BYTES;
    return await this.sftp(async (sftp) => {
      let stat: import('ssh2').Stats;
      try {
        stat = await new Promise<import('ssh2').Stats>((resolve, reject) => {
          sftp.stat(remotePath, (err, stats) => (err ? reject(err) : resolve(stats)));
        });
      } catch (err) {
        throw new MossError({
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: uiText(
            `Cannot stat ${remotePath} on ${this.target.deviceId}: ${err instanceof Error ? err.message : String(err)}`,
            `无法读取 ${this.target.deviceId} 上 ${remotePath} 的状态：${err instanceof Error ? err.message : String(err)}`
          ),
          hint: uiText(
            'Confirm the path exists on the device (device_file_list lists directories), then retry.',
            '确认该路径在设备上存在（device_file_list 可列目录），再重试。'
          ),
          recoverable: true,
        });
      }
      if (stat.size > maxBytes) {
        throw new MossError({
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: uiText(
            `Remote file ${remotePath} is ${stat.size} bytes, above the ${maxBytes}-byte read cap.`,
            `远程文件 ${remotePath} 有 ${stat.size} 字节，超过 ${maxBytes} 字节的读取上限。`
          ),
          hint: uiText(
            'Raise max_bytes, or copy/slice it on the device first.',
            '调高 max_bytes，或先在设备上复制、截取该文件。'
          ),
          recoverable: true,
        });
      }
      const buf = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = sftp.createReadStream(remotePath);
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.once('end', () => resolve(Buffer.concat(chunks)));
        stream.once('error', reject);
      });
      return buf.toString('utf8');
    });
  }

  async writeFile(remotePath: string, options: DeviceWriteFileOptions): Promise<void> {
    if (options.content === undefined && !options.localPath) {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: uiText(
          'writeFile requires content or localPath.',
          'writeFile 需要 content 或 localPath。'
        ),
        recoverable: true,
      });
    }
    if (options.localPath) {
      await this.sftp(async (sftp) => {
        await new Promise<void>((resolve, reject) => {
          sftp.fastPut(
            options.localPath!,
            remotePath,
            options.mode ? { mode: options.mode } : {},
            (err) => (err ? reject(err) : resolve())
          );
        });
      });
      return;
    }
    await this.sftp(async (sftp) => {
      await new Promise<void>((resolve, reject) => {
        const stream = sftp.createWriteStream(
          remotePath,
          options.mode ? { mode: options.mode } : {}
        );
        stream.once('close', () => resolve());
        stream.once('error', reject);
        stream.end(options.content);
      });
    });
  }

  async listDir(remotePath: string): Promise<DeviceFileEntry[]> {
    return await this.sftp(async (sftp) => {
      const list = await new Promise<import('ssh2').FileEntry[]>((resolve, reject) => {
        sftp.readdir(remotePath, (err, entries) => (err ? reject(err) : resolve(entries)));
      });
      return list.map((entry) => {
        const mode = entry.attrs.mode ?? 0;
        const fmt = mode & 0o170000;
        const type: DeviceFileEntry['type'] =
          fmt === 0o040000
            ? 'dir'
            : fmt === 0o120000
              ? 'symlink'
              : fmt === 0o100000
                ? 'file'
                : 'other';
        return {
          name: entry.filename,
          type,
          ...(typeof entry.attrs.size === 'number' ? { sizeBytes: entry.attrs.size } : {}),
          ...(typeof entry.attrs.mtime === 'number' ? { mtimeMs: entry.attrs.mtime * 1000 } : {}),
        };
      });
    });
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.readyPromise = null;
    this._status = 'disconnected';
    this.teardownShell();
    if (client) {
      client.end();
    }
  }
}
