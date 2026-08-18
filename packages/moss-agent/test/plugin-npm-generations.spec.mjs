#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InstalledPluginRegistry } from '../dist/plugins/installed-plugin-registry.js';

test('npm candidates use isolated immutable roots and a failed candidate leaves the registry last-good', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moss npm generations 配置 '));
  const bin = path.join(root, 'fake npm bin');
  const configDir = path.join(root, 'config with spaces 配置');
  await mkdir(bin, { recursive: true });
  const fakeNpm = path.join(bin, 'fake-npm.mjs');
  await writeFile(
    fakeNpm,
    `import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
const source = args.at(-1);
const name = source.slice(0, source.lastIndexOf('@'));
const version = source.slice(source.lastIndexOf('@') + 1);
const packageRoot = path.join(prefix, 'node_modules', ...name.split('/'));
await mkdir(packageRoot, { recursive: true });
await writeFile(path.join(packageRoot, 'moss.plugin.json'), JSON.stringify({
  schemaVersion: 1,
  id: name.replaceAll('_', '-'),
  version,
  runtime: { module: './plugin.mjs' }
}));
await writeFile(path.join(packageRoot, 'plugin.mjs'), name.includes('bad') || (name.includes('recover') && version === '2.0.0')
  ? "await new Promise(() => {}); export default { id: 'fixture-npm-bad', setup() {} };\\n"
  : \`export default { id: \${JSON.stringify(name.replaceAll('_', '-'))}, setup() {} };\\n\`);
`
  );
  const npmCommand = path.join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (process.platform === 'win32') {
    await writeFile(npmCommand, `@"${process.execPath}" "%~dp0\\fake-npm.mjs" %*\r\n`);
  } else {
    await writeFile(npmCommand, `#!${process.execPath}\nimport './fake-npm.mjs';\n`);
    await chmod(npmCommand, 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;
  try {
    const registry = new InstalledPluginRegistry({ configDir, setupTimeoutMs: 75 });
    const first = await registry.add('fixture_npm_one@1.0.0');
    const second = await registry.add('fixture_npm_two@1.0.0');
    assert.notEqual(first.root, second.root);
    assert.match(first.root, /npm[/\\]versions/);
    assert.equal(
      (await readFile(path.join(first.root, 'moss.plugin.json'), 'utf8')).includes(
        'fixture-npm-one'
      ),
      true
    );
    await registry.add('fixture_npm_bad@1.0.0');
    await registry.enable('fixture-npm-bad');
    const isolated = await registry.loadEnabled();
    assert.equal(
      isolated.plugins.some(({ id }) => id === 'fixture-npm-bad'),
      false
    );
    assert.match(
      isolated.failures.find(({ id }) => id === 'fixture-npm-bad')?.message ?? '',
      /timed out/
    );

    const original = await registry.add('fixture_npm_upgrade@1.0.0');
    await registry.enable('fixture-npm-upgrade');
    const candidate = await registry.add('fixture_npm_upgrade@2.0.0');
    assert.equal(candidate.version, '2.0.0');
    assert.equal(candidate.enabled, true);
    assert.equal(candidate.lastGood?.version, '1.0.0');
    assert.notEqual(candidate.root, original.root);
    const restored = await registry.rollback('fixture-npm-upgrade');
    assert.equal(restored.version, '1.0.0');
    assert.equal(restored.root, original.root);
    await assert.rejects(() => readFile(path.join(candidate.root, 'moss.plugin.json')), /ENOENT/);

    await registry.add('fixture_npm_recover@1.0.0');
    await registry.enable('fixture-npm-recover');
    await registry.add('fixture_npm_recover@2.0.0');
    const recovered = await registry.loadEnabled();
    assert.equal(
      recovered.plugins.some(({ id }) => id === 'fixture-npm-recover'),
      true
    );
    assert.match(
      recovered.failures.find(({ id }) => id === 'fixture-npm-recover')?.message ?? '',
      /last-good 1\.0\.0 was restored/
    );
    assert.equal(
      (await registry.list()).find(({ id }) => id === 'fixture-npm-recover')?.version,
      '1.0.0'
    );
    await Promise.all(recovered.plugins.map((plugin) => plugin.disposeCandidate?.()));
  } finally {
    process.env.PATH = previousPath;
  }
});
