#!/usr/bin/env node
/**
 * O100: on an old Node, npm prints its EBADENGINE warnings before preinstall
 * runs and replays the preinstall stderr as `npm error` lines at the end. The
 * Node upgrade command and the Moss reinstall command must both sit in the
 * last 20 lines of the install output, after every EBADENGINE line.
 *
 * The fixture is packed with `npm pack` and installed with `npm i -g <tgz>`
 * into a temp prefix. Its engines range is out of reach so npm warns on any
 * Node; MOSS_TEST_FAKE_NODE_VERSION makes the copied gate script fail.
 * The fixture has no dependencies, so nothing is downloaded.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const TAIL = 20;
const UPGRADE = /nvm install 22 && nvm use 22/;
const REINSTALL = /npm install -g @rdk-moss\/agent@latest/;

assert.equal(pkg.engines.node, '>=22.16.0');

function runNpm(args, cwd, env) {
  const npmCli = process.env.npm_execpath;
  const options = { cwd, env, encoding: 'utf8', timeout: 60_000 };
  if (npmCli && /npm-cli\.[cm]?js$/.test(npmCli)) {
    return spawnSync(process.execPath, [npmCli, ...args], options);
  }
  return spawnSync('npm', args, { ...options, shell: process.platform === 'win32' });
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o100-')));
const project = path.join(root, 'project');
const prefix = path.join(root, 'prefix');
const home = path.join(root, 'home');
for (const dir of [path.join(project, 'bin'), path.join(project, 'scripts'), prefix, home]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(path.join(home, '.npmrc'), '');
fs.writeFileSync(path.join(home, 'etc-npmrc'), '');
fs.copyFileSync(
  path.join(repoRoot, 'scripts', 'check-node-version.cjs'),
  path.join(project, 'scripts', 'check-node-version.cjs')
);
fs.writeFileSync(path.join(project, 'bin', 'moss.cjs'), '#!/usr/bin/env node\n');
fs.writeFileSync(
  path.join(project, 'package.json'),
  JSON.stringify({
    name: 'moss-o100-fixture',
    version: '0.0.0',
    bin: { moss: 'bin/moss.cjs' },
    files: ['bin', 'scripts/check-node-version.cjs'],
    engines: { node: '>=999.0.0' },
    scripts: { preinstall: pkg.scripts.preinstall },
  })
);

function envFor(lang) {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    LANG: lang,
    TMPDIR: os.tmpdir(),
    TEMP: process.env.TEMP || os.tmpdir(),
    TMP: process.env.TMP || os.tmpdir(),
    npm_config_cache: path.join(root, 'cache'),
    npm_config_userconfig: path.join(home, '.npmrc'),
    npm_config_globalconfig: path.join(home, 'etc-npmrc'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_color: 'false',
    MOSS_TEST_FAKE_NODE_VERSION: '20.19.2',
  };
  for (const key of ['Path', 'SystemRoot', 'PATHEXT', 'COMSPEC', 'npm_execpath']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

try {
  const packed = runNpm(['pack', '--pack-destination', root], project, envFor('C'));
  if (packed.error && packed.error.code === 'ENOENT') {
    console.log('[SKIP] O100 install tail: npm is not on PATH');
    process.exit(0);
  }
  assert.equal(packed.status, 0, packed.stderr);
  const tgz = path.join(root, 'moss-o100-fixture-0.0.0.tgz');
  assert.ok(fs.existsSync(tgz));

  for (const [lang, lead] of [
    ['en_US.UTF-8', /Next steps/],
    ['zh_CN.UTF-8', /下一步/],
  ]) {
    const result = runNpm(
      ['install', '-g', tgz, '--prefix', prefix, '--offline', '--no-audit', '--no-fund'],
      root,
      envFor(lang)
    );
    // Terminal order: npm writes everything here to stderr.
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.notEqual(result.status, 0, output);
    const lines = output.replace(/\s+$/, '').split(/\r?\n/);
    const lastEngine = lines.findLastIndex((line) => /EBADENGINE/.test(line));
    assert.ok(lastEngine >= 0, `fixture should trigger EBADENGINE:\n${output}`);
    const tail = lines.slice(-TAIL);
    const start = lines.length - tail.length;
    const at = (re) => start + tail.findIndex((line) => re.test(line));
    for (const re of [lead, UPGRADE, REINSTALL]) {
      assert.ok(
        tail.some((line) => re.test(line)),
        `${re} not in last ${TAIL} lines:\n${output}`
      );
      assert.ok(at(re) > lastEngine, `${re} should follow EBADENGINE:\n${output}`);
    }
    assert.ok(at(REINSTALL) > at(UPGRADE), 'reinstall comes after the Node upgrade');
    assert.doesNotMatch(output, /engine-strict=false|--force/);
  }
  console.log('[PASS] O100 upgrade + reinstall in install tail');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
