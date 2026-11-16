import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import {
  sharedDigest,
  sharedFail,
  sharedId,
  sharedKeys,
  sharedObject,
  SHARED_CLOCK_SKEW_MS,
  validateRsiSharedIndex,
  validateRsiSharedPackage,
  validateRsiSharedTrust,
} from './shared-validation.js';
import type {
  RsiSharedEnvelope,
  RsiSharedIndex,
  RsiSharedPackage,
  RsiSharedTrust,
} from './shared-types.js';

export type * from './shared-types.js';
export { RsiError } from './error.js';
export { validateRsiSharedIndex, validateRsiSharedPackage } from './shared-validation.js';

/** A bounded JSON subset: plain records, dense arrays and safe integers only. */
export function canonicalRsiSharedJson(value: unknown): string {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 10_000 || depth > 32) return sharedFail('json_limit');
    if (item === null) return 'null';
    if (typeof item === 'string') {
      if (Buffer.byteLength(item, 'utf8') > 262_144) return sharedFail('json_limit');
      return JSON.stringify(item);
    }
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number' && Number.isSafeInteger(item)) return JSON.stringify(item);
    if (!item || typeof item !== 'object') return sharedFail('invalid_json');
    if (ancestors.has(item)) return sharedFail('invalid_json');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > 1024 || Object.keys(item).length !== item.length)
          return sharedFail('invalid_json');
        const values: string[] = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !('value' in descriptor)) return sharedFail('invalid_json');
          values.push(visit(descriptor.value, depth + 1));
        }
        return '[' + values.join(',') + ']';
      }
      const data = sharedObject(item);
      return (
        '{' +
        Object.keys(data)
          .sort()
          .map((key) => JSON.stringify(key) + ':' + visit(data[key], depth + 1))
          .join(',') +
        '}'
      );
    } finally {
      ancestors.delete(item);
    }
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(result, 'utf8') > 262_144) return sharedFail('json_limit');
  return result;
}
export function rsiSharedDigest(value: unknown): string {
  return createHash('sha256').update(canonicalRsiSharedJson(value)).digest('hex');
}
function signingBytes(keyId: string, payload: RsiSharedPackage | RsiSharedIndex): Buffer {
  return Buffer.from('moss-rsi-shared/v1\0' + canonicalRsiSharedJson({ keyId, payload }), 'utf8');
}
function payloadKind(value: unknown): RsiSharedPackage | RsiSharedIndex {
  const data = sharedObject(value);
  return data.kind === 'rsi-shared-package'
    ? validateRsiSharedPackage(data)
    : validateRsiSharedIndex(data);
}
export function createRsiSharedEnvelope<T extends RsiSharedPackage | RsiSharedIndex>(
  payload: T,
  keyId: string,
  privateKeyPem: string
): RsiSharedEnvelope<T> {
  sharedId(keyId);
  const checked = payloadKind(payload) as T;
  let signature: string;
  try {
    if (typeof privateKeyPem !== 'string' || privateKeyPem.length > 8192)
      return sharedFail('invalid_signing_key');
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return sharedFail('invalid_signing_key');
    signature = sign(null, signingBytes(keyId, checked), key).toString('base64');
  } catch {
    return sharedFail('invalid_signing_key');
  }
  return { schemaVersion: 1, keyId, payload: checked, digest: rsiSharedDigest(checked), signature };
}
function verifyEnvelope(
  input: unknown,
  inputTrust: RsiSharedTrust
): RsiSharedEnvelope<RsiSharedPackage | RsiSharedIndex> {
  const suppliedTrust = sharedObject(inputTrust);
  const trust = validateRsiSharedTrust({
    registryId: suppliedTrust.registryId,
    publicKeys: suppliedTrust.publicKeys,
  });
  const data = sharedObject(input);
  sharedKeys(data, ['schemaVersion', 'keyId', 'payload', 'digest', 'signature']);
  if (data.schemaVersion !== 1) return sharedFail('unsupported_envelope');
  const keyId = sharedId(data.keyId),
    digest = sharedDigest(data.digest);
  const payload = payloadKind(data.payload);
  if (payload.registryId !== trust.registryId || rsiSharedDigest(payload) !== digest)
    return sharedFail('package_integrity_failed', 409);
  if (
    typeof data.signature !== 'string' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(data.signature) ||
    !Object.hasOwn(trust.publicKeys, keyId)
  )
    return sharedFail('signature_invalid', 409);
  try {
    const key = createPublicKey(trust.publicKeys[keyId]);
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      !verify(null, signingBytes(keyId, payload), key, Buffer.from(data.signature, 'base64'))
    )
      return sharedFail('signature_invalid', 409);
  } catch {
    return sharedFail('signature_invalid', 409);
  }
  return { schemaVersion: 1, keyId, payload, digest, signature: data.signature };
}
export function verifyRsiSharedPackage(
  input: unknown,
  trust: RsiSharedTrust,
  now = Date.now()
): RsiSharedEnvelope<RsiSharedPackage> {
  if (!Number.isSafeInteger(now) || now < 1) return sharedFail('invalid_time');
  const envelope = verifyEnvelope(input, trust);
  if (envelope.payload.kind !== 'rsi-shared-package') return sharedFail('unsupported_package');
  if (envelope.payload.publishedAt > now + SHARED_CLOCK_SKEW_MS)
    return sharedFail('package_from_future', 409);
  return envelope as RsiSharedEnvelope<RsiSharedPackage>;
}
export function verifyRsiSharedIndex(
  input: unknown,
  trust: RsiSharedTrust,
  now = Date.now()
): RsiSharedEnvelope<RsiSharedIndex> {
  if (!Number.isSafeInteger(now) || now < 1) return sharedFail('invalid_time');
  const envelope = verifyEnvelope(input, trust);
  if (envelope.payload.kind !== 'rsi-shared-index') return sharedFail('unsupported_index');
  validateRsiSharedIndex(envelope.payload, now);
  return envelope as RsiSharedEnvelope<RsiSharedIndex>;
}
/** Fresh signatures may refresh timestamps without changing directory revision. */
export function rsiSharedIndexContentDigest(index: RsiSharedIndex): string {
  const data = validateRsiSharedIndex(index);
  const entries = [...data.entries].sort((left, right) => {
    const a = JSON.stringify([left.packageId, left.version]),
      b = JSON.stringify([right.packageId, right.version]);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return rsiSharedDigest({ registryId: data.registryId, revision: data.revision, entries });
}
