import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { canonicalRsiSharedJson, rsiSharedDigest } from './shared-package.js';
import {
  sharedDigest,
  sharedId,
  sharedKeys,
  sharedObject,
  validateRsiSharedTrust,
} from './shared-validation.js';
import {
  managedFail,
  validateRsiManagedManifest,
  validateRsiManagedPackage,
} from './managed-validation.js';
import type { RsiManagedEnvelope, RsiManagedPayload, RsiManagedTrust } from './managed-types.js';

export type * from './managed-types.js';
export { validateRsiManagedPackage, validateRsiManagedManifest } from './managed-validation.js';
export { rsiSharedDigest as rsiManagedDigest } from './shared-package.js';

function payload(value: unknown, now?: number): RsiManagedPayload {
  const data = sharedObject(value);
  return data.kind === 'rsi-managed-package'
    ? validateRsiManagedPackage(data)
    : validateRsiManagedManifest(data, now);
}
function bytes(keyId: string, value: RsiManagedPayload): Buffer {
  return Buffer.from(
    'moss-rsi-managed/v2\0' + canonicalRsiSharedJson({ keyId, payload: value }),
    'utf8'
  );
}
export function createRsiManagedEnvelope<T extends RsiManagedPayload>(
  value: T,
  keyId: string,
  privateKeyPem: string
): RsiManagedEnvelope<T> {
  sharedId(keyId);
  const checked = payload(value) as T;
  if (typeof privateKeyPem !== 'string' || privateKeyPem.length > 8192)
    return managedFail('invalid_signing_key');
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') return managedFail('invalid_signing_key');
  return {
    schemaVersion: 2,
    keyId,
    payload: checked,
    digest: rsiSharedDigest(checked),
    signature: sign(null, bytes(keyId, checked), key).toString('base64'),
  };
}
export function verifyRsiManagedEnvelope<T extends RsiManagedPayload = RsiManagedPayload>(
  input: unknown,
  inputTrust: RsiManagedTrust,
  now?: number
): RsiManagedEnvelope<T> {
  const trust = validateRsiSharedTrust(inputTrust);
  const data = sharedObject(input);
  sharedKeys(data, ['schemaVersion', 'keyId', 'payload', 'digest', 'signature']);
  if (data.schemaVersion !== 2) return managedFail('unsupported_envelope');
  const keyId = sharedId(data.keyId),
    digest = sharedDigest(data.digest);
  const checked = payload(data.payload, now);
  if (
    checked.registryId !== trust.registryId ||
    (checked.kind === 'rsi-managed-package' &&
      now !== undefined &&
      checked.publishedAt > now + 30_000)
  )
    return managedFail('registry_identity_mismatch');
  if (rsiSharedDigest(checked) !== digest) return managedFail('digest_mismatch');
  const pem = trust.publicKeys[keyId];
  if (!pem || typeof data.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(data.signature))
    return managedFail('signature_invalid');
  const key = createPublicKey(pem);
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(null, bytes(keyId, checked), key, Buffer.from(data.signature, 'base64'))
  )
    return managedFail('signature_invalid');
  return structuredClone({
    schemaVersion: 2,
    keyId,
    payload: checked,
    digest,
    signature: data.signature,
  }) as RsiManagedEnvelope<T>;
}
/** Renewal may change timestamps, but the same revision must retain its content. */
export function rsiManagedManifestContentDigest(value: RsiManagedPayload): string {
  if (value.kind !== 'rsi-managed-manifest') return managedFail('unsupported_manifest');
  return rsiSharedDigest({ ...value, issuedAt: 0, expiresAt: 0 });
}
