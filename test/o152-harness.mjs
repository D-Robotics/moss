/**
 * O152 process-level harness (helper, not a spec): real `dist/cli.js -p`
 * against a local fake OpenAI-compatible server that issues one tool call per
 * turn, in a fresh git workspace with seeded protected files. Unlike the O121
 * scenario() it tolerates commands that delete workspace files (or the whole
 * workspace) and records sha256 + mode of watched files before / after, plus
 * whether `git -C <proj> status` still works.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
export const IS_WIN = process.platform === 'win32';

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

function run(args, env, cwd, timeoutMs = 90000) {
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

/** sha256 + mode (`ABSENT` / `LINK` / `DIR` for non-files). Never the content. */
export function fileState(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return { hash: 'LINK', mode: 0 };
    if (st.isDirectory()) return { hash: 'DIR', mode: 0 };
    const hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    return { hash, mode: IS_WIN ? 0 : st.mode & 0o777 };
  } catch {
    return { hash: 'ABSENT', mode: 0 };
  }
}

export const exec = (command) => ({ name: 'exec', args: { command } });

/**
 * @param {object} o
 * @param {'zh'|'en'} o.lang
 * @param {boolean} [o.json]
 * @param {boolean} [o.gitInit]
 * @param {Record<string,string>} [o.seed] relative path → body (after git init)
 * @param {Record<string,number>} [o.modes] relative path → mode
 * @param {string[]} [o.watch]
 * @param {(ctx:{proj:string,root:string,home:string})=>Array<{name:string,args:object}>} o.steps
 * @param {(ctx:{proj:string,root:string,home:string})=>void} [o.prepare]
 * @param {string} o.finalText
 */
export async function o152Scenario(o) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'o152-')));
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  const cfg = path.join(home, '.config', 'moss');
  for (const d of [home, proj, cfg]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(proj, 'README.md'), '# p\n');
  const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  if (o.gitInit !== false) {
    const g = (...a) => spawnSync('git', a, { cwd: proj, stdio: 'ignore', env: gitEnv });
    g('init', '-q');
    g('add', '-A');
    g('-c', 'user.email=a@b', '-c', 'user.name=u', 'commit', '-qm', 'init', '--no-verify');
  }
  for (const [rel, body] of Object.entries(o.seed ?? {})) {
    fs.mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true });
    fs.writeFileSync(path.join(proj, rel), body);
  }
  if (!IS_WIN)
    for (const [rel, mode] of Object.entries(o.modes ?? {}))
      fs.chmodSync(path.join(proj, rel), mode);
  const ctx = { proj, root, home };
  o.prepare?.(ctx);
  const watch = o.watch ?? [];
  const before = Object.fromEntries(watch.map((rel) => [rel, fileState(path.join(proj, rel))]));
  const server = await startFake(o.steps(ctx), o.finalText);
  const port = server.address().port;
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    MOSS_CONFIG_DIR: cfg,
    MOSS_RUNTIME_DIR: path.join(home, 'runtime'),
    MOSS_NO_BUNDLED_DEFAULT: '1',
    MOSS_NO_TUI: '1',
    MOSS_LOCALE: o.lang,
    FAKE_OAI_KEY: 'sk-fake-local-000',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const [k, v] of [
    ['provider', 'openai-compatible'],
    ['baseUrl', `http://127.0.0.1:${port}`],
    ['model', 'fake-model'],
    ['apiKeyEnv', 'FAKE_OAI_KEY'],
  ])
    await run(['config', 'set', k, v], env, proj);
  const r = await run(
    [
      '--trust-workspace',
      '--lang',
      o.lang,
      ...(o.json ? ['--output-format', 'json'] : []),
      '-p',
      'run it',
    ],
    env,
    proj
  );
  server.closeAllConnections?.();
  server.close();
  const after = Object.fromEntries(watch.map((rel) => [rel, fileState(path.join(proj, rel))]));
  const gitStatus = fs.existsSync(proj)
    ? spawnSync('git', ['-C', proj, 'status', '--porcelain'], { env: gitEnv, encoding: 'utf8' })
        .status
    : -1;
  const extra = o.inspect ? o.inspect(ctx) : undefined;
  fs.rmSync(root, { recursive: true, force: true });
  const toolResults = (server.lastMessages ?? [])
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
  const last = r.out.trim().split('\n').pop() ?? '';
  let result;
  if (o.json) {
    for (const line of r.out.split('\n')) {
      try {
        const ev = JSON.parse(line);
        if (ev && ev.type === 'result') result = ev;
      } catch {
        /* not json */
      }
    }
    if (!result) {
      try {
        const ev = JSON.parse(r.out);
        if (ev && ev.type === 'result') result = ev;
      } catch {
        /* ignore */
      }
    }
  }
  return { ...r, last, result, toolResults, before, after, gitStatus, extra, proj };
}
