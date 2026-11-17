import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assetDirectory, assetPath } from './asset-io.js';
import { managedFail } from './managed-validation.js';
import type { RsiScope } from './types.js';
import type { RsiManagedEnvelope, RsiManagedManifest, RsiManagedPackage } from './managed-types.js';

export interface RsiManagedState {
  schemaVersion: 2;
  scope: RsiScope;
  manifest: RsiManagedEnvelope<RsiManagedManifest> | null;
  packages: Array<RsiManagedEnvelope<RsiManagedPackage>>;
  revokedDigests: string[];
  versions: Array<{ packageId: string; version: string; digest: string }>;
}
const MAX_BYTES = 2 * 1024 * 1024;
export class RsiManagedStateFile {
  constructor(private readonly root: string) {}
  private directory(scope: RsiScope) {
    return assetPath(assetDirectory(this.root, scope));
  }
  read(scope: RsiScope): RsiManagedState {
    const file = assetPath(this.directory(scope), 'managed-registry.json');
    let value: RsiManagedState;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
        return managedFail('state_unavailable', 503);
      value = JSON.parse(fs.readFileSync(file, 'utf8')) as RsiManagedState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          schemaVersion: 2,
          scope: structuredClone(scope),
          manifest: null,
          packages: [],
          revokedDigests: [],
          versions: [],
        };
      return managedFail('state_unavailable', 503);
    }
    if (
      !value ||
      value.schemaVersion !== 2 ||
      value.scope?.ownerKey !== scope.ownerKey ||
      value.scope?.environment !== scope.environment ||
      !Array.isArray(value.packages) ||
      value.packages.length > 128 ||
      !Array.isArray(value.revokedDigests) ||
      value.revokedDigests.length > 4096 ||
      !Array.isArray(value.versions) ||
      value.versions.length > 4096
    )
      return managedFail('state_unavailable', 503);
    return value;
  }
  update(scope: RsiScope, work: (state: RsiManagedState) => void): void {
    const directory = this.directory(scope);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = assetPath(directory, 'managed-registry.lock');
    let descriptor: number;
    try {
      descriptor = fs.openSync(lock, 'wx', 0o600);
    } catch {
      return managedFail('state_locked', 409);
    }
    let temporary: string | undefined;
    try {
      const state = this.read(scope);
      work(state);
      const data = JSON.stringify(state);
      if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) return managedFail('storage_limit', 409);
      temporary = path.join(directory, `managed-${randomUUID()}.tmp`);
      const output = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(output, data);
        fs.fsyncSync(output);
      } finally {
        fs.closeSync(output);
      }
      fs.renameSync(temporary, assetPath(directory, 'managed-registry.json'));
      temporary = undefined;
    } finally {
      if (temporary) fs.rmSync(temporary, { force: true });
      fs.closeSync(descriptor);
      fs.rmSync(lock, { force: true });
    }
  }
}
