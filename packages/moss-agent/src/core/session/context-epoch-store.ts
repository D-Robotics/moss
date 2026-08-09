import fs from 'node:fs';
import path from 'node:path';
import type { ContextEpoch } from './context-epoch.js';

export function loadContextEpoch(filePath: string): ContextEpoch | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ContextEpoch;
  } catch {
    return undefined;
  }
}

export function saveContextEpoch(filePath: string, epoch: ContextEpoch): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(epoch, null, 2));
  fs.renameSync(tmp, filePath);
}
