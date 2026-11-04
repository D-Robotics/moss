/**
 * Static gate: formatting, lint and types.
 *
 * The three checks are independent, so they run concurrently. Nothing here
 * imports `dist/`, which is why CI can install with `npm ci --ignore-scripts`
 * for this stage.
 */
import path from 'node:path';
import { captureProcess, formatDuration } from '../lib/proc.mjs';

const STEPS = [
  {
    name: 'format',
    label: 'prettier --check .',
    binary: ['prettier', 'bin', 'prettier.cjs'],
    args: ['--check', '.'],
  },
  {
    name: 'lint',
    label: 'eslint . --max-warnings 0',
    binary: ['eslint', 'bin', 'eslint.js'],
    args: ['.', '--max-warnings', '0'],
  },
  {
    name: 'types',
    label: 'tsc --noEmit',
    binary: ['typescript', 'lib', 'tsc.js'],
    args: ['--noEmit'],
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
  const result = await captureProcess(process.execPath, [binary, ...step.args], {
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
