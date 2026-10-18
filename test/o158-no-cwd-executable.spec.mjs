#!/usr/bin/env node
/**
 * O158 (P1, security): Windows looked in the current directory before PATH
 * when Moss started a bare program name (`where.exe`, Node/libuv spawn,
 * cmd.exe). A cloned repo that ships `pwsh.exe` / `git.exe` / `node.exe` had
 * them run on startup (pwsh probe, git snapshot) before the model did
 * anything. Repro: draft #138, run 39083667100 (cases A and C).
 *
 * Every Moss child now resolves through run-process.ts →
 * resolve-executable.ts: only absolute PATH entries outside the cwd and the
 * workspace, absolute result, child PATH without empty/relative entries and
 * `NoDefaultCurrentDirectoryInExePath=1` on Windows. POSIX had the same hole
 * for an empty PATH entry or `.`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  NO_CWD_EXE_SEARCH_ENV,
  envShebangCommand,
  resolveCommandHead,
  resolveExecutable,
  sanitizeChildPathEnv,
  trustedSearchDirs,
} from '../dist/utils/resolve-executable.js';
import { findOnWindowsPath, knownPwshLocations } from '../dist/utils/host-shell.js';
import {
  runProcess,
  runProcessSync,
  spawnProcess,
  spawnTarget,
} from '../dist/utils/run-process.js';
import { isDotenvDeniedEnvKey } from '../dist/utils/dotenv-denied-env.js';
import { scenario } from './o121-safety-block-outcome.spec.mjs';

const IS_WIN = process.platform === 'win32';
const WIN_ONLY = { skip: !IS_WIN && 'platform mismatch (not win32)' };
const POSIX_ONLY = { skip: IS_WIN && 'platform mismatch (win32)' };
const real = (p) => p;
const has =
  (...files) =>
  (p) =>
    files.map((f) => f.toLowerCase()).includes(p.toLowerCase());

// ---- pure (every platform) ----

test('win32 search dirs: drop empty, `.`, relative, drive-relative, cwd and inside cwd', () => {
  const dirs = trustedSearchDirs({
    platform: 'win32',
    processCwd: 'C:\\ws',
    cwd: 'D:\\child',
    home: 'C:\\Users\\u',
    realpath: real,
    env: {
      Path: ';.;bin;.\\tools;\\rooted;C:foo;C:\\ws;C:\\WS\\node_modules\\.bin;D:\\child\\x;"C:\\Program Files\\Git\\cmd";C:\\Windows\\System32',
    },
  });
  assert.deepEqual(dirs, ['C:\\Program Files\\Git\\cmd', 'C:\\Windows\\System32']);
});

test('posix search dirs: drop empty, `.`, relative, cwd and inside cwd', () => {
  const dirs = trustedSearchDirs({
    platform: 'linux',
    processCwd: '/ws',
    cwd: '/child',
    home: '/home/u',
    realpath: real,
    env: { PATH: ':.:bin:./x:/ws:/ws/node_modules/.bin:/child/sub:/usr/local/bin:/usr/bin:' },
  });
  assert.deepEqual(dirs, ['/usr/local/bin', '/usr/bin']);
});

test('search dirs: realpath inside the workspace is dropped (symlinked PATH entry)', () => {
  const dirs = trustedSearchDirs({
    platform: 'linux',
    processCwd: '/ws',
    home: '/home/u',
    realpath: (p) => (p === '/opt/link' ? '/ws/bin' : p),
    env: { PATH: '/opt/link:/usr/bin' },
  });
  assert.deepEqual(dirs, ['/usr/bin']);
});

test('search dirs: workspace = home or a root drops only that exact dir', () => {
  assert.deepEqual(
    trustedSearchDirs({
      platform: 'linux',
      processCwd: '/home/u',
      home: '/home/u',
      realpath: real,
      env: { PATH: '/home/u:/home/u/.local/bin:/usr/bin' },
    }),
    ['/home/u/.local/bin', '/usr/bin']
  );
  assert.deepEqual(
    trustedSearchDirs({
      platform: 'win32',
      processCwd: 'C:\\',
      home: 'C:\\Users\\u',
      realpath: real,
      env: { PATH: 'C:\\;C:\\Windows\\System32' },
    }),
    ['C:\\Windows\\System32']
  );
});

test('resolveExecutable: absolute result from trusted dirs; null when only the cwd has it', () => {
  const opts = {
    platform: 'win32',
    processCwd: 'C:\\ws',
    home: 'C:\\Users\\u',
    realpath: real,
    env: { PATH: '.;C:\\ws;C:\\Program Files\\Git\\cmd' },
  };
  assert.equal(
    resolveExecutable('git', {
      ...opts,
      isFile: has('C:\\ws\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe'),
    }),
    'C:\\Program Files\\Git\\cmd\\git.exe'
  );
  assert.equal(
    resolveExecutable('git', { ...opts, isFile: has('C:\\ws\\git.exe', 'git.exe') }),
    null
  );
  // libuv only starts .com/.exe; a name with an extension is tried as given first.
  assert.equal(
    resolveExecutable('pwsh.exe', {
      ...opts,
      env: { PATH: 'C:\\p' },
      isFile: has('C:\\p\\pwsh.exe'),
    }),
    'C:\\p\\pwsh.exe'
  );
  assert.equal(
    resolveExecutable('npx', { ...opts, env: { PATH: 'C:\\n' }, isFile: has('C:\\n\\npx.cmd') }),
    null
  );
  // A path the caller wrote is theirs.
  assert.equal(resolveExecutable('.\\x.exe', opts), '.\\x.exe');
  // Fallbacks: absolute, outside the workspace.
  assert.equal(
    resolveExecutable('pwsh', {
      ...opts,
      env: { PATH: '' },
      fallbacks: ['C:\\ws\\PowerShell\\7\\pwsh.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'],
      isFile: () => true,
    }),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  );
});

test('findOnWindowsPath (pwsh, PATHEXT-aware) ignores `.` and workspace entries', () => {
  const isFile = has(
    'C:\\ws\\pwsh.exe',
    'pwsh.exe',
    'C:\\ws\\tools\\pwsh.exe',
    'C:\\PS7\\pwsh.exe'
  );
  const o = { processCwd: 'C:\\ws', home: 'C:\\Users\\u', realpath: real };
  assert.equal(findOnWindowsPath('pwsh', { PATH: '.;;C:\\ws;C:\\ws\\tools' }, isFile, o), null);
  assert.equal(
    findOnWindowsPath('pwsh', { PATH: '.;C:\\ws;C:\\PS7' }, isFile, o),
    'C:\\PS7\\pwsh.exe'
  );
});

test('knownPwshLocations: MSI install and the App Execution Alias, absolute only', () => {
  assert.deepEqual(
    knownPwshLocations({
      ProgramFiles: 'C:\\Program Files',
      ProgramW6432: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    }),
    [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe',
    ]
  );
  assert.deepEqual(knownPwshLocations({ ProgramFiles: 'rel', LOCALAPPDATA: '' }), []);
});

test('child env: PATH loses empty/relative entries; Windows adds NoDefaultCurrentDirectoryInExePath', () => {
  assert.deepEqual(sanitizeChildPathEnv({ PATH: '.:/usr/bin::bin:/bin' }, 'linux'), {
    PATH: '/usr/bin:/bin',
  });
  const clean = { PATH: '/usr/bin' };
  assert.equal(sanitizeChildPathEnv(clean, 'linux'), clean);
  assert.deepEqual(sanitizeChildPathEnv({ Path: '.;C:\\x;;bin' }, 'win32'), {
    Path: 'C:\\x',
    [NO_CWD_EXE_SEARCH_ENV]: '1',
  });
});

test('a project .env cannot set PATHEXT or COMSPEC', () => {
  for (const key of ['PATHEXT', 'COMSPEC', 'ComSpec', 'Path']) {
    assert.equal(isDotenvDeniedEnvKey(key), true, key);
  }
});

// ---- process level: POSIX (`.` / empty PATH entry) ----

function posixFake(dir, name, markDir) {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh\necho "ran $*" >> ${JSON.stringify(path.join(markDir, `MARK-${name}`))}\necho FAKE\n`
  );
  fs.chmodSync(file, 0o755);
}

function marks(markDir) {
  return fs.readdirSync(markDir).filter((f) => f.startsWith('MARK-'));
}

test(
  'posix: runProcess / runProcessSync / spawnProcess never start ./git from a `.` or empty PATH entry',
  POSIX_ONLY,
  async (t) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-ws-'));
    const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-mark-'));
    t.after(() => {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(markDir, { recursive: true, force: true });
    });
    posixFake(ws, 'git', markDir);
    for (const PATH of [`.:${process.env.PATH}`, `:${process.env.PATH}`]) {
      const env = { ...process.env, PATH };
      const a = await runProcess('git', { args: ['--version'], cwd: ws, env });
      assert.match(a.stdout, /^git version/, PATH);
      const b = runProcessSync('git', ['--version'], { cwd: ws, env, encoding: 'utf8' });
      assert.match(String(b.stdout), /^git version/);
      const c = spawnProcess('sh', ['-c', 'git --version'], {
        cwd: ws,
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      await new Promise((r) => c.on('close', r));
      assert.match(out, /^git version/, 'sh child resolved ./git');
    }
    assert.deepEqual(marks(markDir), []);
  }
);

test(
  'posix: a name only the workspace has fails with ENOENT instead of running it',
  POSIX_ONLY,
  async (t) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-ws-'));
    const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-mark-'));
    t.after(() => {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(markDir, { recursive: true, force: true });
    });
    posixFake(ws, 'moss-o158-only-here', markDir);
    fs.mkdirSync(path.join(ws, 'bin'));
    posixFake(path.join(ws, 'bin'), 'moss-o158-in-bin', markDir);
    const env = { ...process.env, PATH: `.:${ws}/bin:${process.env.PATH}` };
    for (const name of ['moss-o158-only-here', 'moss-o158-in-bin']) {
      await assert.rejects(runProcess(name, { args: [], cwd: ws, env }), { code: 'ENOENT' });
      const r = runProcessSync(name, [], { cwd: ws, env });
      assert.equal(r.error?.code, 'ENOENT');
    }
    assert.deepEqual(marks(markDir), []);
    const t1 = spawnTarget('git', { cwd: ws, env });
    assert.equal(path.isAbsolute(t1.command), true);
  }
);

test(
  'posix e2e: fake git/node/sh in the workspace, PATH with `.` — startup, hook and exec use the real ones',
  POSIX_ONLY,
  async () => {
    const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-mark-'));
    try {
      const r = await scenario({
        lang: 'en',
        json: true,
        gitInit: true,
        hooks: { PreToolUse: [{ command: 'git --version' }] },
        steps: [
          { name: 'exec', args: { command: 'git status --short && node -e "console.log(40+2)"' } },
        ],
        finalText: 'Done.',
        extraEnv: { PATH: `.::${process.env.PATH}` },
        prepare: ({ proj }) => {
          for (const n of ['git', 'node', 'sh', 'npx']) posixFake(proj, n, markDir);
        },
      });
      assert.deepEqual(marks(markDir), [], 'a workspace binary ran');
      assert.equal(r.code, 0, r.err);
      assert.match(r.toolResults.join('\n'), /42/);
      assert.doesNotMatch(r.toolResults.join('\n'), /FAKE/);
    } finally {
      fs.rmSync(markDir, { recursive: true, force: true });
    }
  }
);

// ---- process level: Windows (case A / case C / extended matrix) ----

const WIN_MARK_DIR = IS_WIN ? fs.mkdtempSync(path.join(os.tmpdir(), 'o158-winmark-')) : '';
let fakeExe;
/** One compiled fake: writes MARK-<its name>.txt into WIN_MARK_DIR, prints 7. */
function windowsFakeExe() {
  if (fakeExe) return fakeExe;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'o158-fake-')), 'fake.exe');
  const code = `using System; using System.IO;
public class Fake {
  public static int Main(string[] a) {
    string self = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
    string name = Path.GetFileNameWithoutExtension(self);
    File.AppendAllText(Path.Combine(${JSON.stringify(WIN_MARK_DIR)}, "MARK-" + name + ".txt"), Environment.CommandLine + "\\r\\n");
    Console.WriteLine("7"); return 0;
  }
}`;
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  const script = `$ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition ${literal(code)} -OutputAssembly ${literal(out)} -OutputType ConsoleApplication`;
  execFileSync(
    path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, timeout: 60000 }
  );
  fakeExe = out;
  return out;
}

const WIN_FAKES = ['pwsh', 'powershell', 'cmd', 'git', 'node', 'where'];
function plantWindowsFakes(proj) {
  const exe = windowsFakeExe();
  for (const n of WIN_FAKES) fs.copyFileSync(exe, path.join(proj, `${n}.exe`));
  fs.writeFileSync(
    path.join(proj, 'npx.cmd'),
    `@echo off\r\necho ran>>"${path.join(WIN_MARK_DIR, 'MARK-npx.txt')}"\r\n`
  );
}

function clearWinMarks() {
  for (const f of marks(WIN_MARK_DIR)) fs.rmSync(path.join(WIN_MARK_DIR, f), { force: true });
}

const fullPath = process.env.PATH ?? process.env.Path ?? '';
const noPwshPath = fullPath
  .split(';')
  .filter((d) => !(d && fs.existsSync(path.join(d.replace(/^"(.*)"$/, '$1'), 'pwsh.exe'))))
  .join(';');

test('win32 fixture: the fake really runs when started from its own directory', WIN_ONLY, () => {
  clearWinMarks();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-fx-'));
  try {
    plantWindowsFakes(dir);
    spawnSync(path.join(dir, 'git.exe'), ['--version'], { windowsHide: true });
    assert.deepEqual(marks(WIN_MARK_DIR), ['MARK-git.txt']);
  } finally {
    clearWinMarks();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('win32: pwsh does not run a workspace git.exe for a bare `git`', WIN_ONLY, (t) => {
  const pwsh = resolveExecutable('pwsh');
  if (!pwsh) return t.skip('no pwsh 7 on PATH');
  clearWinMarks();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-pw-'));
  try {
    plantWindowsFakes(dir);
    const r = runProcessSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', 'git --version'], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
    });
    assert.match(String(r.stdout), /git version/);
    assert.deepEqual(marks(WIN_MARK_DIR), []);
  } finally {
    clearWinMarks();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const WIN_MATRIX = [
  { id: 'case A: no pwsh on PATH', PATH: noPwshPath },
  { id: 'case C: real pwsh on PATH', PATH: fullPath },
  { id: 'PATH with `.`, empty and relative entries, no pwsh', PATH: `.;;bin;${noPwshPath}` },
  { id: 'PATH with `.`, empty and relative entries, real pwsh', PATH: `.;;bin;${fullPath}` },
];

for (const c of WIN_MATRIX) {
  test(
    `win32 e2e (${c.id}): no workspace binary runs; startup, hook, exec and git status work`,
    WIN_ONLY,
    async () => {
      clearWinMarks();
      try {
        const r = await scenario({
          lang: 'en',
          json: true,
          gitInit: true,
          hooks: { PreToolUse: [{ command: 'git --version' }] },
          steps: [
            {
              name: 'exec',
              args: { command: 'git status --short && node -e "console.log(40+2)"' },
            },
          ],
          finalText: 'Done.',
          extraEnv: {
            PATH: c.PATH,
            ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
            ...(process.env.COMSPEC ? { COMSPEC: process.env.COMSPEC } : {}),
            ...(process.env.ProgramFiles ? { ProgramFiles: process.env.ProgramFiles } : {}),
            ...(process.env.TEMP ? { TEMP: process.env.TEMP, TMP: process.env.TMP } : {}),
          },
          prepare: ({ proj }) => plantWindowsFakes(proj),
        });
        const ran = marks(WIN_MARK_DIR);
        assert.deepEqual(ran, [], `workspace binaries ran: ${ran.join(', ')}`);
        const line = r.out.trim().split(/\r?\n/).pop() ?? '';
        const json = JSON.parse(line);
        assert.match(String(json.shell), /^(pwsh|cmd)/, line);
        if (c.PATH === fullPath) assert.match(String(json.shell), /^pwsh/, line);
        assert.match(r.toolResults.join('\n'), /42/, r.toolResults.join('\n'));
      } finally {
        clearWinMarks();
      }
    }
  );
}

// ---- QA #142 rework: F1 (no PATH), F2 (pwsh fallbacks), F3 (`..name`), O1 ----

test('F3: a workspace child dir named `..something` is still inside the workspace', () => {
  for (const [platform, ws, PATH, keep] of [
    // `/ws/..` is the parent (`/`), not inside the workspace: kept.
    ['linux', '/ws', '/ws/..dotbin:/ws/..:/usr/bin', ['/ws/..', '/usr/bin']],
    ['win32', 'C:\\ws', 'C:\\ws\\..dotbin;C:\\Windows', ['C:\\Windows']],
  ]) {
    assert.deepEqual(
      trustedSearchDirs({ platform, processCwd: ws, home: '/h', realpath: real, env: { PATH } }),
      keep,
      `${platform} ${PATH}`
    );
  }
  // The parent itself (`/ws/..` = `/`) is not inside `/ws`.
  assert.deepEqual(
    trustedSearchDirs({
      platform: 'linux',
      processCwd: '/a/ws',
      home: '/h',
      realpath: real,
      env: { PATH: '/a/ws/../bin' },
    }),
    ['/a/ws/../bin']
  );
});

test('F1: no PATH in the env searches POSIX /usr/bin:/bin, never the cwd', () => {
  const isFile = has('/ws/git', '/usr/bin/git');
  const o = { platform: 'linux', processCwd: '/ws', home: '/h', realpath: real, isFile };
  assert.deepEqual(trustedSearchDirs({ ...o, env: {} }), ['/usr/bin', '/bin']);
  assert.equal(resolveExecutable('git', { ...o, env: {} }), '/usr/bin/git');
  assert.equal(resolveExecutable('git', { ...o, env: { PATH: '.' } }), null);
  // Windows has no such default; nothing is searched.
  assert.deepEqual(
    trustedSearchDirs({ platform: 'win32', processCwd: 'C:\\ws', realpath: real, env: {} }),
    []
  );
});

test(
  'F1 posix: an unresolved name with no trusted PATH entry is ENOENT (child PATH is never "")',
  POSIX_ONLY,
  async (t) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-ws-'));
    const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-mark-'));
    t.after(() => {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(markDir, { recursive: true, force: true });
    });
    const name = 'moss-o158-f1-only-here';
    posixFake(ws, name, markDir);
    fs.mkdirSync(path.join(ws, 'bin'));
    posixFake(path.join(ws, 'bin'), name, markDir);
    for (const PATH of ['.', '', ':', ws, `${ws}/bin`, `.:${ws}:${ws}/bin`]) {
      const env = { ...process.env, PATH };
      const target = spawnTarget(name, { cwd: ws, env });
      assert.notEqual(target.options.env.PATH, '', `PATH=${JSON.stringify(PATH)}`);
      assert.equal(path.isAbsolute(target.options.env.PATH), true, target.options.env.PATH);
      const r = runProcessSync(name, [], { cwd: ws, env });
      assert.equal(r.error?.code, 'ENOENT', `PATH=${JSON.stringify(PATH)}`);
      await assert.rejects(runProcess(name, { args: [], cwd: ws, env }), { code: 'ENOENT' });
    }
    assert.deepEqual(marks(markDir), []);
  }
);

test(
  'F1 posix e2e: PATH unset, fake git/node/sh in the workspace — startup git probes and hook never run them',
  POSIX_ONLY,
  async () => {
    const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-mark-'));
    try {
      const r = await scenario({
        lang: 'en',
        json: true,
        gitInit: true,
        hooks: { PreToolUse: [{ command: 'git --version' }] },
        steps: [{ name: 'exec', args: { command: 'echo o158-f1' } }],
        finalText: 'Done.',
        extraEnv: { PATH: undefined },
        prepare: ({ proj }) => {
          for (const n of ['git', 'node', 'sh', 'npx']) posixFake(proj, n, markDir);
        },
      });
      const ran = marks(markDir).map(
        (f) => `${f}: ${fs.readFileSync(path.join(markDir, f), 'utf8')}`
      );
      assert.deepEqual(ran, [], 'a workspace binary ran');
      assert.equal(r.code, 0, r.err);
    } finally {
      fs.rmSync(markDir, { recursive: true, force: true });
    }
  }
);

test('F2: pwsh fallbacks reject UNC shares and realpath aliases of the workspace', () => {
  const ws = 'C:\\Users\\u\\project-x';
  const short = 'C:\\Users\\u\\PROJEC~1';
  const realpath = (p) =>
    p.toLowerCase().startsWith(short.toLowerCase()) ? ws + p.slice(short.length) : p;
  const o = {
    platform: 'win32',
    processCwd: ws,
    home: 'C:\\Users\\u',
    realpath,
    env: { PATH: '' },
    isFile: () => true,
  };
  for (const bad of [
    '\\\\localhost\\C$\\Users\\u\\project-x\\PowerShell\\7\\pwsh.exe',
    '\\\\evil.example\\s\\PowerShell\\7\\pwsh.exe',
    '//evil.example/s/PowerShell/7/pwsh.exe',
    '\\\\?\\C:\\Users\\u\\project-x\\pwsh.exe',
    `${short}\\PowerShell\\7\\pwsh.exe`,
    `${ws}\\..dot\\pwsh.exe`,
  ]) {
    assert.equal(resolveExecutable('pwsh', { ...o, fallbacks: [bad] }), null, bad);
  }
  assert.equal(
    resolveExecutable('pwsh', { ...o, fallbacks: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'] }),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  );
  // A UNC value for the install-dir variables is never turned into a candidate.
  assert.deepEqual(
    knownPwshLocations({
      ProgramFiles: '\\\\localhost\\C$\\ws',
      ProgramW6432: '//evil/s',
      LOCALAPPDATA: '\\\\evil\\s',
    }),
    []
  );
  // Case-insensitive keys (a plain copy of process.env).
  assert.deepEqual(knownPwshLocations({ PROGRAMFILES: 'C:\\PF' }), [
    'C:\\PF\\PowerShell\\7\\pwsh.exe',
  ]);
  // …and a project .env cannot set them.
  for (const key of ['ProgramFiles', 'ProgramW6432', 'LOCALAPPDATA', 'LocalAppData'])
    assert.equal(isDotenvDeniedEnvKey(key), true, key);
});

test('O1: a hook command head is resolved by Moss rules (quoted absolute), builtins untouched', () => {
  const sh = {
    platform: 'linux',
    processCwd: '/ws',
    home: '/h',
    realpath: real,
    env: { PATH: '/ws/node_modules/.bin:/usr/bin' },
    isFile: has('/ws/node_modules/.bin/git', '/usr/bin/git', '/usr/bin/echo'),
  };
  assert.equal(resolveCommandHead('git --version', 'sh', sh), "'/usr/bin/git' --version");
  assert.equal(resolveCommandHead('  git', 'sh', sh), "  '/usr/bin/git'");
  assert.equal(resolveCommandHead('echo hi', 'sh', sh), 'echo hi');
  assert.equal(resolveCommandHead('cd x && git st', 'sh', sh), 'cd x && git st');
  assert.equal(resolveCommandHead('./git x', 'sh', sh), './git x');
  assert.equal(resolveCommandHead('FOO=1 git x', 'sh', sh), 'FOO=1 git x');
  // Only the workspace has it: left alone (the hook's own intent).
  assert.equal(
    resolveCommandHead('eslint .', 'sh', { ...sh, isFile: has('/ws/node_modules/.bin/eslint') }),
    'eslint .'
  );
  const cmd = {
    platform: 'win32',
    processCwd: 'C:\\ws',
    home: 'C:\\Users\\u',
    realpath: real,
    env: { PATH: 'C:\\ws\\node_modules\\.bin;C:\\Program Files\\nodejs' },
    isFile: has(
      'C:\\ws\\node_modules\\.bin\\node.exe',
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files\\nodejs\\npx.cmd'
    ),
  };
  assert.equal(
    resolveCommandHead('node -e 1', 'cmd', cmd),
    '"C:\\Program Files\\nodejs\\node.exe" -e 1'
  );
  assert.equal(resolveCommandHead('npx x', 'cmd', cmd), '"C:\\Program Files\\nodejs\\npx.cmd" x');
  assert.equal(resolveCommandHead('ECHO hi', 'cmd', cmd), 'ECHO hi');
  assert.equal(resolveCommandHead('@echo off', 'cmd', cmd), '@echo off');
});

/** Reads HOOK-*.txt the hooks wrote into the workspace. */
const hookFiles = ({ proj }) =>
  Object.fromEntries(
    fs
      .readdirSync(proj)
      .filter((f) => f.startsWith('HOOK-'))
      .map((f) => [f, fs.readFileSync(path.join(proj, f), 'utf8').trim()])
  );

const O1_HOOKS = {
  PreToolUse: [
    { command: 'git --version > HOOK-git.txt' },
    { command: 'node -e "console.log(41+1)" > HOOK-node.txt' },
  ],
};

test(
  'O1 posix e2e: PATH starts with $WS/node_modules/.bin (fake git/node/pwsh) — startup and hook launch never run them; model exec does (known limitation)',
  POSIX_ONLY,
  async () => {
    const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-mark-'));
    try {
      const r = await scenario({
        lang: 'en',
        json: true,
        gitInit: true,
        hooks: O1_HOOKS,
        steps: [{ name: 'exec', args: { command: 'git o158-model-exec' } }],
        finalText: 'Done.',
        extraEnv: ({ proj }) => ({
          PATH: `${path.join(proj, 'node_modules', '.bin')}:${process.env.PATH}`,
        }),
        prepare: ({ proj }) => {
          const bin = path.join(proj, 'node_modules', '.bin');
          fs.mkdirSync(bin, { recursive: true });
          for (const n of ['git', 'node', 'pwsh']) posixFake(bin, n, markDir);
        },
        inspect: hookFiles,
      });
      assert.equal(r.code, 0, r.err);
      // Startup probes and both hook launches used the real git/node.
      assert.match(r.inspected['HOOK-git.txt'] ?? '', /^git version/, JSON.stringify(r.inspected));
      assert.equal(r.inspected['HOOK-node.txt'], '42');
      const ran = Object.fromEntries(
        marks(markDir).map((f) => [f, fs.readFileSync(path.join(markDir, f), 'utf8').trim()])
      );
      // KNOWN LIMITATION (PM ruling on O1): the model's own exec inherits the
      // user's PATH, so `git` there is the project's node_modules/.bin/git.
      assert.deepEqual(ran, { 'MARK-git': 'ran o158-model-exec' }, JSON.stringify(ran));
    } finally {
      fs.rmSync(markDir, { recursive: true, force: true });
    }
  }
);

test(
  'O1 win32 e2e: PATH starts with $WS\\node_modules\\.bin (fake git/node/pwsh) — startup and hook launch never run them; model exec does (known limitation)',
  WIN_ONLY,
  async () => {
    clearWinMarks();
    try {
      const r = await scenario({
        lang: 'en',
        json: true,
        gitInit: true,
        hooks: O1_HOOKS,
        steps: [{ name: 'exec', args: { command: 'git o158-model-exec' } }],
        finalText: 'Done.',
        extraEnv: ({ proj }) => ({
          PATH: `${path.join(proj, 'node_modules', '.bin')};${fullPath}`,
          ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
          ...(process.env.COMSPEC ? { COMSPEC: process.env.COMSPEC } : {}),
          ...(process.env.ProgramFiles ? { ProgramFiles: process.env.ProgramFiles } : {}),
          ...(process.env.TEMP ? { TEMP: process.env.TEMP, TMP: process.env.TMP } : {}),
        }),
        prepare: ({ proj }) => {
          const bin = path.join(proj, 'node_modules', '.bin');
          fs.mkdirSync(bin, { recursive: true });
          const exe = windowsFakeExe();
          for (const n of ['git', 'node', 'pwsh']) fs.copyFileSync(exe, path.join(bin, `${n}.exe`));
        },
        inspect: hookFiles,
      });
      assert.equal(r.code, 0, r.err);
      const json = JSON.parse(r.out.trim().split(/\r?\n/).pop() ?? '{}');
      assert.match(
        String(json.shell),
        /^pwsh/,
        'the real pwsh 7, not node_modules\\.bin\\pwsh.exe'
      );
      assert.match(r.inspected['HOOK-git.txt'] ?? '', /^git version/, JSON.stringify(r.inspected));
      assert.equal(r.inspected['HOOK-node.txt'], '42');
      const ran = Object.fromEntries(
        marks(WIN_MARK_DIR).map((f) => [f, fs.readFileSync(path.join(WIN_MARK_DIR, f), 'utf8')])
      );
      // KNOWN LIMITATION (PM ruling on O1): only the model's own exec hits it.
      assert.deepEqual(Object.keys(ran), ['MARK-git.txt'], JSON.stringify(ran));
      assert.match(ran['MARK-git.txt'], /o158-model-exec/);
      assert.equal(ran['MARK-git.txt'].trim().split(/\r?\n/).length, 1, ran['MARK-git.txt']);
    } finally {
      clearWinMarks();
    }
  }
);

test(
  'O1 posix: an `#!/usr/bin/env node` program Moss starts gets an absolute interpreter, not $WS/node_modules/.bin/node',
  POSIX_ONLY,
  async (t) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-ws-'));
    const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-tools-'));
    const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-mark-'));
    t.after(() => {
      for (const d of [ws, tools, markDir]) fs.rmSync(d, { recursive: true, force: true });
    });
    const bin = path.join(ws, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    posixFake(bin, 'node', markDir);
    const tool = path.join(tools, 'moss-o158-envtool');
    fs.writeFileSync(
      tool,
      '#!/usr/bin/env node\nconsole.log("real " + process.argv.slice(2).join(" "));\n'
    );
    fs.chmodSync(tool, 0o755);
    const env = { ...process.env, PATH: `${bin}:${tools}:${process.env.PATH}` };
    const realNode = resolveExecutable('node', { env, processCwd: ws });
    assert.ok(realNode && !realNode.startsWith(ws), realNode);
    assert.deepEqual(envShebangCommand(tool, { env, processCwd: ws }), [realNode, tool]);
    const r = runProcessSync('moss-o158-envtool', ['a'], { cwd: ws, env, encoding: 'utf8' });
    assert.equal(String(r.stdout).trim(), 'real a', String(r.stderr));
    const a = await runProcess('moss-o158-envtool', { args: ['b'], cwd: ws, env });
    assert.equal(a.stdout.trim(), 'real b');
    assert.equal(
      resolveCommandHead('moss-o158-envtool c', 'sh', { env, processCwd: ws, cwd: ws }),
      `'${realNode}' '${tool}' c`
    );
    assert.deepEqual(marks(markDir), []);
  }
);
