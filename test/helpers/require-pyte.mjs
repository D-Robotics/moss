import { spawnSync } from 'node:child_process';

/** What to print when the layout specs cannot import pyte. */
export const PYTE_INSTALL = 'python3 -m pip install pyte';

export function pyteMissingMessage(label) {
  return [
    `[${label}] python3 module pyte is required for the TUI layout specs.`,
    `Install it with: ${PYTE_INSTALL}`,
    'Set MOSS_SKIP_PY_LAYOUT=1 to skip these checks.',
  ].join('\n');
}

/**
 * Gate for the PTY layout specs. Returns true when pyte imported.
 * `MOSS_SKIP_PY_LAYOUT=1` skips (the caller exits 0). Anything else missing
 * pyte exits 1 so `npm run verify` cannot pass a silent skip.
 */
export function requirePyLayout(label) {
  if (process.env.MOSS_SKIP_PY_LAYOUT === '1') {
    console.log(`[${label}] skip: MOSS_SKIP_PY_LAYOUT=1`);
    return false;
  }
  const probe = spawnSync('python3', ['-c', 'import pyte'], { encoding: 'utf8' });
  if (probe.status === 0) return true;
  console.error(pyteMissingMessage(label));
  const detail = `${probe.stderr ?? ''}${probe.stdout ?? ''}`.trim();
  if (detail) console.error(detail);
  else if (probe.error) console.error(probe.error.message);
  process.exit(1);
}
