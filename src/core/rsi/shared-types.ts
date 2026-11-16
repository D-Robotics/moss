import type { RsiAdapter, RsiScope, RsiTaskScope } from './types.js';

export type RsiSharedChannel = 'stable' | 'engineering';
export interface RsiSharedCompatibility {
  sdkApiVersion: 1;
  taskFamily: string;
  executionProfileDigest: string;
  models: string[];
  tools: string[];
  boardPlatforms?: string[];
  providerKinds?: string[];
}
/** A publisher-reviewed instruction package; it does not attest model learning. */
export interface RsiSharedPackage {
  kind: 'rsi-shared-package';
  schemaVersion: 1;
  registryId: string;
  packageId: string;
  version: string;
  channel: RsiSharedChannel;
  source: 'curated';
  publishedAt: number;
  summary: string;
  adapter: RsiAdapter;
  compatibility: RsiSharedCompatibility;
}
export interface RsiSharedIndexEntry {
  packageId: string;
  version: string;
  digest: string;
  channel: RsiSharedChannel;
  status: 'published' | 'revoked';
}
export interface RsiSharedIndex {
  kind: 'rsi-shared-index';
  schemaVersion: 1;
  registryId: string;
  revision: number;
  issuedAt: number;
  expiresAt: number;
  entries: RsiSharedIndexEntry[];
}
export interface RsiSharedEnvelope<T extends RsiSharedPackage | RsiSharedIndex> {
  schemaVersion: 1;
  keyId: string;
  payload: T;
  digest: string;
  signature: string;
}
export interface RsiSharedTrust {
  registryId: string;
  publicKeys: Record<string, string>;
}
export interface RsiSharedConfiguration extends RsiSharedTrust {
  channel: RsiSharedChannel;
  enabled: boolean;
}
export interface RsiSharedProjectPolicy {
  projectId: string;
  packageDigest: string | null;
  previousPackageDigest: string | null;
  version: number;
  updatedAt: number;
}
export interface RsiSharedInstalledPackage {
  digest: string;
  package: RsiSharedPackage;
  installedAt: number;
  availability: 'available' | 'revoked' | 'expired' | 'unlisted' | 'disabled';
}
export interface RsiSharedOverview {
  revision: number;
  configuration: RsiSharedConfiguration | null;
  index: RsiSharedIndex | null;
  indexFresh: boolean;
  installed: RsiSharedInstalledPackage[];
  policies: RsiSharedProjectPolicy[];
}
/** These are facts from trusted host assembly, not model or HTTP claims. */
export interface RsiSharedRunContext {
  taskScope: RsiTaskScope;
  model: string;
  executionProfileDigest: string;
  tools: readonly string[];
  boardPlatform?: string | null;
  providerKind?: string;
}
export interface RsiSharedAdapterSource {
  registryId: string;
  packageId: string;
  packageDigest: string;
  channel: RsiSharedChannel;
  source: 'curated';
}
export interface RsiSharedStoreOptions {
  authorize?(scope: RsiScope): void;
  now?(): number;
}
