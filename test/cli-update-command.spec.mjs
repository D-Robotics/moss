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
  renderUpdateAdvice,
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
  assert.deepEqual(pkg.files, ['dist', 'README.md', 'LICENSE']);
  assert.equal(pkg.engines.node, '>=22.16.0');
  assert.equal(pkg.scripts.prepare, 'npm run build');
  assert.equal(pkg.scripts.prepublishOnly, 'npm run build && npm run verify');
  assert.equal(pkg.publishConfig.access, 'public');
  assert.equal(githubInstallSpec(pkg.repository), 'github:D-Robotics/moss');
  assert.equal(npmInstallSpec(pkg), 'github:D-Robotics/moss');
  assert.equal(
    npmInstallSpec({ private: false, name: '@rdk-moss/agent' }),
    '@rdk-moss/agent@latest'
  );
  assert.equal(githubInstallSpec('git@github.com:D-Robotics/moss.git'), 'github:D-Robotics/moss');
}

{
  const root = '/tmp/moss-clone';
  const advice = adviseMossUpdate({
    packageRoot: root,
    pkg: { private: true, name: '@rdk-moss/agent', repository: repo },
    exists: (target) => target === path.join(root, '.git'),
  });
  assert.equal(advice.kind, 'git-clone');
  assert.equal(
    advice.commands[0],
    'git -C /tmp/moss-clone pull && npm --prefix /tmp/moss-clone run build'
  );
  const text = renderUpdateAdvice(advice, false);
  assert.match(text, /git clone/);
  assert.match(text, /does not run it/);
  assert.doesNotMatch(text, /npm install/);
  const zh = renderUpdateAdvice(advice, true);
  assert.match(zh, /git 克隆/);
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
  assert.equal(advice.commands[0], 'npm install -g github:D-Robotics/moss');
  assert.match(renderUpdateAdvice(advice, false), /npm global install/);
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
  assert.equal(advice.commands.length, 2);
  assert.match(advice.commands[0], /^git -C /);
  assert.equal(advice.commands[1], 'npm install -g github:D-Robotics/moss');
}

{
  const quoted = adviseMossUpdate({
    packageRoot: '/tmp/moss clone',
    pkg,
    exists: (target) => target === path.join('/tmp/moss clone', '.git'),
  });
  assert.match(quoted.commands[0], /git -C '\/tmp\/moss clone' pull/);
}

{
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /默认在后台连接，不需要设备目标/);
  assert.match(readme, /connects it in the background by default/);
  assert.doesNotMatch(readme, /有设备目标（`MOSS_DEVICE_HOST`/);
  assert.doesNotMatch(readme, /when a device target\s+is set/);
  assert.match(readme, /npm install -g github:D-Robotics\/moss/);
  assert.match(readme, /git clone https:\/\/github\.com\/D-Robotics\/moss /);
  assert.doesNotMatch(readme, /QiaolongLi1201/);
  assert.match(readme, /npm publish --access public/);
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
  assert.match(result.stdout, /git clone/);
  assert.match(result.stdout, new RegExp(`git -C ${repoRoot} pull`));
  assert.match(result.stdout, /npm --prefix/);
  assert.match(result.stdout, /run build/);
  assert.match(result.stdout, /does not run it/);
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
  assert.match(result.stdout, new RegExp(`git -C ${repoRoot} pull`));
}

console.log('[PASS] moss update advice');
