#!/usr/bin/env node
/**
 * O127 — L3 snapshot must follow a linked worktree's `.git` file to the real
 * gitdir + commondir: executable keys (core.sshCommand, core.fsmonitor,
 * config.worktree hooksPath) changed from inside a linked worktree are
 * reported; allow-listed keys and ordinary commits stay silent; a rewritten
 * `.git` file / missing gitdir is reported (fail-closed).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(root, 'dist/safety/protected-path-snapshot.js'))) {
  console.error('# FAIL: dist missing — run npm run build first');
  process.exit(1);
}
const {
  takeProtectedPathSnapshot,
  takeProtectedPathSnapshotAfter,
  diffProtectedPathSnapshots,
  filterExpectedGitMetadataChanges,
  formatProtectedPathModifiedNotice,
} = await import('../dist/safety/protected-path-snapshot.js');
const { findShellProtectedWrites } = await import('../dist/safety/protected-paths.js');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o127-'));
process.on('exit', () => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(tmpRoot, 'no-global'),
};
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@e'];

/** main repo + linked worktree outside it. */
function makeLinked() {
  const base = fs.mkdtempSync(path.join(tmpRoot, 'r-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const main = path.join(base, 'main');
  git(base, 'init', '-q', main);
  git(main, ...ID, 'commit', '-q', '--allow-empty', '-m', 'i', '--no-verify');
  const wt = path.join(base, 'wt');
  git(main, 'worktree', 'add', '-q', wt, '-b', 'wt');
  assert.ok(fs.lstatSync(path.join(wt, '.git')).isFile(), 'precondition: .git is a file');
  return { home, main, wt };
}
function changes(r, mutate, command = '') {
  const before = takeProtectedPathSnapshot(r.wt, { home: r.home });
  mutate(r);
  const after = takeProtectedPathSnapshotAfter(before, { home: r.home });
  return filterExpectedGitMetadataChanges(command, diffProtectedPathSnapshots(before, after));
}

// ── A. executable keys from a linked worktree ──────────────────────────
for (const [key, value] of [
  ['core.sshCommand', 'sh /tmp/p'],
  ['core.fsmonitor', '/tmp/p'],
  ['CORE.FsMonitor', '/tmp/p'],
  ['remote.origin.uploadpack', 'sh /tmp/p'],
]) {
  await check(`A1: linked worktree \`git config ${key}\` → reported with key`, () => {
    const r = makeLinked();
    const ch = changes(r, (x) => git(x.wt, 'config', key, value));
    const c = ch.find((y) => y.path.endsWith('.git/config'));
    assert.ok(c, JSON.stringify(ch));
    assert.equal(c.keys.length, 1);
    assert.equal(c.keys[0].toLowerCase(), key.toLowerCase());
    const zh = formatProtectedPathModifiedNotice(ch, true, `git config ${key}`);
    assert.match(zh, /改了 `.+`（不在安全清单内）/);
  });
}

await check('A2: linked worktree config.worktree core.hooksPath → reported', () => {
  const r = makeLinked();
  const ch = changes(r, (x) => {
    git(x.wt, 'config', 'extensions.worktreeConfig', 'true');
    git(x.wt, 'config', '--worktree', 'core.hooksPath', '/tmp/evil');
    assert.equal(git(x.wt, 'config', 'core.hooksPath').trim(), '/tmp/evil');
  });
  const c = ch.find((y) => /\.git\/worktrees\/[^/]+\/config\.worktree$/.test(y.path));
  assert.ok(c, JSON.stringify(ch));
  assert.deepEqual(c.keys, ['core.hooksPath']);
});

await check(
  'A3: pre-check (事前) still blocks hooksPath / direct gitdir writes from worktree',
  () => {
    const r = makeLinked();
    const ctx = { cwd: r.wt, workspaceRoot: r.wt };
    assert.ok(findShellProtectedWrites('git config --worktree core.hooksPath /tmp/e', ctx).length);
    const name = fs.readdirSync(path.join(r.main, '.git', 'worktrees'))[0];
    const p = path.join(r.main, '.git', 'worktrees', name, 'config.worktree');
    assert.ok(findShellProtectedWrites(`echo x >> ${p}`, ctx).length);
    assert.ok(findShellProtectedWrites(`echo x > .git`, ctx).length);
  }
);

// ── B. benign keys and ordinary commits stay silent ────────────────────
await check('B1: linked worktree allow-listed keys → silent', () => {
  const r = makeLinked();
  const ch = changes(r, (x) => {
    git(x.wt, 'config', 'user.name', 'x');
    git(x.wt, 'config', 'color.ui', 'auto');
  });
  assert.deepEqual(ch, []);
});
await check('B2: linked worktree git commit / checkout -b → silent', () => {
  const r = makeLinked();
  const ch = changes(r, (x) => {
    git(x.wt, ...ID, 'commit', '-q', '--allow-empty', '-m', 'c', '--no-verify');
    git(x.wt, 'checkout', '-q', '-b', 'feat');
  });
  assert.deepEqual(ch, []);
});

// ── C. fail-closed on the .git file ────────────────────────────────────
await check('C1: .git file rewritten → reported with reason', () => {
  const r = makeLinked();
  const other = fs.mkdtempSync(path.join(tmpRoot, 'evil-'));
  const ch = changes(r, (x) => fs.writeFileSync(path.join(x.wt, '.git'), `gitdir: ${other}\n`));
  const c = ch.find((y) => y.path === '.git');
  assert.equal(c?.reason, 'gitlink-rewritten', JSON.stringify(ch));
  assert.match(formatProtectedPathModifiedNotice(ch, true), /\.git 被改写/);
});
await check('C2: gitdir removed → reported (gitdir missing)', () => {
  const r = makeLinked();
  const name = fs.readdirSync(path.join(r.main, '.git', 'worktrees'))[0];
  const ch = changes(r, (x) =>
    fs.rmSync(path.join(x.main, '.git', 'worktrees', name), { recursive: true, force: true })
  );
  const c = ch.find((y) => y.path === '.git');
  assert.equal(c?.reason, 'gitlink-missing', JSON.stringify(ch));
  assert.match(formatProtectedPathModifiedNotice(ch, true), /gitdir 不存在/);
});
await check('C3: unparsable shared config from worktree → reported', () => {
  const r = makeLinked();
  const ch = changes(r, (x) => fs.appendFileSync(path.join(x.main, '.git', 'config'), '\n[[[\n'));
  const c = ch.find((y) => y.path.endsWith('.git/config'));
  assert.equal(c?.reason, 'unparsable', JSON.stringify(ch));
});
await check('C4: .git file replaced by symlink → reported', () => {
  const r = makeLinked();
  const ch = changes(r, (x) => {
    const g = path.join(x.wt, '.git');
    const t = path.join(x.wt, '..', 'gitlink-copy');
    fs.copyFileSync(g, t);
    fs.rmSync(g);
    fs.symlinkSync(t, g);
  });
  assert.equal(ch.find((y) => y.path === '.git')?.reason, 'symlink', JSON.stringify(ch));
});

// ── P. pre-check: `cd <root>` operand is not a write target ───────────
await check('P1: cd <worktree root> && node script → no pre-check hit', () => {
  const r = makeLinked();
  for (const root of [r.wt, r.main]) {
    const ctx = { cwd: root, workspaceRoot: root };
    assert.deepEqual(findShellProtectedWrites(`cd ${root} && node x.mjs`, ctx), []);
    assert.deepEqual(
      findShellProtectedWrites(`cd ${root} && node --test t.mjs 2>&1 | tail -25`, ctx),
      []
    );
  }
});
await check('P2: still blocked — root as script arg, rm of root, writes under .git', () => {
  const r = makeLinked();
  const ws = r.wt;
  const ctx = { cwd: ws, workspaceRoot: ws };
  for (const c of [
    `cd ${ws} && node x.mjs ${ws}`,
    `cd ${ws} && node x.mjs ${ws}/`,
    `node x.mjs ${ws}`,
    `cd ${ws} && rm -rf ${ws}`,
    `cd ${ws} && bash x.sh > .git`,
    `cd ${r.main}/.git && node x.mjs`,
    `cd ${ws} && node -e "require('fs').rmSync('.git')"`,
  ]) {
    assert.ok(findShellProtectedWrites(c, ctx).length > 0, c);
  }
});

// ── D. main repo unchanged ─────────────────────────────────────────────
await check('D1: main checkout: commit silent, sshCommand reported', () => {
  const r = makeLinked();
  const before = takeProtectedPathSnapshot(r.main, { home: r.home });
  git(r.main, ...ID, 'commit', '-q', '--allow-empty', '-m', 'm', '--no-verify');
  git(r.main, 'config', 'core.sshCommand', 'sh /tmp/p');
  const ch = diffProtectedPathSnapshots(
    before,
    takeProtectedPathSnapshotAfter(before, { home: r.home })
  );
  assert.deepEqual(
    ch.map((c) => [c.path, c.keys]),
    [['.git/config', ['core.sshCommand']]]
  );
});

// ── G. process-level `moss -p` in a linked worktree ────────────────────
const toolResults = [];
function startFake(calls) {
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
      const toolMsgs = (body.messages ?? []).filter((m) => m.role === 'tool');
      for (const m of toolMsgs)
        toolResults.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      const n = toolMsgs.length;
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
        res.write(chunk({ role: 'assistant', content: '已设置 user.name，完成。' }));
        res.write(chunk({}, 'stop'));
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function runCli(args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'dist', 'cli.js'), ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

async function pRun(lang, command) {
  const r = makeLinked();
  const cfgDir = path.join(r.home, '.config', 'moss');
  fs.mkdirSync(cfgDir, { recursive: true });
  if (typeof command === 'function') {
    fs.writeFileSync(path.join(r.wt, 'ro.mjs'), "console.log('read only');\n");
    command = command(r);
  }
  const server = await startFake([command]);
  const env = {
    PATH: process.env.PATH,
    HOME: r.home,
    MOSS_CONFIG_DIR: cfgDir,
    MOSS_RUNTIME_DIR: path.join(r.home, 'runtime'),
    MOSS_NO_BUNDLED_DEFAULT: '1',
    MOSS_NO_TUI: '1',
    MOSS_LOCALE: lang,
    FAKE_OAI_KEY: 'sk-fake-local-000',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const [k, v] of [
    ['provider', 'openai-compatible'],
    ['baseUrl', `http://127.0.0.1:${server.address().port}`],
    ['model', 'fake-model'],
    ['apiKeyEnv', 'FAKE_OAI_KEY'],
  ])
    await runCli(['config', 'set', k, v], env, r.wt);
  const res = await runCli(['--trust-workspace', '--lang', lang, '-p', 'set name'], env, r.wt);
  server.close();
  return { ...res, last: res.out.trim().split('\n').pop() ?? '', r };
}

for (const lang of ['zh', 'en']) {
  await check(
    `G1 (${lang}): moss -p in worktree, git config core.sshCommand → exit 9`,
    async () => {
      const res = await pRun(lang, 'git config core.sshCommand "sh /tmp/p"');
      assert.equal(git(res.r.wt, 'config', 'core.sshCommand').trim(), 'sh /tmp/p');
      assert.equal(res.code, 9, `${res.last}\n${res.err.slice(-400)}`);
      assert.match(res.out + res.err, /core\.sshCommand/);
    }
  );
  await check(`G2 (${lang}): moss -p in worktree, git config user.name x → exit 0`, async () => {
    const res = await pRun(lang, 'git config user.name x');
    assert.equal(git(res.r.wt, 'config', 'user.name').trim(), 'x');
    assert.equal(res.code, 0, `${res.last}\n${res.err.slice(-400)}`);
    assert.doesNotMatch(res.last, /未完成|Incomplete|已被修改|modified/);
  });
}

// S2 (自举): `cd <worktree root> && node …` was blocked before it ran
// ("<root> is a protected path (git repository internals)").
for (const [label, command] of [
  ['git status', 'git status'],
  ['ls -la', 'ls -la'],
  ['cat .git', 'cat .git'],
  ['git log', 'git log --oneline -1'],
  ['cd <root> && git status', (r) => `cd ${r.wt} && git status`],
  ['cd <root> && node ro.mjs', (r) => `cd ${r.wt} && node ro.mjs`],
  ['cd <root> && node --test … | tail', (r) => `cd ${r.wt} && node --test ro.mjs 2>&1 | tail -25`],
]) {
  await check(
    `G3: moss -p in worktree root, read-only \`${label}\` → exit 0, not blocked`,
    async () => {
      toolResults.length = 0;
      const res = await pRun('zh', command);
      const all = res.out + res.err + '\n' + toolResults.join('\n');
      assert.ok(toolResults.length > 0, 'precondition: command ran');
      assert.equal(res.code, 0, `${res.last}\n${all.slice(-600)}`);
      assert.doesNotMatch(all, /被拦|已拦截|已被修改|受保护路径已|protected path|moss-o101/i);
    }
  );
}

if (failures > 0) {
  console.error(`# ${failures} failure(s)`);
  process.exit(1);
}
console.log('# o127 all ok');
