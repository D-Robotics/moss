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
  { name: 'exec', args: { command: 'git status --short && node -e "console.log(41+1)"' } },
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
    COMSPEC: process.env.COMSPEC,
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
      JSON.stringify({ hooks: { PreToolUse: [{ command: 'git --version' }] } })
    );
  }
  for (const f of c.fakes) fs.copyFileSync(FAKE, path.join(proj, `${f}.exe`));
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
  for (const f of fs.readdirSync(proj))
    if (f.startsWith('MARK-')) marks[f] = fs.readFileSync(path.join(proj, f), 'utf8').trim();
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
  const row = {
    exit: r.code,
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
for (const id of Object.keys(summary.cases).filter((k) => k.startsWith('M-'))) {
  const row = summary.cases[id];
  const ok42 = row.toolResults.some((t) => /\b42\b/.test(t));
  log(
    `O158 MATRIX ${id}: markers=${Object.keys(row.markers).join(',') || 'none'} exit=${row.exit} shell=${row.jsonShell} exec42=${ok42}`
  );
}
