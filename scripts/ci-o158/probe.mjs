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
    PATH: c.pathMode === 'full' ? fullPath : noPwshPath,
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
  for (const f of c.fakes) fs.copyFileSync(FAKE, path.join(proj, `${f}.exe`));
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
const reproduced = Object.keys(summary.cases['A-nopwsh-fake-pwsh-no-tool'].markers).includes(
  'MARK-pwsh.txt'
);
log(
  `\nO158 VERDICT: ${reproduced ? 'REPRODUCED' : 'NOT REPRODUCED'} (case A: fake workspace pwsh.exe ${reproduced ? 'WAS' : 'was NOT'} executed at startup)`
);
