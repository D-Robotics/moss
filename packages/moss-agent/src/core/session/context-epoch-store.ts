/**
 * Durable persistence for a {@link ContextEpoch}.
 *
 * The epoch (immutable baseline + source snapshot) is persisted per session so the
 * provider-cache prefix and last-admitted source values survive a restart: on the
 * next turn the runtime reconciles current sources against the stored snapshot and
 * only emits an update when something actually changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ContextEpoch } from './context-epoch.js';

/** Load a stored epoch; a missing or corrupt file yields undefined (caller initializes). */
export function loadContextEpoch(filePath: string): ContextEpoch | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ContextEpoch;
  } catch {
    return undefined;
  }
}

/** Persist an epoch atomically (temp + rename). */
export function saveContextEpoch(filePath: string, epoch: ContextEpoch): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(epoch, null, 2));
  fs.renameSync(tmp, filePath);
}
