#!/usr/bin/env node
/**
 * `moss task artifacts` probe (offline, B131).
 *
 * `moss tasks <kind>` used to be a separate top-level command one letter away
 * from `moss task`, with its own help and usage. It is now folded into
 * `moss task artifacts`; the old verb stays as a working alias one release.
 * This locks the fold — every kind, the alias equivalence, exit codes and the
 * help surface — without needing a model.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[task-artifacts] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-task-artifacts-'));
const ws = path.join(tmp, 'ws');
const configDir = path.join(tmp, 'config');
await fs.mkdir(path.join(ws, '.git'), { recursive: true });
await fs.writeFile(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
await fs.mkdir(configDir, { recursive: true });

const env = {
  ...process.env,
  MOSS_CONFIG_DIR: configDir,
  MOSS_NO_RDK_DOCS: '1',
  MOSS_NO_TUI: '1',
  MOSS_LANG: 'en',
};
const cli = (args) =>
  captureProcess(process.execPath, [path.join(root, 'dist', 'cli.js'), ...args], {
    cwd: ws,
    env,
    timeoutMs: 60_000,
  });

try {
  // 1. Every kind answers with NO model configuration and exits 0.
  const kinds = ['', 'evidence', 'acceptance', 'device', 'tasks', 'failures'];
  for (const kind of kinds) {
    const args = kind ? ['artifacts', kind] : ['artifacts'];
    const result = await cli(args);
    assert.equal(result.status, 0, `moss ${args.join(' ')}: ${result.stderr}`);
    assert.ok(result.stdout.trim().length > 0, `${args.join(' ')} printed nothing`);
  }
  ok('artifacts: contracts/evidence/acceptance/device/tasks/failures answer without model config');

  // 2. The old verb is the same output, not a second implementation.
  const current = await cli(['artifacts']);
  const alias = await cli(['tasks']);
  assert.equal(alias.status, 0, alias.stderr);
  assert.equal(alias.stdout, current.stdout, '`moss tasks` must match `moss artifacts`');
  const aliasEvidence = await cli(['tasks', 'evidence']);
  assert.equal(aliasEvidence.stdout, (await cli(['artifacts', 'evidence'])).stdout);
  ok('`moss tasks …` is a working alias of `moss artifacts …`');

  // 3. Unknown kinds are rejected with the kind list instead of silently running.
  const bogus = await cli(['artifacts', 'bogus']);
  assert.equal(bogus.status, 2, 'unknown kind must exit 2');
  assert.match(bogus.stderr, /unknown kind "bogus"/);
  assert.match(bogus.stderr, /contracts \| list \| tasks/);
  ok('an unknown kind exits 2 and lists the valid kinds');

  // 4. `--help` shows the artifacts usage, not a fallback or a wrong kind.
  const help = await cli(['artifacts', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /moss artifacts \[/);
  assert.match(help.stdout, /contracts {5}task contracts/);
  ok('`moss artifacts --help` prints its own usage');

  // 5. The command surface has one artifacts entry, not the retired `tasks` row.
  const full = await cli(['--help', '--all']);
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /artifacts contracts\|tasks\|evidence/);
  assert.ok(!/tasks list\|evidence/.test(full.stdout), 'the retired `tasks` help row must be gone');
  ok('help lists one artifacts entry and no retired `tasks` row');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`[task-artifacts] ${checks}/${checks} checks passed`);
