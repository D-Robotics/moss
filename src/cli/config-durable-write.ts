import fs from 'node:fs';
import path from 'node:path';
import { ensureConfigDirectoryDurably, syncConfigDirectory } from './config-api-key-crypto.js';

export interface ConfigAtomicWriteOperations {
  ensureDirectory: (directoryPath: string) => void;
  open: (filePath: string, flags: string, mode: number) => number;
  write: (fileDescriptor: number, contents: string) => void;
  fsync: (fileDescriptor: number) => void;
  close: (fileDescriptor: number) => void;
  rename: (from: string, to: string) => void;
  remove: (filePath: string) => void;
  syncDirectory: (directoryPath: string) => void;
}

const defaultOperations: ConfigAtomicWriteOperations = {
  ensureDirectory: ensureConfigDirectoryDurably,
  open: (filePath, flags, mode) => fs.openSync(filePath, flags, mode),
  write: (fileDescriptor, contents) => fs.writeFileSync(fileDescriptor, contents, 'utf8'),
  fsync: (fileDescriptor) => fs.fsyncSync(fileDescriptor),
  close: (fileDescriptor) => fs.closeSync(fileDescriptor),
  rename: (from, to) => fs.renameSync(from, to),
  remove: (filePath) => fs.rmSync(filePath, { force: true }),
  syncDirectory: syncConfigDirectory,
};

/** Atomically replace config contents and durably publish the directory entry. */
export function writeConfigFileAtomic(
  configPath: string,
  contents: string,
  operations: ConfigAtomicWriteOperations = defaultOperations,
  temporaryPath = path.join(
    path.dirname(configPath),
    `.tmp-${process.pid}-${globalThis.crypto.randomUUID()}`
  )
): void {
  operations.ensureDirectory(path.dirname(configPath));
  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = operations.open(temporaryPath, 'wx', 0o600);
    operations.write(descriptor, contents);
    operations.fsync(descriptor);
    operations.close(descriptor);
    descriptor = undefined;
    operations.rename(temporaryPath, configPath);
    renamed = true;
    operations.syncDirectory(path.dirname(configPath));
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        operations.close(descriptor);
      } catch {}
    }
    if (!renamed) {
      try {
        operations.remove(temporaryPath);
      } catch {}
    }
    throw error;
  }
}
