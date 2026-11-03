#!/usr/bin/env node
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, matchesGlob, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createTestRunRoot, listMossTempHomes } from '../test/helpers/temp-home.mjs';

const testDir = join(process.cwd(), 'test');

// Focused test routing: `--filter <pattern>` (repeatable) narrows the run to
// matching *.spec.mjs files so a single-change iteration does not need the
// whole suite. Patterns match by substring on the cwd-relative path or
// basename; patterns containing glob wildcards also try glob matching.
// `--jobs N` runs spec files through a worker pool (default 1 keeps the
// historical sequential semantics).
function parseArgs(argv) {
  const filters = [];
  let jobs = 1;
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
    } else if (arg === '--jobs') {
      const raw = argv[i + 1];
      if (!raw || Number.isNaN(Number(raw)) || !Number.isInteger(Number(raw)) || Number(raw) < 1) {
        console.error('[test] --jobs requires a positive integer');
        process.exit(1);
      }
      jobs = Number(raw);
      i += 1;
    } else if (arg.startsWith('--jobs=')) {
      const raw = arg.slice('--jobs='.length);
      if (Number.isNaN(Number(raw)) || !Number.isInteger(Number(raw)) || Number(raw) < 1) {
        console.error('[test] --jobs requires a positive integer');
        process.exit(1);
      }
      jobs = Number(raw);
    } else {
      console.error(`[test] unknown argument: ${arg} (expected --filter <pattern> or --jobs <n>)`);
      process.exit(1);
    }
  }
  return { filters, jobs };
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

const { filters, jobs } = parseArgs(process.argv.slice(2));
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
const runRoot = createTestRunRoot(tmpdir());
let runRootRemoved = false;
function removeRunRoot() {
  if (runRootRemoved) return;
  runRootRemoved = true;
  rmSync(runRoot, { recursive: true, force: true });
}
process.on('exit', removeRunRoot);

const testEnv = {
  ...process.env,
  LANG: 'C',
  LC_ALL: 'C',
  LC_MESSAGES: 'C',
  TMPDIR: runRoot,
  TMP: runRoot,
  TEMP: runRoot,
};

// Specs are async children so SIGINT/SIGTERM can stop the current spec and
// delete this run's temp root on the way out.
const activeChildren = new Set();
const completedFiles = new Array(testFiles.length).fill(false);
let nextFileIndex = 0;
let shuttingDown = false;

// O149: an interrupted run names every spec that did not finish.
function reportNotRun() {
  const notRun = testFiles.filter((_, index) => !completedFiles[index]);
  if (notRun.length === 0) return;
  console.error(`[test] interrupted: ${notRun.length} file(s) did not run to completion:`);
  for (const file of notRun) console.error(`  ${file}`);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  reportNotRun();
  const children = [...activeChildren];
  for (const child of children) child.kill('SIGTERM');
  if (children.length === 0) {
    process.exit(code);
    return;
  }
  const exitWhenChildrenClose = () => {
    if (activeChildren.size === 0) process.exit(code);
  };
  for (const child of children) child.once('close', exitWhenChildrenClose);
  setTimeout(() => {
    for (const child of [...activeChildren]) child.kill('SIGKILL');
  }, 2000).unref();
}

process.on('SIGINT', () => {
  shutdown(130);
});
process.on('SIGTERM', () => {
  shutdown(143);
});

function runSpec(file) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [file], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: testEnv,
    });
    activeChildren.add(child);
    child.on('error', (err) => {
      activeChildren.delete(child);
      console.error(`[test] failed to start ${file}: ${err instanceof Error ? err.message : err}`);
      resolve({ status: 1, durationMs: Date.now() - startedAt });
    });
    child.on('close', (status) => {
      activeChildren.delete(child);
      resolve({ status, durationMs: Date.now() - startedAt });
    });
  });
}

function leakedHomes() {
  return listMossTempHomes(runRoot);
}

function reportLeaks() {
  const leaked = leakedHomes();
  if (leaked.length === 0) return 0;
  console.error(`[test] leaked ${leaked.length} moss temp home(s):`);
  for (const dir of leaked) console.error(`  ${dir}`);
  return 1;
}

// O149 (QA #145 F1): no fail-fast, locally or under CI. A red portability
// spec that sorts early (e.g. `exec-git-config` on Windows) used to stop a
// local run before the safety specs ran. Telling safety specs apart by file
// name missed most of them (o151/o153/o158/safe-child-env/permission-rules/…),
// so every file runs and the failures are summarized at the end with a
// non-zero exit. If the run is interrupted, every file that did not run is
// listed by name, so a skipped spec is never silent.
const results = new Array(testFiles.length).fill(null);

async function worker() {
  while (!shuttingDown) {
    const index = nextFileIndex;
    nextFileIndex += 1;
    if (index >= testFiles.length) return;
    const file = testFiles[index];
    console.error(`[test] ${file}`);
    const result = await runSpec(file);
    if (shuttingDown) return;
    results[index] = result;
    completedFiles[index] = true;
    console.error(`[test] ${file} finished in ${result.durationMs}ms`);
  }
}

if (jobs > 1) console.error(`[test] running ${testFiles.length} file(s) with jobs=${jobs}`);
await Promise.all(Array.from({ length: Math.min(jobs, testFiles.length) }, () => worker()));

const failedFiles = results
  .map((result, index) => ({ result, index }))
  .filter(({ result }) => result !== null && result.status !== 0)
  .map(({ result, index }) => ({ file: testFiles[index], status: result.status }));

if (failedFiles.length > 0) {
  console.error(`[test] ${failedFiles.length} of ${testFiles.length} file(s) failed:`);
  for (const { file, status } of failedFiles)
    console.error(`  ${file} (exit ${status ?? 'signal'})`);
  const leakStatus = reportLeaks();
  process.exit(failedFiles[0].status ?? (leakStatus || 1));
}

const slowest = results
  .map((result, index) => ({ file: testFiles[index], durationMs: result?.durationMs ?? 0 }))
  .sort((a, b) => b.durationMs - a.durationMs)
  .slice(0, 5);
if (slowest.length > 0) {
  console.error('[test] slowest specs:');
  for (const { file, durationMs } of slowest)
    console.error(`  ${durationMs}ms ${relative(process.cwd(), file)}`);
}

const leakStatus = reportLeaks();
if (leakStatus !== 0) process.exit(leakStatus);

console.error(
  `[test] passed ${testFiles.length} file(s)` +
    (filters.length > 0 ? ` (filter: ${filters.join(', ')})` : '') +
    (jobs > 1 ? ` (jobs: ${jobs})` : '')
);
