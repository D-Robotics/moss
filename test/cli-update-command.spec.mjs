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
  assert.equal(pkg.bin.moss, 'dist/cli.js');
  assert.deepEqual(pkg.files, ['dist', '!dist/**/*.map', 'README.md', 'LICENSE']);
  assert.equal(pkg.engines.node, '>=22.16.0');
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
  assert.match(readme, /allow-scripts/);
  assert.match(readme, /ssh2/);
  assert.match(readme, /npm audit fix --force/);
  assert.match(readme, /--force/);
  assert.match(readme, /~\/\.moss\/cache\/npx/);
  assert.doesNotMatch(readme, /npm install -g github:/);
  assert.doesNotMatch(readme, /QiaolongLi1201/);
  assert.doesNotMatch(readme, /npm link/);
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
