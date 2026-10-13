#!/usr/bin/env node
/**
 * O123 — ordinary `git commit` / `checkout -b` / `merge` must not be reported
 * by L3 as「已被修改 .git/refs/heads/…」. QA path allow-list: well-formed
 * HEAD / loose-ref rewrites are silent regardless of how the command is
 * spelled (`git -c k=v commit`, `git -C`, scripts). hooks/, config, info/,
 * HEAD → `ref: ../x`, ref symlinks are still reported (exit 9).
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
  parseProtectedPathModMarker,
} = await import('../dist/safety/protected-path-snapshot.js');
const { createRunCompletionTracker } = await import('../dist/cli/run-completion.js');
const { resolveRunOutcome, formatOutcomeLine } = await import('../dist/cli/run-outcome.js');

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o123-'));
process.on('exit', () => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(tmpRoot, 'no-global'),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@e',
};
function git(ws, ...args) {
  const r = spawnSync('git', args, { cwd: ws, env: gitEnv, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}
function makeRepo() {
  const home = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
  const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
  git(ws, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(ws, 'a.txt'), '1\n');
  git(ws, 'add', 'a.txt');
  git(ws, 'commit', '-qm', 'init');
  return { home, ws };
}
function changesAround(mutate) {
  const { home, ws } = makeRepo();
  const before = takeProtectedPathSnapshot(ws, { home });
  mutate(ws);
  return diffProtectedPathSnapshots(before, takeProtectedPathSnapshotAfter(before, { home }));
}
function lastLines(changes, command = 'sh x.sh') {
  const parsed = parseProtectedPathModMarker(
    formatProtectedPathModifiedNotice(changes, true, command)
  );
  const out = {};
  for (const lang of ['zh', 'en']) {
    const tracker = createRunCompletionTracker();
    tracker.protectedPathChanges = parsed.map((c) => ({ ...c, command }));
    out[lang] = formatOutcomeLine(
      resolveRunOutcome({ tracker, finalText: '已完成。', request: command }),
      lang
    );
  }
  return out;
}

// ── A. snapshot level: ordinary git writes are silent (no command filter) ──

await check('A1: `git -c … commit --allow-empty` (UX a5 repro) → no change', () => {
  const ch = changesAround((ws) =>
    git(ws, '-c', 'user.name=u', 'commit', '--allow-empty', '-qm', 'x')
  );
  assert.deepEqual(ch, []);
});
await check('A2: git add + commit of a real change → no change', () => {
  const ch = changesAround((ws) => {
    fs.writeFileSync(path.join(ws, 'a.txt'), '2\n');
    git(ws, 'add', 'a.txt');
    git(ws, 'commit', '-qm', 'two');
  });
  assert.deepEqual(ch, []);
});
await check('A3: checkout -b, merge, branch -d, tag → no change', () => {
  const ch = changesAround((ws) => {
    git(ws, 'checkout', '-qb', 'feat');
    fs.writeFileSync(path.join(ws, 'b.txt'), 'b\n');
    git(ws, 'add', 'b.txt');
    git(ws, 'commit', '-qm', 'b');
    git(ws, 'checkout', '-q', 'master');
    git(ws, 'merge', '-q', '--no-ff', '-m', 'm', 'feat');
    git(ws, 'tag', 'v1');
    git(ws, 'branch', '-qd', 'feat');
  });
  assert.deepEqual(ch, []);
});
await check('A4: detached HEAD (commit id) → no change', () => {
  const ch = changesAround((ws) => git(ws, 'checkout', '-q', '--detach'));
  assert.deepEqual(ch, []);
});

// ── B. still reported ─────────────────────────────────────────────────

await check(
  'B1: .git/HEAD → `ref: ../x` reported with reason, even after git commit filter',
  () => {
    const ch = changesAround((ws) =>
      fs.writeFileSync(path.join(ws, '.git', 'HEAD'), 'ref: ../x\n')
    );
    const head = ch.find((c) => c.path.endsWith('.git/HEAD'));
    assert.ok(head, JSON.stringify(ch));
    assert.equal(head.reason, 'ref-outside');
    assert.equal(filterExpectedGitMetadataChanges('git commit -qm x', ch).length, ch.length);
    const { zh, en } = lastLines(ch);
    assert.match(zh, /\.git\/HEAD 指向仓库外路径/);
    assert.match(en, /\.git\/HEAD points outside the repository/);
    assert.doesNotMatch(zh + en, /未知|unknown/i);
  }
);
await check('B2: garbage in a ref → reported', () => {
  const ch = changesAround((ws) =>
    fs.writeFileSync(path.join(ws, '.git/refs/heads/master'), 'evil\n')
  );
  assert.equal(ch.find((c) => c.path.endsWith('refs/heads/master'))?.reason, 'ref-invalid');
});
await check('B3: ref replaced by a symlink outside the repo → reported', () => {
  const ch = changesAround((ws) => {
    const ref = path.join(ws, '.git/refs/heads/master');
    const out = path.join(tmpRoot, `outside-${Date.now()}`);
    fs.copyFileSync(ref, out);
    fs.rmSync(ref);
    fs.symlinkSync(out, ref);
  });
  assert.equal(ch.find((c) => c.path.endsWith('refs/heads/master'))?.reason, 'symlink');
});
await check('B4: new hook after a commit → reported, says why (zh + en)', () => {
  const ch = changesAround((ws) => {
    git(ws, 'commit', '--allow-empty', '-qm', 'x');
    fs.writeFileSync(path.join(ws, '.git/hooks/pre-commit'), '#!/bin/sh\n', { mode: 0o755 });
  });
  const c = filterExpectedGitMetadataChanges('git commit -qm x', ch);
  // The hooks/ directory entry is reported too (pre-existing); no refs/objects/index.
  assert.deepEqual(
    c.map((x) => x.path).sort(),
    ['.git/hooks', '.git/hooks/pre-commit'],
    JSON.stringify(ch)
  );
  const { zh, en } = lastLines(c);
  assert.match(zh, /卡在：.*\.git\/hooks\/pre-commit 被新增（git 钩子，会执行命令）/);
  assert.match(en, /\.git\/hooks\/pre-commit was added \(git hook, runs commands\)/);
  assert.doesNotMatch(zh, /refs|index|objects/);
});
await check('B5: commit + core.hooksPath → only config named', () => {
  const ch = changesAround((ws) => {
    git(ws, 'commit', '--allow-empty', '-qm', 'x');
    git(ws, 'config', 'core.hooksPath', '/tmp/evil');
  });
  assert.deepEqual(
    ch.map((c) => [c.path, c.keys]),
    [['.git/config', ['core.hooksPath']]]
  );
});
await check(
  'B6: info/, objects/info/alternates, modules/*/config, worktrees/*/config watched',
  () => {
    const ch = changesAround((ws) => {
      fs.writeFileSync(path.join(ws, '.git/info/attributes'), '* filter=x\n');
      fs.mkdirSync(path.join(ws, '.git/objects/info'), { recursive: true });
      fs.writeFileSync(path.join(ws, '.git/objects/info/alternates'), '/tmp/o\n');
    });
    const paths = ch.map((c) => c.path).sort();
    assert.deepEqual(paths, ['.git/info/attributes', '.git/objects/info/alternates']);
    const { home, ws } = makeRepo();
    fs.mkdirSync(path.join(ws, '.git/modules/sub'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.git/modules/sub/config'), '');
    const before = takeProtectedPathSnapshot(ws, { home });
    fs.writeFileSync(path.join(ws, '.git/modules/sub/config'), '[core]\n\tfsmonitor = /tmp/p\n');
    const ch2 = diffProtectedPathSnapshots(
      before,
      takeProtectedPathSnapshotAfter(before, { home })
    );
    assert.ok(
      ch2.some((c) => c.path === '.git/modules/sub/config'),
      JSON.stringify(ch2)
    );
  }
);

// ── C. process-level `moss -p` ────────────────────────────────────────

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
        res.write(chunk({ role: 'assistant', content: '已提交，完成。' }));
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

async function pRun(lang, calls, prep) {
  const home = fs.mkdtempSync(path.join(tmpRoot, 'phome-'));
  const proj = fs.mkdtempSync(path.join(tmpRoot, 'pproj-'));
  const cfgDir = path.join(home, '.config', 'moss');
  fs.mkdirSync(cfgDir, { recursive: true });
  git(proj, 'init', '-q', '-b', 'master');
  git(proj, 'commit', '-q', '--allow-empty', '-m', 'init');
  if (prep) prep(proj);
  const server = await startFake(calls);
  const env = {
    PATH: process.env.PATH,
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
    HOME: home,
    MOSS_CONFIG_DIR: cfgDir,
    MOSS_RUNTIME_DIR: path.join(home, 'runtime'),
    MOSS_NO_BUNDLED_DEFAULT: '1',
    MOSS_NO_TUI: '1',
    MOSS_LOCALE: lang,
    FAKE_OAI_KEY: 'sk-fake-local-000',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@e',
  };
  for (const [k, v] of [
    ['provider', 'openai-compatible'],
    ['baseUrl', `http://127.0.0.1:${server.address().port}`],
    ['model', 'fake-model'],
    ['apiKeyEnv', 'FAKE_OAI_KEY'],
  ])
    await runCli(['config', 'set', k, v], env, proj);
  const r = await runCli(['--trust-workspace', '--lang', lang, '-p', 'commit it'], env, proj);
  server.close();
  const n = spawnSync('git', ['rev-list', '--count', '--all'], {
    cwd: proj,
    env: gitEnv,
    encoding: 'utf8',
  });
  return {
    ...r,
    last: r.out.trim().split('\n').pop() ?? '',
    commits: Number(n.stdout.trim()),
    proj,
  };
}

for (const lang of ['zh', 'en']) {
  await check(
    `C1 (${lang}): moss -p git add+commit, commit --allow-empty, checkout -b, merge → exit 0`,
    async () => {
      const r = await pRun(lang, [
        "echo hi > a.txt && git add a.txt && git commit -qm 'add a'",
        'git -c user.name=u commit --allow-empty -qm x',
        'git checkout -qb feat && echo b > b.txt && git add b.txt && git commit -qm b && git checkout -q master && git merge -q --no-ff -m m feat',
      ]);
      assert.ok(r.commits >= 5, `precondition: commits ran (${r.commits})`);
      assert.equal(r.code, 0, `${r.last}\n${r.err.slice(-400)}`);
      assert.doesNotMatch(r.last, /未完成|Incomplete|已被修改|modified/);
    }
  );
}
await check(
  'C2 (zh): moss -p commit + write .git/hooks/x → exit 9, names the hook only',
  async () => {
    // Script file: the O103 pre-block does not see the path; L3 must.
    const r = await pRun('zh', ['git commit -q --allow-empty -m x && sh w.sh'], (p) =>
      fs.writeFileSync(path.join(p, 'w.sh'), "d=.git; printf '#!/bin/sh\\n' > $d/hooks/x\n")
    );
    assert.equal(r.code, 9, `${r.last}\n${r.err.slice(-400)}`);
    assert.match(r.last, /\.git\/hooks\/x/);
    assert.doesNotMatch(r.last, /refs|objects|index/);
  }
);
await check('C3 (en): moss -p HEAD → ref: ../x via script → exit 9', async () => {
  const r = await pRun('en', ['git commit -q --allow-empty -m x && sh w.sh'], (p) =>
    fs.writeFileSync(path.join(p, 'w.sh'), "d=.git; printf 'ref: ../x\\n' > $d/HEAD\n")
  );
  assert.equal(r.code, 9, `${r.last}\n${r.err.slice(-400)}`);
  assert.match(r.last, /\.git\/HEAD points outside/);
});
await check('C4 (zh): moss -p script sets core.hooksPath → exit 9', async () => {
  const r = await pRun('zh', ['git commit -q --allow-empty -m x && sh x.sh'], (p) =>
    fs.writeFileSync(path.join(p, 'x.sh'), 'git config core.hooksPath /tmp/evilhooks\n')
  );
  assert.equal(r.code, 9, `${r.last}\n${r.err.slice(-400)}`);
  assert.match(r.last, /core\.hooksPath/);
});

if (failures > 0) {
  console.error(`# ${failures} failure(s)`);
  process.exit(1);
}
console.log('# o123 all ok');
