import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';

/** Turn a frozen.txt glob into a full-path regular expression. `*` stays inside one segment; `**` crosses segments. */
export function globToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      source += '.*';
      i += 1;
      if (pattern[i + 1] === '/') i += 1;
      continue;
    }
    if (ch === '*') {
      source += '[^/]*';
      continue;
    }
    if ('\\^$+?.()|{}[]'.includes(ch)) source += `\\${ch}`;
    else source += ch;
  }
  return new RegExp(`^${source}$`);
}

export function matchFrozen(pattern, filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  return globToRegExp(pattern).test(normalized);
}

export function loadFrozenPatterns(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export function frozenHits(patterns, files) {
  const hits = [];
  for (const file of files) {
    const matched = patterns.filter((pattern) => matchFrozen(pattern, file));
    if (matched.length > 0) hits.push({ file, patterns: matched });
  }
  return hits;
}

const SKIP = 'skip';
const ONLY = 'only';
const SKIP_ONLY_RE = new RegExp(
  `\\.(?:${SKIP}|${ONLY})\\b|\\b(?:test|it|describe)\\s*\\.\\s*(?:${SKIP}|${ONLY})\\b`
);
const CASE_RE = new RegExp(`^\\s*(?:test|it)\\s*(?:\\.\\s*(?:${SKIP}|${ONLY})\\s*)?\\(`);

function isSpec(file) {
  return file.startsWith('test/') && file.endsWith('.spec.mjs');
}

function readAtRev(repo, rev, file) {
  const result = git(repo, ['show', `${rev}:${file}`]);
  if (result.status !== 0) return null;
  return result.stdout;
}

function countCases(text) {
  if (!text) return 0;
  let count = 0;
  for (const line of text.split('\n')) {
    if (CASE_RE.test(line)) count += 1;
  }
  return count;
}

function worktreeSpecs(repo) {
  const root = path.join(repo, 'test');
  if (!fs.existsSync(root)) return [];
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.spec.mjs')) {
        found.push(path.relative(repo, full).replaceAll('\\', '/'));
      }
    }
  }
  return found.sort();
}

function baseSpecs(repo, base) {
  const result = git(repo, ['ls-tree', '-r', '--name-only', base]);
  if (result.status !== 0) {
    throw new Error((result.stderr || `git ls-tree ${base} failed`).trim());
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim().replaceAll('\\', '/'))
    .filter(isSpec)
    .sort();
}

/**
 * G0 test-count rule: spec file count and `test(` / `it(` call count must not drop.
 * Added `.skip` / `.only` in test files are rejected even when the count rises.
 */
export function testCountReport(repo, base) {
  const beforeFiles = baseSpecs(repo, base);
  const afterFiles = worktreeSpecs(repo);
  let beforeCases = 0;
  let afterCases = 0;
  for (const file of beforeFiles) beforeCases += countCases(readAtRev(repo, base, file));
  for (const file of afterFiles) {
    afterCases += countCases(fs.readFileSync(path.join(repo, file), 'utf8'));
  }
  const additions = skipOnlyAdditions(repo, base);
  const reasons = [];
  if (afterFiles.length < beforeFiles.length) {
    reasons.push(`test file count dropped from ${beforeFiles.length} to ${afterFiles.length}`);
  }
  if (afterCases < beforeCases) {
    reasons.push(`test case count dropped from ${beforeCases} to ${afterCases}`);
  }
  for (const addition of additions) reasons.push(`new skip or only: ${addition}`);
  return {
    ok: reasons.length === 0,
    reasons,
    beforeFiles: beforeFiles.length,
    afterFiles: afterFiles.length,
    beforeCases,
    afterCases,
  };
}

function skipOnlyAdditions(repo, base) {
  const result = git(repo, ['diff', '-U0', base]);
  if (result.status !== 0) {
    throw new Error((result.stderr || 'git diff failed').trim());
  }
  const hits = [];
  let file = '';
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice('+++ b/'.length).replaceAll('\\', '/');
      continue;
    }
    if (!isSpec(file)) continue;
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (SKIP_ONLY_RE.test(line)) hits.push(`${file}: ${line.slice(1).trim()}`);
  }
  return hits;
}
