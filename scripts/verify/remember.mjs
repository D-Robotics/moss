#!/usr/bin/env node
/**
 * D6 probe — explicit memory write path: `moss remember "<fact>"`.
 * Asserts preview writes nothing, the real write lands in AGENTS.md, a second
 * run de-dupes (whitespace/case-insensitive), and the section is created once.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const cli = path.join(root, 'dist/cli.js');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'remember-ws-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remember-home-'));
fs.mkdirSync(path.join(home, '.config/moss'), { recursive: true });
const agentsFile = path.join(workspace, 'AGENTS.md');
fs.writeFileSync(agentsFile, '# House rules\n\n- keep commits small\n');

const remember = (args) =>
  captureProcess(process.execPath, [cli, ...args], {
    cwd: workspace,
    env: { ...process.env, HOME: home, MOSS_NO_RDK_DOCS: '1', MOSS_NO_TUI: '1' },
    timeoutMs: 60_000,
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

const fact = 'Device bench: run npm run bench:device -- --target sim';

await check('--dry-run previews the fact and writes nothing', async () => {
  const before = fs.readFileSync(agentsFile, 'utf8');
  const result = await remember(['remember', fact, '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(`${result.stdout}${result.stderr}`, /Would add to AGENTS\.md/);
  assert.match(`${result.stdout}${result.stderr}`, /bench:device/);
  assert.equal(fs.readFileSync(agentsFile, 'utf8'), before);
});

await check('the real write creates the section and the bullet', async () => {
  const result = await remember(['remember', fact]);
  assert.equal(result.status, 0, result.stderr);
  const text = fs.readFileSync(agentsFile, 'utf8');
  assert.match(text, /## Remembered facts/);
  assert.match(text, /^- Device bench: run npm run bench:device -- --target sim$/m);
  assert.match(text, /- keep commits small/, 'existing content must be preserved');
});

await check('a second write de-dupes (same fact, different case/whitespace)', async () => {
  const result = await remember([
    'remember',
    'device   bench: RUN npm run bench:device -- --target sim',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const text = fs.readFileSync(agentsFile, 'utf8');
  const bullets = text.split('\n').filter((line) => line.includes('bench:device'));
  assert.equal(bullets.length, 1, `expected one bullet, got: ${bullets.join(' | ')}`);
  assert.match(`${result.stdout}${result.stderr}`, /Already remembered/);
});

await check('an empty fact is a usage error (exit 2)', async () => {
  const result = await remember(['remember']);
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /Usage:/);
});

await check('a fact longer than the cap is rejected, not truncated', async () => {
  const result = await remember(['remember', 'x'.repeat(600)]);
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /chars/);
});

await check('the file is valid markdown with the heading exactly once', async () => {
  const text = fs.readFileSync(agentsFile, 'utf8');
  const headings = text.split('\n').filter((line) => line.trim() === '## Remembered facts');
  assert.equal(headings.length, 1);
  assert.ok(text.endsWith('\n'));
});

for (const line of checks) console.log(`[remember] ${line}`);
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
const failed = checks.filter((line) => line.startsWith('FAIL'));
if (failed.length > 0) {
  console.error(`[remember] ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`[remember] ${checks.length} checks passed`);
