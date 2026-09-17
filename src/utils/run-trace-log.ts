import { getRootLogger } from '../logger.js';

export function mossRunTrace(
  kind: 'queue_wait' | 'run_start' | 'run_done' | 'run_error',
  fields: Record<string, unknown>
): void {
  const log = getRootLogger().child(`agent:trace:${kind}`);
  const level = kind === 'run_error' ? 'warn' : 'info';
  log[level](kind, fields);
}
