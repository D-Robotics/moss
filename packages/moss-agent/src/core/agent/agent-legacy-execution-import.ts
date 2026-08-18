import fs from 'node:fs';
import path from 'node:path';

import type { LegacyExecutionImporter, LegacyExecutionKind } from '../../orchestration/index.js';
import { getMossWorkspacePaths } from '../../utils/workspace-paths.js';

export function importLegacySessionCheckpoint(input: {
  importer: LegacyExecutionImporter;
  workspaceDir?: string;
  sessionKey: string;
  kind: Extract<LegacyExecutionKind, 'goal' | 'task-frame'>;
  state?: Readonly<Record<string, unknown>>;
}): void {
  if (!input.state) return;
  const root = path.join(
    getMossWorkspacePaths(input.workspaceDir ?? process.cwd()).runtimeDir,
    'runtime',
    'legacy-checkpoints'
  );
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  input.importer.import({
    kind: input.kind,
    sourcePath: path.join(root, `${encodeURIComponent(input.sessionKey)}.${input.kind}.checkpoint`),
    state: input.state,
  });
}
