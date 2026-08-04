import { createHash } from 'node:crypto';
import path from 'node:path';

/** Hash stable, non-secret execution context without persisting its raw values. */
export function environmentFingerprint(input: {
  workspaceDir?: string;
  boardType?: string;
  firmwareVersion?: string;
  runtimeMode?: string;
}): string {
  const workspaceDir = input.workspaceDir?.trim();
  const values = {
    ...(workspaceDir ? { workspace: path.resolve(workspaceDir).replace(/\\/g, '/').toLowerCase() } : {}),
    ...(input.boardType ? { boardType: input.boardType } : {}),
    ...(input.firmwareVersion ? { firmwareVersion: input.firmwareVersion } : {}),
    ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
  };
  if (Object.keys(values).length === 0) return 'unknown';
  return `sha256:${createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
}
