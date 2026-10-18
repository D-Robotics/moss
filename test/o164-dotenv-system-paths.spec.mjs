#!/usr/bin/env node
/**
 * O164 (P2, follow-up to O158; QA #142 r2):
 * 1. A project `.env` could set SystemRoot / windir (they were not on the
 *    deny list) and the Windows background job built its powershell.exe path
 *    from `process.env.SystemRoot`, so a repo could have Moss run
 *    `<WS>\fake\System32\WindowsPowerShell\v1.0\powershell.exe`.
 * 2. A child PATH whose entries were all dropped (`.`, `::`) or that was
 *    empty became "", which sh reads as the current directory.
 * 3. O158 F2a (pwsh install dirs from the env before `.env`) and F2b (no UNC
 *    fallback) each get a test that turns red when its code is removed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isDotenvDeniedEnvKey } from '../dist/utils/dotenv-denied-env.js';
import { captureEnvBeforeDotenv } from '../dist/utils/startup-env.js';
import { windowsSystemRoot } from '../dist/utils/system-root.js';
import { knownPwshLocations, pwshFallbacks } from '../dist/utils/host-shell.js';
import {
  noTrustedPath,
  resolveExecutable,
  sanitizeChildPathEnv,
} from '../dist/utils/resolve-executable.js';
import { spawnTarget } from '../dist/utils/run-process.js';
import { backgroundShellInvocation } from '../dist/tools/windows-background-job.js';
import { scenario } from './o121-safety-block-outcome.spec.mjs';

const IS_WIN = process.platform === 'win32';
const WIN_ONLY = { skip: !IS_WIN && 'platform mismatch (not win32)' };
const POSIX_ONLY = { skip: IS_WIN && 'platform mismatch (win32)' };

/** Run `fn` with `live` applied on top of process.env after capturing `startup`. */
function withEnv(startup, live, fn) {
  const saved = { ...process.env };
  try {
    captureEnvBeforeDotenv(startup);
    Object.assign(process.env, live);
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    captureEnvBeforeDotenv(saved);
  }
}

// ---- 1. SystemRoot & co. ----------------------------------------------------
test('1: a project .env cannot set SystemRoot, windir or the other Windows system locations', () => {
  for (const key of [
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
    'PSModulePath',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'SystemDrive',
    'NoDefaultCurrentDirectoryInExePath',
    'TEMP',
    'TMP',
    'PATH',
    'Path',
  ]) {
    assert.equal(isDotenvDeniedEnvKey(key), true, key);
  }
  assert.equal(isDotenvDeniedEnvKey('MY_APP_SETTING'), false);
});

test('1: the Windows directory comes from the env before .env, drive-absolute only', () => {
  withEnv({ SystemRoot: 'C:\\Windows' }, { SystemRoot: 'C:\\ws\\fake' }, () => {
    assert.equal(windowsSystemRoot(), 'C:\\Windows');
  });
  withEnv({}, { SystemRoot: 'C:\\ws\\fake', windir: 'C:\\ws\\fake' }, () => {
    assert.equal(windowsSystemRoot(), 'C:\\Windows', 'introduced by .env only → default');
  });
  assert.equal(windowsSystemRoot({ windir: 'D:\\Win' }), 'D:\\Win');
  assert.equal(windowsSystemRoot({ SYSTEMROOT: 'E:\\W' }), 'E:\\W');
  for (const bad of ['\\\\host\\share\\Windows', '//host/s', 'fake', 'C:fake', '']) {
    assert.equal(windowsSystemRoot({ SystemRoot: bad }), 'C:\\Windows', bad);
  }
});

let fakeExe;
/** Compiled fake: appends to MARK-<name>.txt in `markDir`, prints FAKE. */
function windowsFakeExe(markDir) {
  if (fakeExe) return fakeExe;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'o164-fake-')), 'fake.exe');
  const code = `using System; using System.IO;
public class Fake {
  public static int Main(string[] a) {
    string self = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
    File.AppendAllText(Path.Combine(${JSON.stringify(markDir)}, "MARK-" + Path.GetFileNameWithoutExtension(self) + ".txt"), Environment.CommandLine + "\\r\\n");
    Console.WriteLine("FAKE"); return 0;
  }
}`;
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  const script = `$ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition ${literal(code)} -OutputAssembly ${literal(out)} -OutputType ConsoleApplication`;
  execFileSync(
    path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, timeout: 120000 }
  );
  fakeExe = out;
  return out;
}
function plantFakePowershell(root, markDir) {
  const dir = path.join(root, 'fake', 'System32', 'WindowsPowerShell', 'v1.0');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(windowsFakeExe(markDir), path.join(dir, 'powershell.exe'));
  return path.join(root, 'fake');
}
const marks = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('MARK-'));

test(
  '1 win32: background job (cmd host shell) never starts <WS>\\fake\\…\\powershell.exe after a .env SystemRoot',
  WIN_ONLY,
  async (t) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'o164-ws-'));
    const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o164-mark-'));
    t.after(() => {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(markDir, { recursive: true, force: true });
    });
    const fakeRoot = plantFakePowershell(ws, markDir);
    const realRoot = process.env.SystemRoot;
    const cmd = {
      kind: 'cmd',
      executable: path.join(realRoot, 'System32', 'cmd.exe'),
      argsFor: (c) => ['/d', '/s', '/c', `"${c}"`],
    };
    // Startup env without SystemRoot/windir; the "project .env" then adds them.
    const startup = { ...process.env };
    for (const k of Object.keys(startup)) if (/^(systemroot|windir)$/i.test(k)) delete startup[k];
    const invocation = withEnv(startup, { SystemRoot: fakeRoot, windir: fakeRoot }, () =>
      backgroundShellInvocation('echo o164-bg-ok', cmd, ws)
    );
    assert.equal(
      invocation.executable.toLowerCase(),
      path.win32
        .join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        .toLowerCase()
    );
    const child = spawn(invocation.executable, invocation.args, {
      cwd: ws,
      env: process.env,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const code = await new Promise((r) => child.on('close', r));
    assert.deepEqual(marks(markDir), [], 'the fake powershell.exe ran');
    assert.equal(code, 0, out);
    assert.match(out, /o164-bg-ok/, 'the background job still works');
  }
);

test(
  '1 win32 CLI: .env SystemRoot=<WS>\\fake + cmd host shell — background exec works, fake never runs',
  WIN_ONLY,
  async () => {
    const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o164-mark-'));
    try {
      const fullPath = process.env.PATH ?? process.env.Path ?? '';
      // No pwsh on PATH → Moss falls back to cmd, the path that uses SystemRoot.
      const noPwshPath = fullPath
        .split(';')
        .filter((d) => !(d && fs.existsSync(path.join(d.replace(/^"(.*)"$/, '$1'), 'pwsh.exe'))))
        .join(';');
      const r = await scenario({
        lang: 'en',
        json: true,
        // `-p` exposes background jobs through exec's run_in_background.
        steps: [
          {
            name: 'exec',
            args: { command: 'echo o164-bg-ok', run_in_background: true, settle_ms: 10000 },
          },
          // Windows PowerShell 5.1 (the job owner) can start slower than the settle window.
          { name: 'exec_wait', args: { ids: ['bg_1'], timeout_ms: 60000 } },
        ],
        finalText: 'Done.',
        // The attack needs SystemRoot absent at startup; .env then supplies it.
        extraEnv: { PATH: noPwshPath, SystemRoot: undefined, windir: undefined },
        prepare: ({ proj }) => {
          const fakeRoot = plantFakePowershell(proj, markDir);
          fs.writeFileSync(path.join(proj, '.env'), `SystemRoot=${fakeRoot}\nwindir=${fakeRoot}\n`);
        },
      });
      const ran = marks(markDir).map(
        (f) => `${f}: ${fs.readFileSync(path.join(markDir, f), 'utf8')}`
      );
      assert.deepEqual(ran, [], 'the fake powershell.exe ran');
      assert.match(
        r.toolResults.join('\n'),
        /o164-bg-ok/,
        `${r.toolResults.join('\n')}\n${r.err.slice(-800)}`
      );
    } finally {
      fs.rmSync(markDir, { recursive: true, force: true });
    }
  }
);

// ---- 2. PATH emptied ----------------------------------------------------------
test('2: a child PATH with no usable entry is a nonexistent absolute dir, never ""', () => {
  for (const PATH of ['.', '', '::', ':.:', 'rel/bin']) {
    const posix = sanitizeChildPathEnv({ PATH }, 'linux');
    assert.equal(posix.PATH, '/nonexistent/moss-no-trusted-path', JSON.stringify(PATH));
  }
  for (const Path of ['.', '', ';;', 'rel\\bin;.']) {
    const win = sanitizeChildPathEnv({ Path }, 'win32');
    assert.equal(win.Path, noTrustedPath('win32'), JSON.stringify(Path));
    assert.match(win.Path, /^[A-Za-z]:\\.*\\System32\\moss-no-trusted-path$/);
  }
  // Unchanged when something usable is left.
  assert.deepEqual(sanitizeChildPathEnv({ PATH: '.:/usr/bin' }, 'linux'), { PATH: '/usr/bin' });
  assert.ok(!fs.existsSync(noTrustedPath()), 'placeholder must not exist');
});

function posixFake(dir, name, markDir) {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh\necho "ran $*" >> ${JSON.stringify(path.join(markDir, `MARK-${name}`))}\necho FAKE\n`
  );
  fs.chmodSync(file, 0o755);
}

for (const PATH of ['.', '', '::']) {
  test(
    `2 posix e2e: PATH=${JSON.stringify(PATH)} — startup, hook and exec never run workspace programs`,
    POSIX_ONLY,
    async () => {
      const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o164-mark-'));
      try {
        await scenario({
          lang: 'en',
          json: true,
          hooks: { PreToolUse: [{ command: 'git --version' }] },
          steps: [{ name: 'exec', args: { command: 'git status; node -v; ls' } }],
          finalText: 'Done.',
          extraEnv: { PATH },
          prepare: ({ proj }) => {
            for (const n of ['git', 'node', 'sh', 'ls', 'npx']) posixFake(proj, n, markDir);
          },
        });
        const ran = marks(markDir).map(
          (f) => `${f}: ${fs.readFileSync(path.join(markDir, f), 'utf8')}`
        );
        assert.deepEqual(ran, [], 'a workspace program ran');
      } finally {
        fs.rmSync(markDir, { recursive: true, force: true });
      }
    }
  );
}

test(
  '2 posix: spawnTarget with PATH="" / "." / "::" never hands the child PATH=""',
  POSIX_ONLY,
  () => {
    for (const PATH of ['.', '', '::']) {
      const t = spawnTarget('/bin/sh', { cwd: os.tmpdir(), env: { PATH } });
      assert.equal(t.options.env.PATH, '/nonexistent/moss-no-trusted-path', JSON.stringify(PATH));
    }
  }
);

// ---- 3. O158 F2a / F2b ----------------------------------------------------------
test('3 F2a: pwsh install dirs come from the env before .env, not from a value .env added', () => {
  withEnv(
    { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    {
      ProgramFiles: 'C:\\ws\\evil',
      ProgramW6432: 'C:\\ws\\evil',
      LOCALAPPDATA: 'C:\\ws\\evil',
    },
    () => {
      assert.deepEqual(pwshFallbacks(), [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe',
      ]);
    }
  );
});

test('3 F2b: a UNC pwsh fallback, or one whose realpath is a UNC share, is never used', () => {
  const o = {
    platform: 'win32',
    processCwd: 'C:\\ws',
    home: 'C:\\Users\\u',
    env: { PATH: '' },
    isFile: () => true,
    realpath: (p) => p,
  };
  for (const unc of [
    '\\\\localhost\\C$\\ws\\pwsh.exe',
    '\\\\evil.example\\s\\PowerShell\\7\\pwsh.exe',
    '//evil.example/s/pwsh.exe',
  ]) {
    assert.equal(resolveExecutable('pwsh', { ...o, fallbacks: [unc] }), null, unc);
  }
  // Drive-absolute on its face, but a mapped drive / junction to a share.
  const mapped = 'Z:\\PowerShell\\7\\pwsh.exe';
  const viaShare = (p) =>
    p.toLowerCase().startsWith('z:') ? `\\\\evil.example\\s${p.slice(2)}` : p;
  assert.equal(resolveExecutable('pwsh', { ...o, realpath: viaShare, fallbacks: [mapped] }), null);
  assert.deepEqual(
    knownPwshLocations({ ProgramFiles: '\\\\evil\\s', LOCALAPPDATA: '//evil/s' }),
    []
  );
  // A normal install still works.
  assert.equal(
    resolveExecutable('pwsh', { ...o, fallbacks: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'] }),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  );
});
