













export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface Logger {
  





  child(scope: string, context?: Record<string, unknown>): Logger;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  
  setLevel(level: LogLevel): void;
  
  getLevel(): LogLevel;
  
  readonly scope: string;
}

export interface LoggerOptions {
  scope?: string;
  level?: LogLevel;
  
  json?: boolean;
  
  context?: Record<string, unknown>;
  
  sink?: (entry: LogEntry) => void;
  
  sensitiveKeys?: readonly string[];
}

const DEFAULT_SENSITIVE_KEYS = [
  'apikey',
  'api_key',
  'token',
  'bearer',
  'authorization',
  'password',
  'secret',
  'sessionid',
  'session_id',
  'cookie',
  'refresh_token',
] as const;

function envLevel(): LogLevel | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  const env =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const raw = String(env.MOSS_LOG_LEVEL ?? '')
    .trim()
    .toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return undefined;
}

function envJson(): boolean {
  if (typeof globalThis === 'undefined') return false;
  const env =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const raw = String(env.MOSS_LOG_JSON ?? '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true';
}

function nowIso(): string {
  return new Date().toISOString();
}







export function redactSensitive(
  data: Record<string, unknown> | undefined,
  sensitiveKeys: readonly string[] = DEFAULT_SENSITIVE_KEYS,
  depth = 0,
  seen?: WeakSet<object>
): Record<string, unknown> | string | undefined {
  if (!data || typeof data !== 'object') return data;
  if (depth > 4) return '[REDACTED:depth]';
  if (!seen) seen = new WeakSet<object>();
  if (seen.has(data)) return '[Circular]';
  seen.add(data);
  const lowerKeys = new Set(sensitiveKeys.map((k) => k.toLowerCase()));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const isSensitive = lowerKeys.has(k.toLowerCase());
    if (isSensitive) {
      out[k] = maskValue(v);
      continue;
    }
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) {
        out[k] = v.map((item) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            return redactSensitive(item as Record<string, unknown>, sensitiveKeys, depth + 1, seen);
          }
          return item;
        });
      } else {
        out[k] = redactSensitive(v as Record<string, unknown>, sensitiveKeys, depth + 1, seen);
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function maskValue(v: unknown): string {
  if (typeof v !== 'string' || !v) return '***';
  if (v.length <= 8) return '***';
  return `${v.slice(0, 2)}***${v.slice(-4)}`;
}

function formatConsole(entry: LogEntry): string {
  const scope = entry.scope ? `[${entry.scope}]` : '';
  const levelTag = entry.level === 'debug' ? ' [debug]' : '';
  let suffix = '';
  if (entry.data && Object.keys(entry.data).length > 0) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(entry.data)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        parts.push(`${k}=${v}`);
      } else {
        parts.push(`${k}=${safeStringify(v)}`);
      }
    }
    if (parts.length) suffix = ' · ' + parts.join(' · ');
  }
  return `${scope}${levelTag} ${entry.msg}${suffix}`;
}

function safeStringify(v: unknown, max = 400): string {
  try {
    const s = JSON.stringify(v);
    if (!s) return String(v);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(v);
  }
}

function defaultSink(entry: LogEntry, json: boolean): void {
  if (typeof globalThis === 'undefined') return;
  const c = (globalThis as { console?: Console }).console;
  if (!c) return;
  if (json) {
    const payload = JSON.stringify({
      ts: entry.ts,
      level: entry.level,
      scope: entry.scope,
      msg: entry.msg,
      ...(entry.data ?? {}),
    });
    if (entry.level === 'error') c.error(payload);
    else if (entry.level === 'warn') c.warn(payload);
    else c.warn(payload);
    return;
  }
  
  
  
  const line = formatConsole(entry);
  if (entry.level === 'error') c.error(line);
  else c.warn(line);
}















export function createLogger(opts: LoggerOptions = {}): Logger {
  const parentScope = opts.scope ?? '';
  let currentLevel: LogLevel = opts.level ?? envLevel() ?? 'info';
  const useJson = opts.json ?? envJson();
  const sink = opts.sink ?? ((entry: LogEntry) => defaultSink(entry, useJson));
  const sensitiveKeys = opts.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS;
  const baseContext = { ...(opts.context ?? {}) };

  function emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentLevel]) return;
    const merged: Record<string, unknown> | undefined =
      (data && Object.keys(data).length > 0) || Object.keys(baseContext).length > 0
        ? { ...baseContext, ...(data ?? {}) }
        : undefined;
    const safe = redactSensitive(merged, sensitiveKeys) as Record<string, unknown> | undefined;
    sink({
      ts: nowIso(),
      level,
      scope: parentScope,
      msg,
      data: safe,
    });
  }

  const logger: Logger = {
    scope: parentScope,
    getLevel: () => currentLevel,
    setLevel: (level) => {
      currentLevel = level;
    },
    debug: (msg, data) => emit('debug', msg, data),
    info: (msg, data) => emit('info', msg, data),
    warn: (msg, data) => emit('warn', msg, data),
    error: (msg, data) => emit('error', msg, data),
    child: (childScope, childContext) => {
      const nextScope =
        parentScope && childScope ? `${parentScope}:${childScope}` : childScope || parentScope;
      return createLogger({
        scope: nextScope,
        level: currentLevel,
        json: useJson,
        context: { ...baseContext, ...(childContext ?? {}) },
        sink,
        sensitiveKeys,
      });
    },
  };

  return logger;
}






let rootLogger: Logger | null = null;
let rootLoggerOptions: LoggerOptions = {};

export function configureRootLogger(opts: LoggerOptions = {}): void {
  rootLoggerOptions = opts;
  rootLogger = createLogger(opts);
}

export function getRootLogger(): Logger {
  if (!rootLogger) {
    rootLogger = createLogger(rootLoggerOptions);
  }
  return rootLogger;
}
