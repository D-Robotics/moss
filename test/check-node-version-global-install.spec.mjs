#!/usr/bin/env node
/**
 * `npm install -g --install-links .` ignores the project `.npmrc`, so
 * engine-strict does not stop it. npm packs the folder and runs `prepare`
 * before it links the global bin. The prepare script runs
 * scripts/check-node-version.cjs first. MOSS_TEST_FAKE_NODE_VERSION is read
 * only by that script, so this stays on the real Node and does not download
 * dependencies.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const FAKE_VERSION = '20.19.2';
const SHIM_NAMES = new Set(['moss', 'moss.cmd', 'moss.ps1']);

assert.equal(pkg.scripts.preinstall, 'node scripts/check-node-version.cjs');
assert.equal(pkg.scripts.prepare, 'node scripts/check-node-version.cjs && npm run build');

function makeTemp(name) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
}

function findShims(dir) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return found;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (SHIM_NAMES.has(entry.name)) found.push(full);
    if (entry.isDirectory()) found.push(...findShims(full));
  }
  return found;
}

function runNpm(args, cwd, env) {
  const npmCli = process.env.npm_execpath;
  const options = { cwd, env, encoding: 'utf8', timeout: 60_000 };
  if (npmCli && /npm-cli\.[cm]?js$/.test(npmCli)) {
    return spawnSync(process.execPath, [npmCli, ...args], options);
  }
  return spawnSync('npm', args, { ...options, shell: process.platform === 'win32' });
}

const root = makeTemp('moss-node-gate-');
const project = path.join(root, 'project');
const prefix = path.join(root, 'prefix');
const home = path.join(root, 'home');
fs.mkdirSync(path.join(project, 'bin'), { recursive: true });
fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
fs.mkdirSync(prefix, { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, '.npmrc'), '');
fs.writeFileSync(path.join(home, 'etc-npmrc'), '');
fs.writeFileSync(path.join(project, '.npmrc'), 'engine-strict=true\n');
fs.copyFileSync(
  path.join(repoRoot, 'scripts', 'check-node-version.cjs'),
  path.join(project, 'scripts', 'check-node-version.cjs')
);
fs.writeFileSync(
  path.join(project, 'bin', 'moss.cjs'),
  '#!/usr/bin/env node\nconsole.log("fixture");\n'
);
fs.writeFileSync(
  path.join(project, 'package.json'),
  JSON.stringify({
    name: 'moss-node-gate-fixture',
    version: '0.0.0',
    private: true,
    bin: { moss: 'bin/moss.cjs' },
    files: ['bin', 'scripts/check-node-version.cjs'],
    engines: { node: '>=22.16.0' },
    scripts: {
      preinstall: pkg.scripts.preinstall,
      prepare: pkg.scripts.prepare,
    },
  })
);

const env = {
  PATH: process.env.PATH ?? '',
  HOME: home,
  USERPROFILE: home,
  LANG: 'C',
  LC_ALL: 'C',
  TMPDIR: os.tmpdir(),
  TEMP: process.env.TEMP || os.tmpdir(),
  TMP: process.env.TMP || os.tmpdir(),
  npm_config_cache: path.join(root, 'cache'),
  npm_config_prefix: prefix,
  npm_config_userconfig: path.join(home, '.npmrc'),
  npm_config_globalconfig: path.join(home, 'etc-npmrc'),
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  MOSS_TEST_FAKE_NODE_VERSION: FAKE_VERSION,
};
if (process.env.Path) env.Path = process.env.Path;
if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
if (process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT;
if (process.env.COMSPEC) env.COMSPEC = process.env.COMSPEC;
if (process.env.npm_execpath) env.npm_execpath = process.env.npm_execpath;

try {
  const result = runNpm(
    [
      'install',
      '-g',
      '--install-links',
      '.',
      '--prefix',
      prefix,
      '--offline',
      '--ignore-scripts=false',
      '--no-audit',
      '--no-fund',
    ],
    project,
    env
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.error && result.error.code === 'ENOENT') {
    console.log('[SKIP] check-node-version global install: npm is not on PATH');
    process.exit(0);
  }
  const offline = /ENOTCACHED|EAI_AGAIN|ENOTFOUND|getaddrinfo|registry\.npmjs\.org/i.test(output);
  if (result.status !== 0 && !output.includes(FAKE_VERSION) && offline) {
    console.log('[SKIP] check-node-version global install: npm needed the network while offline');
    process.exit(0);
  }
  assert.notEqual(result.status, 0, output);
  assert.match(output, /Node 20\.19\.2/);
  assert.match(
    output,
    /curl -o- https:\/\/raw\.githubusercontent\.com\/nvm-sh\/nvm\/v0\.40\.3\/install\.sh/
  );
  assert.match(output, /nvm install 22 && nvm use 22/);
  assert.match(output, /curl -fsSL https:\/\/fnm\.vercel\.app\/install/);
  assert.match(output, /fnm install 22 && fnm use 22/);
  assert.match(output, /winget install OpenJS\.NodeJS\.LTS/);
  assert.match(output, /winget install Schniz\.fnm/);
  assert.deepEqual(findShims(prefix), []);
  console.log('[PASS] check-node-version global install');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
