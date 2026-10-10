#!/usr/bin/env node
/**
 * `moss update` prints the upgrade command for a git clone or an npm install.
 * It does not run that command. The package stays private and publishable.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  adviseMossUpdate,
  githubInstallSpec,
  npmInstallSpec,
  LEGACY_PACKAGE_UNINSTALL,
  parseUpdateArgs,
  renderUpdateAdvice,
  sourceInstallCommands,
  UPGRADE_IN_CLONE,
  upgradeCommand,
} from '../dist/cli/update-command.js';
import { isolatedCliEnv } from './helpers/isolated-cli-env.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'dist', 'cli.js');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const repo = { url: 'git+https://github.com/D-Robotics/moss.git' };

{
  assert.equal(pkg.name, '@rdk-moss/agent');
  assert.equal(pkg.private, true);
  assert.equal(typeof pkg.bin.moss, 'string');
  const binPath = pkg.bin.moss.replaceAll('\\', '/');
  assert.ok(fs.existsSync(path.join(repoRoot, binPath)), binPath);
  assert.ok(
    pkg.files.some((entry) => entry === binPath || binPath.startsWith(`${entry}/`)),
    `files must include the bin path ${binPath}`
  );
  assert.equal(pkg.engines.node, '>=22.16.0');
  assert.equal(pkg.scripts.preinstall, 'node scripts/check-node-version.cjs');
  assert.ok(pkg.files.includes('scripts/check-node-version.cjs'));
  assert.equal(pkg.scripts.prepare, 'npm run build');
  assert.equal(pkg.scripts.prepublishOnly, 'npm run build && npm run verify');
  assert.equal(pkg.publishConfig.access, 'public');
  assert.equal(githubInstallSpec(pkg.repository), 'github:D-Robotics/moss');
  assert.equal(npmInstallSpec(pkg), null);
  assert.equal(
    npmInstallSpec({ private: false, name: '@rdk-moss/agent' }),
    '@rdk-moss/agent@latest'
  );
  assert.equal(githubInstallSpec('git@github.com:D-Robotics/moss.git'), 'github:D-Robotics/moss');
  assert.deepEqual(sourceInstallCommands(pkg.repository), [
    'git clone https://github.com/D-Robotics/moss.git',
    'cd moss',
    'npm ci',
    'npm install -g --install-links .',
  ]);
  assert.equal(
    UPGRADE_IN_CLONE,
    'cd moss && git pull && npm ci && npm install -g --install-links .'
  );
  assert.equal(
    upgradeCommand('/tmp/moss-clone'),
    UPGRADE_IN_CLONE.replace('cd moss', 'cd /tmp/moss-clone')
  );
  assert.deepEqual(sourceInstallCommands(undefined), sourceInstallCommands(pkg.repository));
  assert.equal(LEGACY_PACKAGE_UNINSTALL, 'npm uninstall -g moss');
}

{
  const root = '/tmp/moss-clone';
  const advice = adviseMossUpdate({
    packageRoot: root,
    pkg: { private: true, name: '@rdk-moss/agent', repository: repo },
    exists: (target) => target === path.join(root, '.git'),
  });
  assert.equal(advice.kind, 'git-clone');
  assert.equal(advice.commands[0], upgradeCommand(root));
  const text = renderUpdateAdvice(advice, false);
  assert.match(text, /git clone/);
  assert.match(text, /npm install -g --install-links \./);
  assert.match(text, /--force/);
  assert.match(text, /does not run it/);
  assert.doesNotMatch(text, /git clone https:/);
  assert.doesNotMatch(text, /npm run build/);
  const zh = renderUpdateAdvice(advice, true);
  assert.match(zh, /git 克隆/);
  assert.match(zh, /--force/);
  assert.match(zh, /不会执行/);
}

{
  const root = path.join('/usr', 'lib', 'node_modules', '@rdk-moss', 'agent');
  const advice = adviseMossUpdate({
    packageRoot: root,
    pkg: { private: true, repository: repo },
    exists: () => false,
  });
  assert.equal(advice.kind, 'npm-global');
  assert.deepEqual(advice.commands, sourceInstallCommands(repo));
  const text = renderUpdateAdvice(advice, false);
  assert.match(text, /npm global install/);
  assert.match(text, /npm install -g --install-links \./);
  assert.match(text, /EEXIST/);
  assert.match(text, /--force/);
  assert.match(text, /npm uninstall -g moss/);
  assert.match(text, /No moss clone/);
  assert.match(text, /does not run it/);
  assert.doesNotMatch(text, /github:/);
  const zh = renderUpdateAdvice(advice, true);
  assert.match(zh, /EEXIST/);
  assert.match(zh, /--force/);
  assert.match(zh, /npm uninstall -g moss/);
  assert.match(zh, /不会执行/);
}

{
  const root = path.join('/work', 'app', 'node_modules', '@rdk-moss', 'agent');
  const advice = adviseMossUpdate({
    packageRoot: root,
    pkg: { private: false, name: '@rdk-moss/agent' },
    exists: (target) => target === path.join('/work', 'app', 'package.json'),
  });
  assert.equal(advice.kind, 'npm-local');
  assert.equal(advice.commands[0], 'npm install @rdk-moss/agent@latest');
}

{
  const advice = adviseMossUpdate({
    packageRoot: '/opt/moss',
    pkg: { private: true, repository: repo },
    exists: () => false,
  });
  assert.equal(advice.kind, 'unknown');
  assert.deepEqual(advice.commands, sourceInstallCommands(repo));
  assert.match(renderUpdateAdvice(advice, false), /npm uninstall -g moss/);
  assert.match(renderUpdateAdvice(advice, false), /--force/);
  assert.doesNotMatch(advice.commands[0], /git -C/);
}

{
  const quoted = adviseMossUpdate({
    packageRoot: '/tmp/moss clone',
    pkg,
    exists: (target) => target === path.join('/tmp/moss clone', '.git'),
  });
  assert.equal(
    quoted.commands[0],
    "cd '/tmp/moss clone' && git pull && npm ci && npm install -g --install-links ."
  );
}

{
  const clone = path.join('/work', 'moss');
  const root = path.join('/usr', 'lib', 'node_modules', '@rdk-moss', 'agent');
  const advice = adviseMossUpdate({
    packageRoot: root,
    pkg: { private: true, repository: repo },
    cwd: '/work',
    exists: (target) => target === path.join(clone, '.git'),
    readPackage: (dir) =>
      dir === clone ? { name: '@rdk-moss/agent', bin: { moss: 'dist/cli.js' } } : {},
  });
  assert.equal(advice.kind, 'git-clone');
  assert.equal(advice.root, clone);
  assert.equal(advice.commands[0], upgradeCommand(clone));
  assert.doesNotMatch(advice.commands.join('\n'), /git clone https:/);
}

{
  const elsewhere = '/opt/moss-src';
  const root = path.join('/usr', 'lib', 'node_modules', '@rdk-moss', 'agent');
  const advice = adviseMossUpdate({
    packageRoot: root,
    pkg: { private: true, repository: repo },
    cwd: '/tmp',
    sourceDir: elsewhere,
    exists: (target) => target === path.join(elsewhere, '.git'),
    readPackage: (dir) => (dir === elsewhere ? { name: '@rdk-moss/agent' } : {}),
  });
  assert.equal(advice.kind, 'git-clone');
  assert.equal(advice.commands[0], upgradeCommand(elsewhere));
  const missing = adviseMossUpdate({
    packageRoot: root,
    pkg: { private: true, repository: repo },
    sourceDir: '/opt/not-moss',
    exists: () => false,
    readPackage: () => ({}),
  });
  assert.equal(missing.missingSource, true);
  assert.deepEqual(missing.commands, []);
  assert.match(renderUpdateAdvice(missing, false), /Not a moss git checkout/);
  assert.deepEqual(parseUpdateArgs(['--dir', '/opt/moss-src']), { dir: '/opt/moss-src' });
  assert.deepEqual(parseUpdateArgs(['--dir=/opt/moss-src']), { dir: '/opt/moss-src' });
  assert.equal(parseUpdateArgs(['--dir']).error?.code, 'dir-missing');
  assert.equal(parseUpdateArgs(['--nope']).error?.code, 'unknown');
}

{
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /默认在后台连接，不需要设备目标/);
  assert.match(readme, /connects it in the background by default/);
  assert.doesNotMatch(readme, /有设备目标（`MOSS_DEVICE_HOST`/);
  assert.doesNotMatch(readme, /when a device target\s+is set/);
  for (const command of sourceInstallCommands(pkg.repository)) {
    assert.ok(readme.includes(command), `README is missing: ${command}`);
  }
  assert.ok(readme.split(UPGRADE_IN_CLONE).length - 1 >= 2, 'upgrade line in en and zh');
  assert.ok(readme.includes(LEGACY_PACKAGE_UNINSTALL));
  assert.ok(readme.includes('npm uninstall -g @rdk-moss/agent'));
  assert.match(readme, /coming soon/);
  assert.match(readme, /即将发布/);
  assert.match(readme, /npm config set registry https:\/\/registry\.npmmirror\.com/);
  assert.match(readme, /Set-ExecutionPolicy -Scope CurrentUser RemoteSigned/);
  assert.match(readme, /~\/\.npm-global/);
  assert.match(readme, /install-scripts/);
  assert.match(readme, /ssh2/);
  assert.match(readme, /cpu-features/);
  assert.match(readme, /npm audit fix --force/);
  assert.match(readme, /--force/);
  assert.match(readme, /~\/\.moss\/cache\/npx/);
  assert.match(readme, /~\/\.cache\/node-gyp/);
  assert.match(readme, /node_modules\/@rdk-moss/);
  assert.match(readme, /xcode-select --install/);
  assert.match(readme, /npm 12/);
  assert.match(readme, /npm link/);
  assert.match(readme, /may name `ssh2`/);
  assert.match(readme, /可能会点名 `ssh2`/);
  assert.doesNotMatch(readme, /before dependencies are installed/);
  assert.doesNotMatch(readme, /不会把依赖装一半/);
  assert.match(readme, /dependencies before the root `preinstall`/);
  for (const [start, end] of [
    ['## 升级', '## 卸载'],
    ['### Upgrade', '### Uninstall'],
  ]) {
    const section = readme.slice(readme.indexOf(start), readme.indexOf(end));
    const note = section.indexOf(LEGACY_PACKAGE_UNINSTALL);
    const command = section.indexOf(UPGRADE_IN_CLONE);
    assert.ok(
      note !== -1 && command !== -1 && note < command,
      `${start} note precedes the command`
    );
  }
  assert.match(readme, /MOSS_SOURCE_DIR/);
  assert.match(readme, /moss update --dir/);
  assert.doesNotMatch(readme, /npm install -g github:/);
  assert.doesNotMatch(readme, /QiaolongLi1201/);
  assert.doesNotMatch(readme, /Xcode Command Line Tools are optional/);
  assert.doesNotMatch(readme, /不需要 Xcode Command Line Tools/);
}

{
  const result = spawnSync(process.execPath, [cli, 'update'], {
    encoding: 'utf8',
    timeout: 20_000,
    cwd: repoRoot,
    env: isolatedCliEnv({
      isolateHome: false,
      overrides: { NO_COLOR: '1', FORCE_COLOR: '0', LANG: 'C', LC_ALL: 'C', LC_MESSAGES: 'C' },
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(upgradeCommand(repoRoot)), result.stdout);
  assert.match(result.stdout, /does not run it/);
  assert.match(result.stdout, /--force/);
  assert.doesNotMatch(result.stdout, /git clone https:/);
  assert.doesNotMatch(result.stdout, /git -C/);
  assert.doesNotMatch(result.stdout, /npm run build/);
  assert.doesNotMatch(result.stdout, /Already up to date|npm warn/);
  assert.equal(result.stderr, '');
}

{
  const pointed = spawnSync(process.execPath, [cli, 'update', '--dir', repoRoot], {
    encoding: 'utf8',
    timeout: 20_000,
    cwd: repoRoot,
    env: isolatedCliEnv({
      isolateHome: false,
      overrides: { NO_COLOR: '1', FORCE_COLOR: '0', LANG: 'C', LC_ALL: 'C' },
    }),
  });
  assert.equal(pointed.status, 0, pointed.stderr);
  assert.ok(pointed.stdout.includes(upgradeCommand(repoRoot)), pointed.stdout);
  const missing = spawnSync(
    process.execPath,
    [cli, 'update', '--dir', path.join(repoRoot, 'no-such')],
    {
      encoding: 'utf8',
      timeout: 20_000,
      cwd: repoRoot,
      env: isolatedCliEnv({
        isolateHome: false,
        overrides: { NO_COLOR: '1', FORCE_COLOR: '0', LANG: 'C', LC_ALL: 'C' },
      }),
    }
  );
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stdout, /Not a moss git checkout/);
  const unknown = spawnSync(process.execPath, [cli, 'update', '--nope'], {
    encoding: 'utf8',
    timeout: 20_000,
    cwd: repoRoot,
    env: isolatedCliEnv({
      isolateHome: false,
      overrides: { NO_COLOR: '1', FORCE_COLOR: '0', LANG: 'C', LC_ALL: 'C' },
    }),
  });
  assert.equal(unknown.status, 2, unknown.stdout);
  assert.match(unknown.stderr, /unknown argument: --nope/);
}

{
  const result = spawnSync(process.execPath, [cli, 'update'], {
    encoding: 'utf8',
    timeout: 20_000,
    cwd: repoRoot,
    env: isolatedCliEnv({
      isolateHome: false,
      overrides: {
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        LANG: 'zh_CN.UTF-8',
        LC_ALL: 'zh_CN.UTF-8',
        LC_MESSAGES: 'zh_CN.UTF-8',
      },
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /git 克隆/);
  assert.match(result.stdout, /不会执行/);
  assert.match(result.stdout, /--force/);
  assert.ok(result.stdout.includes(upgradeCommand(repoRoot)), result.stdout);
}

console.log('[PASS] moss update advice');
