import { hashHarnessAdapter } from '../agent/harness-adapter.js';
import { containsSecrets } from '../../safety/secret-sanitizer.js';
import {
  sharedDigest,
  sharedId,
  sharedInteger,
  sharedKeys,
  sharedObject,
  sharedText,
  sharedVersion,
} from './shared-validation.js';
import { RsiError } from './error.js';
import type {
  RsiManagedGatewayIdentity,
  RsiManagedManifest,
  RsiManagedPackage,
  RsiManagedTarget,
} from './managed-types.js';

export const managedFail = (reason: string, status = 400): never => {
  throw new RsiError(`rsi_managed_${reason}`, status);
};
export function managedTexts(value: unknown, empty = false): string[] {
  if (!Array.isArray(value) || value.length > 128 || (!empty && !value.length))
    return managedFail('invalid_set');
  const items = value.map((item) => sharedText(item, 256));
  if (new Set(items).size !== items.length) return managedFail('invalid_set');
  return items;
}
export function managedTargets(value: unknown): RsiManagedTarget[] {
  if (!Array.isArray(value) || !value.length || value.length > 64)
    return managedFail('invalid_targets');
  const targets = value.map((item) => {
    const data = sharedObject(item);
    sharedKeys(data, ['platformId', 'modelId']);
    return { platformId: sharedText(data.platformId), modelId: sharedText(data.modelId) };
  });
  if (new Set(targets.map((item) => JSON.stringify(item))).size !== targets.length)
    return managedFail('invalid_targets');
  return targets;
}
export function managedGatewayIdentity(value: unknown): RsiManagedGatewayIdentity {
  const data = sharedObject(value);
  const contractVersion = sharedText(data.contractVersion, 128);
  if (data.mode === 'manual') {
    sharedKeys(data, ['mode', 'contractVersion', 'selectionId', 'platformId', 'modelId']);
    return {
      mode: 'manual',
      contractVersion,
      selectionId: sharedId(data.selectionId),
      platformId: sharedText(data.platformId),
      modelId: sharedText(data.modelId),
    };
  }
  sharedKeys(data, ['mode', 'contractVersion', 'routeId', 'targets', 'bounded']);
  if (data.mode !== 'auto' || data.bounded !== true)
    return managedFail('gateway_identity_unresolved');
  return {
    mode: 'auto',
    contractVersion,
    routeId: sharedText(data.routeId),
    targets: managedTargets(data.targets),
    bounded: true,
  };
}
export function validateRsiManagedPackage(value: unknown): RsiManagedPackage {
  const data = sharedObject(value);
  sharedKeys(data, [
    'kind',
    'schemaVersion',
    'registryId',
    'packageId',
    'version',
    'channel',
    'source',
    'publishedAt',
    'summary',
    'adapter',
    'compatibility',
  ]);
  if (
    data.kind !== 'rsi-managed-package' ||
    data.schemaVersion !== 2 ||
    data.channel !== 'stable' ||
    data.source !== 'curated'
  )
    return managedFail('unsupported_package');
  sharedId(data.registryId);
  sharedId(data.packageId);
  sharedVersion(data.version);
  sharedInteger(data.publishedAt, 1);
  sharedText(data.summary, 2048);
  const adapter = sharedObject(data.adapter);
  sharedKeys(adapter, ['id', 'version', 'digest', 'instructions']);
  const normalized = {
    id: sharedId(adapter.id),
    version: sharedVersion(adapter.version),
    digest: sharedDigest(adapter.digest),
    instructions: sharedText(adapter.instructions, 8192),
  };
  if (normalized.version !== data.version || hashHarnessAdapter(normalized) !== normalized.digest)
    return managedFail('adapter_integrity_failed');
  const compatibility = sharedObject(data.compatibility);
  sharedKeys(
    compatibility,
    [
      'sdkApiVersion',
      'profiles',
      'targets',
      'gatewayContractVersions',
      'requiredTools',
      'forbiddenTools',
      'allowAdditionalTools',
    ],
    ['boardPlatforms']
  );
  if (compatibility.sdkApiVersion !== 2 || typeof compatibility.allowAdditionalTools !== 'boolean')
    return managedFail('invalid_compatibility');
  if (
    !Array.isArray(compatibility.profiles) ||
    !compatibility.profiles.length ||
    compatibility.profiles.length > 16
  )
    return managedFail('invalid_profiles');
  const profiles = compatibility.profiles.map((value) => {
    const profile = sharedObject(value);
    sharedKeys(profile, ['id', 'version']);
    return { id: sharedId(profile.id), version: sharedText(profile.version, 128) };
  });
  if (new Set(profiles.map((profile) => JSON.stringify(profile))).size !== profiles.length)
    return managedFail('invalid_profiles');
  managedTargets(compatibility.targets);
  managedTexts(compatibility.gatewayContractVersions);
  const required = managedTexts(compatibility.requiredTools, true);
  const forbidden = managedTexts(compatibility.forbiddenTools, true);
  if (required.some((tool) => forbidden.includes(tool)))
    return managedFail('invalid_compatibility');
  if (compatibility.boardPlatforms !== undefined) managedTexts(compatibility.boardPlatforms);
  if (
    containsSecrets(JSON.stringify(data)) ||
    /-----BEGIN[^\r\n]*PRIVATE KEY-----|\bBearer\s+[a-zA-Z0-9._-]{16,}/i.test(JSON.stringify(data))
  )
    return managedFail('package_contains_credentials');
  return structuredClone(data) as unknown as RsiManagedPackage;
}
export function validateRsiManagedManifest(value: unknown, now?: number): RsiManagedManifest {
  const data = sharedObject(value);
  sharedKeys(data, [
    'kind',
    'schemaVersion',
    'registryId',
    'revision',
    'issuedAt',
    'expiresAt',
    'enabled',
    'entries',
    'revokedDigests',
  ]);
  if (
    data.kind !== 'rsi-managed-manifest' ||
    data.schemaVersion !== 2 ||
    typeof data.enabled !== 'boolean'
  )
    return managedFail('unsupported_manifest');
  sharedId(data.registryId);
  sharedInteger(data.revision, 1);
  const issued = sharedInteger(data.issuedAt, 1),
    expires = sharedInteger(data.expiresAt, 1);
  if (
    expires <= issued ||
    expires - issued > 300_000 ||
    (now !== undefined && (issued > now + 30_000 || now >= expires))
  )
    return managedFail('index_expired');
  if (!Array.isArray(data.entries) || data.entries.length > 128) return managedFail('policy_limit');
  const ids = new Set<string>();
  for (const value of data.entries) {
    const policy = sharedObject(value);
    sharedKeys(policy, ['policyId', 'packageDigest', 'priority', 'rolloutPercent']);
    const id = sharedId(policy.policyId);
    if (ids.has(id)) return managedFail('duplicate_policy');
    ids.add(id);
    sharedDigest(policy.packageDigest);
    if (sharedInteger(policy.priority) > 1_000_000 || sharedInteger(policy.rolloutPercent) > 100)
      return managedFail('invalid_policy');
  }
  if (!Array.isArray(data.revokedDigests) || data.revokedDigests.length > 4096)
    return managedFail('revocation_limit');
  const revoked = data.revokedDigests.map((digest) => sharedDigest(digest));
  if (new Set(revoked).size !== revoked.length) return managedFail('duplicate_revocation');
  if (
    data.entries.some((entry) =>
      revoked.includes(String((entry as Record<string, unknown>).packageDigest))
    )
  )
    return managedFail('revoked_policy');
  return structuredClone(data) as unknown as RsiManagedManifest;
}
