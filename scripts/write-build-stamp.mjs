/**
 * Write dist/utils/build-stamp.json after tsc. `moss --version` reads it.
 * Git missing or not a repository is not a build failure: the stamp then
 * carries only the UTC date, and the version line omits the parenthetical.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist', 'utils');
const outFile = path.join(outDir, 'build-stamp.json');

function shortCommit() {
  const result = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  const commit = (result.stdout ?? '').trim();
  return /^[0-9a-f]{7,40}$/i.test(commit) ? commit.toLowerCase() : undefined;
}

const commit = shortCommit();
const date = new Date().toISOString().slice(0, 10);
const stamp = commit ? { commit, date } : { date };
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(stamp)}\n`);
