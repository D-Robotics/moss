#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFileInfo } from 'prettier';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const trackedAndCommittable = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
)
  .split('\0')
  .filter(Boolean)
  .sort();

const ignorePath = path.join(repoRoot, '.prettierignore');
for (const relativePath of trackedAndCommittable) {
  const info = await getFileInfo(path.join(repoRoot, relativePath), {
    ignorePath,
    withNodeModules: false,
  });
  if (!info.ignored && info.inferredParser) {
    process.stdout.write(`${relativePath.replaceAll(path.sep, '/')}\n`);
  }
}
