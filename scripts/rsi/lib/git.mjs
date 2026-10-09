import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function git(repo, args) {
  return spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
}

export function gitOk(repo, args) {
  const result = git(repo, args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function lines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function changedPaths(repo, base) {
  const chunks = [
    ['diff', '--name-only', `${base}..HEAD`],
    ['diff', '--name-only', '--cached'],
    ['diff', '--name-only'],
    ['ls-files', '--others', '--exclude-standard'],
  ];
  const paths = new Set();
  for (const args of chunks) {
    const result = git(repo, args);
    if (result.status !== 0) {
      throw new Error((result.stderr || `git ${args[0]} failed against ${base}`).trim());
    }
    for (const file of lines(result.stdout)) paths.add(file.replaceAll('\\', '/'));
  }
  return [...paths].sort();
}

export function headSha(repo) {
  return gitOk(repo, ['rev-parse', 'HEAD']).trim();
}

export function refSha(repo, ref) {
  return gitOk(repo, ['rev-parse', `${ref}^{commit}`]).trim();
}

export function withBaseWorktree(repo, base, run) {
  const sha = refSha(repo, base);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rsi-base-'));
  const dir = path.join(parent, 'wt');
  const added = git(repo, ['worktree', 'add', '--detach', dir, sha]);
  if (added.status !== 0) {
    fs.rmSync(parent, { recursive: true, force: true });
    throw new Error((added.stderr || 'git worktree add failed').trim());
  }
  try {
    return run(dir, sha);
  } finally {
    git(repo, ['worktree', 'remove', '--force', dir]);
    fs.rmSync(parent, { recursive: true, force: true });
  }
}
