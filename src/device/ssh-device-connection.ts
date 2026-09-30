import fs from 'node:fs/promises';
import { Client } from 'ssh2';
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

/** Max simultaneous remote channels (exec streams / sftp sessions). */
const MAX_INFLIGHT = 4;
const CONNECT_TIMEOUT_MS = 15_000;
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

interface SshAuth {
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

async function resolveAuth(target: DeviceTarget): Promise<SshAuth> {
  const username = target.user || 'root';
  const auth = target.auth;
  if (!auth) return { username };
  if (auth.method === 'private-key') {
    if (!auth.privateKeyPath) return { username };
    const privateKey = await fs.readFile(auth.privateKeyPath, 'utf8');
    const passphrase = auth.passphraseEnvVar ? process.env[auth.passphraseEnvVar] : undefined;
    return { username, privateKey, ...(passphrase ? { passphrase } : {}) };
  }
  const password = auth.passwordEnvVar ? process.env[auth.passwordEnvVar] : undefined;
  return { username, ...(password ? { password } : {}) };
}

export class SshDeviceConnection implements DeviceConnection {
  readonly target: DeviceTarget;
  private client: Client | null = null;
  private readyPromise: Promise<Client> | null = null;
  private readonly inflight = new Semaphore(MAX_INFLIGHT);
  private _status: DeviceConnectionStatus = 'disconnected';
  private _lastError: string | undefined;
  execCount = 0;
  lastActiveAt: number | undefined;

  constructor(target: DeviceTarget) {
    this.target = target;
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
      if (!auth.password && !auth.privateKey) {
        throw new MossError({
          code: ErrorCode.CONFIG_IO_FAILED,
          message: `No credentials for device ${this.target.deviceId}: set MOSS_DEVICE_PASSWORD or MOSS_DEVICE_KEY.`,
          hint: 'Credentials come from env / .env only; they are never stored in the device target.',
          recoverable: true,
        });
      }
      const client = new Client();
      return await new Promise<Client>((resolve, reject) => {
        const onReady = () => {
          cleanup();
          this.client = client;
          this._status = 'connected';
          this._lastError = undefined;
          client.on('close', () => this.handleDown('connection closed'));
          client.on('error', (err: Error) => this.handleDown(err.message));
          resolve(client);
        };
        const onError = (err: Error) => {
          cleanup();
          this.handleDown(err.message);
          client.end();
          reject(
            new MossError({
              code: ErrorCode.TOOL_EXECUTION_FAILED,
              message: `Cannot connect to ${this.target.user || 'root'}@${this.target.host}:${this.target.port ?? 22}: ${err.message}`,
              hint: 'Check host/port reachability and credentials (MOSS_DEVICE_USER / MOSS_DEVICE_PASSWORD / MOSS_DEVICE_KEY).',
              recoverable: true,
              context: { deviceId: this.target.deviceId },
            })
          );
        };
        const cleanup = () => {
          client.removeListener('ready', onReady);
          client.removeListener('error', onError);
        };
        client.once('ready', onReady);
        client.once('error', onError);
        client.connect({
          host: this.target.host,
          port: this.target.port ?? 22,
          username: auth.username,
          ...(auth.password ? { password: auth.password } : {}),
          ...(auth.privateKey ? { privateKey: auth.privateKey } : {}),
          ...(auth.passphrase ? { passphrase: auth.passphrase } : {}),
          readyTimeout: CONNECT_TIMEOUT_MS,
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
                  message: `Device exec failed on ${this.target.deviceId}: ${err.message}`,
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
                  message: `Device exec stream error on ${this.target.deviceId}: ${streamErr.message}`,
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
                  message: `SFTP session failed on ${this.target.deviceId}: ${err.message}`,
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
          message: `Cannot stat ${remotePath} on ${this.target.deviceId}: ${err instanceof Error ? err.message : String(err)}`,
          recoverable: true,
        });
      }
      if (stat.size > maxBytes) {
        throw new MossError({
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: `Remote file ${remotePath} is ${stat.size} bytes, above the ${maxBytes}-byte read cap.`,
          hint: 'Raise max_bytes, or copy/slice it on the device first.',
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
        message: 'writeFile requires content or localPath.',
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
    if (client) {
      client.end();
    }
  }
}
