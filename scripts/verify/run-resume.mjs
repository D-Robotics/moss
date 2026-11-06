#!/usr/bin/env node
/**
 * `moss goal --resume` probe (offline, B139).
 *
 * The hero command starts a verified run; `--resume [<id>]` makes the same entry
 * continue one (no id = newest resumable task). This locks the argv shaping, the
 * empty-workspace error, and the help surface without needing a model call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const { shapeRunResumeArgs, resumeTaskArgs } = await import(
  pathToFileURL(path.join(root, 'dist/cli/run-resume-args.js')).href
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[run-resume] ok ${name}`);
};

// 1. No flag: untouched (the start-a-run path).
{
  const shaped = shapeRunResumeArgs(['create hello.txt', '--accept', 'test -f hello.txt']);
  assert.equal(shaped.resume, false);
  assert.deepEqual(shaped.rest, ['create hello.txt', '--accept', 'test -f hello.txt']);
}
ok('without --resume the argv is untouched');

// 2. `--resume` alone: implicit id, flags preserved.
{
  const shaped = shapeRunResumeArgs(['--resume', '--accept', 'npm test']);
  assert.equal(shaped.resume, true);
  assert.equal(shaped.id, undefined);
  assert.deepEqual(shaped.rest, ['--accept', 'npm test']);
  assert.deepEqual(resumeTaskArgs(shaped, 'task_latest'), [
    'resume',
    'task_latest',
    '--accept',
    'npm test',
  ]);
}
ok('`--resume` alone keeps flags and fills in the resolved latest task');

// 3. `--resume <id>`: explicit id, removed from the passthrough args.
{
  const shaped = shapeRunResumeArgs([
    '--resume',
    'task_abc',
    '--max-turns',
    '2',
    '--accept',
    'true',
  ]);
  assert.equal(shaped.resume, true);
  assert.equal(shaped.id, 'task_abc');
  assert.deepEqual(shaped.rest, ['--max-turns', '2', '--accept', 'true']);
  assert.deepEqual(resumeTaskArgs(shaped, shaped.id ?? ''), [
    'resume',
    'task_abc',
    '--max-turns',
    '2',
    '--accept',
    'true',
  ]);
}
ok('`--resume <id>` removes the id from passthrough flags');

// 4. CLI: empty workspace -> honest usage error (exit 2), no model call.
{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-run-resume-'));
  const ws = path.join(tmp, 'ws');
  const configDir = path.join(tmp, 'config');
  await fs.mkdir(path.join(ws, '.git'), { recursive: true });
  await fs.writeFile(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await fs.mkdir(configDir, { recursive: true });
  // An unreachable provider is enough: `--resume` with nothing to resume must
  // fail before any model call.
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
  try {
    const env = {
      ...process.env,
      MOSS_CONFIG_DIR: configDir,
      MOSS_NO_RDK_DOCS: '1',
      MOSS_NO_TUI: '1',
      MOSS_LANG: 'en',
      MOSS_TRUST_WORKSPACE: '1',
    };
    const none = await captureProcess(
      process.execPath,
      [path.join(root, 'dist', 'cli.js'), 'run', '--resume'],
      { cwd: ws, env, timeoutMs: 60_000 }
    );
    assert.equal(none.status, 2, none.stderr);
    assert.match(none.stderr, /no resumable task in this workspace/);
    assert.match(none.stderr, /moss goal "<intent>" --accept/);

    const help = await captureProcess(
      process.execPath,
      [path.join(root, 'dist', 'cli.js'), 'run', '--help'],
      { cwd: ws, env, timeoutMs: 60_000 }
    );
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /moss goal --resume \[<task_id>\]/);
    assert.match(help.stdout, /newest resumable/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  ok('an empty workspace exits 2 with a start-a-run hint; --help documents --resume');
}

console.log(`[run-resume] ${checks}/${checks} checks passed`);
