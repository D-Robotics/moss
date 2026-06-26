/**
 * Minimal internal logger for moss-memory.
 *
 * moss-memory is a standalone package with no dependency on @rdk-moss/agent.
 * This module provides structured, prefixed log output without pulling in
 * the full logger framework. Hosts that need structured logging should
 * configure their own logger at the application level.
 *
 * Format: [memory] message  (aligned with the main [scope] convention)
 */

const PREFIX = '[memory]';

export function memoryWarn(msg: string, data?: unknown): void {
  if (data !== undefined) {
    console.warn(`${PREFIX} ${msg}`, data);
  } else {
    console.warn(`${PREFIX} ${msg}`);
  }
}

export function memoryInfo(msg: string): void {
  console.warn(`${PREFIX} ${msg}`);
}
