import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assetDirectory, assetPath } from './asset-io.js';
import { sharedFail, sharedInteger, validateRsiSharedConfiguration } from './shared-validation.js';
import type { RsiScope } from './types.js';
import type {
  RsiSharedConfiguration,
  RsiSharedEnvelope,
  RsiSharedIndex,
  RsiSharedPackage,
  RsiSharedProjectPolicy,
} from './shared-types.js';

export interface SharedRegistryHistory {
  registryId: string;
  revision: number;
  contentDigest: string;
  issuedAt: number;
  revokedDigests: string[];
  versions: Array<{ packageId: string; version: string; digest: string }>;
}
export interface SharedState {
  schemaVersion: 1;
  scope: RsiScope;
  revision: number;
  configuration: RsiSharedConfiguration | null;
  index: RsiSharedEnvelope<RsiSharedIndex> | null;
  histories: SharedRegistryHistory[];
  installed: Array<{ envelope: RsiSharedEnvelope<RsiSharedPackage>; installedAt: number }>;
  policies: RsiSharedProjectPolicy[];
}
const MAX_BYTES = 2 * 1024 * 1024;
function empty(scope: RsiScope): SharedState {
  return {
    schemaVersion: 1,
    scope: structuredClone(scope),
    revision: 0,
    configuration: null,
    index: null,
    histories: [],
    installed: [],
    policies: [],
  };
}
export class RsiSharedStateFile {
  constructor(private readonly rootDir: string) {}
  private directory(scope: RsiScope): string {
    return assetPath(assetDirectory(this.rootDir, scope));
  }
  read(scope: RsiScope): SharedState {
    const file = assetPath(this.directory(scope), 'shared-registry.json');
    let state: SharedState;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
        return sharedFail('state_unavailable', 503);
      state = JSON.parse(fs.readFileSync(file, 'utf8')) as SharedState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(scope);
      return sharedFail('state_unavailable', 503);
    }
    if (
      !state ||
      state.schemaVersion !== 1 ||
      state.scope?.ownerKey !== scope.ownerKey ||
      state.scope.environment !== scope.environment ||
      !Array.isArray(state.histories) ||
      state.histories.length > 8 ||
      !Array.isArray(state.installed) ||
      state.installed.length > 128 ||
      !Array.isArray(state.policies) ||
      state.policies.length > 128
    )
      return sharedFail('state_unavailable', 503);
    sharedInteger(state.revision);
    if (state.configuration) validateRsiSharedConfiguration(state.configuration);
    return state;
  }
  update<T>(scope: RsiScope, expectedRevision: number, mutate: (state: SharedState) => T): T {
    sharedInteger(expectedRevision);
    const directory = this.directory(scope);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = assetPath(directory, 'shared-registry.lock');
    let descriptor: number;
    try {
      descriptor = fs.openSync(lock, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        return sharedFail('state_unavailable', 503);
      // Crashed writers require explicit recovery; never delete another writer's lock.
      return sharedFail('state_locked', 409);
    }
    let temporary: string | undefined;
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
      const state = this.read(scope);
      if (state.revision !== expectedRevision) return sharedFail('revision_conflict', 409);
      const result = mutate(state);
      state.revision++;
      const bytes = JSON.stringify(state);
      if (Buffer.byteLength(bytes, 'utf8') > MAX_BYTES) return sharedFail('storage_limit', 409);
      temporary = path.join(directory, `shared-${randomUUID()}.tmp`);
      const output = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(output, bytes);
        fs.fsyncSync(output);
      } finally {
        fs.closeSync(output);
      }
      fs.renameSync(temporary, assetPath(directory, 'shared-registry.json'));
      temporary = undefined;
      return structuredClone(result);
    } finally {
      if (temporary) fs.rmSync(temporary, { force: true });
      fs.closeSync(descriptor);
      fs.rmSync(lock, { force: true });
    }
  }
}
