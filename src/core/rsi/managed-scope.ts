import { rsiTaskScopeDigest } from './external-training.js';
import { canonicalRsiSharedJson } from './shared-package.js';
import { rsiDigest } from './store.js';
import { sharedDigest, sharedKeys, sharedObject, sharedText } from './shared-validation.js';
import type { RsiTaskScope } from './types.js';
import type { RsiManagedTaskScope } from './managed-types.js';

/** Device identities use a distinct domain; Git/Hermit scope validation remains unchanged. */
export function rsiManagedTaskScopeDigest(scope: RsiManagedTaskScope): string {
  const value = sharedObject(scope);
  if (value.kind !== 'device-binding') return rsiTaskScopeDigest(scope as RsiTaskScope);
  sharedKeys(value, ['kind', 'projectId', 'deviceId', 'bindingRevision', 'capabilitiesDigest']);
  const identity = {
    kind: 'device-binding',
    projectId: sharedText(value.projectId),
    deviceId: sharedText(value.deviceId),
    bindingRevision: sharedDigest(value.bindingRevision),
    capabilitiesDigest: sharedDigest(value.capabilitiesDigest),
  };
  return rsiDigest('moss-rsi-managed-device-scope/v1\0' + canonicalRsiSharedJson(identity));
}
