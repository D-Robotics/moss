/**
 * MCP stdio transport — JSON-RPC 2.0 over the child's stdin/stdout with
 * newline framing (per the MCP stdio transport spec: each message is a single
 * line of JSON, no embedded newlines).
 *
 * The child is a long-lived process spawned through `spawnProcess` (the shared
 * low-level spawn boundary); bounded one-shot commands elsewhere use
 * `runProcess`, which is wrong for a persistent peer. Stderr is captured (capped)
 * for crash diagnostics only.
 */
import { spawnProcess, type ChildProcess } from '../../utils/run-process.js';
import { safeChildEnv } from '../../utils/safe-child-env.js';
import { MossError, ErrorCode, errorMessage } from '../../errors.js';
import { getRootLogger } from '../../logger.js';
import type {
  InboundJsonRpcMessage,
  McpTransport,
  McpTransportRequestOptions,
  McpServerConfig,
  McpConnectionState,
} from './types.js';

const log = getRootLogger().child('mcp:stdio');

/** Cap on the unparsed stdout buffer / a single line — a broken peer must not
 *  be able to OOM the agent with an unterminated line. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Cap on stderr kept for diagnostics. */
const MAX_STDERR_CHARS = 16 * 1024;
/** Grace period between SIGTERM and SIGKILL when closing. */
const KILL_ESCALATION_MS = 2_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export class McpStdioTransport implements McpTransport {
  readonly kind = 'stdio' as const;

  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = '';
  private stderrTail = '';
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private closedPromise: Promise<void> | null = null;

  private _state: McpConnectionState = 'disconnected';
  private _lastError: string | undefined;

  constructor(private readonly config: McpServerConfig) {}

  get state(): McpConnectionState {
    return this._state;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  async start(_timeoutMs: number): Promise<void> {
    if (this._state === 'connected' || this._state === 'connecting') return;
    if (this._state === 'closed') {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `mcp stdio transport for "${this.config.name}" is closed`,
        recoverable: false,
      });
    }
    const command = this.config.command;
    if (!command) {
      this._state = 'failed';
      this._lastError = 'missing required field "command" for stdio transport';
      throw new MossError({
        code: ErrorCode.USER_INPUT_INVALID,
        message: `mcp server "${this.config.name}": stdio transport requires "command"`,
        recoverable: false,
      });
    }
    this._state = 'connecting';
    let child: ChildProcess;
    try {
      child = spawnProcess(command, this.config.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Credential-bearing env values come only from the expanded config env
        // block; the inherited parent env is sanitized by safeChildEnv.
        env: safeChildEnv(this.config.env ?? {}),
        windowsHide: true,
      });
    } catch (err) {
      this._state = 'failed';
      this._lastError = errorMessage(err);
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `mcp server "${this.config.name}": failed to spawn "${command}"`,
        hint: 'Check that the command exists and is executable.',
        recoverable: false,
        cause: err,
      });
    }
    this.child = child;

    const exited = new Promise<never>((_, reject) => {
      child.once('error', (err: NodeJS.ErrnoException) => {
        this._lastError = err.code ? `${err.code}: ${errorMessage(err)}` : errorMessage(err);
        reject(err);
      });
      child.once('close', (code, signal) => {
        reject(
          new MossError({
            code: ErrorCode.TOOL_EXECUTION_FAILED,
            message: `mcp server "${this.config.name}" exited during connect (code ${code ?? '?'}${signal ? `, signal ${signal}` : ''})`,
          })
        );
      });
    });
    const spawned = new Promise<void>((resolve) => {
      // Node ≥ 15 emits 'spawn' once the process exists; resolves immediately
      // if it already fired.
      child.once('spawn', () => resolve());
      child.once('error', () => resolve());
    });

    this.attachRuntimeListeners(child);

    try {
      await Promise.race([spawned, exited]);
    } catch (err) {
      this._state = 'failed';
      if (!this._lastError) this._lastError = errorMessage(err);
      this.failAllPending(
        new MossError({
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: `mcp server "${this.config.name}" failed to start: ${this._lastError}`,
          hint: 'Check the server command, args, and that the server speaks MCP over stdio.',
          recoverable: false,
          cause: err,
        })
      );
      throw err;
    }
    this._state = 'connected';
    this._lastError = undefined;
  }

  private attachRuntimeListeners(child: ChildProcess): void {
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      let newlineIdx = this.stdoutBuffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
        if (line) this.handleLine(line);
        newlineIdx = this.stdoutBuffer.indexOf('\n');
      }
      if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
        this.abortTransport(
          `mcp server "${this.config.name}" sent an unterminated line > ${MAX_LINE_BYTES} bytes`
        );
      }
    });
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      if (this.stderrTail.length < MAX_STDERR_CHARS) {
        this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_CHARS);
      }
    });
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
      this.abortTransport(`stdin write failed: ${errorMessage(err)}`);
    });
    child.once('close', (code, signal) => {
      // Drain any complete lines still buffered before the pipes closed.
      const rest = this.stdoutBuffer.trim();
      this.stdoutBuffer = '';
      if (rest) this.handleLine(rest);
      if (this._state === 'connected' || this._state === 'connecting') {
        this._state = 'closed';
        this._lastError = `server process exited (code ${code ?? '?'}${signal ? `, signal ${signal}` : ''})${this.stderrTail ? `; stderr tail: ${this.stderrTail.split('\n').slice(-5).join(' | ')}` : ''}`;
        this.failAllPending(
          new MossError({
            code: ErrorCode.TOOL_EXECUTION_FAILED,
            message: `mcp server "${this.config.name}" exited before answering`,
            hint: this._lastError,
            recoverable: false,
          })
        );
      }
    });
    child.once('error', (err) => {
      this._state = 'failed';
      this._lastError = errorMessage(err);
    });
  }

  private handleLine(line: string): void {
    let msg: InboundJsonRpcMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) return;
      msg = parsed as InboundJsonRpcMessage;
    } catch {
      log.debug('unparseable line from server', { server: this.config.name });
      return;
    }
    if (msg.id === undefined || msg.id === null) {
      // Server-initiated notification — accepted and ignored (we advertise no
      // server-facing capabilities yet).
      log.debug('notification from server', { server: this.config.name, method: msg.method });
      return;
    }
    // Our request ids are numbers; tolerate a server echoing them as strings.
    const idKey = typeof msg.id === 'number' ? msg.id : Number(msg.id);
    const pending = Number.isInteger(idKey) ? this.pending.get(idKey) : undefined;
    if (!pending) return; // late answer to a timed-out/aborted request — discard
    this.pending.delete(idKey);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort ?? (() => {}));
    if (msg.error) {
      pending.reject(
        new MossError({
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: `mcp server "${this.config.name}": ${msg.error.message} (code ${msg.error.code})`,
          recoverable: true,
        })
      );
      return;
    }
    pending.resolve(msg.result);
  }

  request(
    method: string,
    params?: Record<string, unknown>,
    opts?: McpTransportRequestOptions
  ): Promise<unknown> {
    if (this._state !== 'connected') {
      return Promise.reject(
        new MossError({
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: `mcp server "${this.config.name}" is not connected (state: ${this._state})`,
          ...(this._lastError ? { hint: this._lastError } : {}),
          recoverable: false,
        })
      );
    }
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });

    return new Promise<unknown>((resolve, reject) => {
      const settle = (err: unknown) => {
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      };
      const onAbort = () =>
        settle(
          new MossError({
            code: ErrorCode.USER_ABORTED,
            message: `mcp request "${method}" to "${this.config.name}" aborted`,
            recoverable: true,
          })
        );
      const signal = opts?.signal;
      const timer = setTimeout(() => {
        // Timeout races the response (Promise.race shape): the pending entry is
        // dropped so a late server answer is discarded, the process stays up.
        settle(
          new MossError({
            code: ErrorCode.TOOL_EXECUTION_TIMEOUT,
            message: `mcp request "${method}" to "${this.config.name}" timed out after ${timeoutMs}ms`,
            hint: 'The server did not answer in time; it may be overloaded or stuck.',
            recoverable: true,
          })
        );
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          this.pending.delete(id);
          resolve(value);
        },
        reject: settle,
        timer,
        signal,
        onAbort,
      });
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.child?.stdin?.write(`${payload}\n`);
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this._state !== 'connected') return;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    });
    this.child?.stdin?.write(`${payload}\n`);
  }

  async close(): Promise<void> {
    if (this._state === 'closed' || this._state === 'disconnected') {
      this._state = 'closed';
      return;
    }
    if (!this.child) {
      this._state = 'closed';
      return;
    }
    if (!this.closedPromise) {
      const child = this.child;
      this.closedPromise = new Promise<void>((resolve) => {
        const done = () => {
          if (this.killTimer) clearTimeout(this.killTimer);
          resolve();
        };
        if (child.exitCode !== null || child.signalCode !== null) {
          done();
          return;
        }
        child.once('close', done);
        this.killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
          done();
        }, KILL_ESCALATION_MS);
        if (typeof this.killTimer.unref === 'function') this.killTimer.unref();
        try {
          child.stdin?.end();
          child.kill('SIGTERM');
        } catch {
          done();
        }
      });
    }
    this._state = 'closed';
    this.failAllPending(
      new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `mcp server "${this.config.name}" connection closed`,
        recoverable: false,
      })
    );
    await this.closedPromise;
  }

  private abortTransport(reason: string): void {
    this._state = 'failed';
    this._lastError = reason;
    this.failAllPending(
      new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `mcp server "${this.config.name}": ${reason}`,
        recoverable: false,
      })
    );
    void this.close();
  }

  private failAllPending(err: MossError): void {
    for (const pending of [...this.pending.values()]) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.onAbort ?? (() => {}));
      pending.reject(err);
    }
    this.pending.clear();
  }
}
