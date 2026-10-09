/**
 * Pluggable approval environment for live device-bench runs.
 *
 *   full     --full-access. Readonly and reversible device calls auto-allow.
 *            Destructive and sensitive stay gated unless the operator also
 *            sets MOSS_DEVICE_TRUST (this mode does not).
 *   inherit  same full interaction, and the run records a device-risk
 *            snapshot (src/safety/device-risk.ts). No MOSS_DEVICE_TRUST, so
 *            the new policy is what decides: reversible passes, destructive
 *            and sensitive do not.
 *   manual   prompt policy (headless denies device mutations)
 *
 * Set MOSS_DEVICE_BENCH_APPROVAL or pass --approval. Unknown modes throw.
 *
 * `--full-access` is required for full mode. MOSS_SAFETY_MODE=full-access
 * alone is mapped to manual by modeFromLegacySafetyPair.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const APPROVAL_MODES = ['full', 'inherit', 'manual'];

const INHERIT_PROBES = [
  'uname -a',
  'dpkg -i /tmp/moss-bench-marker.deb',
  'reboot',
  'cat /etc/shadow',
];

export function approvalEnv(mode = process.env.MOSS_DEVICE_BENCH_APPROVAL || 'full') {
  if (mode === 'inherit' || mode === 'full') {
    return { MOSS_SAFETY_MODE: 'full-access', MOSS_APPROVAL_POLICY: 'never' };
  }
  if (mode === 'manual') {
    return { MOSS_SAFETY_MODE: 'workspace-write', MOSS_APPROVAL_POLICY: 'prompt' };
  }
  throw new Error(
    `unknown MOSS_DEVICE_BENCH_APPROVAL "${mode}" (expected ${APPROVAL_MODES.join('|')})`
  );
}

/** Full mode auto-allow. The device-risk gate keeps these tiers asking. */
export function inheritAutoAllows(tier) {
  return tier === 'readonly' || tier === 'reversible';
}

export async function inheritPolicySnapshot() {
  const href = pathToFileURL(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/safety/device-risk.js')
  ).href;
  const { classifyDeviceOperation } = await import(href);
  const samples = INHERIT_PROBES.map((command) => {
    const judged = classifyDeviceOperation({
      toolName: 'device_exec',
      sideEffect: 'device_mutation',
      command,
    });
    const tier = judged?.tier ?? null;
    return {
      command,
      tier,
      signal: judged?.signal ?? null,
      autoAllow: tier != null && inheritAutoAllows(tier),
    };
  });
  return {
    classifier: 'device-risk',
    mode: 'full',
    deviceTrust: 'gated',
    samples,
  };
}
