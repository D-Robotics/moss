import { spawnSync } from 'node:child_process';

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

/** Committed `base..HEAD` plus staged and unstaged edits, so a dirty tree cannot bypass G0. */
export function changedPaths(repo, base) {
  const chunks = [
    git(repo, ['diff', '--name-only', `${base}..HEAD`]),
    git(repo, ['diff', '--name-only', '--cached']),
    git(repo, ['diff', '--name-only']),
    git(repo, ['ls-files', '--others', '--exclude-standard']),
  ];
  const paths = new Set();
  for (const result of chunks) {
    if (result.status !== 0) {
      const detail = (result.stderr || '').trim();
      throw new Error(detail || `git diff failed against ${base}`);
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

export function netLineChange(repo, base) {
  const stdout = gitOk(repo, ['diff', '--numstat', base]);
  let additions = 0;
  let deletions = 0;
  for (const line of lines(stdout)) {
    const [added, deleted] = line.split('\t');
    if (!/^\d+$/.test(added) || !/^\d+$/.test(deleted)) continue;
    additions += Number(added);
    deletions += Number(deleted);
  }
  return { additions, deletions, net: additions - deletions };
}
