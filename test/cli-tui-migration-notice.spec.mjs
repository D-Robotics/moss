import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const nodeModules = path.dirname(path.dirname(require.resolve('undici/package.json')));
const syntheticSecret = 'sk-syntheticNoticeSecret123456789Tail';

async function captureTui(t, scenario) {
  if (process.platform === 'win32') return t.skip('tmux PTY is unavailable on Windows');
  const version = spawnSync('tmux', ['-V'], {
    encoding: 'utf8',
    env: { HOME: process.env.HOME, PATH: process.env.PATH },
  });
  if (version.error?.code === 'ENOENT') return t.skip('tmux is not installed');
  assert.ifError(version.error);
  assert.equal(version.status, 0, version.stderr);

  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mt-'));
  const workspace = path.join(root, 'workspace');
  const config = path.join(root, 'config.json');
  const socket = path.join(root, 'tmux.sock');
  const dist = path.join(repo, 'dist');
  const fixture = path.join(repo, 'test', 'fixtures', 'tui-workspace-migration.mjs');
  fs.mkdirSync(workspace);
  fs.writeFileSync(config, '{}');
  if (scenario === 'collision' || scenario === 'sensitive') {
    const item =
      scenario === 'sensitive'
        ? `${syntheticSecret.slice(0, 12)}\x1b[31m${syntheticSecret.slice(12)}-الرابط`
        : 'same';
    const source = path.join(workspace, 'skill-candidates', item);
    const dest = path.join(workspace, '.moss', 'skills', 'candidates', item);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(source, 'old');
    fs.writeFileSync(dest, 'current');
  }
  if (scenario === 'cleanup') {
    fs.mkdirSync(path.join(workspace, 'agent', 'skills'), { recursive: true });
  }
  const env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    MOSS_NO_RDK_DOCS: '1',
    MOSS_NOTIFY: '0',
    ...(scenario === 'cleanup' ? { MOSS_TUI_TEST_CLEANUP: '1' } : {}),
    ...(scenario === 'sensitive' ? { MOSS_TEST_SECRET: syntheticSecret } : {}),
  };
  const tmux = (...args) =>
    spawnSync('tmux', ['-S', socket, '-f', '/dev/null', ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
  let screen = '';
  let alternate = '';
  try {
    const start = tmux(
      'new-session',
      '-d',
      '-s',
      'moss-test',
      '-x',
      '120',
      '-y',
      '40',
      '-c',
      root,
      '/usr/bin/env',
      '-u',
      'TMUX',
      process.execPath,
      '--permission',
      `--allow-fs-read=${dist}`,
      `--allow-fs-read=${nodeModules}`,
      `--allow-fs-read=${path.join(repo, 'package.json')}`,
      `--allow-fs-read=${path.join(repo, 'bin', 'node-version-message.cjs')}`,
      `--allow-fs-read=${fixture}`,
      `--allow-fs-read=${root}`,
      `--allow-fs-write=${root}`,
      fixture,
      '--config-file',
      config,
      workspace
    );
    assert.ifError(start.error);
    assert.equal(start.status, 0, start.stderr);
    const retain = tmux('set-option', '-w', '-t', 'moss-test', 'remain-on-exit', 'on');
    assert.equal(retain.status, 0, retain.stderr);
    let readyFrames = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const capture = tmux('capture-pane', '-p', '-t', 'moss-test');
      const state = tmux('display-message', '-p', '-t', 'moss-test', '#{alternate_on}');
      if (capture.status !== 0) break;
      screen = capture.stdout ?? '';
      alternate = (state.stdout ?? '').trim();
      if (alternate === '1' && screen.includes('❯')) {
        readyFrames += 1;
        const hasExpected =
          scenario === 'collision' || scenario === 'sensitive'
            ? /some legacy skill entries were not migrated/i.test(screen)
            : scenario === 'cleanup'
              ? /old skill directories could not be checked or cleaned/i.test(screen)
              : readyFrames >= 5;
        if (hasExpected) break;
      }
      if (screen.includes('Pane is dead')) break;
      await delay(100);
    }
    assert.equal(alternate, '1', `expected alternate screen, got ${alternate}:\n${screen}`);
    assert.ok(screen.includes('❯'), `TUI composer not visible:\n${screen}`);
    return screen;
  } finally {
    tmux('kill-server');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('fullscreen TUI shows skipped legacy migration notice', async (t) => {
  const screen = await captureTui(t, 'collision');
  if (screen === undefined) return;
  assert.match(screen, /some legacy skill entries were not migrated/i);
  assert.match(screen, /skill-candidates/);
});

test('fullscreen TUI does not render untrusted secret fragments or RTL names', async (t) => {
  if (process.platform === 'win32') return t.skip('control characters are not valid Windows paths');
  const screen = await captureTui(t, 'sensitive');
  if (screen === undefined) return;
  assert.match(screen, /some legacy skill entries were not migrated/i);
  assert.ok(!screen.includes(syntheticSecret.slice(12)), screen);
  assert.ok(!screen.includes('الرابط'), screen);
});

test('fullscreen TUI shows optional cleanup notice', async (t) => {
  const screen = await captureTui(t, 'cleanup');
  if (screen === undefined) return;
  assert.match(screen, /old skill directories could not be checked or cleaned/i);
  assert.match(screen, /agent\/skills\//);
});

test('fullscreen TUI has no migration notice when nothing was skipped', async (t) => {
  const screen = await captureTui(t, 'clean');
  if (screen === undefined) return;
  assert.doesNotMatch(screen, /some legacy skill entries were not migrated/i);
});
