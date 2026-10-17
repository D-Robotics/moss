#!/usr/bin/env node
/**
 * O153 (P1, honest results): on Windows, `node -e 1; ls R` reported exit 0,
 * `(no output)` and json success.
 *
 * Root cause (windows-latest, draft #133 run 39070896610): when the env has no
 * PATHEXT (IDE/service/CI launchers, the -p specs), `where.exe pwsh` finds
 * nothing, so Moss fell back to cmd.exe. cmd does not split on `;`, so only
 * `node` ran, with `1;`, `ls`, `R` as its argv. Under pwsh every `;`
 * statement runs and is captured.
 *
 * The fix resolves pwsh on PATH with Windows' default PATHEXT. These tests are
 * process-level: a real `-p` run with the o121 minimal env and real pwsh.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findOnWindowsPath, hostShellChildEnv } from '../dist/utils/host-shell.js';
import { scenario } from './o121-safety-block-outcome.spec.mjs';

const IS_WIN = process.platform === 'win32';
const WIN_ONLY = { skip: !IS_WIN && 'platform mismatch (not win32)' };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = (command) => ({ name: 'exec', args: { command } });

// ---- PATH lookup (pure; every platform) ----
const PF = 'C:\\Program Files\\PowerShell\\7';
const has =
  (...files) =>
  (p) =>
    files.map((f) => f.toLowerCase()).includes(p.toLowerCase());

test('findOnWindowsPath: no PATHEXT in env → Windows default (.EXE) still finds pwsh', () => {
  const env = { PATH: `C:\\Windows\\system32;${PF}` };
  assert.equal(findOnWindowsPath('pwsh', env, has(`${PF}\\pwsh.exe`)), `${PF}\\pwsh.exe`);
});

test('findOnWindowsPath: honours PATHEXT, quoted and empty PATH entries, first hit wins', () => {
  const env = { PATH: `;"${PF}";C:\\other`, PATHEXT: '.CMD;.EXE' };
  assert.equal(
    findOnWindowsPath('pwsh', env, has(`${PF}\\pwsh.exe`, 'C:\\other\\pwsh.cmd')),
    `${PF}\\pwsh.exe`
  );
  assert.equal(
    findOnWindowsPath('pwsh', { PATH: 'C:\\x' }, () => false),
    null
  );
  assert.equal(
    findOnWindowsPath('pwsh', {}, () => true),
    null,
    'empty PATH finds nothing'
  );
});

// ---- pwsh child env (pure; every platform) ----
// Without PATHEXT pwsh cannot resolve `node`/`git` either (windows-latest run
// 39071567382: "The term 'node' is not recognized"), so the pwsh child gets
// Windows' default PATHEXT.
test('hostShellChildEnv: pwsh child with no PATHEXT gets the Windows default', () => {
  const env = { PATH: 'C:\\x', LANG: 'en_US.UTF-8' };
  const out = hostShellChildEnv(env, { kind: 'pwsh' });
  assert.equal(out.PATHEXT, '.COM;.EXE;.BAT;.CMD');
  assert.equal(out.PATH, 'C:\\x');
  assert.equal(env.PATHEXT, undefined, 'input env is not mutated');
  assert.equal(
    hostShellChildEnv({ PATH: 'C:\\x', PATHEXT: '  ' }, { kind: 'pwsh' }).PATHEXT,
    '.COM;.EXE;.BAT;.CMD'
  );
  const lower = hostShellChildEnv({ Pathext: '' }, { kind: 'pwsh' });
  assert.deepEqual(
    Object.keys(lower),
    ['PATHEXT'],
    'empty differently-cased key replaced, not duplicated'
  );
});

test('hostShellChildEnv: existing PATHEXT (any case) and non-pwsh shells are unchanged', () => {
  const custom = { PATH: 'C:\\x', PATHEXT: '.EXE;.PS1' };
  assert.equal(hostShellChildEnv(custom, { kind: 'pwsh' }), custom);
  const mixed = { PathExt: '.EXE' };
  assert.equal(hostShellChildEnv(mixed, { kind: 'pwsh' }), mixed);
  const bare = { PATH: '/usr/bin' };
  assert.equal(hostShellChildEnv(bare, { kind: 'cmd' }), bare);
  assert.equal(hostShellChildEnv(bare, { kind: 'sh' }), bare);
});

// ---- process level (real pwsh on windows-latest) ----
function resolveKindIn(env) {
  return new Promise((resolve) => {
    const src = `import('./dist/utils/host-shell.js').then(m=>process.stdout.write(m.resolveHostShell().kind))`;
    const child = spawn(process.execPath, ['-e', src], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('close', () => resolve(out.trim()));
  });
}

test('win32: exec shell is still pwsh when the env has no PATHEXT', WIN_ONLY, async () => {
  const env = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  assert.equal(await resolveKindIn(env), 'pwsh', 'must not fall back to cmd.exe');
});

const tools = (r) => r.toolResults.join('\n');

// Acceptance 1: second half output is captured; exit 0.
for (const [cmd, marker] of [
  ['node -e 1; ls notes.txt', 'notes.txt'],
  ['node -e 1; ls -Name notes.txt', 'notes.txt'],
  ['node -e 1; Write-Output after', 'after'],
  ['Write-Output before; ls -Name notes.txt', 'notes.txt'],
  // regression: && chain and a single command
  ['node -e 1 && ls -Name notes.txt', 'notes.txt'],
  ['Write-Output single-o153', 'single-o153'],
]) {
  test(`win32 -p (minimal env): \`${cmd}\` → output has ${marker}, exit 0`, WIN_ONLY, async () => {
    const r = await scenario({ lang: 'en', steps: [exec(cmd)], finalText: 'Listed.' });
    const t = tools(r);
    assert.ok(t.includes(marker), `marker ${marker}: ${t.slice(0, 400)}`);
    assert.doesNotMatch(t, /\(no output\)|Command failed|is not recognized/, t.slice(0, 400));
    assert.equal(r.code, 0, `exit 0, got ${r.code}; last=${r.last}`);
    if (cmd.startsWith('Write-Output before')) assert.ok(t.includes('before'), t.slice(0, 400));
  });
}

// Acceptance 2: a failing `;` tail is visible to the model (error stream or
// non-zero exit), never `(no output)`.
for (const [cmd, want] of [
  ['node -e 1; Get-Item NO_SUCH_PATH_XYZ', /NO_SUCH_PATH_XYZ/],
  ['node -e 1; node -e "process.exit(3)"', /Command failed \(exit [1-9]\d*\)/],
]) {
  test(`win32 -p (minimal env): \`${cmd}\` → failure visible to the model`, WIN_ONLY, async () => {
    const r = await scenario({ lang: 'en', steps: [exec(cmd)], finalText: 'It failed.' });
    const t = tools(r);
    assert.match(t, /^Command failed \(exit [1-9]\d*\)/, t.slice(0, 400));
    assert.match(t, want, t.slice(0, 400));
    assert.doesNotMatch(t, /\(no output\)/);
  });
}
