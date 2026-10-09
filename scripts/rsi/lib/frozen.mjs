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
  return parseFrozenPatterns(fs.readFileSync(file, 'utf8'));
}

function parseFrozenPatterns(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/**
 * The base list is authoritative so a candidate cannot remove the entries that
 * protect this file or scripts/rsi/**. Current-only entries take effect too.
 */
export function loadFrozenPatternsForBase(repo, base, currentFile) {
  const current = loadFrozenPatterns(currentFile);
  const atBase = readAtRev(repo, base, '.rsi/frozen.txt');
  return [...new Set([...(atBase === null ? [] : parseFrozenPatterns(atBase)), ...current])];
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

function parsePackage(text, where) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${where} is not valid JSON`, { cause: error });
  }
}

const PROTECTED_SCRIPT_NAMES = new Set([
  'clean',
  'build',
  'typecheck',
  'lint',
  'format:check',
  'test',
  'smoke',
  'check',
  'verify',
]);

function scriptIsProtected(name) {
  return PROTECTED_SCRIPT_NAMES.has(name) || name.startsWith('rsi:') || name.startsWith('bench');
}

/**
 * G0 protects the gate and verification command graph from package.json retargeting.
 * New protected names are also rejected, because an `rsi:*` alias can otherwise
 * become a misleading alternate entry point.
 */
export function protectedScriptReport(repo, base) {
  const beforeText = readAtRev(repo, base, 'package.json');
  if (beforeText === null) throw new Error(`package.json is missing at ${base}`);
  const currentFile = path.join(repo, 'package.json');
  if (!fs.existsSync(currentFile)) {
    return { ok: false, reasons: ['package.json was removed'], changed: [] };
  }
  const before = parsePackage(beforeText, `${base}:package.json`).scripts ?? {};
  const after = parsePackage(fs.readFileSync(currentFile, 'utf8'), 'package.json').scripts ?? {};
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...names]
    .filter(scriptIsProtected)
    .filter((name) => before[name] !== after[name])
    .sort();
  return {
    ok: changed.length === 0,
    reasons: changed.map((name) => `protected package script changed: ${name}`),
    changed,
  };
}

function countCases(text) {
  if (!text) return 0;
  let count = 0;
  for (const line of text.split('\n')) {
    if (CASE_RE.test(line)) count += 1;
  }
  return count;
}

const ASSERTION_RE = /\b(?:assert(?:\s*\(|\s*\.)|expect\s*\()/;

function countAssertionLines(text) {
  if (!text) return 0;
  return text.split('\n').filter((line) => ASSERTION_RE.test(line)).length;
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
  let beforeAssertions = 0;
  let afterAssertions = 0;
  for (const file of beforeFiles) {
    const text = readAtRev(repo, base, file);
    beforeCases += countCases(text);
    beforeAssertions += countAssertionLines(text);
  }
  for (const file of afterFiles) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8');
    afterCases += countCases(text);
    afterAssertions += countAssertionLines(text);
  }
  const additions = skipOnlyAdditions(repo, base);
  const assertionRemovals = netAssertionRemovals(repo, base);
  const reasons = [];
  if (afterFiles.length < beforeFiles.length) {
    reasons.push(`test file count dropped from ${beforeFiles.length} to ${afterFiles.length}`);
  }
  if (afterCases < beforeCases) {
    reasons.push(`test case count dropped from ${beforeCases} to ${afterCases}`);
  }
  if (afterAssertions < beforeAssertions) {
    reasons.push(`assertion line count dropped from ${beforeAssertions} to ${afterAssertions}`);
  }
  for (const removal of assertionRemovals) {
    reasons.push(
      `assertion lines removed net in ${removal.file}: -${removal.removed} +${removal.added}`
    );
  }
  for (const addition of additions) reasons.push(`new skip or only: ${addition}`);
  return {
    ok: reasons.length === 0,
    reasons,
    beforeFiles: beforeFiles.length,
    afterFiles: afterFiles.length,
    beforeCases,
    afterCases,
    beforeAssertions,
    afterAssertions,
    assertionRemovals,
  };
}

function diffLines(repo, base) {
  const result = git(repo, ['diff', '-U0', base, '--', 'test']);
  if (result.status !== 0) {
    throw new Error((result.stderr || 'git diff failed').trim());
  }
  return result.stdout.split('\n');
}

function skipOnlyAdditions(repo, base) {
  const hits = [];
  let file = '';
  for (const line of diffLines(repo, base)) {
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

function netAssertionRemovals(repo, base) {
  const counts = new Map();
  let beforeFile = '';
  let afterFile = '';
  for (const line of diffLines(repo, base)) {
    if (line.startsWith('--- a/')) {
      beforeFile = line.slice('--- a/'.length).replaceAll('\\', '/');
      continue;
    }
    if (line.startsWith('+++ b/')) {
      afterFile = line.slice('+++ b/'.length).replaceAll('\\', '/');
      continue;
    }
    const file = isSpec(afterFile) ? afterFile : isSpec(beforeFile) ? beforeFile : '';
    if (!file || !ASSERTION_RE.test(line.slice(1))) continue;
    const count = counts.get(file) ?? { file, removed: 0, added: 0 };
    if (line.startsWith('-') && !line.startsWith('---')) count.removed += 1;
    if (line.startsWith('+') && !line.startsWith('+++')) count.added += 1;
    counts.set(file, count);
  }
  return [...counts.values()].filter((count) => count.removed > count.added);
}
