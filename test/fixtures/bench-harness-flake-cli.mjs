#!/usr/bin/env node
/**
 * Deterministic fake benchmark CLI. Attempt 1 emits the zero-turn
 * error_during_execution shape; later attempts repair math.js and emit success.
 * MOSS_HARNESS_FLAKE_CLI_MODE=always-error never recovers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = process.env.HOME || os.homedir();
const alwaysMarker = path.join(home, '.harness-flake-always');
const firstRunMarker = path.join(home, '.harness-flake-first-run');
const result = (subtype, numTurns) => {
  console.log(
    JSON.stringify({
      type: 'result',
      subtype,
      num_turns: numTurns,
      duration_ms: 25,
    })
  );
};

if (fs.existsSync(alwaysMarker) || !fs.existsSync(firstRunMarker)) {
  fs.writeFileSync(firstRunMarker, '1\n');
  result('error_during_execution', 1);
  process.exit(0);
}

fs.writeFileSync(
  path.join(process.cwd(), 'math.js'),
  'export function clamp(n, lo, hi) {\n  return Math.min(Math.max(n, lo), hi);\n}\n'
);
result('success', 2);
