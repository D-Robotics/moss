import { hashHarnessAdapter } from '../agent/harness-adapter.js';
import { createPublicKey } from 'node:crypto';
import { containsSecrets } from '../../safety/secret-sanitizer.js';
import { RsiError } from './error.js';
import type {
  RsiSharedConfiguration,
  RsiSharedIndex,
  RsiSharedPackage,
  RsiSharedTrust,
} from './shared-types.js';

export const SHARED_INDEX_TTL_MS = 300_000;
export const SHARED_CLOCK_SKEW_MS = 30_000;
export const SHARED_MAX_PACKAGES = 128;
export const SHARED_MAX_INDEX_ENTRIES = 512;
export const sharedFail = (code: string, status = 400): never => {
  throw new RsiError(`rsi_shared_${code}`, status);
};
export function sharedObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return sharedFail('invalid_object');
  const proto: unknown = Object.getPrototypeOf(value);
  if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(value).length)
    return sharedFail('invalid_object');
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)))
    if (
      ['__proto__', 'constructor', 'prototype'].includes(name) ||
      !('value' in descriptor) ||
      !descriptor.enumerable
    )
      return sharedFail('invalid_object');
  return value as Record<string, unknown>;
}
export function sharedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    sharedFail('invalid_fields');
}
export function sharedText(value: unknown, max = 256): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value, 'utf8') > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    return sharedFail('invalid_text');
  return value;
}
export function sharedId(value: unknown): string {
  const text = sharedText(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(text)) return sharedFail('invalid_identifier');
  return text;
}
export function sharedInteger(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    return sharedFail('invalid_integer');
  return value;
}
export function sharedDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    return sharedFail('invalid_digest');
  return value;
}
export function sharedVersion(value: unknown): string {
  const text = sharedText(value, 128);
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(text)) return sharedFail('invalid_version');
  return text;
}
export function sharedChannel(value: unknown): 'stable' | 'engineering' {
  if (value !== 'stable' && value !== 'engineering') return sharedFail('invalid_channel');
  return value;
}
function stringSet(value: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.length > 64 || (!allowEmpty && !value.length))
    return sharedFail('invalid_compatibility');
  const values = value.map((item) => sharedText(item));
  for (const text of values) publishedText(text);
  if (new Set(values).size !== values.length) return sharedFail('invalid_compatibility');
  return values;
}
function publishedText(value: string): void {
  if (
    containsSecrets(value) ||
    /-----BEGIN[^\r\n]*PRIVATE KEY-----|\bBearer\s+[a-zA-Z0-9._-]{16,}|["']?\b(?:api[_-]?key|access[_-]?token|password|token|secret)["']?\s*[:=]\s*["']?[^\s"']{8,}/i.test(
      value
    )
  )
    sharedFail('package_contains_credentials');
}
export function validateRsiSharedTrust(value: unknown): RsiSharedTrust {
  const data = sharedObject(value);
  sharedKeys(data, ['registryId', 'publicKeys']);
  sharedId(data.registryId);
  const keys = sharedObject(data.publicKeys);
  if (Object.keys(keys).length < 1 || Object.keys(keys).length > 8)
    return sharedFail('invalid_trust');
  const normalized: Record<string, string> = {};
  for (const [id, value] of Object.entries(keys)) {
    sharedId(id);
    const key = sharedText(value, 4096).trim();
    if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----$/.test(key))
      return sharedFail('invalid_public_key');
    try {
      const publicKey = createPublicKey(key);
      if (publicKey.asymmetricKeyType !== 'ed25519') return sharedFail('invalid_public_key');
      normalized[id] = String(publicKey.export({ format: 'pem', type: 'spki' }));
    } catch {
      return sharedFail('invalid_public_key');
    }
  }
  return { registryId: String(data.registryId), publicKeys: normalized };
}
export function validateRsiSharedConfiguration(value: unknown): RsiSharedConfiguration {
  const data = sharedObject(value);
  sharedKeys(data, ['registryId', 'publicKeys', 'channel', 'enabled']);
  const trust = validateRsiSharedTrust({
    registryId: data.registryId,
    publicKeys: data.publicKeys,
  });
  sharedChannel(data.channel);
  if (typeof data.enabled !== 'boolean') return sharedFail('invalid_configuration');
  return { ...trust, channel: sharedChannel(data.channel), enabled: data.enabled };
}
export function validateRsiSharedPackage(value: unknown): RsiSharedPackage {
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
  if (data.kind !== 'rsi-shared-package' || data.schemaVersion !== 1 || data.source !== 'curated')
    return sharedFail('unsupported_package');
  sharedId(data.registryId);
  sharedId(data.packageId);
  sharedVersion(data.version);
  sharedChannel(data.channel);
  sharedInteger(data.publishedAt, 1);
  sharedText(data.summary, 2048);
  publishedText(String(data.summary));
  const adapter = sharedObject(data.adapter);
  sharedKeys(adapter, ['id', 'version', 'digest', 'instructions']);
  sharedId(adapter.id);
  sharedVersion(adapter.version);
  sharedText(adapter.instructions, 8192);
  publishedText(String(adapter.instructions));
  sharedDigest(adapter.digest);
  if (
    adapter.version !== data.version ||
    hashHarnessAdapter({
      id: String(adapter.id),
      version: String(adapter.version),
      instructions: String(adapter.instructions),
    }) !== adapter.digest
  )
    return sharedFail('adapter_integrity_failed');
  const compatibility = sharedObject(data.compatibility);
  sharedKeys(
    compatibility,
    ['sdkApiVersion', 'taskFamily', 'executionProfileDigest', 'models', 'tools'],
    ['boardPlatforms', 'providerKinds']
  );
  if (compatibility.sdkApiVersion !== 1) return sharedFail('unsupported_sdk_api');
  sharedText(compatibility.taskFamily, 128);
  sharedDigest(compatibility.executionProfileDigest);
  stringSet(compatibility.models);
  stringSet(compatibility.tools);
  if (compatibility.boardPlatforms !== undefined) stringSet(compatibility.boardPlatforms);
  if (compatibility.providerKinds !== undefined) stringSet(compatibility.providerKinds);
  return structuredClone(data) as unknown as RsiSharedPackage;
}
export function validateRsiSharedIndex(value: unknown, now?: number): RsiSharedIndex {
  const data = sharedObject(value);
  sharedKeys(data, [
    'kind',
    'schemaVersion',
    'registryId',
    'revision',
    'issuedAt',
    'expiresAt',
    'entries',
  ]);
  if (data.kind !== 'rsi-shared-index' || data.schemaVersion !== 1)
    return sharedFail('unsupported_index');
  sharedId(data.registryId);
  sharedInteger(data.revision);
  const issued = sharedInteger(data.issuedAt, 1),
    expires = sharedInteger(data.expiresAt, 1);
  if (expires <= issued || expires - issued > SHARED_INDEX_TTL_MS)
    return sharedFail('invalid_index_lifetime');
  if (now !== undefined && (issued > now + SHARED_CLOCK_SKEW_MS || expires <= now))
    return sharedFail('index_expired', 409);
  if (!Array.isArray(data.entries) || data.entries.length > SHARED_MAX_INDEX_ENTRIES)
    return sharedFail('index_limit');
  const versions = new Set<string>(),
    digests = new Set<string>();
  for (const value of data.entries) {
    const entry = sharedObject(value);
    sharedKeys(entry, ['packageId', 'version', 'digest', 'channel', 'status']);
    const id = sharedId(entry.packageId),
      version = sharedVersion(entry.version);
    const digest = sharedDigest(entry.digest);
    sharedChannel(entry.channel);
    if (entry.status !== 'published' && entry.status !== 'revoked')
      return sharedFail('invalid_entry');
    const key = JSON.stringify([id, version]);
    if (versions.has(key) || digests.has(digest)) return sharedFail('duplicate_entry');
    versions.add(key);
    digests.add(digest);
  }
  return structuredClone(data) as unknown as RsiSharedIndex;
}
