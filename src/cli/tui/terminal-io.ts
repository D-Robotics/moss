/**
 * The only terminal output path while the TUI is mounted.
 *
 * warn/error logs go to a file. error (and a rate-limited warn) also become
 * one transcript line. Direct stderr writes are not used.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getRootLogger, setRootLogSink, type LogEntry } from '../../logger.js';

export interface TuiLogSinkOptions {
  logFile: string;
  onUserVisible: (line: string) => void;
  now?: () => number;
}

const WARN_INTERVAL_MS = 60_000;

export function installTuiLogSink(options: TuiLogSinkOptions): () => void {
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
  const now = options.now ?? Date.now;
  const lastWarn = new Map<string, number>();
  setRootLogSink((entry: LogEntry) => {
    if (entry.level !== 'warn' && entry.level !== 'error') return;
    const line = `${entry.ts} ${entry.level} ${entry.scope} ${entry.msg}`;
    try {
      fs.appendFileSync(options.logFile, `${line}\n`);
    } catch {
      // A log-file failure must not paint the terminal.
    }
    if (entry.level === 'error') {
      options.onUserVisible(entry.msg);
      return;
    }
    const previous = lastWarn.get(entry.msg) ?? 0;
    if (now() - previous < WARN_INTERVAL_MS) return;
    lastWarn.set(entry.msg, now());
    options.onUserVisible(entry.msg);
  });
  return () => {
    setRootLogSink(null);
  };
}

/** Route a diagnostic through the root logger so the TUI sink can catch it. */
export function writeDiagnostic(scope: string, message: string): void {
  getRootLogger().child(scope).warn(message);
}
