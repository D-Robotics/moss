/**
 * Provider logs go through `redactEgress` before they reach stderr.
 * The root logger cannot import safety (layering), so the redaction stays here.
 */
import { getRootLogger, type Logger, type LogLevel } from '../logger.js';
import { redactEgress } from '../safety/tool-output-redact.js';

function redactLogData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') out[key] = redactEgress(value);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null)
      out[key] = value;
    else out[key] = redactEgress(JSON.stringify(value) ?? '');
  }
  return out;
}

export function providerLogger(scope: string): Logger {
  const raw = getRootLogger().child(scope);
  const write =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (msg: string, data?: Record<string, unknown>): void => {
      raw[level](redactEgress(msg), redactLogData(data));
    };
  return {
    scope: raw.scope,
    child(next: string) {
      return providerLogger(`${scope}:${next}`);
    },
    setLevel(level: LogLevel) {
      raw.setLevel(level);
    },
    getLevel() {
      return raw.getLevel();
    },
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
}
