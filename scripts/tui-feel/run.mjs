#!/usr/bin/env node
/**
 * TUI feel bench entry. The PTY driver lives in driver.py (pyte).
 * A missing Python or pyte is an error, not a successful benchmark.
 *
 *   node scripts/tui-feel/run.mjs
 *   node scripts/tui-feel/run.mjs --scenario /path/to/scenario.json
 * Legacy comparison is disabled until it can run in isolation.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.slice(2).some((arg) => arg === '--compare' || arg.startsWith('--compare='))) {
  console.error('[tui-feel] legacy comparison is disabled until it can run in isolation');
  process.exit(1);
}

if (process.platform === 'win32') {
  console.error('[tui-feel] the PTY benchmark requires macOS or Linux');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const driver = path.join(root, 'scripts/tui-feel', 'driver.py');
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
if (result.status !== 0) process.exit(result.status ?? 1);

// B12 gate: the product-side `cli_composer_ms` is the number the 600ms target is
// about (the end-to-end `composer_ready_ms` also pays this driver's PTY/parse/poll
// overhead, ~300-430ms). Report both, and fail only when asked to be strict.
const report = JSON.parse(fs.readFileSync(out, 'utf8'));
const threshold = Number(process.env.MOSS_TUI_FEEL_MAX_COMPOSER_MS ?? '600');
const strict = process.env.MOSS_TUI_FEEL_STRICT === '1';
const product = [];
const endToEnd = [];
const overhead = [];
for (const scenario of report.scenarios ?? []) {
  const metrics = scenario.metrics ?? {};
  if (typeof metrics.cli_composer_ms === 'number') product.push(metrics.cli_composer_ms);
  if (typeof metrics.composer_ready_ms === 'number') endToEnd.push(metrics.composer_ready_ms);
  if (typeof metrics.driver_overhead_ms === 'number') overhead.push(metrics.driver_overhead_ms);
}
if (product.length === 0) {
  console.error(
    '[tui-feel] no startup timing line was captured, so cli_composer_ms is missing; the 600ms target cannot be checked'
  );
  process.exit(strict ? 1 : 0);
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};
const productMedian = median(product);
const worst = Math.max(...product);
console.log(
  `[tui-feel] composer: product median ${productMedian}ms (worst ${worst}ms), end-to-end median ${median(endToEnd)}ms, driver overhead median ${median(overhead)}ms; target <=${threshold}ms for the product number`
);
const over = product.filter((value) => value > threshold);
if (over.length > 0) {
  const message = `[tui-feel] ${over.length}/${product.length} scenario(s) exceeded the ${threshold}ms product composer target (worst ${worst}ms)`;
  if (strict) {
    console.error(`${message}; failing because MOSS_TUI_FEEL_STRICT=1`);
    process.exit(1);
  }
  console.warn(`${message}; set MOSS_TUI_FEEL_STRICT=1 to make this a failure`);
}
process.exit(0);
