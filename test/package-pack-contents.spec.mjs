#!/usr/bin/env node
/**
 * The publishable tarball holds only package.json, README.md, LICENSE, the
 * package bin paths, the built .js / .d.ts files, and any file a package.json
 * lifecycle hook runs with `node <path>`. No tests, other scripts, workspace
 * state, env files, source maps, or key material.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Hooks npm runs inside the unpacked package (`npm install -g` of the tarball).
 * `prepare`, `prepublishOnly`, and `test` run in the source tree and are not
 * packed. `build` is not a hook.
 */
const LIFECYCLE_HOOKS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'preuninstall',
  'uninstall',
  'postuninstall',
]);

/**
 * Relative files a lifecycle hook executes via `node <path>`. Inline
 * `node -e` / `--eval` / `-p` are not files. `npm run <name>` is not expanded.
 */
function lifecycleNodeScripts(pkg) {
  const scripts = pkg.scripts ?? {};
  const paths = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (!LIFECYCLE_HOOKS.has(name) || typeof command !== 'string') continue;
    const re = /(?:^|&&|\|\||;)\s*node\s+(?!(?:-e|--eval|-p)\b)(\S+)/g;
    for (const match of command.matchAll(re)) {
      const rel = match[1].replaceAll('\\', '/').replace(/^\.\//, '');
      if (!rel.startsWith('-')) paths.push(rel);
    }
  }
  return [...new Set(paths)];
}

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const lifecycleScripts = lifecycleNodeScripts(pkgJson);

// npm runs `prepare` (a clean rebuild of dist/) before packing, even with
// --ignore-scripts, so this checks what a publish would actually ship.
const packArgs = ['pack', '--dry-run', '--json'];
const npmCli = process.env.npm_execpath;
const result =
  npmCli && /npm-cli\.[cm]?js$/.test(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...packArgs], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 120_000,
      })
    : spawnSync('npm', packArgs, {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 120_000,
        shell: process.platform === 'win32',
      });
assert.equal(result.status, 0, `npm pack --dry-run failed:\n${result.stderr}`);

const report = JSON.parse(result.stdout);
assert.ok(Array.isArray(report) && report.length === 1, 'one package in the pack report');
const [entry] = report;
assert.equal(entry.name, '@rdk-moss/agent');
const files = entry.files.map((file) => file.path.replace(/\\/g, '/'));
assert.equal(files.length, entry.entryCount);

const forbidden = [
  [/^test\//, 'test/'],
  [/^scripts\//, 'scripts/'],
  [/(^|\/)\.moss(\/|$)/, '.moss/'],
  [/(^|\/)\.env/, '.env*'],
  [/\.map$/, '*.map'],
  [/\.(pem|key|p12|pfx|crt|der|keystore|jks|gpg|asc)$/i, 'key or certificate file'],
  [/(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/, 'ssh key'],
  [/(^|\/)\.(npmrc|netrc|pgpass)$/, 'credential config'],
  [/(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i, 'credentials file'],
];
for (const file of files) {
  for (const [pattern, label] of forbidden) {
    if (label === 'scripts/' && lifecycleScripts.includes(file)) continue;
    assert.doesNotMatch(file, pattern, `${file} is packed (${label})`);
  }
}

assert.ok(
  lifecycleScripts.includes('scripts/check-node-version.cjs'),
  'preinstall runs scripts/check-node-version.cjs'
);
const binField = pkgJson.bin;
const binPaths = (typeof binField === 'string' ? [binField] : Object.values(binField ?? {})).map(
  (binPath) => {
    assert.equal(typeof binPath, 'string');
    return binPath.replaceAll('\\', '/');
  }
);
assert.ok(binPaths.length > 0, 'package.json bin declares at least one path');

const allowed = (file) =>
  file === 'package.json' ||
  file === 'README.md' ||
  file === 'LICENSE' ||
  file === 'dist/utils/build-stamp.json' ||
  lifecycleScripts.includes(file) ||
  binPaths.includes(file) ||
  file.startsWith('bin/') ||
  (file.startsWith('dist/') && (file.endsWith('.js') || file.endsWith('.d.ts')));
assert.deepEqual(
  files.filter((file) => !allowed(file)),
  [],
  'only package.json, README.md, LICENSE, lifecycle hook scripts, package bin paths, dist/utils/build-stamp.json, and dist/**/*.{js,d.ts}'
);
assert.ok(files.includes('dist/utils/build-stamp.json'), 'build stamp is packed');
assert.ok(files.includes('dist/cli.js'), 'ESM CLI is packed');
assert.ok(files.includes('bin/moss.cjs'), 'CJS Node pre-check bin is packed');
assert.ok(
  files.includes('bin/node-version-message.cjs'),
  'shared node version message is packed'
);
assert.ok(files.includes('dist/index.js'), 'SDK entry is packed');
assert.ok(files.includes('dist/index.d.ts'), 'SDK types are packed');

for (const binPath of binPaths) {
  assert.ok(files.includes(binPath), `bin script ${binPath} is packed`);
}
for (const rel of lifecycleScripts) {
  assert.ok(files.includes(rel), `lifecycle hook script ${rel} is packed`);
}

const keyLike = [
  [
    /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
    'private key',
  ],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/, 'sk- API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, 'GitHub fine-grained token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token'],
];
for (const file of files) {
  const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  for (const [pattern, label] of keyLike) {
    const match = text.match(pattern);
    assert.equal(match, null, `${file} contains something shaped like a ${label}: ${match?.[0]}`);
  }
}

console.log(
  `[PASS] npm pack contents: ${files.length} files, ${entry.size} bytes packed, ${entry.unpackedSize} unpacked`
);
