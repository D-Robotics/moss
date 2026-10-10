#!/usr/bin/env node
/**
 * PATH scan for `moss` executables. The filesystem is injected — no spawn,
 * no real install. English warnings assume the test runner's C locale.
 */
import assert from 'node:assert/strict';
import path from 'node:path';

import { clearUiLanguage, installUiLanguage } from '../dist/utils/ui-language.js';
import { collectMossRuntimeFacts, scanMossBinariesOnPath } from '../dist/cli/moss-binary-path.js';

/** @param {Record<string, { realPath?: string, mode?: number, isFile?: boolean }>} files */
function fakeFs(files) {
  return {
    statSync(filePath) {
      const hit = files[filePath];
      if (!hit) throw new Error(`ENOENT: ${filePath}`);
      return {
        isFile: () => hit.isFile !== false,
        mode: hit.mode ?? 0o755,
      };
    },
    realpathSync(filePath) {
      const hit = files[filePath];
      if (!hit) throw new Error(`ENOENT: ${filePath}`);
      return hit.realPath ?? filePath;
    },
  };
}

// ─── one executable: no warning, even if a non-executable moss sits later ──

{
  const scan = scanMossBinariesOnPath({
    pathEnv: '/usr/local/bin:/opt/data/bin',
    platform: 'linux',
    runningPath: '/usr/local/bin/moss',
    fs: fakeFs({
      '/usr/local/bin/moss': { realPath: '/usr/local/bin/moss', mode: 0o755 },
      '/opt/data/bin/moss': { realPath: '/opt/data/bin/moss', mode: 0o644 },
    }),
  });
  assert.equal(scan.warning, null, 'a single executable moss does not warn');
  assert.equal(scan.binaries.length, 1);
  assert.equal(scan.winner?.listed, '/usr/local/bin/moss');
  assert.equal(scan.winnerIsRunning, true);
}

// ─── two different binaries: name both, the PATH-order winner, and running ──

{
  const fs = fakeFs({
    '/usr/local/bin/moss': { realPath: '/usr/local/bin/moss' },
    '/opt/homebrew/bin/moss': { realPath: '/opt/homebrew/bin/moss' },
  });
  const running = scanMossBinariesOnPath({
    pathEnv: '/usr/local/bin:/opt/homebrew/bin',
    platform: 'darwin',
    runningPath: '/usr/local/bin/moss',
    fs,
  });
  const warning = running.warning ?? '';
  assert.equal(running.binaries.length, 2);
  assert.equal(running.winner?.realPath, '/usr/local/bin/moss');
  assert.equal(running.winnerIsRunning, true);
  assert.match(warning, /\/usr\/local\/bin\/moss/);
  assert.match(warning, /\/opt\/homebrew\/bin\/moss/);
  assert.ok(
    warning.indexOf('/usr/local/bin/moss') < warning.indexOf('/opt/homebrew/bin/moss'),
    'PATH order, not sorted order'
  );
  assert.match(warning, /\/usr\/local\/bin\/moss wins \(first on PATH\)/);
  assert.match(warning, /is the one currently running/);
  assert.doesNotMatch(warning, /not the one currently running/);

  const other = scanMossBinariesOnPath({
    pathEnv: '/usr/local/bin:/opt/homebrew/bin',
    platform: 'darwin',
    runningPath: '/opt/homebrew/bin/moss',
    fs,
  });
  assert.equal(other.winnerIsRunning, false);
  assert.match(other.warning ?? '', /\/usr\/local\/bin\/moss wins \(first on PATH\)/);
  assert.match(other.warning ?? '', /not the one currently running \(\/opt\/homebrew\/bin\/moss\)/);
}

// ─── two PATH entries, one real file: count once, no warning ───────────────

{
  const scan = scanMossBinariesOnPath({
    pathEnv: '/usr/local/bin:/opt/homebrew/bin',
    platform: 'linux',
    runningPath: '/opt/moss/bin/moss.cjs',
    fs: fakeFs({
      '/usr/local/bin/moss': { realPath: '/opt/moss/bin/moss.cjs' },
      '/opt/homebrew/bin/moss': { realPath: '/opt/moss/bin/moss.cjs' },
    }),
  });
  assert.equal(scan.binaries.length, 1, 'symlinks to the same target count once');
  assert.equal(scan.warning, null);
  assert.equal(scan.binaries[0]?.listed, '/usr/local/bin/moss');
  assert.equal(scan.binaries[0]?.realPath, '/opt/moss/bin/moss.cjs');
  assert.equal(scan.winnerIsRunning, true);
}

// ─── Windows PATHEXT: only listed extensions, plus the bare name ───────────

{
  const dir = 'C:\\Tools';
  const bare = path.win32.join(dir, 'moss');
  const exe = path.win32.join(dir, 'moss.exe');
  const cmd = path.win32.join(dir, 'moss.cmd');
  const ps1 = path.win32.join(dir, 'moss.ps1');
  const bat = path.win32.join(dir, 'moss.bat');
  const txt = path.win32.join(dir, 'moss.txt');
  const shared = 'C:\\Real\\moss.exe';
  const fs = fakeFs({
    [bare]: { realPath: shared },
    [exe]: { realPath: shared },
    [cmd]: { realPath: 'C:\\Real\\moss.cmd' },
    [ps1]: { realPath: 'C:\\Real\\moss.ps1' },
    [bat]: { realPath: 'C:\\Real\\moss.bat' },
    [txt]: { realPath: 'C:\\Real\\moss.txt' },
  });

  const exeOnly = scanMossBinariesOnPath({
    pathEnv: dir,
    pathExt: '.EXE',
    platform: 'win32',
    runningPath: 'c:\\real\\moss.exe',
    fs,
  });
  assert.equal(exeOnly.warning, null, '.EXE does not pick up .cmd/.ps1/.bat/.txt');
  assert.equal(exeOnly.binaries.length, 1);
  assert.equal(exeOnly.binaries[0]?.listed, bare, 'bare moss is probed and shares the exe target');
  assert.equal(exeOnly.binaries[0]?.realPath, shared);
  assert.equal(exeOnly.winnerIsRunning, true, 'Windows path compare is case-insensitive');

  const many = scanMossBinariesOnPath({
    pathEnv: dir,
    pathExt: '.EXE;.CMD;.PS1',
    platform: 'win32',
    runningPath: 'C:\\Tools\\moss.exe',
    fs,
  });
  const names = many.binaries.map((hit) => hit.listed);
  assert.deepEqual(names, [bare, cmd, ps1]);
  assert.ok(many.warning);
  const warning = many.warning ?? '';
  assert.match(warning, /moss\.cmd/);
  assert.match(warning, /moss\.ps1/);
  assert.match(warning, /wins \(first on PATH\)/);
  assert.doesNotMatch(warning, /moss\.txt/);
  assert.doesNotMatch(warning, /moss\.bat/);
  assert.match(warning, /not the one currently running/);
  assert.equal(many.winner?.listed, bare);
  assert.equal(many.winnerIsRunning, false);
}

// ─── Chinese warning names both installs without the English verb ──────────

{
  installUiLanguage({ language: 'zh', source: 'flag', setting: 'zh' });
  try {
    const scan = scanMossBinariesOnPath({
      pathEnv: '/usr/local/bin:/opt/homebrew/bin',
      platform: 'linux',
      runningPath: '/opt/homebrew/bin/moss',
      fs: fakeFs({
        '/usr/local/bin/moss': { realPath: '/usr/local/bin/moss' },
        '/opt/homebrew/bin/moss': { realPath: '/opt/homebrew/bin/moss' },
      }),
    });
    const warning = scan.warning ?? '';
    assert.match(warning, /\/usr\/local\/bin\/moss/);
    assert.match(warning, /\/opt\/homebrew\/bin\/moss/);
    assert.match(warning, /先出现的会生效：\/usr\/local\/bin\/moss/);
    assert.match(warning, /它不是当前正在运行的（\/opt\/homebrew\/bin\/moss）/);
    assert.equal(warning.includes('wins'), false);
    assert.equal(warning.includes('currently'), false);
  } finally {
    clearUiLanguage();
  }
}

// ─── entry realpath and package root, without spawning ─────────────────────

{
  const facts = collectMossRuntimeFacts({
    pathEnv: '/opt/moss/bin',
    platform: 'linux',
    argv1: '/opt/moss/bin/moss.cjs',
    packageJsonPath: '/opt/moss/package.json',
    fs: fakeFs({
      '/opt/moss/bin/moss': { realPath: '/real/moss/bin/moss.cjs' },
      '/opt/moss/bin/moss.cjs': { realPath: '/real/moss/bin/moss.cjs' },
      '/opt/moss/package.json': { realPath: '/real/moss/package.json' },
    }),
  });
  assert.equal(facts.entryPath, '/real/moss/bin/moss.cjs');
  assert.equal(facts.packageRoot, '/real/moss');
  assert.equal(facts.scan.binaries.length, 1);
  assert.equal(facts.scan.winnerIsRunning, true, 'PATH moss and argv[1] share a real path');
  assert.equal(facts.scan.warning, null);
}

console.log('[PASS] moss binary path');
