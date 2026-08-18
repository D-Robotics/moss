import fs from 'node:fs';

type DirectorySyncOperations = Pick<typeof fs, 'openSync' | 'fsyncSync' | 'closeSync'>;

/** Persist a directory entry where the host platform supports directory fsync. @internal */
export function syncDirectoryEntryIfSupported(
  directoryPath: string,
  operations: DirectorySyncOperations = fs,
  platform: NodeJS.Platform = process.platform
): void {
  // Windows does not provide portable directory-handle fsync semantics. The
  // file itself is fsynced before rename; this mirrors the session-store seam.
  if (platform === 'win32') return;
  const directory = operations.openSync(directoryPath, 'r');
  try {
    operations.fsyncSync(directory);
  } finally {
    operations.closeSync(directory);
  }
}
