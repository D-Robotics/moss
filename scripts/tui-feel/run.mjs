#!/usr/bin/env node
/**
 * TUI feel bench entry. The PTY driver lives in driver.py (pyte). When python3
 * or pyte is missing this prints a skip and exits 0, matching smoke-moss-cli.
 *
 *   node scripts/tui-feel/run.mjs
 *   node scripts/tui-feel/run.mjs --real
 *   node scripts/tui-feel/run.mjs --compare claude
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const compare = process.argv.includes('--compare');
const driver = path.join(root, 'scripts/tui-feel', compare ? 'compare_feel.py' : 'driver.py');
const py = spawnSync('python3', ['-c', 'import pyte'], { encoding: 'utf8' });
if (py.status !== 0) {
  console.log('[tui-feel] skip: python3 or pyte is not available');
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(root, 'bench/results', `tui-feel-${stamp}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
const result = spawnSync('python3', [driver, '--out', out, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
