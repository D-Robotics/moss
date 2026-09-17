#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, matchesGlob, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const testDir = join(process.cwd(), 'test');

// Focused test routing: `--filter <pattern>` (repeatable) narrows the run to
// matching *.spec.mjs files so a single-change iteration does not need the
// whole suite. Patterns match by substring on the cwd-relative path or
// basename; patterns containing glob wildcards also try glob matching.
// Without --filter the runner keeps its historical full-suite behavior.
function parseFilters(argv) {
  const filters = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--filter') {
      const pattern = argv[i + 1];
      if (!pattern || pattern.startsWith('--')) {
        console.error('[test] --filter requires a pattern');
        process.exit(1);
      }
      filters.push(pattern);
      i += 1;
    } else if (arg.startsWith('--filter=')) {
      const pattern = arg.slice('--filter='.length);
      if (!pattern) {
        console.error('[test] --filter requires a pattern');
        process.exit(1);
      }
      filters.push(pattern);
    } else {
      console.error(`[test] unknown argument: ${arg} (expected --filter <pattern>)`);
      process.exit(1);
    }
  }
  return filters;
}

function matchesFilters(file, filters) {
  const relativePath = relative(process.cwd(), file);
  const name = basename(file);
  return filters.some((pattern) => {
    if (relativePath.includes(pattern) || name.includes(pattern)) return true;
    if (pattern.includes('*') || pattern.includes('?')) {
      try {
        return matchesGlob(relativePath, pattern) || matchesGlob(name, pattern);
      } catch {
        return false;
      }
    }
    return false;
  });
}

try {
  readdirSync(testDir);
} catch (err) {
  if (err && err.code === 'ENOENT') {
    console.error(`[test] missing test directory: ${testDir}`);
    process.exit(1);
  }
  throw err;
}

function collectTestFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(file));
    } else if (entry.isFile() && entry.name.endsWith('.spec.mjs')) {
      files.push(file);
    }
  }
  return files;
}

const testFilesAll = collectTestFiles(testDir).sort();

if (testFilesAll.length === 0) {
  console.error(`[test] no *.spec.mjs files found in ${testDir}`);
  process.exit(1);
}

const filters = parseFilters(process.argv.slice(2));
const testFiles =
  filters.length === 0
    ? testFilesAll
    : testFilesAll.filter((file) => matchesFilters(file, filters));

if (testFiles.length === 0) {
  console.error(`[test] no *.spec.mjs matched filter: ${filters.join(', ')}`);
  console.error(`[test] available files: ${testFilesAll.length} under ${testDir}`);
  process.exit(1);
}

// Tests import the built `dist/`; wait until a build that may still be running
// from the test script's build-first step has settled.
function distSnapshot(dir) {
  if (!existsSync(dir)) return null;
  const stack = [dir];
  let count = 0;
  let bytes = 0;
  let latestMtime = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = statSync(file);
      count += 1;
      bytes += stat.size;
      latestMtime = Math.max(latestMtime, stat.mtimeMs);
    }
  }
  return `${count}:${bytes}:${Math.round(latestMtime)}`;
}

async function waitForStableDist() {
  const dir = join(process.cwd(), 'dist');
  const deadline = Date.now() + 5_000;
  let previous = null;
  while (Date.now() < deadline) {
    const snapshot = distSnapshot(dir);
    if (snapshot) {
      if (snapshot === previous) return;
      previous = snapshot;
    } else {
      previous = null;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
}

await waitForStableDist();

// Pin an English locale for child specs. Many specs assert hardcoded English
// CLI strings; on a Chinese developer shell (LANG=zh_CN.UTF-8) the CLI
// localizes to Chinese and those assertions fail even though the code is
// correct. Specs that need a specific locale set it themselves.
const testEnv = {
  ...process.env,
  LANG: 'C',
  LC_ALL: 'C',
  LC_MESSAGES: 'C',
};

for (const file of testFiles) {
  console.error(`[test] ${file}`);
  const result = spawnSync(process.execPath, [file], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: testEnv,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.error(
  `[test] passed ${testFiles.length} file(s)` +
    (filters.length > 0 ? ` (filter: ${filters.join(', ')})` : '')
);
