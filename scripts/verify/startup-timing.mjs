#!/usr/bin/env node
/**
 * H2 probe — `MOSS_STARTUP_TIMING=1` prints one phased startup line; off by
 * default. Uses the offline mock provider, so no model call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const cli = path.join(root, 'dist/cli.js');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-timing-ws-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-timing-home-'));
fs.mkdirSync(path.join(home, '.config/moss'), { recursive: true });

const run = (env) =>
  captureProcess(process.execPath, [cli, '-p', 'Reply with the single word ok.', '--mock'], {
    cwd: workspace,
    env: {
      ...process.env,
      HOME: home,
      MOSS_NO_RDK_DOCS: '1',
      MOSS_NO_TUI: '1',
      ...env,
    },
    timeoutMs: 120_000,
  });

const checks = [];
const check = async (name, fn) => {
  try {
    await fn();
    checks.push(`PASS ${name}`);
  } catch (err) {
    checks.push(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

const LINE_RE = /\[startup\] timing: config=\d+ms agent=\d+ms skills=\d+ms total=\d+ms/;

await check('MOSS_STARTUP_TIMING=1 prints a phased startup line', async () => {
  const result = await run({ MOSS_STARTUP_TIMING: '1' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const line = `${result.stderr}`.split('\n').find((entry) => entry.includes('[startup] timing:'));
  assert.ok(line, `no timing line in stderr:\n${result.stderr}`);
  assert.match(line, LINE_RE);
});

await check('the marks are monotonic (config <= agent <= skills <= total)', async () => {
  const result = await run({ MOSS_STARTUP_TIMING: '1' });
  const line = `${result.stderr}`.split('\n').find((entry) => entry.includes('[startup] timing:'));
  assert.ok(line);
  const values = Object.fromEntries(
    [...line.matchAll(/(\w+)=(\d+)ms/g)].map((match) => [match[1], Number(match[2])])
  );
  assert.ok(values.config <= values.agent, line);
  assert.ok(values.agent <= values.skills, line);
  assert.ok(values.skills <= values.total, line);
});

await check('timing is off by default', async () => {
  const result = await run({});
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('[startup] timing:'));
});

await check('the flag is read as a boolean, not any non-empty string', async () => {
  const result = await run({ MOSS_STARTUP_TIMING: '0' });
  assert.equal(result.status, 0);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('[startup] timing:'));
});

for (const line of checks) console.log(`[startup-timing] ${line}`);
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
const failed = checks.filter((line) => line.startsWith('FAIL'));
if (failed.length > 0) {
  console.error(`[startup-timing] ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`[startup-timing] ${checks.length} checks passed`);
