// O153 root-cause probe ([CI-only], do not merge).
// Runs the QA N1 matrix through pwsh with the same spawn shape Moss uses
// (stdin ignore, stdout/stderr pipe, args -NoProfile -NonInteractive -Command)
// plus variants, then through Moss's execTool, and prints PROBE: JSON lines.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o153-'));
fs.writeFileSync(path.join(dir, 'README.md'), '# p\n');
fs.writeFileSync(path.join(dir, 'MARKER_O153.txt'), 'x\n');

function run(exe, args, { stdin = 'ignore', env = process.env, verbatim = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      stdio: [stdin, 'pipe', 'pipe'],
      env,
      cwd: dir,
      ...(verbatim ? { windowsVerbatimArguments: true } : {}),
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    if (stdin === 'pipe') child.stdin.end();
    child.on('error', (e) => resolve({ error: String(e) }));
    child.on('close', (code, signal) => resolve({ code, signal, stdout: out, stderr: err }));
  });
}

const which = await run(IS_WIN ? 'where.exe' : 'which', ['pwsh']);
const PWSH = (which.stdout || '').split(/\r?\n/).find(Boolean)?.trim() || 'pwsh';
const ver = await run(PWSH, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
const nodeWhere = await run(IS_WIN ? 'where.exe' : 'which', ['node']);
console.log(
  `PROBE: env ${JSON.stringify({ platform: process.platform, node: process.version, pwsh: PWSH, pwshVersion: ver.stdout?.trim(), nodeOnPath: nodeWhere.stdout?.trim() })}`
);

const QA = [
  'node -e 1; ls -Name .',
  'node -e 1 && ls -Name .',
  'Write-Output before; ls -Name .',
  'node -e 1; Write-Output after',
  'node -e 1; Get-ChildItem -Name .; if (-not $?) { exit 2 }',
  'node -e 1; Get-Item NO_SUCH_PATH_XYZ',
];
const EXTRA = [
  'node -e 1; ls .',
  'node -e 1; node -e "process.exit(3)"',
  'node -e 1; Set-Content -Path ran_o153.txt -Value x; Write-Output after',
  'node -e 1; [Console]::Out.WriteLine("direct-console")',
  'node -e 1; Write-Host host-after',
  'node -e 1; [Console]::Error.WriteLine("direct-err")',
  'node -e 1; Write-Error err-after',
  'Write-Output before; node -e 1; Write-Output after',
  'node -e "console.log(1)"; Write-Output after',
  'cmd /c echo native; Write-Output after',
  'whoami; Write-Output after',
  'node -e 1; Write-Output after; "lastexit=$LASTEXITCODE"',
  'node -e 1\nWrite-Output after-newline',
  '& { node -e 1; Write-Output after }',
  '$null = node -e 1; Write-Output after',
  'node -e 1 | Out-Null; Write-Output after',
  'node -e 1 | Out-Default; Write-Output after',
  '(node -e 1); Write-Output after',
];

const variants = [
  ['moss', (c) => ['-NoProfile', '-NonInteractive', '-Command', c], {}],
  ['stdin-pipe', (c) => ['-NoProfile', '-NonInteractive', '-Command', c], { stdin: 'pipe' }],
  ['interactive', (c) => ['-NoProfile', '-Command', c], {}],
  ['outputformat-text', (c) => ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', c], {}],
  [
    'encoded',
    (c) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(c, 'utf16le').toString('base64')],
    {},
  ],
];

const short = (s) => (s ?? '').replace(/\r/g, '').slice(0, 300);
for (const cmd of [...QA, ...EXTRA]) {
  try { fs.rmSync(path.join(dir, 'ran_o153.txt'), { force: true }); } catch {}
  for (const [name, argsFor, opts] of variants) {
    if (name !== 'moss' && !QA.includes(cmd) && !cmd.includes('after')) continue;
    const r = await run(PWSH, argsFor(cmd), opts);
    const ran = fs.existsSync(path.join(dir, 'ran_o153.txt'));
    console.log(
      `PROBE: raw ${JSON.stringify({ variant: name, cmd, exit: r.code, stdout: short(r.stdout), stderr: short(r.stderr), ...(cmd.includes('ran_o153') ? { secondHalfRan: ran } : {}), error: r.error })}`
    );
  }
}

// cmd fallback and sh for comparison
for (const cmd of ['node -e 1 & dir /b', 'node -e 1 && dir /b']) {
  if (!IS_WIN) break;
  const r = await run(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { verbatim: true });
  console.log(`PROBE: cmd ${JSON.stringify({ cmd, exit: r.code, stdout: short(r.stdout), stderr: short(r.stderr) })}`);
}

// Moss exec tool, same commands
const { execTool } = await import('../dist/tools/builtin.js');
for (const cmd of [...QA, 'node -e 1; node -e "process.exit(3)"', 'node -e 1; Set-Content -Path ran_o153.txt -Value x; Write-Output after']) {
  try { fs.rmSync(path.join(dir, 'ran_o153.txt'), { force: true }); } catch {}
  let text;
  try {
    text = await execTool.execute({ command: cmd }, { workspaceDir: dir, sessionKey: 'o153' });
  } catch (e) {
    text = `THROW ${e?.message ?? e}`;
  }
  console.log(
    `PROBE: moss-exec ${JSON.stringify({ cmd, text: short(text), ...(cmd.includes('ran_o153') ? { secondHalfRan: fs.existsSync(path.join(dir, 'ran_o153.txt')) } : {}) })}`
  );
}

// ---- Part 2: Moss CLI (-p) with the o121/o151 minimal child env ----
// Hypothesis: with the minimal env the host-shell probe falls back to cmd.exe,
// where `;` is not a separator (node swallows `; ls R` as argv → exit 0, no output).
const minimal = {
  PATH: process.env.PATH,
  HOME: os.homedir(),
  USERPROFILE: os.homedir(),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
};
const resolveSrc = `import('./dist/utils/host-shell.js').then(m=>{const s=m.resolveHostShell();console.log(JSON.stringify({kind:s.kind,exe:s.executable}))})`;
const envVariants = [
  ['full', process.env],
  ['minimal(o121)', minimal],
  ...['PATHEXT', 'ComSpec', 'windir', 'TEMP', 'APPDATA', 'LOCALAPPDATA', 'PSModulePath', 'ProgramFiles', 'SystemDrive'].map(
    (k) => [`minimal+${k}`, { ...minimal, ...(process.env[k] !== undefined ? { [k]: process.env[k] } : {}) }]
  ),
];
for (const [name, env] of envVariants) {
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', resolveSrc], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    child.stdout.on('data', (c) => (o += c));
    child.stderr.on('data', (c) => (e += c));
    child.on('close', (code) => resolve({ code, o, e }));
  });
  console.log(`PROBE: hostshell ${JSON.stringify({ env: name, exit: r.code, out: short(r.o), err: short(r.e) })}`);
}
for (const [name, env] of [['full', process.env], ['minimal(o121)', minimal]]) {
  const w = await run(IS_WIN ? 'where.exe' : 'which', ['pwsh'], { env });
  console.log(`PROBE: where-pwsh ${JSON.stringify({ env: name, exit: w.code, stdout: short(w.stdout), stderr: short(w.stderr) })}`);
  const v = await run(PWSH, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { env });
  console.log(`PROBE: pwsh-major ${JSON.stringify({ env: name, exit: v.code, stdout: short(v.stdout), stderr: short(v.stderr) })}`);
}

const { scenario } = await import('../test/o121-safety-block-outcome.spec.mjs');
const execStep = (command) => ({ name: 'exec', args: { command } });
const cliCases = [
  'node -e 1; ls -Name .',
  'node -e 1 && ls -Name .',
  'node -e 1; Write-Output after',
  'Write-Output before; ls -Name .',
  'node -e 1; Get-Item NO_SUCH_PATH_XYZ',
  'node -e 1; node -e "process.exit(3)"',
  '$PSVersionTable.PSVersion.Major',
  'echo %COMSPEC%',
];
for (const cmd of cliCases) {
  for (const json of [false, true]) {
    try {
      const r = await scenario({ lang: 'en', steps: [execStep(cmd)], finalText: 'Done.', json });
      const res = json
        ? r.out.trim().split('\n').filter((l) => l.startsWith('{')).pop()
        : r.last;
      console.log(
        `PROBE: cli ${JSON.stringify({ cmd, json, exit: r.code, tool: short(r.toolResults.join('\n')), last: short(res) })}`
      );
    } catch (e) {
      console.log(`PROBE: cli ${JSON.stringify({ cmd, json, error: String(e?.message ?? e) })}`);
    }
  }
}
