#!/usr/bin/env node
/**
 * TUI feel bench entry. The PTY driver lives in driver.py (pyte).
 * A missing Python or pyte is an error, not a successful benchmark.
 *
 *   node scripts/tui-feel/run.mjs
 *   node scripts/tui-feel/run.mjs --scenario /path/to/scenario.json
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
  console.error('[tui-feel] python3 and pyte are required (python3 -m pip install pyte)');
  if (py.error) console.error(py.error.message);
  else if (py.stderr) console.error(py.stderr.trim());
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(root, 'bench/results', `tui-feel-${stamp}-${process.pid}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
const result = spawnSync('python3', [driver, '--out', out, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
