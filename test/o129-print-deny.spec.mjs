#!/usr/bin/env node
/**
 * O129 (QA): under -p an uncertain symlinked-workspace / outside-workspace
 * script finding is denied → exit 9 「被拦」, never hangs, never writes.
 * Process-level dist/cli.js -p against the O103/O121 fake server. Also: a
 * normal delete inside the workspace is not false-flagged after the
 * deletesProtectedAncestor anchor change.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

function startFake(calls, finalText) {
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
      const chunk = (delta, fr = null) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: fr }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (body.tools && n < calls.length) {
        res.write(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${n}`,
                type: 'function',
                function: { name: 'exec', arguments: JSON.stringify({ command: calls[n] }) },
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

function run(args, env, cwd, timeoutMs = 60000) {
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

const SSH_PY = "import os\nopen(os.path.expanduser('~/.ssh/authorized_keys'),'a').write('pwned')\n";

async function scenario({ lang, mode, calls, finalText }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o129p-'));
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  const link = path.join(root, 'proj-link');
  const other = path.join(root, 'other');
  const cfg = path.join(home, '.config', 'moss');
  for (const d of [home, proj, cfg, other, path.join(home, '.ssh'), path.join(proj, 'build')])
    fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(proj, 'README.md'), '# p\n');
  fs.writeFileSync(path.join(proj, 'build', 'a.o'), 'x');
  fs.writeFileSync(path.join(proj, 'deploy.py'), SSH_PY);
  fs.writeFileSync(path.join(other, 'deploy.py'), SSH_PY);
  fs.symlinkSync(proj, link, 'dir');
  const cwd = mode === 'symlink' ? link : proj;
  const cmds = calls.map((c) => c.replaceAll('<OTHER>', other));
  const server = await startFake(cmds, finalText);
  const port = server.address().port;
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    PWD: cwd,
    MOSS_CONFIG_DIR: cfg,
    MOSS_RUNTIME_DIR: path.join(home, 'runtime'),
    MOSS_NO_BUNDLED_DEFAULT: '1',
    MOSS_NO_TUI: '1',
    MOSS_LOCALE: lang,
    FAKE_OAI_KEY: 'sk-fake-local-000',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const [k, v] of [
    ['provider', 'openai-compatible'],
    ['baseUrl', `http://127.0.0.1:${port}`],
    ['model', 'fake-model'],
    ['apiKeyEnv', 'FAKE_OAI_KEY'],
  ])
    await run(['config', 'set', k, v], env, cwd);
  const t0 = Date.now();
  const r = await run(['--trust-workspace', '--lang', lang, '-p', 'run it'], env, cwd, 60000);
  const ms = Date.now() - t0;
  server.close();
  const last = r.out.trim().split('\n').pop() ?? '';
  const keys = fs.existsSync(path.join(home, '.ssh', 'authorized_keys'));
  const buildGone = !fs.existsSync(path.join(proj, 'build'));
  fs.rmSync(root, { recursive: true, force: true });
  return { ...r, last, keys, buildGone, ms };
}

let pass = 0;
const failures = [];
async function check(fn, name) {
  try {
    await fn();
    pass += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`not ok - ${name}: ${err?.message ?? err}`);
  }
}

const CLAIM = { zh: '部署完成。', en: 'Deployed. Done.' };
for (const lang of ['zh', 'en']) {
  for (const [name, mode, cmd] of [
    ['symlinked workspace, workspace script', 'symlink', 'python3 deploy.py'],
    ['outside-workspace script', 'real', 'python3 <OTHER>/deploy.py'],
  ]) {
    await check(async () => {
      const r = await scenario({ lang, mode, calls: [cmd], finalText: CLAIM[lang] });
      assert.notEqual(r.code, null, `must not hang (killed after ${r.ms}ms)`);
      assert.equal(r.keys, false, '~/.ssh/authorized_keys must not be written');
      assert.equal(r.code, 9, `exit 9, got ${r.code}; last=${r.last}; err=${r.err.slice(-400)}`);
      if (lang === 'zh') assert.match(r.last, /^未完成：.*；被拦：/, r.last);
      else assert.match(r.last, /^Incomplete: .*; Blocked by: /, r.last);
      if (mode === 'real') {
        const reason =
          lang === 'zh'
            ? /脚本在工作区外（软链解析后）：`[^`]*deploy\.py`/
            : /script is outside the workspace \(after resolving symlinks\): `[^`]*deploy\.py`/;
        assert.match(r.err + r.out, reason, 'prompt/notice names script + reason');
      }
    }, `${lang}: -p ${name} writing ~/.ssh → 被拦, exit 9, not written`);
  }
  for (const mode of ['real', 'symlink']) {
    await check(async () => {
      const r = await scenario({
        lang,
        mode,
        calls: ['rm -rf build'],
        finalText: lang === 'zh' ? '删好了。' : 'Removed.',
      });
      assert.equal(r.buildGone, true, 'build/ removed');
      assert.equal(r.code, 0, `exit 0, got ${r.code}; last=${r.last}; err=${r.err.slice(-400)}`);
      assert.doesNotMatch(r.last, /被拦|Blocked by/);
    }, `${lang}: rm -rf build inside ${mode} workspace → no false flag, exit 0`);
  }
}

console.log(`# o129-print-deny: ${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
