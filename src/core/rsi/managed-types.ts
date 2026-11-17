import type { RsiSelectedAdapter } from './engine.js';
import type { RsiAdapter, RsiTaskScope } from './types.js';
import type { RsiSharedTrust } from './shared-types.js';

export type RsiManagedTrust = RsiSharedTrust;
export interface RsiManagedTarget {
  platformId: string;
  modelId: string;
}
export type RsiManagedGatewayIdentity =
  | {
      mode: 'manual';
      contractVersion: string;
      selectionId: string;
      platformId: string;
      modelId: string;
    }
  | {
      mode: 'auto';
      contractVersion: string;
      routeId: string;
      targets: RsiManagedTarget[];
      bounded: true;
    };
export interface RsiManagedCompatibility {
  sdkApiVersion: 2;
  profiles: Array<{ id: string; version: string }>;
  targets: RsiManagedTarget[];
  gatewayContractVersions: string[];
  requiredTools: string[];
  forbiddenTools: string[];
  allowAdditionalTools: boolean;
  boardPlatforms?: string[];
}
export interface RsiManagedPackage {
  kind: 'rsi-managed-package';
  schemaVersion: 2;
  registryId: string;
  packageId: string;
  version: string;
  channel: 'stable';
  source: 'curated';
  publishedAt: number;
  summary: string;
  adapter: RsiAdapter;
  compatibility: RsiManagedCompatibility;
}
export interface RsiManagedPolicy {
  policyId: string;
  packageDigest: string;
  priority: number;
  rolloutPercent: number;
}
export interface RsiManagedManifest {
  kind: 'rsi-managed-manifest';
  schemaVersion: 2;
  registryId: string;
  revision: number;
  issuedAt: number;
  expiresAt: number;
  enabled: boolean;
  entries: RsiManagedPolicy[];
  revokedDigests: string[];
}
export type RsiManagedPayload = RsiManagedPackage | RsiManagedManifest;
export interface RsiManagedEnvelope<T extends RsiManagedPayload = RsiManagedPayload> {
  schemaVersion: 2;
  keyId: string;
  payload: T;
  digest: string;
  signature: string;
}
/** Managed readonly device runs have no Git revision and never enter Hermit training scope. */
export interface RsiManagedDeviceScope {
  kind: 'device-binding';
  projectId: string;
  deviceId: string;
  bindingRevision: string;
  capabilitiesDigest: string;
}
export type RsiManagedTaskScope = RsiTaskScope | RsiManagedDeviceScope;
/** The host supplies facts from actual admission, never an assistant/browser claim. */
export interface RsiManagedRunContext {
  profile: string;
  profileVersion: string;
  gateway?: RsiManagedGatewayIdentity;
  tools: readonly string[];
  boardPlatform?: string;
  taskScope: RsiManagedTaskScope;
  /** Stable, account-isolated deployment bucket in [0, 99]. No raw owner is published. */
  cohort: number;
}
export type RsiManagedReason =
  | 'selected'
  | 'cache_cold'
  | 'policy_disabled'
  | 'index_expired'
  | 'signature_invalid'
  | 'package_revoked'
  | 'gateway_identity_unresolved'
  | 'model_incompatible'
  | 'capability_mismatch'
  | 'task_profile_unsupported'
  | 'policy_ambiguous'
  | 'rollout_excluded';
export interface RsiManagedDecision {
  reason: RsiManagedReason;
  policyId?: string;
  policyRevision?: number;
  packageDigest?: string;
  selection?: RsiSelectedAdapter;
}
export interface RsiManagedReceipt {
  schemaVersion: 2;
  policyId: string;
  policyRevision: number;
  profile: string;
  profileVersion: string;
  gateway: RsiManagedGatewayIdentity;
}
