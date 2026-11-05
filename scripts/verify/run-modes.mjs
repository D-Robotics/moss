#!/usr/bin/env node
/**
 * `moss run` mode probe (offline, B140).
 *
 * One verb + three modifiers: an intent with `--accept` (task run), `--until`
 * (closed loop) and `--workflow` (declarative plan), plus `--resume`. This locks
 * the classifier, the conflicts, the help surface, and one real CLI routing into
 * the workflow engine (offline via --mock) so routing cannot silently drift.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const { classifyRunMode } = await import(
  pathToFileURL(path.join(root, 'dist/cli/run-mode-args.js')).href
);
const { listRunRecords } = await import(
  pathToFileURL(path.join(root, 'dist/core/run-ledger.js')).href
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[run-modes] ok ${name}`);
};

// 1. Plain verified run stays untouched.
assert.deepEqual(classifyRunMode(['create hello.txt', '--accept', 'test -f hello.txt']), {
  mode: 'run',
});
ok('an intent with --accept classifies as the verified-run mode');

// 2. `--until` extracts the check and keeps the intent + loop flags.
{
  const mode = classifyRunMode(['fix the tests', '--until', 'npm test', '--max', '2']);
  assert.equal(mode.mode, 'until');
  assert.equal(mode.until, 'npm test');
  assert.deepEqual(mode.rest, ['fix the tests', '--max', '2']);
  const equals = classifyRunMode(['fix', '--until=npm test']);
  assert.equal(equals.mode, 'until');
  assert.equal(equals.until, 'npm test');
}
ok('--until extracts its command (space and = forms) and keeps the intent');

// 3. `--workflow` extracts the plan path.
{
  const mode = classifyRunMode(['--workflow', 'plan.json', '--mock']);
  assert.equal(mode.mode, 'workflow');
  assert.equal(mode.target, 'plan.json');
  assert.deepEqual(mode.rest, ['--mock']);
}
ok('--workflow extracts the plan path and keeps passthrough flags');

// 4. Conflicts and missing values are usage errors, not silent misroutes.
for (const [args, pattern] of [
  [['x', '--until', 'true', '--workflow', 'p.json'], /different run modes/],
  [['x', '--until', 'true', '--accept', 'true'], /--accept does not apply/],
  [['--workflow', 'p.json', '--accept', 'true'], /--accept does not apply/],
  [['--workflow'], /needs a value/],
  [['x', '--until'], /needs a value/],
  [['--until', 'true'], /needs the intent to loop on/],
]) {
  const mode = classifyRunMode(args);
  assert.equal(mode.mode, 'error', args.join(' '));
  assert.match(mode.message, pattern, args.join(' '));
}
ok('conflicting modifiers and missing values are explicit usage errors');

// 5. CLI: help documents the three modifiers; bad combinations exit 2.
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-run-modes-'));
  const ws = path.join(tmp, 'ws');
  const configDir = path.join(tmp, 'config');
  await fs.mkdir(path.join(ws, '.git'), { recursive: true });
  await fs.writeFile(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    `${JSON.stringify({
      provider: 'openai-compatible',
      model: 'm',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test',
      permissions: { defaultMode: 'full' },
    })}\n`,
    'utf8'
  );
  const env = {
    ...process.env,
    MOSS_CONFIG_DIR: configDir,
    MOSS_NO_RDK_DOCS: '1',
    MOSS_NO_TUI: '1',
    MOSS_LANG: 'en',
    MOSS_TRUST_WORKSPACE: '1',
  };
  const cli = (args) =>
    captureProcess(process.execPath, [path.join(root, 'dist', 'cli.js'), ...args], {
      cwd: ws,
      env,
      timeoutMs: 120_000,
    });
  try {
    const help = await cli(['run', '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--until "<command>"/);
    assert.match(help.stdout, /--workflow <plan.json>/);
    assert.match(help.stdout, /one run verb plus three modifiers/i);

    const conflict = await cli(['run', 'x', '--until', 'true', '--accept', 'true']);
    assert.equal(conflict.status, 2, conflict.stderr);
    assert.match(conflict.stderr, /--accept does not apply/);

    const missing = await cli(['run', '--workflow']);
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stderr, /needs a value/);

    // Real routing into the workflow engine, offline via --mock.
    await fs.writeFile(
      path.join(ws, 'plan.json'),
      `${JSON.stringify({ name: 'modes', concurrency: 1, steps: [{ id: 's1', task: 'say ok' }] })}\n`,
      'utf8'
    );
    const workflow = await cli(['run', '--workflow', 'plan.json', '--mock']);
    assert.equal(workflow.status, 0, `${workflow.stdout}\n${workflow.stderr}`);
    const records = await listRunRecords(ws);
    assert.equal(records.length, 1, `expected one record, got ${records.length}`);
    assert.equal(records[0].kind, 'workflow');
    assert.equal(records[0].status, 'completed');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  ok('CLI help documents the modifiers and `run --workflow` reaches the workflow engine');
}

console.log(`[run-modes] ${checks}/${checks} checks passed`);
