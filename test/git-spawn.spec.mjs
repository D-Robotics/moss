/**
 * A repo `.git/config` can name a program in core.fsmonitor / diff.external.
 * Startup git status and /diff must not run it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildEnvironmentContextLayer } from '../dist/context/environment.js';
import { buildGitStatusSnapshot } from '../dist/context/git-status-snapshot.js';
import {
  configOverridesForExecutableKeys,
  hardenedGitArgs,
  runWorkingTreeDiff,
} from '../dist/utils/git-spawn.js';

test('hardened git args override exec keys and keep system config', () => {
  const readOnly = hardenedGitArgs(['status', '--porcelain']);
  assert.deepEqual(readOnly.slice(0, 12), [
    '-c',
    'core.fsmonitor=',
    '-c',
    `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
    '-c',
    'core.sshCommand=',
    '-c',
    'diff.external=',
    '-c',
    'core.pager=cat',
    '-c',
    'credential.helper=',
  ]);
  assert.deepEqual(readOnly.slice(12), ['status', '--porcelain']);
  const diffArgs = hardenedGitArgs(['--no-pager', 'diff', '--stat']);
  assert.ok(diffArgs.includes('--no-ext-diff'));
  assert.ok(diffArgs.includes('--no-textconv'));
  assert.ok(diffArgs.indexOf('diff') < diffArgs.indexOf('--no-ext-diff'));
  assert.ok(diffArgs.indexOf('diff') < diffArgs.indexOf('--no-textconv'));
  const mutating = hardenedGitArgs(['apply', '--3way', 'p.patch'], { readOnly: false });
  assert.ok(mutating.includes('core.fsmonitor='));
  assert.ok(
    mutating.includes(`core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`)
  );
  assert.equal(mutating.includes('credential.helper='), false);
  assert.equal(mutating.includes('GIT_CONFIG_NOSYSTEM'), false);
  assert.equal(readOnly.includes('GIT_CONFIG_NOSYSTEM'), false);
});

test('startup git status and /diff do not run core.fsmonitor', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-fsmonitor-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'moss@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Moss Test'], { cwd: dir, stdio: 'ignore' });
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });

  const marker = path.join(dir, 'FSMONITOR_RAN');
  const script = path.join(dir, 'fsmonitor.sh');
  await fs.writeFile(script, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 0\n`);
  await fs.chmod(script, 0o755);
  execFileSync('git', ['config', 'core.fsmonitor', script], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'diff.external', script], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'core.pager', script], { cwd: dir, stdio: 'ignore' });
  await fs.rm(marker, { force: true });

  execFileSync('git', ['status', '--porcelain'], { cwd: dir, stdio: 'ignore' });
  assert.equal(
    await fs
      .readFile(marker, 'utf8')
      .then((text) => text.includes('ran'))
      .catch(() => false),
    true,
    'fixture: raw git status should run core.fsmonitor'
  );
  await fs.rm(marker, { force: true });

  const layer = await buildEnvironmentContextLayer(dir);
  assert.equal(await markerWritten(marker), false, 'startup git status ran core.fsmonitor');
  assert.match(layer, /Git branch/);

  await fs.writeFile(path.join(dir, 'README.md'), 'hello\nchanged\n');
  const diff = await runWorkingTreeDiff(dir);
  assert.equal(await markerWritten(marker), false, '/diff ran core.fsmonitor or diff.external');
  assert.equal(diff.exitCode, 0);
  assert.match(diff.output, /README\.md/);
  assert.match(diff.output, /\+changed/);

  const snap = await buildGitStatusSnapshot(dir);
  assert.equal(await markerWritten(marker), false, 'live git status ran core.fsmonitor');
  assert.match(snap, /README\.md/);
});

test('config overrides blank local and worktree drivers only', () => {
  const args = configOverridesForExecutableKeys(
    [
      'local\tfilter.x.clean /tmp/clean.sh',
      'worktree\tfilter.x.smudge /tmp/smudge.sh',
      'local\tfilter.x.process /tmp/process.sh',
      'local\tdiff.x.textconv /tmp/textconv.sh',
      'worktree\tdiff.x.command /tmp/command.sh',
      'local\tcore.fsmonitor /tmp/fs.sh',
      'system\tfilter.lfs.clean git-lfs clean -- %f',
      'global\tfilter.global.clean /tmp/global.sh',
      'command\tfilter.evil.clean /tmp/evil.sh',
      'local\tnot.a.program true',
    ].join('\n')
  );
  assert.ok(args.includes('filter.x.clean='));
  assert.ok(args.includes('filter.x.smudge='));
  assert.ok(args.includes('filter.x.process='));
  assert.ok(args.includes('filter.x.required=false'));
  assert.ok(args.includes('diff.x.textconv='));
  assert.ok(args.includes('diff.x.command='));
  assert.ok(args.includes('core.fsmonitor='));
  assert.equal(args.includes('filter.lfs.clean='), false);
  assert.equal(args.includes('filter.lfs.required=false'), false);
  assert.equal(args.includes('filter.global.clean='), false);
  assert.equal(args.includes('filter.evil.clean='), false);
  assert.equal(args.includes('not.a.program='), false);
});

test('startup git status and /diff do not run filter.clean or diff.textconv', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-filter-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'moss@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Moss Test'], { cwd: dir, stdio: 'ignore' });
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\n');
  await fs.writeFile(path.join(dir, '.gitattributes'), '* filter=mossmarker diff=mossmarker\n');
  execFileSync('git', ['add', 'README.md', '.gitattributes'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });

  const cleanMarker = path.join(dir, 'CLEAN_RAN');
  const textMarker = path.join(dir, 'TEXT_RAN');
  const cleanScript = path.join(dir, 'clean.sh');
  const textScript = path.join(dir, 'text.sh');
  await fs.writeFile(cleanScript, `#!/bin/sh\necho ran >> ${JSON.stringify(cleanMarker)}\ncat\n`);
  await fs.writeFile(
    textScript,
    `#!/bin/sh\necho ran >> ${JSON.stringify(textMarker)}\ncat "$1"\n`
  );
  await fs.chmod(cleanScript, 0o755);
  await fs.chmod(textScript, 0o755);
  execFileSync('git', ['config', 'filter.mossmarker.clean', cleanScript], {
    cwd: dir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'filter.mossmarker.smudge', '/bin/cat'], {
    cwd: dir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'filter.mossmarker.required', 'true'], {
    cwd: dir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'diff.mossmarker.textconv', textScript], {
    cwd: dir,
    stdio: 'ignore',
  });
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\nchanged\n');
  await fs.rm(cleanMarker, { force: true });
  await fs.rm(textMarker, { force: true });

  execFileSync('git', ['status', '--porcelain'], { cwd: dir, stdio: 'ignore' });
  assert.equal(
    await markerWritten(cleanMarker),
    true,
    'fixture: raw git status should run filter.clean'
  );
  await fs.rm(cleanMarker, { force: true });

  const layer = await buildEnvironmentContextLayer(dir);
  assert.equal(await markerWritten(cleanMarker), false, 'startup git status ran filter.clean');
  assert.equal(await markerWritten(textMarker), false, 'startup git status ran diff.textconv');
  assert.match(layer, /Git branch/);

  execFileSync('git', ['--no-pager', 'diff', '--', 'README.md'], { cwd: dir, stdio: 'ignore' });
  assert.equal(
    await markerWritten(textMarker),
    true,
    'fixture: raw git diff should run diff.textconv'
  );
  await fs.rm(cleanMarker, { force: true });
  await fs.rm(textMarker, { force: true });

  const diff = await runWorkingTreeDiff(dir);
  assert.equal(await markerWritten(cleanMarker), false, '/diff ran filter.clean');
  assert.equal(await markerWritten(textMarker), false, '/diff ran diff.textconv');
  assert.equal(diff.exitCode, 0, diff.output);
  assert.match(diff.output, /\+changed/);

  const snap = await buildGitStatusSnapshot(dir);
  assert.equal(await markerWritten(cleanMarker), false, 'live git status ran filter.clean');
  assert.match(snap, /README\.md/);
});

test('startup git status and /diff do not run an include.path filter', async (t) => {
  const repo = await initDirtyFilterRepo(t, 'moss-include-');
  const included = path.join(repo.dir, 'included.cfg');
  await fs.writeFile(included, filterConfig(repo.script));
  execFileSync('git', ['config', '--local', 'include.path', included], {
    cwd: repo.dir,
    stdio: 'ignore',
  });
  await assertFilterStaysOff(repo);
});

test('startup git status and /diff do not run an includeIf gitdir filter', async (t) => {
  // macOS /tmp is a symlink to /private/tmp. git includeIf gitdir: matches the
  // realpath of the git dir, so a pattern written with the logical path never
  // arms the filter (and never proves Moss neutralized it).
  const realParent = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-includeif-real-'));
  const linkParent = path.join(
    os.tmpdir(),
    `moss-includeif-link-${process.pid}-${Date.now().toString(36)}`
  );
  await fs.symlink(realParent, linkParent);
  t.after(() => fs.rm(linkParent, { force: true }));
  t.after(() => fs.rm(realParent, { recursive: true, force: true }));

  const shapes = [
    {
      name: 'gitdir',
      pattern: (gitDir) => `gitdir:${gitDir}`,
    },
    {
      name: 'gitdir-i',
      pattern: (gitDir) => `gitdir/i:${gitDir.toUpperCase()}`,
    },
    {
      name: 'trailing-slash',
      pattern: (gitDir) => `gitdir:${path.dirname(gitDir)}/`,
    },
  ];
  for (const shape of shapes) {
    const repo = await initDirtyFilterRepo(t, `moss-includeif-${shape.name}-`, linkParent);
    const included = path.join(repo.dir, 'included-if.cfg');
    await fs.writeFile(included, filterConfig(repo.script));
    const logicalGitDir = path.join(repo.dir, '.git');
    const gitDir = await fs.realpath(logicalGitDir);
    assert.notEqual(gitDir, logicalGitDir);
    const includedReal = await fs.realpath(included);
    await fs.appendFile(
      path.join(gitDir, 'config'),
      `\n[includeIf "${shape.pattern(gitDir)}"]\n\tpath = ${includedReal}\n`
    );
    await assertFilterStaysOff(repo);
  }
});

test('startup git status and /diff do not run a config.worktree filter', async (t) => {
  const repo = await initDirtyFilterRepo(t, 'moss-worktree-cfg-');
  execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], {
    cwd: repo.dir,
    stdio: 'ignore',
  });
  await fs.writeFile(path.join(repo.dir, '.git', 'config.worktree'), filterConfig(repo.script));
  await assertFilterStaysOff(repo);
});

test('project .env GIT_CONFIG does not run a filter', async (t) => {
  const savedGitConfig = process.env.GIT_CONFIG;
  const savedGitDir = process.env.GIT_DIR;
  delete process.env.GIT_CONFIG;
  delete process.env.GIT_DIR;
  const { loadEnvFile } = await import('../dist/cli/config.js');
  const { captureEnvBeforeDotenv } = await import('../dist/utils/startup-env.js');
  const { runGit } = await import('../dist/utils/git-spawn.js');
  const { ProcessError } = await import('../dist/utils/run-process.js');

  const repo = await initDirtyFilterRepo(t, 'moss-git-config-');
  const evilCfg = path.join(repo.dir, 'evil.cfg');
  await fs.writeFile(evilCfg, filterConfig(repo.script));
  await fs.writeFile(path.join(repo.dir, '.env'), `GIT_CONFIG=${evilCfg}\n`);

  try {
    const before = process.env.GIT_CONFIG;
    loadEnvFile(path.join(repo.dir, '.env'));
    assert.equal(process.env.GIT_CONFIG, before);
    assert.notEqual(process.env.GIT_CONFIG, evilCfg);
    captureEnvBeforeDotenv(process.env);

    process.env.GIT_CONFIG = evilCfg;
    const listed = execFileSync('git', ['config', '--get', 'filter.mossinc.clean'], {
      cwd: repo.dir,
      env: { ...process.env, GIT_CONFIG: evilCfg },
      encoding: 'utf8',
    }).trim();
    assert.equal(listed, repo.script, 'fixture: git config should read GIT_CONFIG');

    await fs.rm(repo.marker, { force: true });
    const layer = await buildEnvironmentContextLayer(repo.dir);
    assert.equal(await markerWritten(repo.marker), false, 'startup ran GIT_CONFIG filter');
    assert.match(layer, /Git branch/);
    const diff = await runWorkingTreeDiff(repo.dir);
    assert.equal(await markerWritten(repo.marker), false, '/diff ran GIT_CONFIG filter');
    assert.equal(diff.exitCode, 0, diff.output);
    assert.match(diff.output, /\+changed/);

    let got = '';
    try {
      const result = await runGit(
        ['config', '--includes', '--show-scope', '--get-regexp', '^filter\\.mossinc\\.'],
        { cwd: repo.dir, timeout: 3000 }
      );
      got = result.stdout;
    } catch (err) {
      if (!(err instanceof ProcessError)) throw err;
      got = `${err.stdout}\n${err.stderr}`;
    }
    assert.equal(got.includes(repo.script), false, got);
    assert.equal(got.includes('filter.mossinc.clean'), false, got);
  } finally {
    if (savedGitConfig === undefined) delete process.env.GIT_CONFIG;
    else process.env.GIT_CONFIG = savedGitConfig;
    if (savedGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = savedGitDir;
  }
});

test('project .env GIT_DIR does not run another repo filter', async (t) => {
  const evil = await initDirtyFilterRepo(t, 'moss-git-dir-evil-');
  execFileSync('git', ['config', 'filter.mossinc.clean', evil.script], {
    cwd: evil.dir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'filter.mossinc.smudge', '/bin/cat'], {
    cwd: evil.dir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'filter.mossinc.required', 'true'], {
    cwd: evil.dir,
    stdio: 'ignore',
  });
  const good = await initPlainRepo(t, 'moss-git-dir-good-');
  const evilGitDir = path.join(evil.dir, '.git');
  await fs.writeFile(
    path.join(good, '.env'),
    `GIT_DIR=${evilGitDir}\nGIT_CONFIG=${path.join(evil.dir, 'evil.cfg')}\n`
  );

  const { loadEnvFile } = await import('../dist/cli/config.js');
  const { captureEnvBeforeDotenv } = await import('../dist/utils/startup-env.js');
  const savedGitDir = process.env.GIT_DIR;
  const savedGitConfig = process.env.GIT_CONFIG;
  delete process.env.GIT_DIR;
  delete process.env.GIT_CONFIG;
  try {
    const before = process.env.GIT_DIR;
    loadEnvFile(path.join(good, '.env'));
    assert.equal(process.env.GIT_DIR, before);
    assert.notEqual(process.env.GIT_DIR, evilGitDir);
    captureEnvBeforeDotenv(process.env);

    await fs.rm(evil.marker, { force: true });
    execFileSync('git', ['status', '--porcelain'], {
      cwd: good,
      env: { ...process.env, GIT_DIR: evilGitDir },
      stdio: 'ignore',
    });
    assert.equal(
      await markerWritten(evil.marker),
      true,
      'fixture: GIT_DIR should run the other repo filter'
    );
    await fs.rm(evil.marker, { force: true });

    process.env.GIT_DIR = evilGitDir;
    const layer = await buildEnvironmentContextLayer(good);
    assert.equal(await markerWritten(evil.marker), false, 'startup ran GIT_DIR filter');
    assert.match(layer, /Git branch/);
    const diff = await runWorkingTreeDiff(good);
    assert.equal(await markerWritten(evil.marker), false, '/diff ran GIT_DIR filter');
    assert.equal(diff.exitCode, 0, diff.output);
  } finally {
    if (savedGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = savedGitDir;
    if (savedGitConfig === undefined) delete process.env.GIT_CONFIG;
    else process.env.GIT_CONFIG = savedGitConfig;
  }
});

test('read-only git refuses when config discovery exits 128', async (t) => {
  const { captureEnvBeforeDotenv } = await import('../dist/utils/startup-env.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-git-discovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const marker = path.join(dir, 'FILTER_RAN');
  await fs.mkdir(bin);
  const fakeGit = path.join(bin, 'git');
  await fs.writeFile(
    fakeGit,
    `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "--get-regexp" ]; then\n    echo 'fatal: discovery failed' >&2\n    exit 128\n  fi\ndone\necho ran >> ${JSON.stringify(marker)}\nexit 0\n`
  );
  await fs.chmod(fakeGit, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
  captureEnvBeforeDotenv(process.env);
  try {
    await assert.rejects(
      () => runWorkingTreeDiff(dir),
      /Refusing read-only git: config discovery exited 128/
    );
    assert.equal(await markerWritten(marker), false, 'refused git still ran the filter');
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    captureEnvBeforeDotenv(process.env);
  }
});

async function initPlainRepo(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'moss@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Moss Test'], { cwd: dir, stdio: 'ignore' });
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

async function initDirtyFilterRepo(t, prefix, parent) {
  const dir = await fs.mkdtemp(path.join(parent ?? os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'moss@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Moss Test'], { cwd: dir, stdio: 'ignore' });
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\n');
  await fs.writeFile(path.join(dir, '.gitattributes'), '* filter=mossinc\n');
  execFileSync('git', ['add', 'README.md', '.gitattributes'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\nchanged\n');
  const marker = path.join(dir, 'FILTER_RAN');
  const script = path.join(dir, 'clean.sh');
  await fs.writeFile(script, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\ncat\n`);
  await fs.chmod(script, 0o755);
  return { dir, marker, script };
}

function filterConfig(script, name = 'mossinc') {
  return `[filter "${name}"]\n\tclean = ${script}\n\tsmudge = /bin/cat\n\trequired = true\n`;
}

async function assertFilterStaysOff(repo) {
  await fs.rm(repo.marker, { force: true });
  execFileSync('git', ['status', '--porcelain'], { cwd: repo.dir, stdio: 'ignore' });
  assert.equal(
    await markerWritten(repo.marker),
    true,
    'fixture: raw git status should run filter.clean'
  );
  await fs.rm(repo.marker, { force: true });
  const layer = await buildEnvironmentContextLayer(repo.dir);
  assert.equal(await markerWritten(repo.marker), false, 'startup git status ran filter.clean');
  assert.match(layer, /Git branch/);
  const diff = await runWorkingTreeDiff(repo.dir);
  assert.equal(await markerWritten(repo.marker), false, '/diff ran filter.clean');
  assert.equal(diff.exitCode, 0, diff.output);
  assert.match(diff.output, /\+changed/);
}

async function markerWritten(marker) {
  return fs
    .readFile(marker, 'utf8')
    .then((text) => text.includes('ran'))
    .catch(() => false);
}
