/**
 * Explicit device-trust ledger.
 *
 * The approval hook grants a one-shot token when it allows a destructive
 * call (user confirmed, allow rule, or full trust). The device tool consumes
 * that token so a host that skipped the hook still refuses the destructive
 * tier unless `MOSS_DEVICE_TRUST` / `MOSS_DEVICE_TRUST_DEVICES` says otherwise.
 */
import type { DeviceRiskClassification } from './device-risk.js';

const grants = new Map<string, number>();

export function deviceGrantKey(toolName: string, operand: string): string {
  return `${toolName}\0${operand}`;
}

export function grantDeviceOperation(toolName: string, operand: string): void {
  const key = deviceGrantKey(toolName, operand);
  grants.set(key, (grants.get(key) ?? 0) + 1);
}

export function consumeDeviceGrant(toolName: string, operand: string): boolean {
  const key = deviceGrantKey(toolName, operand);
  const left = grants.get(key) ?? 0;
  if (left <= 0) return false;
  if (left === 1) grants.delete(key);
  else grants.set(key, left - 1);
  return true;
}

/** Test isolation. Production callers do not need this. */
export function resetDeviceOperationGrants(): void {
  grants.clear();
}

export function isDeviceTrustEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.MOSS_DEVICE_TRUST ?? '').trim().toLowerCase();
  return raw === 'full' || raw === '1' || raw === 'true' || raw === 'yes';
}

export function parseDeviceTrustList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    ),
  ];
}

export function deviceIdsMatchTrustList(
  deviceIds: readonly string[],
  trusted: readonly string[]
): boolean {
  if (trusted.includes('*')) return true;
  const allowed = new Set(trusted);
  return deviceIds.some((id) => id.trim() !== '' && allowed.has(id.trim()));
}

export function currentDeviceIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const ids = [env.MOSS_DEVICE_HOST, env.MOSS_DEVICE_ID];
  return [...new Set(ids.map((id) => (id ?? '').trim()).filter((id) => id.length > 0))];
}

/**
 * Destructive operations run only with an env trust, a per-device env
 * allowlist, or a one-shot grant from the approval hook. Other tiers run.
 */
export function permitDeviceOperation(
  classification: DeviceRiskClassification,
  toolName: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (classification.tier !== 'destructive' && classification.tier !== 'sensitive') return true;
  if (isDeviceTrustEnv(env)) return true;
  if (
    deviceIdsMatchTrustList(
      currentDeviceIds(env),
      parseDeviceTrustList(env.MOSS_DEVICE_TRUST_DEVICES)
    )
  ) {
    return true;
  }
  return consumeDeviceGrant(toolName, classification.operand);
}
