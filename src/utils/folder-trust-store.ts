/**
 * User-owned folder trust store (`<configDir>/workspace-trust.json`).
 *
 * The key is a real path. A trusted folder covers its subdirectories. The
 * filesystem root is never stored and never grants trust. Entries written by
 * the earlier project-capability prompt (the workspace directory itself) live
 * in this same file and count. Git hardening and the CLI read this one file.
 */
import fs from 'node:fs';
import path from 'node:path';

const TRUST_FILE = 'workspace-trust.json';

export function folderPathKey(dir: string): string {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

export function trustStorePath(configDir: string): string {
  return path.join(configDir, TRUST_FILE);
}

export function readTrustStore(configDir: string): Record<string, boolean> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(trustStorePath(configDir), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeTrustStore(configDir: string, store: Record<string, boolean>): void {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(trustStorePath(configDir), `${JSON.stringify(store, null, 2)}\n`);
}

export function isFilesystemRoot(dir: string): boolean {
  const key = folderPathKey(dir);
  return key === path.parse(key).root;
}

/**
 * True when `dir` or one of its ancestors (never the filesystem root) was
 * trusted. A stored `false` does not count — declining is not remembered.
 */
export function isFolderTrusted(configDir: string, dir: string): boolean {
  const store = readTrustStore(configDir);
  return trustStoreCovers(store, folderPathKey(dir));
}

export function trustStoreCovers(store: Record<string, boolean>, dir: string): boolean {
  let current = dir;
  const root = path.parse(current).root;
  while (current && current !== root) {
    if (store[current] === true) return true;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/** Remember `dir` unless it is the filesystem root. */
export function rememberFolderTrust(configDir: string, dir: string): { persisted: boolean } {
  const key = folderPathKey(dir);
  if (key === path.parse(key).root) return { persisted: false };
  const store = readTrustStore(configDir);
  store[key] = true;
  writeTrustStore(configDir, store);
  return { persisted: true };
}

/**
 * Remove the entry that covers `dir` (the directory itself, or the nearest
 * trusted ancestor). Returns the path that was removed.
 */
export function forgetFolderTrust(configDir: string, dir: string): string | null {
  const store = readTrustStore(configDir);
  let current = folderPathKey(dir);
  const root = path.parse(current).root;
  while (current && current !== root) {
    if (store[current] === true) {
      delete store[current];
      writeTrustStore(configDir, store);
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function listTrustedFolders(configDir: string): string[] {
  return Object.entries(readTrustStore(configDir))
    .filter(([, trusted]) => trusted)
    .map(([key]) => key)
    .filter((key) => key !== path.parse(key).root)
    .sort();
}
