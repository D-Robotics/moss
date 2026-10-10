/**
 * Model exec and background exec harden git in an untrusted workspace.
 * An explicit workspace-trust grant leaves repo filters alone.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { formatHeadlessStreamEvent, createHeadlessPrintState } from '../dist/cli/print.js';
import { applyAgentEvent, beginRun, createTuiStore } from '../dist/cli/tui/render-bridge.js';
import { renderTranscriptRows } from '../dist/cli/tui/transcript.js';
import { formatToolResultForSsePreview } from '../dist/core/loop/agent-loop-tool-helpers.js';
import { execBackgroundTool } from '../dist/tools/background-exec.js';
import { execTool } from '../dist/tools/builtin.js';
import { childEnv, commandInvokesGit } from '../dist/tools/tool-helpers.js';
import { appendGitConfigEnv, untrustedShellGitConfig } from '../dist/utils/git-config-env.js';
import { GIT_HOOKS_PATH, shellGitConfigPairs } from '../dist/utils/git-spawn.js';
import { captureEnvBeforeDotenv } from '../dist/utils/startup-env.js';
import { isWorkspaceTrusted, workspaceTrustKey } from '../dist/utils/workspace-trust-state.js';

const gitPath = (file) => file.split(path.sep).join('/');
const joinGit = (...parts) => gitPath(path.join(...parts));
const hooksPath = GIT_HOOKS_PATH;

function builtinScriptPath(command) {
  const file = command.startsWith("'") ? command.slice(1, -1).replaceAll("'\\''", "'") : command;
  if (command.startsWith("'")) assert.equal(command.at(-1), "'");
  assert.ok(path.isAbsolute(file), 'the builtin command names an actual absolute script');
  return file;
}

function unlinkFixtureLink(file) {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st) return;
  assert.equal(st.isSymbolicLink(), true, 'only the exact fixture link may be unlinked');
  fs.unlinkSync(file);
}

const nativeModes = [];
if (process.platform === 'win32') {
  for (const name of ['mkdirSync', 'writeFileSync']) {
    const original = fs[name];
    fs[name] = function (file, ...args) {
      const result = original.call(this, file, ...args);
      const options = name === 'mkdirSync' ? args[0] : args[1];
      if (options && typeof options === 'object') {
        nativeModes.push({ name, file: path.resolve(String(file)), mode: options.mode });
      }
      return result;
    };
  }
}

function assertPrivateMode(dir, script) {
  if (process.platform === 'win32') {
    assert.ok(fs.lstatSync(dir).isDirectory());
    assert.ok(
      nativeModes.some(
        (entry) =>
          entry.mode === 0o700 &&
          ((entry.name === 'mkdirSync' && entry.file === path.resolve(dir)) ||
            (entry.name === 'writeFileSync' && path.dirname(entry.file) === path.resolve(dir)))
      ),
      'the real native install requested 0700; this is not a Windows ACL assertion'
    );
    assert.ok(fs.lstatSync(script).isFile());
  } else {
    const st = fs.lstatSync(dir);
    assert.equal(st.mode & 0o777, 0o700);
    assert.equal(st.uid, process.getuid());
  }
}

test('the native install mode oracle rejects an actual non-0700 request', () => {
  const root = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-git-mode-oracle-'));
  try {
    const dir = joinGit(root, 'nonprivate');
    fs.mkdirSync(dir, { mode: 0o755 });
    const script = joinGit(dir, 'script.sh');
    fs.writeFileSync(script, '#!/bin/sh\n', { mode: 0o755 });
    assert.throws(() => assertPrivateMode(dir, script), assert.AssertionError);
    assert.equal(fs.readFileSync(script, 'utf8'), '#!/bin/sh\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
  const ws = joinGit(root, 'ws');
  const markers = joinGit(root, 'markers');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(markers, { recursive: true });
  git(ws, ['init', '-q']);
  git(ws, ['config', 'user.email', 'moss@example.com']);
  git(ws, ['config', 'user.name', 'Moss Test']);
  fs.writeFileSync(joinGit(ws, 'data.txt'), 'hello 1\n');
  fs.writeFileSync(joinGit(ws, 'README.md'), '# readme\n');
  fs.writeFileSync(
    joinGit(ws, '.gitattributes'),
    '*.txt filter=evil diff=evil\n*.md filter=included\n'
  );
  git(ws, ['add', '-A']);
  git(ws, ['commit', '-qm', 'init']);

  const fsmonitor = joinGit(ws, 'fsmonitor.sh');
  const clean = joinGit(ws, 'clean.sh');
  const smudge = joinGit(ws, 'smudge.sh');
  const textconv = joinGit(ws, 'textconv.sh');
  const includedClean = joinGit(ws, 'included-clean.sh');
  markerScript(fsmonitor, joinGit(markers, 'fsmonitor'));
  markerScript(clean, joinGit(markers, 'filter-clean'), 'cat');
  markerScript(smudge, joinGit(markers, 'filter-smudge'), 'cat');
  markerScript(textconv, joinGit(markers, 'textconv'), 'cat "$1"');
  markerScript(includedClean, joinGit(markers, 'filter-include'), 'cat');
  const hooks = joinGit(ws, 'hooks');
  markerScript(joinGit(hooks, 'pre-commit'), joinGit(markers, 'hooks'));
  const included = joinGit(ws, 'included.cfg');
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
  fs.writeFileSync(joinGit(ws, 'data.txt'), 'hello 2\n');
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
  assert.equal(value('core.hooksPath'), '/tmp/global-hooks');
  assert.equal(value('diff.external'), 'false');
  assert.equal(value('diff.x.command'), 'false');
  assert.equal(value('core.sshCommand'), '/tmp/global-ssh.sh');
  assert.equal(value('core.pager'), 'cat');
  assert.deepEqual(helpers, ['', '/tmp/sys-helper.sh', '/tmp/global-helper.sh']);
  assert.equal(value('filter.x.clean'), 'cat');
  assert.equal(value('filter.x.smudge'), 'cat');
  assert.equal(value('filter.x.process'), 'cat');
  assert.equal(value('filter.x.required'), 'false');
  assert.equal(value('diff.x.textconv'), 'cat');
  assert.equal(value('diff.x.command'), 'false');
  assert.equal(value('diff.external'), 'false');
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
  assert.deepEqual(untouched, [{ key: 'diff.external', value: 'false' }]);
  const builtin = '/opt/moss/git-builtin-diff.sh';
  const external = shellGitConfigPairs(
    ['local\tdiff.external /tmp/ext.sh', 'worktree\tdiff.evil.command /tmp/cmd.sh'].join('\n'),
    { builtinDiff: builtin }
  );
  assert.equal(external.find((pair) => pair.key === 'diff.external')?.value, builtin);
  assert.equal(external.find((pair) => pair.key === 'diff.evil.command')?.value, builtin);
  assert.deepEqual(shellGitConfigPairs('local\tdiff.external /tmp/ext.sh'), [
    { key: 'diff.external', value: 'false' },
  ]);
  const hooks = shellGitConfigPairs('global\tcore.hookspath /tmp/global-hooks', {
    executableHooks: true,
  });
  assert.deepEqual(hooks, []);
  assert.deepEqual(shellGitConfigPairs('', { executableHooks: true }), [
    { key: 'core.hooksPath', value: hooksPath },
  ]);
  assert.deepEqual(
    shellGitConfigPairs('local\tcore.hookspath /tmp/evil\nglobal\tcore.hookspath /tmp/user-hooks'),
    [{ key: 'core.hooksPath', value: '/tmp/user-hooks' }]
  );
  assert.deepEqual(shellGitConfigPairs('local\tcore.hookspath /tmp/evil'), [
    { key: 'core.hooksPath', value: hooksPath },
  ]);
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
  const untrustedRoot = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-'));
  const trustedRoot = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-trust-'));
  const configDir = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-cfg-'));
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
      names.map((name) => [name, count(joinGit(evil.markers, name))])
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
      assert.equal(count(joinGit(evil.markers, name)), 0, `${name} ran under untrusted exec`);
    }

    const trusted = armRepo(trustedRoot);
    fs.writeFileSync(
      joinGit(configDir, 'workspace-trust.json'),
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
    assert.ok(count(joinGit(trusted.markers, 'fsmonitor')) > 0, 'trusted fsmonitor did not run');
    assert.ok(count(joinGit(trusted.markers, 'filter-clean')) > 0, 'trusted clean did not run');
    assert.ok(count(joinGit(trusted.markers, 'textconv')) > 0, 'trusted textconv did not run');
    assert.ok(count(joinGit(trusted.markers, 'hooks')) > 0, 'trusted hook did not run');
  } finally {
    restoreGitConfig();
    restoreEnv();
    fs.rmSync(untrustedRoot, { recursive: true, force: true });
    fs.rmSync(trustedRoot, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('discovery cache follows config mtime and a failed discovery leaves user git config alone', async () => {
  const root = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-cache-'));
  const configDir = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-cache-cfg-'));
  try {
    useConfigDir(configDir);
    const { ws } = armRepo(root);
    const first = await untrustedShellGitConfig(ws);
    const second = await untrustedShellGitConfig(ws);
    assert.equal(first, second);
    assert.ok(first.some((pair) => pair.key === 'filter.evil.clean' && pair.value === 'cat'));
    fs.appendFileSync(joinGit(ws, '.git', 'config'), '\n# touch\n');
    const third = await untrustedShellGitConfig(ws);
    assert.notEqual(first, third);

    const fresh = armRepo(joinGit(root, 'aborted'));
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
  const root = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-cred-'));
  const configDir = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-cred-cfg-'));
  const globalFile = joinGit(root, 'global.gitconfig');
  const stub = joinGit(root, 'stub-helper.sh');
  const stubMarker = joinGit(root, 'stub.marker');
  const evil = joinGit(root, 'evil-helper.sh');
  const evilMarker = joinGit(root, 'evil.marker');
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

    const clean = joinGit(root, 'clean');
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

    const dirty = joinGit(root, 'dirty');
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
  const root = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-ssh-'));
  const configDir = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-ssh-cfg-'));
  const globalFile = joinGit(root, 'global.gitconfig');
  const globalSsh = joinGit(root, 'global-ssh.sh');
  const globalMarker = joinGit(root, 'global-ssh.marker');
  const evilSsh = joinGit(root, 'evil-ssh.sh');
  const evilMarker = joinGit(root, 'evil-ssh.marker');
  try {
    useConfigDir(configDir);
    writeExec(globalSsh, `#!/bin/sh\necho ran >> ${JSON.stringify(globalMarker)}\nexit 0\n`);
    writeExec(evilSsh, `#!/bin/sh\necho ran >> ${JSON.stringify(evilMarker)}\nexit 0\n`);
    gitConfigFile(globalFile, ['core.sshCommand', globalSsh]);
    useIsolatedGitConfig(globalFile);

    const clean = joinGit(root, 'clean');
    initRepo(clean);
    git(clean, ['remote', 'add', 'origin', 'git@example.invalid:test/repo.git']);
    assert.equal(pairsNamed(await childEnv(clean), 'core.sshCommand').length, 0);
    await execTool.execute({ command: 'git ls-remote origin', timeout_ms: 20000 }, ctx(clean));
    assert.ok(count(globalMarker) > 0, 'global ssh command was not invoked');

    const dirty = joinGit(root, 'dirty');
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
  const root = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-hooks-'));
  const configDir = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-hooks-cfg-'));
  const globalFile = joinGit(root, 'global.gitconfig');
  const globalHooks = joinGit(root, 'global-hooks');
  const globalMarker = joinGit(root, 'global-hook.marker');
  const localMarker = joinGit(root, 'local-hook.marker');
  const evilMarker = joinGit(root, 'evil-hook.marker');
  try {
    useConfigDir(configDir);
    fs.mkdirSync(globalHooks);
    writeExec(
      joinGit(globalHooks, 'pre-commit'),
      `#!/bin/sh\necho ran >> ${JSON.stringify(globalMarker)}\nexit 0\n`
    );
    gitConfigFile(globalFile, ['core.hooksPath', globalHooks]);
    useIsolatedGitConfig(globalFile);

    const clean = joinGit(root, 'clean');
    initRepo(clean);
    fs.writeFileSync(joinGit(clean, 'data.txt'), 'one\n');
    assert.equal(pairsNamed(await childEnv(clean), 'core.hooksPath').length, 0);
    const committed = await execTool.execute(
      { command: 'git add data.txt && git commit -qm hooked', timeout_ms: 20000 },
      ctx(clean)
    );
    assert.doesNotMatch(committed, /exit_code:/);
    assert.ok(count(globalMarker) > 0, 'global pre-commit hook did not run');

    writeExec(
      joinGit(clean, '.git', 'hooks', 'pre-commit'),
      `#!/bin/sh\necho ran >> ${JSON.stringify(localMarker)}\nexit 0\n`
    );
    fs.writeFileSync(joinGit(clean, 'data.txt'), 'two\n');
    assert.equal(pairsNamed(await childEnv(clean), 'core.hooksPath').length, 0);
    const before = count(globalMarker);
    const again = await execTool.execute(
      { command: 'git add data.txt && git commit -qm hooked-again', timeout_ms: 20000 },
      ctx(clean)
    );
    assert.doesNotMatch(again, /exit_code:/);
    assert.equal(count(localMarker), 0, 'repo pre-commit hook ran');
    assert.ok(count(globalMarker) > before, 'global hook did not run when .git/hooks is unused');

    const pointed = joinGit(root, 'pointed');
    initRepo(pointed);
    const evilHooks = joinGit(root, 'evil-hooks');
    fs.mkdirSync(evilHooks);
    writeExec(
      joinGit(evilHooks, 'pre-commit'),
      `#!/bin/sh\necho ran >> ${JSON.stringify(evilMarker)}\nexit 0\n`
    );
    git(pointed, ['config', 'core.hooksPath', evilHooks]);
    fs.writeFileSync(joinGit(pointed, 'data.txt'), 'one\n');
    assert.deepEqual(
      pairsNamed(await childEnv(pointed), 'core.hooksPath').map((pair) => pair.value),
      [globalHooks]
    );
    const beforePointed = count(globalMarker);
    const pointedCommit = await execTool.execute(
      { command: 'git add data.txt && git commit -qm pointed', timeout_ms: 20000 },
      { ...ctx(pointed), sessionKey: 'exec-git-hooks-pointed' }
    );
    assert.doesNotMatch(pointedCommit, /exit_code:/);
    assert.match(pointedCommit, /Repo hooks in an untrusted workspace were not run/);
    assert.equal(count(evilMarker), 0, 'local hooksPath program ran');
    assert.ok(count(globalMarker) > beforePointed, 'global hook was not restored');
    const pointedAgain = await execTool.execute(
      { command: 'git status --porcelain', timeout_ms: 20000 },
      { ...ctx(pointed), sessionKey: 'exec-git-hooks-pointed' }
    );
    assert.doesNotMatch(pointedAgain, /Repo hooks in an untrusted workspace were not run/);

    useIsolatedGitConfig();
    const disabled = joinGit(root, 'disabled');
    initRepo(disabled);
    const disabledMarker = joinGit(root, 'disabled-hook.marker');
    writeExec(
      joinGit(disabled, '.git', 'hooks', 'pre-commit'),
      `#!/bin/sh\necho ran >> ${JSON.stringify(disabledMarker)}\nexit 0\n`
    );
    assert.deepEqual(
      pairsNamed(await childEnv(disabled), 'core.hooksPath').map((pair) => pair.value),
      [hooksPath]
    );
    fs.writeFileSync(joinGit(disabled, 'data.txt'), 'one\n');
    const savedLocale = {
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LC_MESSAGES: process.env.LC_MESSAGES,
    };
    process.env.LANG = 'zh_CN.UTF-8';
    process.env.LC_ALL = 'zh_CN.UTF-8';
    process.env.LC_MESSAGES = 'zh_CN.UTF-8';
    try {
      const zh = await execTool.execute(
        { command: 'git add data.txt && git commit -qm disabled', timeout_ms: 20000 },
        { ...ctx(disabled), sessionKey: 'exec-git-hooks-zh' }
      );
      assert.doesNotMatch(zh, /exit_code:/);
      assert.match(zh, /未受信任工作区中的仓库钩子未运行/);
      assert.equal(count(disabledMarker), 0, 'repo hook ran without a user hooksPath');
    } finally {
      for (const [key, value] of Object.entries(savedLocale)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  } finally {
    restoreGitConfig();
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

function gitText(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL || '/dev/null',
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM || '/dev/null',
      GIT_PAGER: 'cat',
    },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function execDiffBody(text) {
  const failed = text.match(/^Command failed \(exit \d+\):\n([\s\S]*)$/);
  return (failed ? failed[1] : text).trim();
}

test('untrusted exec git diff matches --no-ext-diff and does not run repo diff programs', async () => {
  const root = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-extdiff-'));
  const configDir = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-extdiff-cfg-'));
  const marker = joinGit(root, 'diff.marker');
  const script = joinGit(root, 'evil-diff.sh');
  try {
    useConfigDir(configDir);
    useIsolatedGitConfig();
    const ws = joinGit(root, 'ws');
    initRepo(ws);
    writeExec(script, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 1\n`);
    fs.writeFileSync(joinGit(ws, '.gitattributes'), '* diff=evil\n');
    fs.writeFileSync(joinGit(ws, 'data.txt'), 'one\n');
    fs.writeFileSync(joinGit(ws, 'hello world.txt'), 'space\n');
    const metacharName = process.platform === 'win32' ? 'a&b.txt' : 'a|b.txt';
    fs.writeFileSync(joinGit(ws, metacharName), 'metachar\n');
    fs.writeFileSync(joinGit(ws, 'binary.bin'), Buffer.from([0, 1, 2, 3, 255]));
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-qm', 'base']);
    git(ws, ['config', 'diff.external', script]);
    git(ws, ['config', 'diff.evil.command', script]);
    fs.writeFileSync(joinGit(ws, 'data.txt'), 'two\n');
    fs.writeFileSync(joinGit(ws, 'hello world.txt'), 'space 2\n');
    fs.rmSync(joinGit(ws, metacharName));
    fs.writeFileSync(joinGit(ws, 'binary.bin'), Buffer.from([0, 1, 2, 9, 255]));
    fs.writeFileSync(joinGit(ws, 'new file.txt'), 'added\n');

    const external = pairsNamed(await childEnv(ws), 'diff.external');
    const command = pairsNamed(await childEnv(ws), 'diff.evil.command');
    assert.equal(external.length, 1);
    assert.equal(command.length, 1);
    assert.equal(external[0].value, command[0].value);
    const builtinScript = builtinScriptPath(external[0].value);
    assert.match(builtinScript, /moss-git-builtin-diff\.sh$/);
    assert.ok(builtinScript.includes('/git-builtin-diff/'));
    assert.ok(!builtinScript.startsWith(joinGit(os.tmpdir(), 'moss-git-builtin-diff.sh')));
    const scriptDir = fs.lstatSync(path.dirname(builtinScript));
    assert.equal(scriptDir.isSymbolicLink(), false);
    assert.equal(scriptDir.isDirectory(), true);
    assertPrivateMode(path.dirname(builtinScript), builtinScript);

    const ref = gitText(ws, ['--no-pager', 'diff', '--no-ext-diff', '--no-color']);
    assert.equal(count(marker), 0, 'reference diff ran the repo diff program');
    assert.equal(ref.stderr, '');
    const got = await execTool.execute(
      { command: 'git --no-pager diff --no-color', timeout_ms: 20000 },
      { ...ctx(ws), sessionKey: 'exec-git-extdiff' }
    );
    assert.equal(count(marker), 0, 'untrusted git diff ran the repo diff program');
    assert.equal(execDiffBody(got), ref.stdout.trim());
    assert.doesNotMatch(got, /Repo hooks/);

    const refStat = gitText(ws, ['--no-pager', 'diff', '--stat', '--no-ext-diff', '--no-color']);
    const gotStat = await execTool.execute(
      { command: 'git --no-pager diff --stat --no-color', timeout_ms: 20000 },
      { ...ctx(ws), sessionKey: 'exec-git-extdiff' }
    );
    assert.equal(count(marker), 0);
    assert.equal(execDiffBody(gotStat), refStat.stdout.trim());

    git(ws, ['add', '-A']);
    const refCached = gitText(ws, [
      '--no-pager',
      'diff',
      '--cached',
      '--no-ext-diff',
      '--no-color',
    ]);
    const gotCached = await execTool.execute(
      { command: 'git --no-pager diff --cached --no-color', timeout_ms: 20000 },
      { ...ctx(ws), sessionKey: 'exec-git-extdiff' }
    );
    assert.equal(count(marker), 0);
    assert.equal(execDiffBody(gotCached), refCached.stdout.trim());

    git(ws, ['reset', '--hard', '-q']);
    git(ws, ['mv', 'data.txt', 'renamed.txt']);
    const refRename = gitText(ws, [
      '--no-pager',
      'diff',
      '--cached',
      '--find-renames',
      '--no-ext-diff',
      '--no-color',
    ]);
    const gotRename = await execTool.execute(
      { command: 'git --no-pager diff --cached --find-renames --no-color', timeout_ms: 20000 },
      { ...ctx(ws), sessionKey: 'exec-git-extdiff' }
    );
    assert.equal(count(marker), 0, 'rename diff ran the repo diff program');
    assert.match(refRename.stdout, /rename from data\.txt/);
    assert.equal(execDiffBody(gotRename), refRename.stdout.trim());
    assert.doesNotMatch(gotRename, /git-blob-/);

    git(ws, ['reset', '--hard', '-q']);
    git(ws, ['update-index', '--chmod=+x', 'data.txt']);
    const refMode = gitText(ws, ['--no-pager', 'diff', '--cached', '--no-ext-diff', '--no-color']);
    const gotMode = await execTool.execute(
      { command: 'git --no-pager diff --cached --no-color', timeout_ms: 20000 },
      { ...ctx(ws), sessionKey: 'exec-git-extdiff' }
    );
    assert.equal(count(marker), 0, 'chmod diff ran the repo diff program');
    assert.match(refMode.stdout, /old mode /);
    assert.match(refMode.stdout, /new mode /);
    assert.equal(execDiffBody(gotMode), refMode.stdout.trim());

    git(ws, ['reset', '--hard', '-q']);
    const quotedNames =
      process.platform === 'win32'
        ? ['a&b ü.txt', "say'hi é.txt", 'café.txt']
        : ['a\tb.txt', 'say"hi.txt', 'café.txt'];
    for (const name of quotedNames) fs.writeFileSync(joinGit(ws, name), 'v1\n');
    git(ws, ['add', '-A']);
    git(ws, ['commit', '-qm', 'quoted']);
    for (const name of quotedNames) fs.writeFileSync(joinGit(ws, name), 'v2\n');
    const refQuoted = gitText(ws, ['--no-pager', 'diff', '--no-ext-diff', '--no-color']);
    const gotQuoted = await execTool.execute(
      { command: 'git --no-pager diff --no-color', timeout_ms: 20000 },
      { ...ctx(ws), sessionKey: 'exec-git-extdiff' }
    );
    assert.equal(count(marker), 0, 'quoted-path diff ran the repo diff program');
    if (process.platform === 'win32') {
      assert.match(refQuoted.stdout, /\\303\\274/);
      assert.match(refQuoted.stdout, /a&b/);
      assert.match(refQuoted.stdout, /say'hi/);
    } else {
      assert.match(refQuoted.stdout, /\\t/);
      assert.match(refQuoted.stdout, /\\"/);
    }
    assert.match(refQuoted.stdout, /\\303\\251/);
    assert.equal(execDiffBody(gotQuoted), refQuoted.stdout.trim());
    assert.doesNotMatch(gotQuoted, /git-blob-/);
  } finally {
    restoreGitConfig();
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('commandInvokesGit matches a git command word, not a git substring', () => {
  assert.equal(commandInvokesGit('git status'), true);
  assert.equal(commandInvokesGit('git'), true);
  assert.equal(commandInvokesGit('/usr/bin/git diff'), true);
  assert.equal(commandInvokesGit('FOO=1 BAR=2 /usr/bin/git'), true);
  assert.equal(commandInvokesGit('ls && git status'), true);
  assert.equal(commandInvokesGit('ls; git status'), true);
  assert.equal(commandInvokesGit('echo keep | git apply'), true);
  assert.equal(commandInvokesGit('(git status)'), true);
  assert.equal(commandInvokesGit('echo $(git status)'), true);
  assert.equal(commandInvokesGit('echo "$(git rev-parse HEAD)"'), true);
  assert.equal(commandInvokesGit('echo git'), false);
  assert.equal(commandInvokesGit('echo "git status"'), false);
  assert.equal(commandInvokesGit("echo 'git status'"), false);
  assert.equal(commandInvokesGit('cat .gitignore'), false);
  assert.equal(commandInvokesGit('ls gitignore'), false);
  assert.equal(commandInvokesGit('gitignore'), false);
  assert.equal(commandInvokesGit('echo git && true'), false);
  assert.equal(commandInvokesGit('bash -c "git status"'), true);
  assert.equal(commandInvokesGit("sh -c 'git diff'"), true);
  assert.equal(commandInvokesGit('bash -lc "git status"'), true);
  assert.equal(commandInvokesGit('bash -c "echo git"'), false);
  assert.equal(commandInvokesGit('bash -c "echo git status"'), false);
  assert.equal(commandInvokesGit('xargs git'), true);
  assert.equal(commandInvokesGit('xargs -n 1 git'), true);
  assert.equal(commandInvokesGit('xargs -n1 git diff'), true);
  assert.equal(commandInvokesGit('xargs echo git'), false);
  assert.equal(commandInvokesGit('xargs gitignore'), false);
  assert.equal(commandInvokesGit('echo xargs git'), false);
});

test('repo hook notice waits for a command that actually runs git', async () => {
  const root = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-notice-'));
  const configDir = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-notice-cfg-'));
  try {
    useConfigDir(configDir);
    useIsolatedGitConfig();
    const ws = joinGit(root, 'ws');
    initRepo(ws);
    writeExec(joinGit(ws, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const session = { ...ctx(ws), sessionKey: 'exec-git-notice-once' };
    const listed = await execTool.execute(
      { command: 'echo gitignore && ls .git', timeout_ms: 20000 },
      session
    );
    assert.doesNotMatch(listed, /Repo hooks/);
    const status = await execTool.execute(
      { command: 'git status --porcelain', timeout_ms: 20000 },
      session
    );
    assert.match(status, /Repo hooks in an untrusted workspace were not run/);
    const again = await execTool.execute(
      { command: 'git status --porcelain', timeout_ms: 20000 },
      session
    );
    assert.doesNotMatch(again, /Repo hooks/);
  } finally {
    restoreGitConfig();
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('untrusted external diff fails closed when the builtin script path is not safe', async () => {
  const root = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-diff-closed-'));
  const configDir = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-diff-closed-cfg-'));
  const marker = joinGit(root, 'diff.marker');
  try {
    useConfigDir(configDir);
    useIsolatedGitConfig();
    const attack = joinGit(root, 'attack');
    fs.mkdirSync(attack);
    writeExec(
      joinGit(attack, 'moss-git-builtin-diff.sh'),
      `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 1\n`
    );
    fs.symlinkSync(
      attack,
      joinGit(configDir, 'git-builtin-diff'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const ws = joinGit(root, 'ws');
    initRepo(ws);
    const evil = joinGit(root, 'evil-diff.sh');
    writeExec(evil, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 1\n`);
    fs.writeFileSync(joinGit(ws, 'data.txt'), 'one\n');
    git(ws, ['add', 'data.txt']);
    git(ws, ['commit', '-qm', 'base']);
    git(ws, ['config', 'diff.external', evil]);
    git(ws, ['config', 'diff.evil.command', evil]);
    fs.writeFileSync(joinGit(ws, '.gitattributes'), '* diff=evil\n');
    fs.writeFileSync(joinGit(ws, 'data.txt'), 'two\n');
    assert.deepEqual(
      pairsNamed(await childEnv(ws), 'diff.external').map((pair) => pair.value),
      ['false']
    );
    assert.deepEqual(
      pairsNamed(await childEnv(ws), 'diff.evil.command').map((pair) => pair.value),
      ['false']
    );
    const session = { ...ctx(ws), sessionKey: 'exec-git-diff-closed' };
    const skipped = await execTool.execute({ command: 'echo git', timeout_ms: 20000 }, session);
    assert.doesNotMatch(skipped, /external diff was disabled/);
    const got = await execTool.execute(
      { command: 'git --no-pager diff --no-color', timeout_ms: 20000 },
      session
    );
    assert.equal(count(marker), 0, 'fail-closed diff ran a repo or planted program');
    assert.match(got, /The repo's external diff was disabled/);
    const again = await execTool.execute(
      { command: 'git --no-pager diff --no-color', timeout_ms: 20000 },
      session
    );
    assert.match(again, /external diff died/);
    assert.match(again, /The repo's external diff was disabled/);

    const looseDir = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-diff-loose-'));
    const looseScriptDir = joinGit(looseDir, 'git-builtin-diff');
    fs.mkdirSync(looseScriptDir, { mode: 0o777 });
    fs.chmodSync(looseScriptDir, 0o777);
    const planted = joinGit(looseScriptDir, 'moss-git-builtin-diff.sh');
    fs.symlinkSync(evil, planted);
    useConfigDir(looseDir);
    const tightened = pairsNamed(await childEnv(ws), 'diff.external');
    assert.equal(tightened.length, 1);
    const tightenedScript = builtinScriptPath(tightened[0].value);
    assert.match(tightenedScript, /moss-git-builtin-diff\.sh$/);
    const tightenedStat = fs.lstatSync(path.dirname(tightenedScript));
    assert.equal(tightenedStat.isDirectory(), true);
    assertPrivateMode(path.dirname(tightenedScript), tightenedScript);
    assert.equal(fs.lstatSync(tightenedScript).isSymbolicLink(), false);
    assert.match(fs.readFileSync(tightenedScript, 'utf8'), /xfrm-msg/);
    const replaced = await execTool.execute(
      { command: 'git --no-pager diff --no-color', timeout_ms: 20000 },
      { ...ctx(ws), sessionKey: 'exec-git-diff-tightened' }
    );
    assert.equal(count(marker), 0, 'replaced symlink diff ran the planted program');
    assert.doesNotMatch(replaced, /external diff was disabled/);
    fs.rmSync(looseDir, { recursive: true, force: true });
  } finally {
    unlinkFixtureLink(joinGit(configDir, 'git-builtin-diff'));
    restoreGitConfig();
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a long git diff keeps the hook notice in the TUI row and stream-json preview', async () => {
  const root = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-preview-'));
  const configDir = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-preview-cfg-'));
  try {
    useConfigDir(configDir);
    useIsolatedGitConfig();
    const ws = joinGit(root, 'ws');
    initRepo(ws);
    writeExec(joinGit(ws, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const body = Array.from({ length: 40 }, (_, i) => `line ${i} ${'x'.repeat(24)}`).join('\n');
    fs.writeFileSync(joinGit(ws, 'data.txt'), `${body}\n`);
    git(ws, ['add', 'data.txt']);
    git(ws, ['commit', '-qm', 'base']);
    fs.writeFileSync(joinGit(ws, 'data.txt'), `${body}\nextra\n`.repeat(2));
    const got = await execTool.execute(
      { command: 'git --no-pager diff --no-color', timeout_ms: 20000 },
      { ...ctx(ws), sessionKey: 'exec-git-preview-notice' }
    );
    const notice = '[moss] Repo hooks in an untrusted workspace were not run.';
    const noticeAt = got.indexOf(notice);
    assert.ok(noticeAt > 500, `notice was not past the 500-char preview (at ${noticeAt})`);
    const preview = formatToolResultForSsePreview(got, false);
    assert.ok(preview.length < got.length, 'the stream preview was not truncated');
    assert.ok(preview.startsWith(got.slice(0, 500)));
    assert.match(preview, /Repo hooks in an untrusted workspace were not run/);

    const store = createTuiStore();
    beginRun(store);
    applyAgentEvent(store, {
      type: 'tool_start',
      toolName: 'exec',
      toolCallId: 'long-diff',
      input: { command: 'git diff' },
    });
    applyAgentEvent(store, {
      type: 'tool_end',
      toolName: 'exec',
      toolCallId: 'long-diff',
      isError: false,
      result: preview,
    });
    const noticeRow = store.rows.find((row) => row.kind === 'system');
    assert.equal(noticeRow?.text, notice, 'the hook notice is its own TUI row');
    const resultRow = store.rows.find((row) => row.kind === 'result');
    assert.doesNotMatch(resultRow?.text ?? '', /\[moss\] Repo hooks/);
    const painted = renderTranscriptRows(store.rows, 80, false)
      .map((line) => line.text)
      .join('\n');
    assert.match(painted, /Repo hooks in an untrusted workspace were not run/);

    const state = createHeadlessPrintState({ sessionId: 'preview-notice' });
    const events = formatHeadlessStreamEvent(state, {
      type: 'tool_end',
      toolCallId: 'long-diff',
      toolName: 'exec',
      result: preview,
      isError: false,
    });
    const json = events.map((event) => JSON.stringify(event)).join('\n');
    assert.match(json, /"type":"user"/);
    assert.match(json, /Repo hooks in an untrusted workspace were not run/);
  } finally {
    restoreGitConfig();
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('external diff died keeps its explanation after the once-per-session notice', async () => {
  const root = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-died-'));
  const configDir = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-died-cfg-'));
  const marker = joinGit(root, 'diff.marker');
  try {
    useConfigDir(configDir);
    useIsolatedGitConfig();
    fs.symlinkSync(
      root,
      joinGit(configDir, 'git-builtin-diff'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const ws = joinGit(root, 'ws');
    initRepo(ws);
    const evil = joinGit(root, 'evil-diff.sh');
    writeExec(evil, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 1\n`);
    fs.writeFileSync(joinGit(ws, 'data.txt'), 'one\n');
    git(ws, ['add', 'data.txt']);
    git(ws, ['commit', '-qm', 'base']);
    git(ws, ['config', 'diff.external', evil]);
    fs.writeFileSync(joinGit(ws, 'data.txt'), 'two\n');
    const session = { ...ctx(ws), sessionKey: 'exec-git-diff-died' };
    const status = await execTool.execute(
      { command: 'git status --porcelain', timeout_ms: 20000 },
      session
    );
    assert.match(status, /The repo's external diff was disabled/);
    assert.doesNotMatch(status, /external diff died/);
    const diff = await execTool.execute(
      { command: 'git --no-pager diff --no-color', timeout_ms: 20000 },
      session
    );
    assert.match(diff, /external diff died/);
    assert.match(diff, /The repo's external diff was disabled/);
    assert.equal(count(marker), 0, 'disabled external diff ran the repo program');
    const again = await execTool.execute(
      { command: 'git --no-pager diff --no-color', timeout_ms: 20000 },
      session
    );
    assert.match(again, /external diff died/);
    assert.match(again, /The repo's external diff was disabled/);
  } finally {
    unlinkFixtureLink(joinGit(configDir, 'git-builtin-diff'));
    restoreGitConfig();
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test(`${process.platform === 'win32' ? 'a write-denied' : 'a group-writable'} or symlinked Moss config dir disables the repo external diff`, async () => {
  const root = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-parent-'));
  const marker = joinGit(root, 'diff.marker');
  let deniedDir;
  let deniedSid;
  try {
    useIsolatedGitConfig();
    const ws = joinGit(root, 'ws');
    initRepo(ws);
    const evil = joinGit(root, 'evil-diff.sh');
    writeExec(evil, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 1\n`);
    fs.writeFileSync(joinGit(ws, 'data.txt'), 'one\n');
    git(ws, ['add', 'data.txt']);
    git(ws, ['commit', '-qm', 'base']);
    git(ws, ['config', 'diff.external', evil]);
    fs.writeFileSync(joinGit(ws, 'data.txt'), 'two\n');

    const writable = fs.mkdtempSync(joinGit(root, 'writable-'));
    if (process.platform === 'win32') {
      deniedDir = path.resolve(writable);
      const relative = path.relative(path.resolve(os.tmpdir()), deniedDir);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      assert.equal(path.dirname(deniedDir), path.resolve(root));
      deniedSid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      }).match(/S-1-5-[\d-]+/)?.[0];
      assert.ok(deniedSid);
      execFileSync('icacls.exe', [deniedDir, '/deny', `*${deniedSid}:(W)`], {
        stdio: 'pipe',
        timeout: 5000,
        windowsHide: true,
      });
      assert.throws(
        () => fs.writeFileSync(joinGit(deniedDir, 'denied-probe'), 'denied'),
        (error) => ['EPERM', 'EACCES'].includes(error.code)
      );
    } else {
      fs.chmodSync(writable, 0o777);
    }
    useConfigDir(writable);
    assert.deepEqual(
      pairsNamed(await childEnv(ws), 'diff.external').map((pair) => pair.value),
      ['false']
    );
    if (process.platform !== 'win32') assert.equal(fs.lstatSync(writable).mode & 0o777, 0o777);
    const ran = await execTool.execute(
      { command: 'git --no-pager diff --no-color', timeout_ms: 20000 },
      { ...ctx(ws), sessionKey: 'exec-git-parent-writable' }
    );
    assert.equal(count(marker), 0, 'unsafe or write-denied config install ran the repo diff');
    assert.match(ran, /The repo's external diff was disabled/);

    const safe = fs.mkdtempSync(joinGit(root, 'safe-'));
    fs.chmodSync(safe, 0o755);
    useConfigDir(safe);
    const installed = pairsNamed(await childEnv(ws), 'diff.external');
    assert.match(builtinScriptPath(installed[0].value), /moss-git-builtin-diff\.sh$/);
    if (process.platform !== 'win32') assert.equal(fs.lstatSync(safe).mode & 0o777, 0o755);
    else assert.equal(fs.lstatSync(safe).isDirectory(), true);
    const link = joinGit(root, 'cfg-link');
    fs.symlinkSync(safe, link, process.platform === 'win32' ? 'junction' : 'dir');
    useConfigDir(link);
    assert.deepEqual(
      pairsNamed(await childEnv(ws), 'diff.external').map((pair) => pair.value),
      ['false']
    );
    const followed = await execTool.execute(
      { command: 'git --no-pager diff --no-color', timeout_ms: 20000 },
      { ...ctx(ws), sessionKey: 'exec-git-parent-link' }
    );
    assert.equal(count(marker), 0, 'symlinked config dir ran the repo diff');
    assert.match(followed, /external diff died/);
    assert.match(followed, /The repo's external diff was disabled/);
  } finally {
    if (deniedSid) {
      execFileSync('icacls.exe', [deniedDir, '/remove:d', `*${deniedSid}`], {
        stdio: 'pipe',
        timeout: 5000,
        windowsHide: true,
      });
      const restored = joinGit(deniedDir, 'restored-probe');
      fs.writeFileSync(restored, 'restored');
      assert.equal(fs.readFileSync(restored, 'utf8'), 'restored');
      fs.unlinkSync(restored);
    }
    restoreGitConfig();
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a project MOSS_TRUST_WORKSPACE after startup capture does not grant git trust', () => {
  const root = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-env-'));
  const configDir = fs.mkdtempSync(joinGit(os.tmpdir(), 'moss-exec-git-env-cfg-'));
  try {
    const snapshot = { ...process.env, MOSS_CONFIG_DIR: configDir };
    delete snapshot.MOSS_TRUST_WORKSPACE;
    captureEnvBeforeDotenv(snapshot);
    process.env.MOSS_TRUST_WORKSPACE = '1';
    process.env.MOSS_CONFIG_DIR = configDir;
    assert.equal(isWorkspaceTrusted(root), false);
    fs.writeFileSync(
      joinGit(configDir, 'workspace-trust.json'),
      `${JSON.stringify({ [workspaceTrustKey(root)]: true }, null, 2)}\n`
    );
    assert.equal(isWorkspaceTrusted(root), true);
  } finally {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
