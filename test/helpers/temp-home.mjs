/**
 * Temporary HOME directories created by specs and TUI probes.
 * The leak fingerprint is `.config/moss/config.json`. `trackTempDir` removes
 * a directory when the spec process exits, including `process.exit`.
 *
 * The suite runner gives every spec its own temp root and only scans that
 * root. A shared /tmp is not walked, so another user's moss homes are not
 * this run's leaks.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tracked = new Set();
let hooked = false;

function removeTracked() {
  for (const dir of tracked) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // The suite check reports anything that is still on disk.
    }
  }
}

/** Remember `dir` and delete it on process exit. Returns `dir`. */
export function trackTempDir(dir) {
  if (!hooked) {
    hooked = true;
    process.on('exit', removeTracked);
  }
  tracked.add(dir);
  return dir;
}

/** Prefix of one `npm test` temp root. Stale roots from a killed run live here. */
export const TEST_RUN_PREFIX = 'moss-test-run-';

/** A killed run's temp root is swept once it has been idle this long. */
export const STALE_TEST_RUN_MS = 60 * 60 * 1000;

/** Prefixes of temp HOMEs (and the workspace dirs created next to them). */
export const MOSS_TEMP_HOME_PREFIXES = [
  'moss-screen-home-',
  'moss-screen-ws-',
  'moss-inline-exit-home-',
  'moss-inline-exit-ws-',
  'moss-mcp-layout-home-',
  'moss-mcp-layout-ws-',
  'moss-cli-spec-',
  'moss-lang-',
  'moss-e2e-',
  'moss-scope-',
  'moss-print-redact-',
  'moss-doctor-home-',
  'moss-doctor-zh-',
  'moss-once-home-',
  'moss-once-zh-',
  'moss-feel-home-',
  'moss-feel-ws-',
  'moss-real-home-',
  'moss-real-ws-',
  'moss-egress-',
  'moss-npmrc-',
  'moss-config-mode-',
  'moss-notice-',
  'moss-save-key-',
];

function markerHome(dir) {
  return fs.existsSync(path.join(dir, '.config', 'moss', 'config.json'));
}

function matchesPrefix(name) {
  return MOSS_TEMP_HOME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Moss temp homes directly under `root` (this run's TMPDIR). A directory
 * counts when it holds `.config/moss/config.json` or its name is one of the
 * known prefixes. Nested homes one level under a `moss-*` directory count too.
 */
export function listMossTempHomes(root = os.tmpdir()) {
  const found = new Set();
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  for (const name of names) {
    const dir = path.join(root, name);
    let isDir;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (markerHome(dir) || matchesPrefix(name)) found.add(dir);
    if (!name.startsWith('moss-')) continue;
    let children;
    try {
      children = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const child of children) {
      const nested = path.join(dir, child);
      if (markerHome(nested)) found.add(nested);
    }
  }
  return [...found].sort();
}

/**
 * Remove `moss-test-run-*` directories under `parent` that have not changed
 * for an hour. The current run's root is fresh, so it stays.
 */
export function sweepStaleTestRuns(parent, now = Date.now(), maxAgeMs = STALE_TEST_RUN_MS) {
  const removed = [];
  let names;
  try {
    names = fs.readdirSync(parent);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(TEST_RUN_PREFIX)) continue;
    const dir = path.join(parent, name);
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (now - stat.mtimeMs < maxAgeMs) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

/** A private temp root for one test run, after sweeping killed runs. */
export function createTestRunRoot(parent = os.tmpdir()) {
  sweepStaleTestRuns(parent);
  return fs.mkdtempSync(path.join(parent, TEST_RUN_PREFIX));
}
