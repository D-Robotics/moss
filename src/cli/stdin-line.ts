/**
 * Read one line from the terminal while a `/run`/`/task` run owns stdin.
 *
 * During a run the REPL has paused readline, so the normal approval asker can
 * never resolve — an `ask_user_question` from the agent used to spin until the
 * user hit Ctrl+C (observed: 31s of a stuck run in round 32). This reads a line
 * directly from stdin for that window only: cooked terminals deliver the line
 * on Enter, raw ones arrive byte-wise (feedback is echoed only when the terminal
 * is not echoing for us).
 *
 * Returns `null` when stdin is not a TTY: a question the user cannot see must
 * not block, so the caller lets the tool decline and the agent continue.
 */
import { ErrorCode, MossError } from '../errors.js';

export interface ReadStdinLineOptions {
  stdin?: NodeJS.ReadStream;
  stderr?: NodeJS.WriteStream;
  signal?: AbortSignal;
  /** Prefix written before the cursor, e.g. `> `. */
  prompt?: string;
  /** Hard cap on a single answer; anything longer is truncated. */
  maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 4000;

export async function readStdinLine(options: ReadStdinLineOptions = {}): Promise<string | null> {
  const stdin = options.stdin ?? process.stdin;
  const stderr = options.stderr ?? process.stderr;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (!stdin.isTTY) return null;
  if (options.signal?.aborted) {
    throw new MossError({
      code: ErrorCode.USER_ABORTED,
      message: 'Question cancelled by user.',
      hint: 'Continue with the remaining work, or ask again later.',
      recoverable: true,
    });
  }
  stderr.write(options.prompt ?? '');

  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let done = false;
    const raw = Boolean(stdin.isRaw);

    const cleanup = (): void => {
      stdin.off('data', onData);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      if (done) return;
      done = true;
      cleanup();
      stderr.write('\n');
      reject(
        new MossError({
          code: ErrorCode.USER_ABORTED,
          message: 'Question cancelled by user.',
          hint: 'Continue with the remaining work, or ask again later.',
          recoverable: true,
        })
      );
    };
    const finish = (line: string): void => {
      if (done) return;
      done = true;
      cleanup();
      stderr.write('\n');
      resolve(line.slice(0, maxLength));
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const char of text) {
        if (char === '\n' || (raw && char === '\r')) {
          finish(buffer);
          return;
        }
        if (char === '\x03') {
          // Ctrl+C on a raw terminal arrives as a byte, not SIGINT.
          onAbort();
          return;
        }
        if (char === '\x7f' || char === '\b') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            if (raw) stderr.write('\b \b');
          }
          continue;
        }
        if (buffer.length >= maxLength) continue;
        buffer += char;
        // Cooked terminals echo for us; raw ones do not, so mirror the input.
        if (raw && char >= ' ') stderr.write(char);
      }
    };

    stdin.on('data', onData);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (typeof stdin.resume === 'function') stdin.resume();
  });
}
