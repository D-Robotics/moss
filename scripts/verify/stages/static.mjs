/**
 * Static gate: formatting, lint and types.
 *
 * The three checks are independent, so they run concurrently. Nothing here
 * imports `dist/`, which is why CI can install with `npm ci --ignore-scripts`
 * for this stage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

/**
 * B68: every tool here keeps a content-addressed cache. A cold run on a loaded
 * dev machine spends ~1.5-2 minutes on the three checks, which is why local
 * `verify` kept overshooting the 60s budget; a warm run is single-digit seconds
 * because nothing changed since the last check. The cache lives inside
 * `node_modules/` (already ignored) and is cold exactly once in CI, so gate
 * semantics are unchanged: a changed file invalidates its own entry.
 */
function cachePath(root, name) {
  const dir = path.join(root, 'node_modules', '.cache', 'verify');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

const STEPS = [
  {
    name: 'format',
    label: 'prettier --check . (cached)',
    binary: ['prettier', 'bin', 'prettier.cjs'],
    args: (root) => [
      '--check',
      '.',
      '--cache',
      '--cache-location',
      cachePath(root, 'prettier.cache'),
    ],
  },
  {
    name: 'lint',
    label: 'eslint . --max-warnings 0 (cached)',
    binary: ['eslint', 'bin', 'eslint.js'],
    args: (root) => [
      '.',
      '--max-warnings',
      '0',
      '--cache',
      '--cache-location',
      cachePath(root, 'eslint.cache'),
    ],
  },
  {
    name: 'types',
    label: 'tsc --noEmit (incremental)',
    binary: ['typescript', 'lib', 'tsc.js'],
    args: (root) => [
      '--noEmit',
      '--incremental',
      '--tsBuildInfoFile',
      cachePath(root, 'tsc.tsbuildinfo'),
    ],
  },
];

const OUTPUT_LIMIT = 20_000;

function tail(text) {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `… (${text.length - OUTPUT_LIMIT} characters omitted)\n${text.slice(-OUTPUT_LIMIT)}`;
}

function binaryFor(root, segments) {
  return path.join(root, 'node_modules', ...segments);
}

async function runStep(step, root) {
  const binary = binaryFor(root, step.binary);
  const result = await captureProcess(process.execPath, [binary, ...step.args(root)], {
    cwd: root,
    timeoutMs: 10 * 60 * 1000,
  });
  return { step, result };
}

export const stage = {
  name: 'static',
  requires: [],
  description: 'format, lint and types',
  async run(context) {
    console.log(`[static] ${STEPS.map((step) => step.label).join(', ')} (parallel)`);
    const outcomes = await Promise.all(STEPS.map((step) => runStep(step, context.root)));
    let ok = true;
    let firstFailure;
    for (const { step, result } of outcomes) {
      const output = `${result.stdout}${result.stderr}`.trim();
      if (result.timedOut) {
        ok = false;
        firstFailure ??= { step, reason: 'timed out' };
        console.error(`[static] ${step.name} TIMEOUT after ${formatDuration(result.durationMs)}`);
      } else if (result.status !== 0) {
        ok = false;
        firstFailure ??= { step, reason: `exit ${result.status ?? result.signal}` };
        console.error(`[static] ${step.name} FAILED (${firstFailure.reason})`);
      } else {
        console.log(`[static] ${step.name} ok in ${formatDuration(result.durationMs)}`);
      }
      if (output) console.error(tail(output));
    }
    if (!ok) {
      return {
        ok: false,
        detail: firstFailure ? `${firstFailure.step.name} failed` : 'static checks failed',
      };
    }
    return { ok: true };
  },
};
