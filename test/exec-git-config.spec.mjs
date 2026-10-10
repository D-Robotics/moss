/**
 * Model exec and background exec harden git in an untrusted workspace.
 * An explicit workspace-trust grant leaves repo filters alone.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { execBackgroundTool } from '../dist/tools/background-exec.js';
import { execTool } from '../dist/tools/builtin.js';
import { childEnv } from '../dist/tools/tool-helpers.js';
import { appendGitConfigEnv, untrustedShellGitConfig } from '../dist/utils/git-config-env.js';
import { GIT_HOOKS_PATH, shellGitConfigPairs } from '../dist/utils/git-spawn.js';
import { captureEnvBeforeDotenv } from '../dist/utils/startup-env.js';
import { isWorkspaceTrusted, workspaceTrustKey } from '../dist/utils/workspace-trust-state.js';

const hooksPath = GIT_HOOKS_PATH;

function writeExec(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

function markerScript(file, marker, passThrough) {
  const body = passThrough
    ? `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\n${passThrough}\n`
    : `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\n`;
  writeExec(file, body);
}

function count(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

function armRepo(root) {
  const ws = path.join(root, 'ws');
  const markers = path.join(root, 'markers');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(markers, { recursive: true });
  git(ws, ['init', '-q']);
  git(ws, ['config', 'user.email', 'moss@example.com']);
  git(ws, ['config', 'user.name', 'Moss Test']);
  fs.writeFileSync(path.join(ws, 'data.txt'), 'hello 1\n');
  fs.writeFileSync(path.join(ws, 'README.md'), '# readme\n');
  fs.writeFileSync(
    path.join(ws, '.gitattributes'),
    '*.txt filter=evil diff=evil\n*.md filter=included\n'
  );
  git(ws, ['add', '-A']);
  git(ws, ['commit', '-qm', 'init']);

  const fsmonitor = path.join(ws, 'fsmonitor.sh');
  const clean = path.join(ws, 'clean.sh');
  const smudge = path.join(ws, 'smudge.sh');
  const textconv = path.join(ws, 'textconv.sh');
  const includedClean = path.join(ws, 'included-clean.sh');
  markerScript(fsmonitor, path.join(markers, 'fsmonitor'));
  markerScript(clean, path.join(markers, 'filter-clean'), 'cat');
  markerScript(smudge, path.join(markers, 'filter-smudge'), 'cat');
  markerScript(textconv, path.join(markers, 'textconv'), 'cat "$1"');
  markerScript(includedClean, path.join(markers, 'filter-include'), 'cat');
  const hooks = path.join(ws, 'hooks');
  markerScript(path.join(hooks, 'pre-commit'), path.join(markers, 'hooks'));
  const included = path.join(ws, 'included.cfg');
  fs.writeFileSync(
    included,
    `[filter "included"]\n\tclean = ${includedClean}\n\trequired = true\n`
  );
  git(ws, ['config', 'core.fsmonitor', fsmonitor]);
  git(ws, ['config', 'filter.evil.clean', clean]);
  git(ws, ['config', 'filter.evil.smudge', smudge]);
  git(ws, ['config', 'filter.evil.required', 'true']);
  git(ws, ['config', 'diff.evil.textconv', textconv]);
  git(ws, ['config', 'core.hooksPath', hooks]);
  git(ws, ['config', 'include.path', included]);
  fs.writeFileSync(path.join(ws, 'data.txt'), 'hello 2\n');
  return { ws, markers };
}

function ctx(ws) {
  return { workspaceDir: ws, sessionKey: 'exec-git', abortSignal: new AbortController().signal };
}

const savedConfigDir = process.env.MOSS_CONFIG_DIR;
const savedTrust = process.env.MOSS_TRUST_WORKSPACE;
const savedGitGlobal = process.env.GIT_CONFIG_GLOBAL;
const savedGitSystem = process.env.GIT_CONFIG_SYSTEM;

function useIsolatedGitConfig(globalFile = '/dev/null', systemFile = '/dev/null') {
  process.env.GIT_CONFIG_GLOBAL = globalFile;
  process.env.GIT_CONFIG_SYSTEM = systemFile;
}

function restoreGitConfig() {
  if (savedGitGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGitGlobal;
  if (savedGitSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
  else process.env.GIT_CONFIG_SYSTEM = savedGitSystem;
}

function injectedPairs(env) {
  const raw = env.GIT_CONFIG_COUNT;
  const count = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 0;
  const pairs = [];
  for (let i = 0; i < count; i++) {
    pairs.push({ key: env[`GIT_CONFIG_KEY_${i}`], value: env[`GIT_CONFIG_VALUE_${i}`] });
  }
  return pairs;
}

function pairsNamed(env, key) {
  const want = key.toLowerCase();
  return injectedPairs(env).filter((pair) => String(pair.key).toLowerCase() === want);
}

function gitConfigFile(file, args) {
  execFileSync('git', ['config', '--file', file, ...args], {
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function initRepo(ws) {
  fs.mkdirSync(ws, { recursive: true });
  git(ws, ['init', '-q']);
  git(ws, ['config', 'user.email', 'moss@example.com']);
  git(ws, ['config', 'user.name', 'Moss Test']);
}

function useConfigDir(dir) {
  process.env.MOSS_CONFIG_DIR = dir;
  delete process.env.MOSS_TRUST_WORKSPACE;
}

function restoreEnv() {
  if (savedConfigDir === undefined) delete process.env.MOSS_CONFIG_DIR;
  else process.env.MOSS_CONFIG_DIR = savedConfigDir;
  if (savedTrust === undefined) delete process.env.MOSS_TRUST_WORKSPACE;
  else process.env.MOSS_TRUST_WORKSPACE = savedTrust;
}

test('shell git pairs override repo programs and keep user global config', () => {
  const pairs = shellGitConfigPairs(
    [
      'local\tfilter.x.clean /tmp/clean.sh',
      'worktree\tfilter.x.smudge /tmp/smudge.sh',
      'local\tfilter.x.process /tmp/process.sh',
      'local\tdiff.x.textconv /tmp/textconv.sh',
      'worktree\tdiff.x.command /tmp/command.sh',
      'local\tcore.fsmonitor /tmp/fs.sh',
      'system\tcore.fsmonitor /tmp/sys-fs.sh',
      'local\tcore.sshcommand /tmp/local-ssh.sh',
      'system\tcore.sshcommand /tmp/sys-ssh.sh',
      'global\tcore.sshcommand /tmp/global-ssh.sh',
      'local\tcore.pager /tmp/local-pager.sh',
      'local\tcredential.helper /tmp/local-helper.sh',
      'local\tcredential.helper /tmp/included-helper.sh',
      'system\tcredential.helper /tmp/sys-helper.sh',
      'global\tcredential.helper /tmp/global-helper.sh',
      'local\tdiff.external /tmp/ext.sh',
      'local\tcore.hookspath /tmp/local-hooks',
      'global\tcore.hookspath /tmp/global-hooks',
      'system\tfilter.lfs.clean git-lfs clean -- %f',
      'global\tfilter.global.clean /tmp/global.sh',
      'command\tcredential.helper ',
    ].join('\n')
  );
  const value = (key) => pairs.find((pair) => pair.key.toLowerCase() === key.toLowerCase())?.value;
  const helpers = pairs
    .filter((pair) => pair.key === 'credential.helper')
    .map((pair) => pair.value);
  assert.equal(value('core.fsmonitor'), '/tmp/sys-fs.sh');
  assert.equal(value('core.hooksPath'), hooksPath);
  assert.equal(value('core.sshCommand'), '/tmp/global-ssh.sh');
  assert.equal(value('core.pager'), 'cat');
  assert.deepEqual(helpers, ['', '/tmp/sys-helper.sh', '/tmp/global-helper.sh']);
  assert.equal(value('filter.x.clean'), 'cat');
  assert.equal(value('filter.x.smudge'), 'cat');
  assert.equal(value('filter.x.process'), 'cat');
  assert.equal(value('filter.x.required'), 'false');
  assert.equal(value('diff.x.textconv'), 'cat');
  assert.equal(value('diff.x.command'), undefined);
  assert.equal(value('diff.external'), undefined);
  assert.equal(value('filter.lfs.clean'), undefined);
  assert.equal(value('filter.global.clean'), undefined);
});

test('shell git pairs leave user-global keys alone when the repo does not set them', () => {
  const untouched = shellGitConfigPairs(
    [
      'global\tcore.fsmonitor true',
      'global\tcredential.helper osxkeychain',
      'global\tcore.sshcommand ssh -o IdentityFile=~/.ssh/id',
      'system\tcore.pager less',
      'global\tcore.hookspath /tmp/global-hooks',
      'local\tdiff.external /tmp/ext.sh',
    ].join('\n')
  );
  assert.deepEqual(untouched, []);
  const hooks = shellGitConfigPairs('global\tcore.hookspath /tmp/global-hooks', {
    executableHooks: true,
  });
  assert.deepEqual(hooks, [{ key: 'core.hooksPath', value: hooksPath }]);
  const localOnly = shellGitConfigPairs(
    [
      'local\tcore.sshcommand /tmp/evil-ssh.sh',
      'local\tcore.fsmonitor /tmp/evil-fs.sh',
      'local\tcore.pager /tmp/evil-pager.sh',
      'worktree\tcredential.helper /tmp/evil-helper.sh',
    ].join('\n')
  );
  const value = (key) =>
    localOnly.find((pair) => pair.key.toLowerCase() === key.toLowerCase())?.value;
  assert.equal(value('core.sshCommand'), '');
  assert.equal(value('core.fsmonitor'), '');
  assert.equal(value('core.pager'), 'cat');
  assert.deepEqual(
    localOnly.filter((pair) => pair.key === 'credential.helper').map((pair) => pair.value),
    ['']
  );
  assert.deepEqual(shellGitConfigPairs(''), []);
});

test('git config env appends after an existing count', () => {
  const env = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'color.ui',
    GIT_CONFIG_VALUE_0: 'false',
  };
  appendGitConfigEnv(env, [
    { key: 'core.fsmonitor', value: '' },
    { key: 'core.hooksPath', value: hooksPath },
  ]);
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(env.GIT_CONFIG_KEY_0, 'color.ui');
  assert.equal(env.GIT_CONFIG_VALUE_0, 'false');
  assert.equal(env.GIT_CONFIG_KEY_1, 'core.fsmonitor');
  assert.equal(env.GIT_CONFIG_VALUE_1, '');
  assert.equal(env.GIT_CONFIG_KEY_2, 'core.hooksPath');
  assert.equal(env.GIT_CONFIG_VALUE_2, hooksPath);
});

test('untrusted exec git does not run repo programs; trusted exec does', async () => {
  const untrustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-git-'));
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-git-trust-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-git-cfg-'));
  try {
    useConfigDir(configDir);
    useIsolatedGitConfig();
    const evil = armRepo(untrustedRoot);
    assert.equal(isWorkspaceTrusted(evil.ws), false);
    const names = [
      'fsmonitor',
      'filter-clean',
      'filter-smudge',
      'textconv',
      'hooks',
      'filter-include',
    ];
    const before = Object.fromEntries(
      names.map((name) => [name, count(path.join(evil.markers, name))])
    );
    assert.deepEqual(before, {
      fsmonitor: 0,
      'filter-clean': 0,
      'filter-smudge': 0,
      textconv: 0,
      hooks: 0,
      'filter-include': 0,
    });

    const status = await execTool.execute(
      { command: 'git status --porcelain', timeout_ms: 20000 },
      ctx(evil.ws)
    );
    assert.match(status, /data\.txt/);
    assert.doesNotMatch(status, /exit_code:/);
    const diff = await execTool.execute(
      { command: 'git diff -- data.txt', timeout_ms: 20000 },
      ctx(evil.ws)
    );
    assert.match(diff, /\+hello 2/);
    assert.doesNotMatch(diff, /exit_code:/);
    assert.doesNotMatch(diff, /external diff died/);
    const added = await execTool.execute(
      { command: 'git add data.txt README.md', timeout_ms: 20000 },
      ctx(evil.ws)
    );
    assert.doesNotMatch(added, /exit_code:/);
    const committed = await execTool.execute(
      { command: 'git commit -qm model-commit', timeout_ms: 20000 },
      ctx(evil.ws)
    );
    assert.doesNotMatch(committed, /exit_code:/);
    const background = await execBackgroundTool.execute(
      { command: 'git status --porcelain', settle_ms: 5000 },
      ctx(evil.ws)
    );
    assert.match(background, /exit 0/);

    for (const name of names) {
      assert.equal(count(path.join(evil.markers, name)), 0, `${name} ran under untrusted exec`);
    }

    const trusted = armRepo(trustedRoot);
    fs.writeFileSync(
      path.join(configDir, 'workspace-trust.json'),
      `${JSON.stringify({ [workspaceTrustKey(trusted.ws)]: true }, null, 2)}\n`
    );
    assert.equal(isWorkspaceTrusted(trusted.ws), true);
    const trustedStatus = await execTool.execute(
      { command: 'git status --porcelain', timeout_ms: 20000 },
      ctx(trusted.ws)
    );
    assert.match(trustedStatus, /data\.txt/);
    await execTool.execute({ command: 'git diff -- data.txt', timeout_ms: 20000 }, ctx(trusted.ws));
    await execTool.execute(
      { command: 'git add data.txt README.md', timeout_ms: 20000 },
      ctx(trusted.ws)
    );
    await execTool.execute(
      { command: 'git commit -qm model-commit', timeout_ms: 20000 },
      ctx(trusted.ws)
    );
    assert.ok(count(path.join(trusted.markers, 'fsmonitor')) > 0, 'trusted fsmonitor did not run');
    assert.ok(count(path.join(trusted.markers, 'filter-clean')) > 0, 'trusted clean did not run');
    assert.ok(count(path.join(trusted.markers, 'textconv')) > 0, 'trusted textconv did not run');
    assert.ok(count(path.join(trusted.markers, 'hooks')) > 0, 'trusted hook did not run');
  } finally {
    restoreGitConfig();
    restoreEnv();
    fs.rmSync(untrustedRoot, { recursive: true, force: true });
    fs.rmSync(trustedRoot, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('discovery cache follows config mtime and a failed discovery leaves user git config alone', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-git-cache-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-git-cache-cfg-'));
  try {
    useConfigDir(configDir);
    const { ws } = armRepo(root);
    const first = await untrustedShellGitConfig(ws);
    const second = await untrustedShellGitConfig(ws);
    assert.equal(first, second);
    assert.ok(first.some((pair) => pair.key === 'filter.evil.clean' && pair.value === 'cat'));
    fs.appendFileSync(path.join(ws, '.git', 'config'), '\n# touch\n');
    const third = await untrustedShellGitConfig(ws);
    assert.notEqual(first, third);

    const fresh = armRepo(path.join(root, 'aborted'));
    const aborted = new AbortController();
    aborted.abort();
    const env = await childEnv(fresh.ws, aborted.signal);
    assert.equal(pairsNamed(env, 'filter.evil.clean').length, 0);
    assert.equal(pairsNamed(env, 'core.fsmonitor').length, 0);
    assert.equal(pairsNamed(env, 'core.hooksPath').length, 0);
    assert.equal(pairsNamed(env, 'core.sshCommand').length, 0);
    assert.equal(pairsNamed(env, 'credential.helper').length, 0);
    assert.equal(pairsNamed(env, 'core.pager').length, 0);
  } finally {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('untrusted exec keeps a global credential helper and blocks a local one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-git-cred-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-git-cred-cfg-'));
  const globalFile = path.join(root, 'global.gitconfig');
  const stub = path.join(root, 'stub-helper.sh');
  const stubMarker = path.join(root, 'stub.marker');
  const evil = path.join(root, 'evil-helper.sh');
  const evilMarker = path.join(root, 'evil.marker');
  try {
    useConfigDir(configDir);
    writeExec(
      stub,
      `#!/bin/sh\necho ran >> ${JSON.stringify(stubMarker)}\nprintf 'username=user\\npassword=pass\\n'\n`
    );
    writeExec(
      evil,
      `#!/bin/sh\necho ran >> ${JSON.stringify(evilMarker)}\nprintf 'username=evil\\npassword=evil\\n'\n`
    );
    gitConfigFile(globalFile, ['credential.helper', stub]);
    useIsolatedGitConfig(globalFile);

    const clean = path.join(root, 'clean');
    initRepo(clean);
    assert.equal(isWorkspaceTrusted(clean), false);
    assert.equal(pairsNamed(await childEnv(clean), 'credential.helper').length, 0);
    const filled = await execTool.execute(
      {
        command: "printf 'protocol=https\\nhost=example.com\\n\\n' | git credential fill",
        timeout_ms: 20000,
      },
      ctx(clean)
    );
    assert.match(filled, /username=user/);
    assert.doesNotMatch(filled, /exit_code:/);
    assert.ok(count(stubMarker) > 0, 'global credential helper was not invoked');

    const dirty = path.join(root, 'dirty');
    initRepo(dirty);
    git(dirty, ['config', '--add', 'credential.helper', evil]);
    assert.deepEqual(
      pairsNamed(await childEnv(dirty), 'credential.helper').map((pair) => pair.value),
      ['', stub]
    );
    fs.writeFileSync(stubMarker, '');
    const blocked = await execTool.execute(
      {
        command: "printf 'protocol=https\\nhost=example.com\\n\\n' | git credential fill",
        timeout_ms: 20000,
      },
      ctx(dirty)
    );
    assert.match(blocked, /username=user/);
    assert.doesNotMatch(blocked, /username=evil/);
    assert.equal(count(evilMarker), 0, 'local credential helper ran');
    assert.ok(count(stubMarker) > 0, 'global credential helper was dropped');
  } finally {
    restoreGitConfig();
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('untrusted exec keeps a global ssh command and blocks a local one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-git-ssh-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-git-ssh-cfg-'));
  const globalFile = path.join(root, 'global.gitconfig');
  const globalSsh = path.join(root, 'global-ssh.sh');
  const globalMarker = path.join(root, 'global-ssh.marker');
  const evilSsh = path.join(root, 'evil-ssh.sh');
  const evilMarker = path.join(root, 'evil-ssh.marker');
  try {
    useConfigDir(configDir);
    writeExec(globalSsh, `#!/bin/sh\necho ran >> ${JSON.stringify(globalMarker)}\nexit 0\n`);
    writeExec(evilSsh, `#!/bin/sh\necho ran >> ${JSON.stringify(evilMarker)}\nexit 0\n`);
    gitConfigFile(globalFile, ['core.sshCommand', globalSsh]);
    useIsolatedGitConfig(globalFile);

    const clean = path.join(root, 'clean');
    initRepo(clean);
    git(clean, ['remote', 'add', 'origin', 'git@example.invalid:test/repo.git']);
    assert.equal(pairsNamed(await childEnv(clean), 'core.sshCommand').length, 0);
    await execTool.execute({ command: 'git ls-remote origin', timeout_ms: 20000 }, ctx(clean));
    assert.ok(count(globalMarker) > 0, 'global ssh command was not invoked');

    const dirty = path.join(root, 'dirty');
    initRepo(dirty);
    git(dirty, ['remote', 'add', 'origin', 'git@example.invalid:test/repo.git']);
    git(dirty, ['config', 'core.sshCommand', evilSsh]);
    assert.deepEqual(
      pairsNamed(await childEnv(dirty), 'core.sshCommand').map((pair) => pair.value),
      [globalSsh]
    );
    fs.writeFileSync(globalMarker, '');
    await execTool.execute({ command: 'git ls-remote origin', timeout_ms: 20000 }, ctx(dirty));
    assert.equal(count(evilMarker), 0, 'local ssh command ran');
    assert.ok(count(globalMarker) > 0, 'global ssh command was dropped');
  } finally {
    restoreGitConfig();
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('untrusted exec keeps a global hooks path unless the repo has its own hooks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-git-hooks-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-git-hooks-cfg-'));
  const globalFile = path.join(root, 'global.gitconfig');
  const globalHooks = path.join(root, 'global-hooks');
  const globalMarker = path.join(root, 'global-hook.marker');
  const localMarker = path.join(root, 'local-hook.marker');
  const evilMarker = path.join(root, 'evil-hook.marker');
  try {
    useConfigDir(configDir);
    fs.mkdirSync(globalHooks);
    writeExec(
      path.join(globalHooks, 'pre-commit'),
      `#!/bin/sh\necho ran >> ${JSON.stringify(globalMarker)}\nexit 0\n`
    );
    gitConfigFile(globalFile, ['core.hooksPath', globalHooks]);
    useIsolatedGitConfig(globalFile);

    const clean = path.join(root, 'clean');
    initRepo(clean);
    fs.writeFileSync(path.join(clean, 'data.txt'), 'one\n');
    assert.equal(pairsNamed(await childEnv(clean), 'core.hooksPath').length, 0);
    const committed = await execTool.execute(
      { command: 'git add data.txt && git commit -qm hooked', timeout_ms: 20000 },
      ctx(clean)
    );
    assert.doesNotMatch(committed, /exit_code:/);
    assert.ok(count(globalMarker) > 0, 'global pre-commit hook did not run');

    writeExec(
      path.join(clean, '.git', 'hooks', 'pre-commit'),
      `#!/bin/sh\necho ran >> ${JSON.stringify(localMarker)}\nexit 0\n`
    );
    fs.writeFileSync(path.join(clean, 'data.txt'), 'two\n');
    assert.deepEqual(
      pairsNamed(await childEnv(clean), 'core.hooksPath').map((pair) => pair.value),
      [hooksPath]
    );
    const before = count(globalMarker);
    const again = await execTool.execute(
      { command: 'git add data.txt && git commit -qm hooked-again', timeout_ms: 20000 },
      ctx(clean)
    );
    assert.doesNotMatch(again, /exit_code:/);
    assert.equal(count(localMarker), 0, 'repo pre-commit hook ran');
    assert.equal(count(globalMarker), before, 'global hook ran after a repo hook appeared');

    const pointed = path.join(root, 'pointed');
    initRepo(pointed);
    const evilHooks = path.join(root, 'evil-hooks');
    fs.mkdirSync(evilHooks);
    writeExec(
      path.join(evilHooks, 'pre-commit'),
      `#!/bin/sh\necho ran >> ${JSON.stringify(evilMarker)}\nexit 0\n`
    );
    git(pointed, ['config', 'core.hooksPath', evilHooks]);
    fs.writeFileSync(path.join(pointed, 'data.txt'), 'one\n');
    assert.deepEqual(
      pairsNamed(await childEnv(pointed), 'core.hooksPath').map((pair) => pair.value),
      [hooksPath]
    );
    const pointedCommit = await execTool.execute(
      { command: 'git add data.txt && git commit -qm pointed', timeout_ms: 20000 },
      ctx(pointed)
    );
    assert.doesNotMatch(pointedCommit, /exit_code:/);
    assert.equal(count(evilMarker), 0, 'local hooksPath program ran');
  } finally {
    restoreGitConfig();
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a project MOSS_TRUST_WORKSPACE after startup capture does not grant git trust', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-git-env-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-git-env-cfg-'));
  try {
    const snapshot = { ...process.env, MOSS_CONFIG_DIR: configDir };
    delete snapshot.MOSS_TRUST_WORKSPACE;
    captureEnvBeforeDotenv(snapshot);
    process.env.MOSS_TRUST_WORKSPACE = '1';
    process.env.MOSS_CONFIG_DIR = configDir;
    assert.equal(isWorkspaceTrusted(root), false);
    fs.writeFileSync(
      path.join(configDir, 'workspace-trust.json'),
      `${JSON.stringify({ [workspaceTrustKey(root)]: true }, null, 2)}\n`
    );
    assert.equal(isWorkspaceTrusted(root), true);
  } finally {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
