// O130 (P1): write targets the POSIX detector did not model — PowerShell write
// cmdlets/aliases, [IO.File]::Write*, every redirection form, `$env:X` /
// `${env:X}` / `%X%` expansion — plus the PM scope rule: only WRITE TARGETS
// are examined; resolvable variables are expanded then compared; unresolvable
// ones (unknown, assigned earlier on the same line, command substitution,
// relative after an unresolvable `cd`) are blocked; `$` in arguments / reads
// never prompts. Detector-level, runs on all three OSes (env comes from ctx).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findShellProtectedWrites } from '../dist/safety/protected-paths.js';
import {
  protectedPathHeadlessNotice,
  protectedPathHeadlessReason,
} from '../dist/cli/protected-path-prompt.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o130p-'));
const profile = path.join(root, 'profile');
const appdata = path.join(profile, 'AppData', 'Roaming');
const cfg = path.join(appdata, 'moss');
const custom = path.join(root, 'custom-moss');
const ws = path.join(root, 'ws');
for (const d of [cfg, custom, ws, path.join(ws, 'src')]) fs.mkdirSync(d, { recursive: true });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const env = {
  USERPROFILE: profile,
  HOME: profile,
  APPDATA: appdata,
  MOSS_CONFIG_DIR: custom,
  TEMP: path.join(root, 'tmp'),
  PATH: '/usr/bin',
};
const ctx = { cwd: ws, workspaceRoot: ws, configDirs: [cfg, custom], env, home: profile };
const hits = (cmd) => findShellProtectedWrites(cmd, ctx);
const fwd = (p) => p.replace(/\\/g, '/');
const CFG = fwd(path.join(cfg, 'config.json'));
const CRED = fwd(path.join(custom, 'credentials'));
const CCFG = fwd(path.join(custom, 'config.json'));

function blocked(cmd, why) {
  const h = hits(cmd);
  // Any gate counts (pre-O130 layers already gate some `$` targets as
  // `git` via the workspace-root fallback; that stays — stricter only).
  assert.ok(h.length > 0, `${why}: expected a gate for ${cmd} -> ${JSON.stringify(h)}`);
  return h;
}
function protectedHit(cmd) {
  const h = blocked(cmd, 'protected');
  assert.ok(
    h.some((x) => x.category === 'moss-config'),
    `${cmd} -> moss-config, got ${JSON.stringify(h)}`
  );
}
function unresolvedHit(cmd) {
  return blocked(cmd, 'unresolved');
}
function clean(cmd) {
  const h = hits(cmd);
  assert.deepEqual(h, [], `must not gate: ${cmd} -> ${JSON.stringify(h)}`);
}

// ---- 1. every pwsh writer / alias / redirection, literal path ----
const LITERAL = [
  `Set-Content -Path '${CFG}' -Value PWN`,
  `Set-Content -LiteralPath '${CFG}' -Value PWN`,
  `Set-Content -Path:'${CFG}' -Value PWN`,
  `Set-Content '${CFG}' PWN`, // positional
  `set-content '${CFG}' PWN`, // case
  `SET-CONTENT "${CFG}" PWN`,
  `sc '${CFG}' PWN`,
  `Add-Content '${CCFG}' PWN`,
  `ac -Path '${CCFG}' -Value PWN`,
  `'x' | Out-File '${CFG}'`,
  `'x' | Out-File -FilePath '${CRED}' -Encoding utf8`,
  `'x' | Tee-Object -FilePath '${CFG}'`,
  `'x' | Tee-Object '${CFG}'`,
  `New-Item -Path '${CFG}' -Value PWN -Force`,
  `New-Item -ItemType File -Path '${custom}' -Name credentials -Value x`,
  `ni '${CFG}' -Value PWN`,
  `Copy-Item evil.json -Destination '${CFG}'`,
  `Copy-Item -Path evil.json -Destination '${CFG}'`,
  `Copy-Item evil.json '${CFG}'`,
  `cpi evil.json '${CFG}'`,
  `copy evil.json '${CFG}'`,
  `Move-Item evil.json -Destination '${CRED}'`,
  `mi evil.json '${CRED}'`,
  `Clear-Content '${CFG}'`,
  `[IO.File]::WriteAllText('${CFG}', 'PWN')`,
  `[System.IO.File]::WriteAllBytes('${CRED}', @(1))`,
  `[IO.File]::AppendAllText("${CFG}", 'PWN')`,
  `echo PWN > '${CFG}'`,
  `echo PWN >> '${CFG}'`,
  `echo PWN 2> '${CFG}'`,
  `echo PWN *> '${CFG}'`,
  `echo PWN *>> '${CFG}'`,
  `echo PWN >'${CFG}'`,
  `cmd /c 2>'${CFG}' echo x`,
  `echo PWN | tee '${CFG}'`,
  `echo PWN | tee -a /tmp/x '${CRED}'`,
  `cp evil.json '${CFG}'`,
  `mv evil.json '${CRED}'`,
  `cp -t '${custom}' credentials`,
  // O130 QA BLOCK: additional writers
  `Set-Item -Path '${CFG}' x`,
  `Set-Item '${CFG}' x`,
  `'x' | Export-Clixml '${CFG}'`,
  `'x' | Export-Csv -Path '${CRED}'`,
  `Export-Csv -Path '${CFG}' -InputObject x`,
  `Invoke-WebRequest http://example.invalid -OutFile '${CFG}'`,
  `iwr http://example.invalid -OutFile '${CRED}'`,
  `curl.exe -o '${CFG}' http://example.invalid`,
  `curl --output '${CRED}' http://example.invalid`,
  `xcopy evil.json '${CFG}'`,
  `robocopy . '${custom}' config.json`,
  `New-Object IO.StreamWriter('${CFG}')`,
  `$w = New-Object IO.StreamWriter('${CRED}'); $w.Close()`,
  `New-Object -TypeName System.IO.StreamWriter -ArgumentList '${CFG}'`,
  // mixed separators / case
  `Set-Content '${CFG.replace(/\//g, '\\')}' x`,
  `Set-Content '${CFG.replace(/\/moss\//, '\\moss/')}' x`,
];
for (const cmd of LITERAL) test(`O130 literal writer gated: ${cmd}`, () => protectedHit(cmd));

// ---- 2. env forms that resolve from the current env → expanded then compared ----
const ENVFORMS = [
  'echo PWN > "$env:APPDATA/moss/config.json"',
  'echo PWN > "$env:APPDATA\\moss\\config.json"',
  'echo PWN > "${env:APPDATA}/moss/config.json"',
  'echo PWN > "$ENV:appdata/moss/config.json"',
  'echo PWN > "$env:MOSS_CONFIG_DIR/credentials"',
  'echo PWN > %APPDATA%/moss/config.json',
  'echo PWN > %appdata%\\moss\\config.json',
  'Set-Content -Path "$env:APPDATA\\moss\\config.json" -Value PWN',
  'Set-Content "$env:APPDATA\\moss\\credentials" PWN',
  'sc $env:MOSS_CONFIG_DIR/config.json PWN',
  'Add-Content -LiteralPath "$env:MOSS_CONFIG_DIR\\credentials" x',
  "'x' | Out-File $env:APPDATA/moss/config.json",
  "'x' | Tee-Object -FilePath $env:APPDATA\\moss\\config.json",
  'New-Item -Path "$env:MOSS_CONFIG_DIR" -Name config.json -Value x -Force',
  'Copy-Item evil.json -Destination "$env:APPDATA\\moss\\config.json"',
  'Move-Item evil.json "$env:MOSS_CONFIG_DIR/credentials"',
  '[IO.File]::WriteAllText("$env:APPDATA\\moss\\config.json", "x")',
  'cp evil.json "$MOSS_CONFIG_DIR/config.json"',
  'echo x > "$APPDATA/moss/config.json"',
  'echo x > "${APPDATA}/moss/config.json"',
  'tee $APPDATA/moss/config.json < evil.json',
  // relative after a resolvable cd (QA counterexample)
  'cd $env:APPDATA\\moss; sc config.json x',
  'Set-Location "$env:MOSS_CONFIG_DIR"; Set-Content credentials x',
  'cd %APPDATA%\\moss && echo x > config.json',
];
for (const cmd of ENVFORMS) test(`O130 env-form writer gated: ${cmd}`, () => protectedHit(cmd));

// ---- 3. unresolvable write targets → conservative block ----
const UNRESOLVABLE = [
  'Set-Content $p x', // pwsh variable, positional path
  'Set-Content -Path $p -Value x',
  'echo x > "$p"',
  'echo x > "$NOT_SET_O130/config.json"',
  'echo x > "$env:NOT_SET_O130\\config.json"',
  'echo x > %NOT_SET_O130%\\config.json',
  'echo x > "$(Get-Moss)/config.json"',
  'echo x > "$(dirname x)/config.json"',
  'echo x > `pwd`/config.json',
  "'x' | Out-File $target",
  'Copy-Item a.json -Destination $dst',
  'cp a.json "$DST"',
  'tee "$OUT"',
  '[IO.File]::WriteAllText($p, "x")',
  'cd $UNSET_O130 && echo x > config.json',
  'cd $p; sc config.json x',
  // QA (2): assigned earlier on the same line → never trust the current env
  '$env:APPDATA=\'C:\\x\'; Set-Content "$env:APPDATA\\moss\\config.json" x',
  '$env:APPDATA = "/tmp/elsewhere"; echo x > "$env:APPDATA/moss/config.json"',
  'APPDATA=/tmp/x; echo x > "$APPDATA/moss/config.json"',
  'APPDATA=/tmp/x echo x > "$APPDATA/x.txt"',
  'export MOSS_CONFIG_DIR=/tmp/x && echo x > "$MOSS_CONFIG_DIR/config.json"',
  'set APPDATA=C:\\x&& echo x > %APPDATA%\\moss\\config.json',
  '$p = "$env:APPDATA\\moss\\config.json"; Set-Content $p x',
  'HOME=/tmp/h; echo x > "$HOME/.bashrc"',
];
for (const cmd of UNRESOLVABLE)
  test(`O130 unresolvable write target gated: ${cmd}`, () => unresolvedHit(cmd));

// The same-line-assigned case must not be compared with the CURRENT env value
// (which would hit protected anyway here) — it must be unresolved even when the
// current env points somewhere harmless.
test('O130: same-line assignment overrides the env (not compared with current value)', () => {
  const harmless = { ...ctx, env: { ...env, APPDATA: path.join(root, 'elsewhere') } };
  const h = findShellProtectedWrites(
    '$env:APPDATA=\'C:\\x\'; Set-Content "$env:APPDATA\\notes.txt" x',
    harmless
  );
  assert.ok(
    h.some((x) => x.category === 'unresolved'),
    JSON.stringify(h)
  );
});

// ---- 4. counterexamples: `$` in arguments / reads, harmless resolvable targets ----
const ALLOW = [
  'Get-Content "$env:APPDATA/moss/config.json"',
  'type %APPDATA%\\moss\\config.json',
  'cat "$MOSS_CONFIG_DIR/config.json"',
  'Get-Content "$env:APPDATA/moss/config.json" | Set-Content out.txt',
  'echo $env:APPDATA > out.txt',
  'echo $HOME > out.txt',
  'echo %APPDATA% > out.txt',
  'Write-Output $p > out.txt',
  'grep $PAT src/a.ts',
  'echo hi > out.txt',
  `Set-Content -Path '${path.join(ws, 'notes.txt')}' -Value x`,
  'Set-Content -Path notes.txt -Value $env:APPDATA',
  'Set-Content notes.txt "$env:APPDATA\\moss\\config.json"', // value, not path
  'echo PWN > "$env:APPDATA/other-app/config.json"',
  'echo x > "$env:TEMP/o130.txt"',
  'Copy-Item "$env:APPDATA\\moss\\config.json" backup.json', // copy FROM config
  'cp "$MOSS_CONFIG_DIR/config.json" backup.json',
  'echo x 2>&1',
  'echo x > NUL',
  'echo x 2>/dev/null',
  'cd $env:TEMP; echo x > a.txt',
];
for (const cmd of ALLOW) test(`O130 does not gate: ${cmd}`, () => clean(cmd));

// ---- 4b. QA BLOCK: value-flag abbreviations must not steal the path slot ----
const ABBREV = [
  `Set-Content -En utf8 '${CFG}' x`,
  `Set-Content -Enc utf8 '${CFG}' x`,
  `Set-Content -Va x '${CFG}'`,
  `Add-Content -Va x '${CCFG}'`,
  `Out-File -Enc utf8 '${CFG}'`,
  `'x' | Out-File -Fi '${CRED}'`,
  `Set-Content -Encoding utf8 '${CFG}' x`, // full name still works
];
for (const cmd of ABBREV) test(`O130 value-flag abbrev gated: ${cmd}`, () => protectedHit(cmd));

// ---- 4c. QA BLOCK: parenthesized expression targets → unresolvable block ----
const PAREN = [
  `Set-Content (Join-Path $env:APPDATA 'moss\\config.json') x`,
  `Set-Content -Path ('${cfg}'+'/config.json') x`,
  `Set-Content (Join-Path '${appdata}' 'moss\\credentials') x`,
];
for (const cmd of PAREN) test(`O130 paren target gated: ${cmd}`, () => unresolvedHit(cmd));

// ---- 4d. QA BLOCK: one-level nested execution (same rules inside) ----
const NESTED = [
  `& { Set-Content '${CFG}' x }`,
  `. { Set-Content -Path '${CFG}' x }`,
  `iex "Set-Content '${CFG}' x"`,
  `Invoke-Expression "Set-Content '${CRED}' x"`,
  `pwsh -c "Set-Content '${CFG}' x"`,
  `pwsh -Command "Set-Content '${CFG}' x"`,
  // same rules inside: abbrev / paren / same-line assign
  `& { Set-Content -En utf8 '${CFG}' x }`,
  `& { Set-Content -Va x '${CFG}' }`,
  `& { Set-Content (Join-Path $env:APPDATA 'moss\\config.json') x }`,
  `& { $env:APPDATA='C:\\x'; Set-Content "$env:APPDATA\\moss\\config.json" x }`,
  `pwsh -c "Set-Content -En utf8 '${CFG}' x"`,
  `pwsh -c '$env:APPDATA="C:\\x"; Set-Content "$env:APPDATA\\moss\\config.json" x'`,
  `cmd /c "echo x > ${CFG.replace(/\//g, '\\\\')}"`,
];
for (const cmd of NESTED) test(`O130 nested one-level gated: ${cmd}`, () => blocked(cmd, 'nested'));

test('O130 -EncodedCommand always blocks (regardless of payload)', () => {
  unresolvedHit('pwsh -EncodedCommand UwBlAHQALQBDAG8AbgB0AGUAbgB0AA==');
  unresolvedHit('powershell.exe -EncodedCommand ABCDEF==');
});

// Mid-prefixes + documented aliases must also block (QA r2 §2.1). Unique-prefix
// of EncodedCommand: -e / -en / -enc / -EncodedC / -EncodedCom / …; plus -ec.
test('O130 -EncodedCommand unique-prefix and -ec aliases always block', () => {
  for (const cmd of [
    'pwsh -EncodedC AAA',
    'pwsh -EncodedCom AAA',
    'pwsh -EncodedComm AAA',
    'pwsh -enc AAA',
    'pwsh -en AAA',
    'pwsh -e AAA',
    'pwsh -ec AAA',
    'powershell -ec AAA',
    'powershell.exe -EncodedC AAA',
    'pwsh.exe -Enco AAA',
  ]) {
    unresolvedHit(cmd);
  }
});

test('O130 iex with variable argument is opaque → blocked', () => {
  unresolvedHit(`$c="Set-Content '${CFG}' x"; Invoke-Expression $c`);
  unresolvedHit(`$c="Set-Content '${CFG}' x"; iex $c`);
});

// ---- 5. copy (UX): reason + next step, zh and en ----
test('O130 unresolvable copy names the variable, why, and the next step (zh/en)', () => {
  const [h] = hits('Set-Content -Path $env:NOT_SET_O130\\config.json -Value x');
  assert.equal(h.category, 'unresolved');
  assert.equal(h.kind, 'unresolved-var');
  const zh = protectedPathHeadlessNotice(h, true);
  const en = protectedPathHeadlessNotice(h, false);
  assert.match(zh, /无法确定 `\$env:NOT_SET_O130\\config\.json` 指向的路径/);
  assert.match(zh, /按受保护路径处理/);
  assert.match(zh, /改用字面路径.*edit 工具/);
  assert.match(en, /cannot tell where `\$env:NOT_SET_O130\\config\.json` points/);
  assert.match(en, /literal path or the edit tool/);
  assert.match(protectedPathHeadlessReason(h, true), /^已拦截：无法确定/);
});

test('O130 resolved env form reports the expanded path', () => {
  const h = hits('Set-Content "$env:APPDATA\\moss\\config.json" x').find(
    (x) => x.category === 'moss-config'
  );
  assert.ok(h);
  assert.equal(fwd(h.resolved).toLowerCase(), CFG.toLowerCase());
  assert.doesNotMatch(h.raw, /\$env:/);
});
