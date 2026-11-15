import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RsiError, rsiDigest } from './store.js';
import type { RsiScope } from './types.js';
import type { RsiState } from './store.js';

export const recordCollections = [
  'runs',
  'cases',
  'candidates',
  'evaluations',
  'trainingSessions',
  'trainingConfirmations',
] as const;
export type RsiDocumentIndex = Partial<Record<(typeof recordCollections)[number], string[]>>;
export const byteDigest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
export function assetDirectory(root: string, scope: RsiScope): string {
  if (
    !scope.ownerKey?.trim() ||
    scope.ownerKey.length > 512 ||
    !['production', 'staging', 'development', 'test'].includes(scope.environment)
  )
    throw new RsiError('invalid_scope', 401);
  return path.join(path.resolve(root), rsiDigest(`${scope.ownerKey}\0${scope.environment}`));
}
/** Reject symlinks below the configured root, including directories. No browser-authored paths. */
export function assetPath(directory: string, ...parts: string[]): string {
  for (const part of parts)
    if (!/^[a-zA-Z0-9._-]+$/.test(part) || part === '.' || part === '..')
      throw new RsiError('invalid_asset_path');
  let current = directory;
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new RsiError('asset_symlink_refused', 409);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return current;
}
export function diskUsage(directory: string): number {
  let count = 0;
  function walk(file: string): number {
    if (++count > 100_000) throw new RsiError('asset_scan_limit', 409);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new RsiError('asset_symlink_refused', 409);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) throw new RsiError('asset_special_file_refused', 409);
    return fs.readdirSync(file).reduce((sum, name) => sum + walk(path.join(file, name)), 0);
  }
  return walk(directory);
}
export function verifiedBytes(file: string, digest: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new RsiError('invalid_asset_digest');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024)
    throw new RsiError('asset_integrity_failed', 409);
  const bytes = fs.readFileSync(file);
  if (byteDigest(bytes) !== digest) throw new RsiError('asset_integrity_failed', 409);
  return bytes;
}
export function immutableBytes(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    if (!verifiedBytes(file, byteDigest(bytes)).equals(bytes))
      throw new RsiError('asset_integrity_failed', 409);
    return;
  }
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}
/** Only used after an owner-bound backup signature and payload digest have been verified. */
export function restoreAuthenticatedBytes(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new RsiError('asset_integrity_failed', 409);
    if (fs.readFileSync(file).equals(bytes)) return;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export function hydrateDocuments(
  directory: string,
  state: RsiState & { documents?: RsiDocumentIndex }
): void {
  if (state.schemaVersion !== 3) return;
  if (!state.documents || typeof state.documents !== 'object')
    throw new RsiError('asset_index_invalid', 503);
  for (const key of recordCollections) {
    const hashes = state.documents[key];
    if (!Array.isArray(hashes) || hashes.length > 1000)
      throw new RsiError('asset_index_invalid', 503);
    const values = hashes.map(
      (hash) =>
        JSON.parse(
          verifiedBytes(assetPath(directory, 'documents', key, `${hash}.json`), hash).toString(
            'utf8'
          )
        ) as never
    );
    state[key] = values;
  }
}
/** Plan first: quota rejection happens before immutable writes; interrupted writes leave only orphans. */
export function documentPlan(directory: string, state: RsiState) {
  const documents: RsiDocumentIndex = {};
  const pending: Array<{ file: string; bytes: Buffer }> = [];
  const serialized: Record<string, unknown> = { ...state, schemaVersion: 3 };
  for (const key of recordCollections) {
    documents[key] = (state[key] ?? []).map((value) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const hash = byteDigest(bytes);
      const file = assetPath(directory, 'documents', key, `${hash}.json`);
      if (fs.existsSync(file)) verifiedBytes(file, hash);
      else pending.push({ file, bytes });
      return hash;
    });
    delete serialized[key];
  }
  serialized.documents = documents;
  return { serialized, pending };
}
