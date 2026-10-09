/**
 * Pluggable approval environment for live device-bench runs.
 *
 * The device-safety stream owns mutation risk classification. This module
 * only maps a mode name onto env vars the CLI already understands:
 *
 *   full     MOSS_SAFETY_MODE=full-access and MOSS_APPROVAL_POLICY=never
 *   inherit  no extra keys (parent policy, including a future classifier)
 *   manual   prompt policy (headless denies device mutations)
 *
 * Set MOSS_DEVICE_BENCH_APPROVAL or pass --approval. Unknown modes throw.
 */

export const APPROVAL_MODES = ['full', 'inherit', 'manual'];

export function approvalEnv(mode = process.env.MOSS_DEVICE_BENCH_APPROVAL || 'full') {
  if (mode === 'inherit') return {};
  if (mode === 'full') {
    return { MOSS_SAFETY_MODE: 'full-access', MOSS_APPROVAL_POLICY: 'never' };
  }
  if (mode === 'manual') {
    return { MOSS_SAFETY_MODE: 'workspace-write', MOSS_APPROVAL_POLICY: 'prompt' };
  }
  throw new Error(
    `unknown MOSS_DEVICE_BENCH_APPROVAL "${mode}" (expected ${APPROVAL_MODES.join('|')})`
  );
}
