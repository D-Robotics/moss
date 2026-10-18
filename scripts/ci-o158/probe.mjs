#!/usr/bin/env node
// O158 [CI-only] repro probe (not a fix). windows-latest only.
// Removes every PATH entry that holds pwsh.exe, puts fake pwsh.exe (and, in
// some cases, powershell/cmd/git/node.exe) in the workspace, starts
// `dist/cli.js -p --output-format json` from that workspace against a local
// fake model server, and records which fake binaries ran (MARK-*.txt files).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const CLI = path.join(ROOT, 'dist', 'cli.js');
const FAKE = process.argv[2];
const OUT = process.argv[3] ?? path.join(ROOT, 'o158-evidence');
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);

const sep = ';';
const fullPath = process.env.PATH ?? process.env.Path ?? '';
const dropped = [];
const noPwshPath = fullPath
  .split(sep)
  .filter((d) => {
    const hit = d && fs.existsSync(path.join(d.replace(/^"(.*)"$/, '$1'), 'pwsh.exe'));
    if (hit) dropped.push(d);
    return !hit;
  })
  .join(sep);
const neutral = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-neutral-'));
const whereCheck = spawnSync('where.exe', ['pwsh'], {
  cwd: neutral,
  env: { ...process.env, PATH: noPwshPath },
  encoding: 'utf8',
});
log('dropped PATH entries:', JSON.stringify(dropped));
log(
  'where.exe pwsh (neutral cwd, filtered PATH): status',
  whereCheck.status,
  JSON.stringify(whereCheck.stdout),
  JSON.stringify(whereCheck.stderr)
);

function startFake(steps, finalText) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        /* ignore */
      }
      const n = (body.messages ?? []).filter((m) => m.role === 'tool').length;
      if (body.tools && body.messages) server.lastMessages = body.messages;
      const chunk = (delta, fr = null) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: fr }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (body.tools && n < steps.length) {
        const s = steps[n];
        res.write(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${n}`,
                type: 'function',
                function: { name: s.name, arguments: JSON.stringify(s.args) },
              },
            ],
          })
        );
        res.write(chunk({}, 'tool_calls'));
      } else {
        res.write(chunk({ role: 'assistant', content: finalText }));
        res.write(chunk({}, 'stop'));
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function run(args, env, cwd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

const ALL = ['pwsh', 'powershell', 'cmd', 'git', 'node'];
const CASES = [
  { id: 'A-nopwsh-fake-pwsh-no-tool', pathMode: 'nopwsh', fakes: ['pwsh'], steps: [] },
  {
    id: 'B-nopwsh-fake-all5-exec',
    pathMode: 'nopwsh',
    fakes: ALL,
    steps: [{ name: 'exec', args: { command: 'node -e "console.log(41+1)"' } }],
  },
  {
    id: 'C-control-realpwsh-fake-all5-exec',
    pathMode: 'full',
    fakes: ALL,
    steps: [{ name: 'exec', args: { command: 'node -e "console.log(41+1)"' } }],
  },
  { id: 'D-baseline-nopwsh-no-fakes', pathMode: 'nopwsh', fakes: [], steps: [] },
];
// O158 extended matrix (spec 4/5): 7 fakes incl. npx.cmd and where.exe, git
// repo, a PreToolUse hook, an exec with `git status` and node, PATH with and
// without pwsh, and PATH polluted with `.`, an empty and a relative entry.
const ALL7 = [...ALL, 'where'];
const MSTEP = [
  {
    name: 'exec',
    args: { command: 'git status --short && node -e "console.log(41+1)" && npx --version' },
  },
];
for (const pathMode of ['nopwsh', 'full', 'dot-nopwsh', 'dot-full'])
  CASES.push({
    id: `M-${pathMode}-fake-all7-hook-exec-gitstatus`,
    pathMode,
    fakes: ALL7,
    npxCmd: true,
    gitInit: true,
    hook: true,
    steps: MSTEP,
  });
// Each fake on its own, with pwsh on PATH and without (spec 4, one at a time).
for (const fake of ['pwsh', 'powershell', 'cmd', 'git', 'node', 'npx.cmd', 'where'])
  for (const pathMode of ['nopwsh', 'full'])
    CASES.push({
      id: `S-${pathMode}-fake-${fake}`,
      pathMode,
      fakes: fake === 'npx.cmd' ? [] : [fake],
      npxCmd: fake === 'npx.cmd',
      gitInit: true,
      hook: true,
      steps: MSTEP,
    });
// QA #142 F4: with COMSPEC unset Moss itself starts a bare `cmd.exe` (hook
// shell, chcp, shell:true); this is the only way a fake cmd.exe can run.
// No Moss path starts a bare `powershell` (windows-background-job uses the
// absolute System32 path), so the powershell rows cannot go red on a revert.
for (const pathMode of ['nopwsh', 'full'])
  CASES.push({
    id: `S-${pathMode}-fake-cmd-nocomspec`,
    pathMode,
    fakes: ['cmd'],
    noComspec: true,
    gitInit: true,
    hook: true,
    steps: MSTEP,
  });
// PM ruling on O1: PATH starts with $WS\node_modules\.bin holding fake
// git/node/pwsh. Startup and the hook launch must not run them; the model's
// own exec (`git o158-model-exec`) does — known limitation.
for (const pathMode of ['nopwsh', 'full'])
  CASES.push({
    id: `O1-${pathMode}-node_modules-bin`,
    pathMode,
    fakes: [],
    binFakes: ['git', 'node', 'pwsh'],
    gitInit: true,
    hook: true,
    hookNode: true,
    steps: [{ name: 'exec', args: { command: 'git o158-model-exec' } }],
  });
// QA #142 F2: a project .env points ProgramFiles / ProgramW6432 / LOCALAPPDATA
// at aliases of the workspace (\\localhost\C$\…, long/short name) holding
// PowerShell\7\pwsh.exe; no pwsh on PATH, none of the three in the real env.
CASES.push({
  id: 'F2-nopwsh-dotenv-pwsh-fallback-alias',
  pathMode: 'nopwsh',
  fakes: [],
  dotenvAlias: true,
  steps: [],
});
const pathFor = (mode) =>
  ({
    full: fullPath,
    nopwsh: noPwshPath,
    'dot-full': `.;;bin;${fullPath}`,
    'dot-nopwsh': `.;;bin;${noPwshPath}`,
  })[mode];

const summary = {
  dropped,
  whereNeutral: { status: whereCheck.status, stdout: whereCheck.stdout },
  cases: {},
};
for (const c of CASES) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o158-'));
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  const cfg = path.join(home, '.config', 'moss');
  for (const d of [home, proj, cfg]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(proj, 'README.md'), '# p\n');
  const server = await startFake(c.steps, 'All done.');
  const port = server.address().port;
  const env = {
    PATH: pathFor(c.pathMode),
    HOME: home,
    USERPROFILE: home,
    SystemRoot: process.env.SystemRoot,
    ...(c.noComspec ? {} : { COMSPEC: process.env.COMSPEC }),
    PATHEXT: process.env.PATHEXT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    MOSS_CONFIG_DIR: cfg,
    MOSS_RUNTIME_DIR: path.join(home, 'runtime'),
    MOSS_NO_BUNDLED_DEFAULT: '1',
    MOSS_NO_TUI: '1',
    MOSS_LOCALE: 'en',
    FAKE_OAI_KEY: 'sk-fake-local-000',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  // config set runs from a neutral dir: fakes are only in proj, planted after.
  for (const [k, v] of [
    ['provider', 'openai-compatible'],
    ['baseUrl', `http://127.0.0.1:${port}`],
    ['model', 'fake-model'],
    ['apiKeyEnv', 'FAKE_OAI_KEY'],
  ])
    await run(['config', 'set', k, v], env, neutral);
  if (c.gitInit) {
    const g = (...a) =>
      spawnSync('git', a, { cwd: proj, stdio: 'ignore', env: { ...process.env, HOME: home } });
    g('init', '-q');
    g('add', '-A');
    g('-c', 'user.email=a@b', '-c', 'user.name=u', 'commit', '-qm', 'init', '--no-verify');
  }
  if (c.hook) {
    fs.mkdirSync(path.join(proj, '.moss'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.moss', 'config.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { command: 'git --version > HOOK-OK.txt' },
            ...(c.hookNode ? [{ command: 'node -e "console.log(41+1)" > HOOK-node.txt' }] : []),
          ],
        },
      })
    );
  }
  for (const f of c.fakes) fs.copyFileSync(FAKE, path.join(proj, `${f}.exe`));
  if (c.binFakes) {
    const bin = path.join(proj, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const f of c.binFakes) fs.copyFileSync(FAKE, path.join(bin, `${f}.exe`));
    env.PATH = `${bin};${env.PATH}`;
  }
  if (c.dotenvAlias) {
    for (const rel of ['PowerShell\\7', 'Microsoft\\WindowsApps']) {
      fs.mkdirSync(path.join(proj, rel), { recursive: true });
      fs.copyFileSync(FAKE, path.join(proj, rel, 'pwsh.exe'));
    }
    const long = fs.realpathSync.native(proj);
    const unc = `\\\\localhost\\${long[0]}$${long.slice(2)}`;
    const other = long === proj ? proj.toUpperCase() : long;
    fs.writeFileSync(
      path.join(proj, '.env'),
      `ProgramFiles=${unc}\r\nProgramW6432=${other}\r\nLOCALAPPDATA=${other}\r\n`
    );
    log(`F2 .env: ProgramFiles=${unc} ProgramW6432/LOCALAPPDATA=${other} (cwd ${proj})`);
    try {
      log('F2 UNC alias reachable:', fs.existsSync(path.join(unc, 'PowerShell', '7', 'pwsh.exe')));
    } catch (e) {
      log('F2 UNC alias check failed:', String(e));
    }
  }
  if (c.npxCmd)
    fs.writeFileSync(
      path.join(proj, 'npx.cmd'),
      '@echo off\r\necho %* >> "%~dp0MARK-npx.txt"\r\necho 7\r\n'
    );
  const r = await run(
    ['--trust-workspace', '--lang', 'en', '--output-format', 'json', '-p', 'run it'],
    env,
    proj
  );
  server.closeAllConnections?.();
  server.close();
  const marks = {};
  const scan = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) scan(full, rel ? `${rel}/${e.name}` : e.name);
      else if (e.name.startsWith('MARK-'))
        marks[rel ? `${rel}/${e.name}` : e.name] = fs.readFileSync(full, 'utf8').trim();
    }
  };
  scan(proj, '');
  let json = null;
  for (const line of r.out.trim().split(/\r?\n/).reverse()) {
    try {
      const j = JSON.parse(line);
      if (j && typeof j === 'object') {
        json = j;
        break;
      }
    } catch {
      /* not json */
    }
  }
  const toolResults = (server.lastMessages ?? [])
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
  const readOr = (f) => {
    try {
      return fs.readFileSync(path.join(proj, f), 'utf8').trim();
    } catch {
      return null;
    }
  };
  // The real git, not a fake that printed "7" into the file.
  const hookRan = /git version/.test(readOr('HOOK-OK.txt') ?? '');
  const hookNode = readOr('HOOK-node.txt');
  const row = {
    exit: r.code,
    hookRan,
    hookNode,
    jsonShell: json?.shell ?? null,
    markers: marks,
    toolResults,
    stderrTail: r.err.slice(-1500),
  };
  summary.cases[c.id] = row;
  fs.writeFileSync(path.join(OUT, `${c.id}.stdout.txt`), r.out);
  fs.writeFileSync(path.join(OUT, `${c.id}.stderr.txt`), r.err);
  log(`\n=== ${c.id} ===`);
  log(JSON.stringify(row, null, 1));
}
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
const markersOf = (id) => Object.keys(summary.cases[id]?.markers ?? {});
const aHit = markersOf('A-nopwsh-fake-pwsh-no-tool').includes('MARK-pwsh.txt');
const cHit = markersOf('C-control-realpwsh-fake-all5-exec');
log(
  `\nO158 VERDICT: ${aHit ? 'REPRODUCED' : 'NOT REPRODUCED'} (case A: fake workspace pwsh.exe ${aHit ? 'WAS' : 'was NOT'} executed at startup)`
);
log(
  `O158 VERDICT C: ${cHit.length ? 'REPRODUCED' : 'NOT REPRODUCED'} (case C, real pwsh on PATH: workspace fakes executed: ${cHit.join(', ') || 'none'})`
);
let matrixClean = true;
for (const id of Object.keys(summary.cases).filter((k) => /^[MS]-/.test(k))) {
  const row = summary.cases[id];
  const ok42 = row.toolResults.some((t) => /\b42\b/.test(t));
  const gitOk = row.toolResults.some((t) => /\?\? /.test(t));
  const npxOk = row.toolResults.some((t) => /\b\d+\.\d+\.\d+\b/.test(t));
  const markers = Object.keys(row.markers);
  const ok = !markers.length && row.exit === 0 && ok42 && gitOk && npxOk && row.hookRan;
  if (!ok) matrixClean = false;
  log(
    `O158 MATRIX ${id}: ${ok ? 'PASS' : 'FAIL'} markers=${markers.join(',') || 'none'} exit=${row.exit} shell=${row.jsonShell} exec42=${ok42} gitStatus=${gitOk} npx=${npxOk} hook=${row.hookRan}`
  );
}
log(`O158 MATRIX OVERALL: ${matrixClean ? 'ALL PASS' : 'SOME FAIL'}`);
for (const id of Object.keys(summary.cases).filter((k) => k.startsWith('O1-'))) {
  const row = summary.cases[id];
  const m = row.markers;
  const keys = Object.keys(m);
  const onlyModelExec =
    keys.length === 1 &&
    keys[0] === 'node_modules/.bin/MARK-git.txt' &&
    /o158-model-exec/.test(m[keys[0]]) &&
    m[keys[0]].split(/\r?\n/).length === 1;
  const ok = onlyModelExec && row.exit === 0 && row.hookRan && row.hookNode === '42';
  log(
    `O158 O1 ${id}: ${ok ? 'PASS' : 'FAIL'} markers=${JSON.stringify(m)} shell=${row.jsonShell} hookGit=${row.hookRan} hookNode=${row.hookNode} (model exec hitting node_modules/.bin/git = known limitation)`
  );
}
{
  const row = summary.cases['F2-nopwsh-dotenv-pwsh-fallback-alias'];
  const keys = Object.keys(row.markers);
  log(
    `O158 F2 ${keys.length ? 'REPRODUCED' : 'NOT REPRODUCED'}: markers=${JSON.stringify(row.markers)} shell=${row.jsonShell} exit=${row.exit}`
  );
}
