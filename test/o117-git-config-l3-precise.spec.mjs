#!/usr/bin/env node
/**
 * O117 — L3 (post-run snapshot) must not treat every `.git/config` write as a
 * protected-path modification. Allow-list (PM): only changes confined to
 * GIT_CONFIG_BENIGN_KEYS (user.name, color.ui, …) are silent; any other key counts; unparsable / swapped / deleted config is
 * still reported (fail-closed).
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
  formatProtectedPathModifiedNotice,
  parseProtectedPathModMarker,
  isSafeGitRemoteUrl,
  isBenignGitConfigKey,
  GIT_CONFIG_BENIGN_KEYS,
} = await import('../dist/safety/protected-path-snapshot.js');
const { execTool } = await import('../dist/tools/builtin.js');
const { findShellProtectedWrites, findProtectedPathHits } =
  await import('../dist/safety/protected-paths.js');
const { createRunCompletionTracker, noteRunCompletionEvent } =
  await import('../dist/cli/run-completion.js');
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o117-'));
process.on('exit', () => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(tmpRoot, 'no-global'),
};

function makeRepo() {
  const home = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
  const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
  const r = spawnSync('git', ['init', '-q', ws], { env: gitEnv });
  assert.equal(r.status, 0, String(r.stderr));
  return { home, ws };
}

function git(ws, ...args) {
  const r = spawnSync('git', args, { cwd: ws, env: gitEnv, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

/** Run `mutate` between snapshots; return changes touching .git/config. */
function configChanges(mutate) {
  const { home, ws } = makeRepo();
  const before = takeProtectedPathSnapshot(ws, { home });
  mutate(ws);
  const after = takeProtectedPathSnapshotAfter(before, { home });
  return diffProtectedPathSnapshots(before, after).filter((c) => c.path.endsWith('.git/config'));
}

const cfg = (ws) => path.join(ws, '.git', 'config');

// ── A. ordinary keys: no report ───────────────────────────────────────

await check('A1: git config user.name x → no .git/config change reported', () => {
  assert.deepEqual(
    configChanges((ws) => git(ws, 'config', 'user.name', 'x')),
    []
  );
});

await check(
  'A2: user.email / color / init.defaultBranch / pull.rebase / core.autocrlf / --unset → no report',
  () => {
    assert.deepEqual(
      configChanges((ws) => {
        git(ws, 'config', 'user.email', 'x@example.com');
        git(ws, 'config', 'USER.Name', 'y');
        git(ws, 'config', 'color.ui', 'auto');
        git(ws, 'config', 'init.defaultBranch', 'main');
        git(ws, 'config', 'pull.rebase', 'true');
        git(ws, 'config', 'core.autocrlf', 'input');
        git(ws, 'config', '--unset', 'user.email');
      }),
      []
    );
  }
);

await check(
  'A3: git remote add origin https://… + real git push -u (to local bare via -c insteadOf) → no report',
  () => {
    const bare = fs.mkdtempSync(path.join(tmpRoot, 'bare-'));
    assert.equal(spawnSync('git', ['init', '-q', '--bare', bare], { env: gitEnv }).status, 0);
    const r = configChanges((ws) => {
      git(ws, 'remote', 'add', 'origin', 'https://example.com/r.git');
      git(
        ws,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@e',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'x'
      );
      git(ws, 'branch', '-M', 'main');
      // url stays https in .git/config; the -c rewrite is process-only, not written.
      git(
        ws,
        '-c',
        `url.file://${bare}.insteadOf=https://example.com/r.git`,
        'push',
        '-q',
        '-u',
        'origin',
        'main'
      );
      const merge = spawnSync('git', ['config', 'branch.main.merge'], {
        cwd: ws,
        env: gitEnv,
        encoding: 'utf8',
      });
      assert.equal(merge.stdout.trim(), 'refs/heads/main', 'precondition: push -u wrote upstream');
    });
    assert.deepEqual(r, []);
  }
);

await check('A4: ssh:// / scp-style url, set-upstream, extra fetch refspec → no report', () => {
  const r = configChanges((ws) => {
    git(ws, 'remote', 'add', 'a', 'ssh://git@github.com:22/o/r.git');
    git(ws, 'remote', 'add', 'b', 'git@github.com:o/r.git');
    git(ws, 'remote', 'set-url', 'a', 'https://user@github.com:8443/o/r.git');
    git(ws, 'config', '--add', 'remote.a.fetch', '+refs/pull/*:refs/remotes/a/pr/*');
    git(ws, 'config', 'branch.dev.remote', 'b');
    git(ws, 'config', 'branch.dev.merge', 'refs/heads/dev');
    git(ws, 'remote', 'remove', 'b');
  });
  assert.deepEqual(r, []);
});

const BAD_URLS = [
  'ext::sh -c touch% /tmp/pwned',
  'fd::17',
  'file:///tmp/evil',
  '/tmp/evil',
  './evil',
  '-oProxyCommand=sh',
  'ssh://-oProxyCommand=touch%20/tmp/p/x',
  'ssh://%2DoProxyCommand=sh/x',
  'ssh://%252DoProxyCommand=sh/x',
  'ssh://-u@host/x',
  'ssh://%2du@host/x',
  'https://host:80a/x',
  'git@-oProxyCommand=sh:x',
  '-x@host:path',
  'git://host/x',
  'http://host/x',
];
for (const url of BAD_URLS) {
  await check(`A5: remote.origin.url = ${JSON.stringify(url)} → reported`, () => {
    const r = configChanges((ws) => git(ws, 'config', 'remote.origin.url', url));
    assert.equal(r.length, 1, JSON.stringify(r));
    assert.deepEqual(r[0].keys, ['remote.origin.url']);
  });
}

await check('A6: url with newline / control char → reported', () => {
  for (const v of ['https://h/x\nfoo', 'https://h/\u0001x']) {
    const r = configChanges((ws) => {
      fs.appendFileSync(
        cfg(ws),
        `[remote "o"]\n\turl = "${v.replace('\n', '\\n').replace('\u0001', '\u0001')}"\n`
      );
    });
    assert.equal(r.length, 1, JSON.stringify(v));
  }
});

await check(
  'A7: same remote, other leaves (pushurl/uploadpack/receivepack/proxy/vcs) → reported',
  () => {
    for (const leaf of [
      'pushurl',
      'uploadpack',
      'receivepack',
      'proxy',
      'vcs',
      'tagOpt',
      'mirror',
    ]) {
      const r = configChanges((ws) => {
        git(ws, 'remote', 'add', 'origin', 'https://example.com/r.git');
        git(ws, 'config', `remote.origin.${leaf}`, 'https://example.com/x');
      });
      assert.equal(r.length, 1, leaf);
      assert.equal(r[0].keys.length, 1, `${leaf}: ${JSON.stringify(r[0].keys)}`);
      assert.equal(r[0].keys[0].toLowerCase(), `remote.origin.${leaf.toLowerCase()}`);
    }
    const b = configChanges((ws) => git(ws, 'config', 'branch.main.pushRemote', 'x'));
    assert.equal(b.length, 1);
  }
);

await check('A8: isSafeGitRemoteUrl unit table', () => {
  for (const u of [
    'https://github.com/o/r.git',
    'https://u:p@h:443/x',
    'ssh://git@h/x',
    'ssh://[::1]:22/x',
    'git@host:o/r',
    'host.example:o/r',
  ])
    assert.ok(isSafeGitRemoteUrl(u), u);
  for (const u of [
    ...BAD_URLS,
    'C:\\x',
    'c:/x',
    '',
    'https://',
    'https://-h/x',
    'https://%2Dh/x',
    'ssh://h:-1/x',
  ])
    assert.ok(!isSafeGitRemoteUrl(u), u);
});

await check('A9: branch.*.remote holding a dangerous URL / path → reported', () => {
  for (const v of ['ext::sh -c id', '/tmp/evil', './evil', '-oProxyCommand=sh', 'ssh://%2Dx/y']) {
    const r = configChanges((ws) => git(ws, 'config', 'branch.main.remote', v));
    assert.equal(r.length, 1, v);
    assert.deepEqual(r[0].keys, ['branch.main.remote']);
  }
  for (const v of ['origin', '.', 'up-stream_2', 'https://example.com/r.git'])
    assert.deepEqual(
      configChanges((ws) => git(ws, 'config', 'branch.main.remote', v)),
      [],
      v
    );
});

// ── B. dangerous keys: still reported ─────────────────────────────────

await check('B1: script writes core.hooksPath (bypassing pre-block) → reported with key', () => {
  const changes = configChanges((ws) => {
    const script = path.join(ws, 'x.sh');
    fs.writeFileSync(script, 'git config core.hooksPath /tmp/evilhooks\n');
    const r = spawnSync('sh', [script], { cwd: ws, env: gitEnv });
    assert.equal(r.status, 0);
  });
  assert.equal(changes.length, 1, JSON.stringify(changes));
  assert.equal(changes[0].kind, 'modified');
  assert.deepEqual(changes[0].keys, ['core.hooksPath']); // original casing
  const zh = formatProtectedPathModifiedNotice(changes, true, 'sh x.sh');
  assert.match(zh, /已被修改/);
  assert.match(zh, /`core\.hooksPath`/);
  assert.doesNotMatch(zh, /evilhooks/); // value never shown
});

await check('B2: case / spacing variants of hooksPath via raw file edit → reported', () => {
  for (const text of [
    '[CORE]\n\tHOOKSPATH = /tmp/h\n',
    '[Core]\n  hooksPath=/tmp/h\n',
    '[core]\n\thookspath = "/tmp/h"\n',
    '[core]\n\thooksPath = /tmp/\\\nh\n',
  ]) {
    const changes = configChanges((ws) => fs.appendFileSync(cfg(ws), text));
    assert.equal(changes.length, 1, `${JSON.stringify(text)} → ${JSON.stringify(changes)}`);
    assert.deepEqual(
      changes[0].keys.map((k) => k.toLowerCase()),
      ['core.hookspath']
    );
  }
});

await check('B3: changing an existing hooksPath value is reported', () => {
  const { home, ws } = makeRepo();
  git(ws, 'config', 'core.hooksPath', '/tmp/a');
  const before = takeProtectedPathSnapshot(ws, { home });
  git(ws, 'config', 'core.hooksPath', '/tmp/b');
  const after = takeProtectedPathSnapshotAfter(before, { home });
  const ch = diffProtectedPathSnapshots(before, after).filter((c) => c.path.endsWith('config'));
  assert.equal(ch.length, 1);
});

await check(
  'B4: include / includeIf / filter / merge driver / fsmonitor / alias / url.insteadOf',
  () => {
    const cases = [
      ['include.path', '/tmp/evil.cfg', 'include.path'],
      ['includeIf.gitdir:/.path', '/tmp/evil.cfg', 'includeif.gitdir:/.path'],
      ['filter.x.smudge', 'sh /tmp/p', 'filter.x.smudge'],
      ['merge.x.driver', 'sh /tmp/p', 'merge.x.driver'],
      ['core.fsmonitor', '/tmp/p', 'core.fsmonitor'],
      ['core.sshCommand', '/tmp/p', 'core.sshcommand'],
      ['credential.helper', '/tmp/p', 'credential.helper'],
      ['diff.x.textconv', '/tmp/p', 'diff.x.textconv'],
      ['alias.st', '!sh /tmp/p', 'alias.st'],
      ['url.https://evil/.insteadOf', 'https://github.com/', 'url.https://evil/.insteadof'],
    ];
    for (const [key, value, norm] of cases) {
      const ch = configChanges((ws) => git(ws, 'config', key, value));
      assert.equal(ch.length, 1, `${key}: ${JSON.stringify(ch)}`);
      assert.deepEqual(
        ch[0].keys.map((k) => k.toLowerCase()),
        [norm.toLowerCase()],
        key
      );
    }
  }
);

await check('B5: deprecated [section.subsection] form of a dangerous key is reported', () => {
  const ch = configChanges((ws) => fs.appendFileSync(cfg(ws), '[filter.x]\n\tclean = sh /tmp/p\n'));
  assert.equal(ch.length, 1, JSON.stringify(ch));
});

await check('B6: remote.*.uploadpack (runs a command, outside allow-list) → reported', () => {
  const ch = configChanges((ws) => git(ws, 'config', 'remote.origin.uploadpack', 'sh /tmp/p'));
  assert.equal(ch.length, 1, JSON.stringify(ch));
  assert.deepEqual(ch[0].keys, ['remote.origin.uploadpack']);
  assert.doesNotMatch(formatProtectedPathModifiedNotice(ch, true, 'x'), /\/tmp\/p/);
});

await check('B7: arbitrary unknown key foo.bar (never on any blacklist) → reported', () => {
  const ch = configChanges((ws) => git(ws, 'config', 'foo.bar', '1'));
  assert.equal(ch.length, 1, JSON.stringify(ch));
  assert.deepEqual(ch[0].keys, ['foo.bar']);
});

await check('B8: benign + unlisted key in one command → only unlisted key named', () => {
  const ch = configChanges((ws) => {
    git(ws, 'config', 'user.name', 'x');
    git(ws, 'config', 'core.pager', 'sh /tmp/p');
  });
  assert.deepEqual(ch[0]?.keys, ['core.pager']);
});

await check('B9: core.fsmonitor and case variant [Core] FSMonitor → reported', () => {
  const a = configChanges((ws) => git(ws, 'config', 'core.fsmonitor', '/tmp/p'));
  assert.deepEqual(a[0]?.keys, ['core.fsmonitor']);
  const b = configChanges((ws) => fs.appendFileSync(cfg(ws), '[Core]\n\tFSMonitor = /tmp/p\n'));
  assert.deepEqual(b[0]?.keys, ['core.FSMonitor']); // reported, original casing kept
});

// ── C. fail-closed ────────────────────────────────────────────────────

await check('C1: unparsable .git/config → whole-file report (no keys)', () => {
  const ch = configChanges((ws) => fs.appendFileSync(cfg(ws), '[core\n\thooksPath = /tmp/h\n'));
  assert.equal(ch.length, 1, JSON.stringify(ch));
  assert.equal(ch[0].keys, undefined);
});

await check('C2: .git/config deleted → reported', () => {
  const ch = configChanges((ws) => fs.rmSync(cfg(ws)));
  assert.equal(ch.length, 1);
  assert.equal(ch[0].kind, 'deleted');
});

await check('C3: .git/config replaced by symlink → reported', () => {
  const ch = configChanges((ws) => {
    const other = path.join(ws, 'other.cfg');
    fs.writeFileSync(other, fs.readFileSync(cfg(ws)));
    fs.rmSync(cfg(ws));
    fs.symlinkSync(other, cfg(ws));
  });
  assert.equal(ch.length, 1, JSON.stringify(ch));
});

await check('C4: allow-list matching — section/name case-insensitive, nothing executable', () => {
  assert.deepEqual(
    [...GIT_CONFIG_BENIGN_KEYS],
    ['user.name', 'user.email', 'color.ui', 'init.defaultBranch', 'pull.rebase', 'core.autocrlf']
  );
  assert.ok(isBenignGitConfigKey('user.name'));
  assert.ok(isBenignGitConfigKey('USER.NAME'));
  assert.ok(isBenignGitConfigKey('Init.DefaultBranch'));
  for (const k of [
    'core.hookspath',
    'CORE.HOOKSPATH',
    'remote.origin.url',
    'remote.origin.uploadpack',
    'branch.main.remote',
    'foo.bar',
    'init.templatedir',
    'pull.x.rebase',
    'core.autocrlfx',
    'user.signingkey',
    'color.diff.meta',
    'core.fsmonitor',
    'alias.st',
    'include.path',
  ]) {
    assert.ok(!isBenignGitConfigKey(k), k);
  }
});

// ── D. end-to-end through execTool + run outcome ──────────────────────

async function runExec(ws, home, command) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return String(
      await execTool.execute(
        { command },
        { workspaceDir: ws, sessionKey: 'o117', abortSignal: new AbortController().signal }
      )
    );
  } finally {
    process.env.HOME = prevHome;
  }
}

function outcomeFor(command, result) {
  const tracker = createRunCompletionTracker();
  noteRunCompletionEvent(tracker, {
    type: 'tool_start',
    toolCallId: '1',
    toolName: 'exec',
    input: { command },
  });
  noteRunCompletionEvent(tracker, {
    type: 'tool_end',
    toolCallId: '1',
    toolName: 'exec',
    result,
    isError: false,
  });
  return resolveRunOutcome({ tracker, finalText: '已完成。', request: command });
}

await check('D1: exec `git config user.name x` → no notice, exit 0', async () => {
  const { home, ws } = makeRepo();
  const out = await runExec(ws, home, 'git config user.name x');
  assert.doesNotMatch(out, /受保护路径已被修改|Protected paths were modified/);
  const outcome = outcomeFor('git config user.name x', out);
  assert.equal(outcome.exitCode, 0, formatOutcomeLine(outcome, 'zh'));
  assert.doesNotMatch(formatOutcomeLine(outcome, 'zh'), /未完成/);
});

await check('D2: exec script that sets core.hooksPath → notice, exit 9', async () => {
  const { home, ws } = makeRepo();
  fs.writeFileSync(path.join(ws, 'x.sh'), 'git config core.hooksPath /tmp/evilhooks\n');
  const out = await runExec(ws, home, 'sh x.sh');
  assert.match(out, /moss-o101-protected-path-modified/);
  const outcome = outcomeFor('sh x.sh', out);
  assert.equal(outcome.exitCode, 9);
  assert.match(formatOutcomeLine(outcome, 'zh'), /已被修改/);
});

// ── E. per-worktree config bypass (QA) ────────────────────────────────

await check(
  'E1: repositoryformatversion=1 + extensions.worktreeConfig + .git/config.worktree hooksPath → reported',
  () => {
    const { home, ws } = makeRepo();
    const before = takeProtectedPathSnapshot(ws, { home });
    git(ws, 'config', 'core.repositoryformatversion', '1');
    git(ws, 'config', 'extensions.worktreeConfig', 'true');
    fs.writeFileSync(path.join(ws, '.git', 'config.worktree'), '[core]\n\thooksPath = /tmp/evil\n');
    // precondition: git really honours it
    const r = spawnSync('git', ['config', 'core.hooksPath'], {
      cwd: ws,
      env: gitEnv,
      encoding: 'utf8',
    });
    assert.equal(r.stdout.trim(), '/tmp/evil');
    const after = takeProtectedPathSnapshotAfter(before, { home });
    const ch = diffProtectedPathSnapshots(before, after);
    const wt = ch.find((c) => c.path.endsWith('.git/config.worktree'));
    assert.ok(wt, JSON.stringify(ch));
    assert.deepEqual(wt.keys, ['core.hooksPath']);
    const main = ch.find((c) => c.path.endsWith('.git/config'));
    assert.deepEqual(main?.keys, ['core.repositoryformatversion', 'extensions.worktreeConfig']);
  }
);

await check('E2: linked worktree .git/worktrees/<n>/config.worktree hooksPath → reported', () => {
  const { home, ws } = makeRepo();
  git(
    ws,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@e',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'i',
    '--no-verify'
  );
  git(ws, 'worktree', 'add', '-q', path.join(ws, 'wt'), '-b', 'wt');
  const before = takeProtectedPathSnapshot(ws, { home });
  const name = fs.readdirSync(path.join(ws, '.git', 'worktrees'))[0];
  fs.writeFileSync(
    path.join(ws, '.git', 'worktrees', name, 'config.worktree'),
    '[core]\n\tfsmonitor = /tmp/p\n'
  );
  const ch = diffProtectedPathSnapshots(before, takeProtectedPathSnapshotAfter(before, { home }));
  const wt = ch.find((c) => c.path.endsWith(`worktrees/${name}/config.worktree`));
  assert.ok(wt, JSON.stringify(ch));
  assert.equal(wt.kind, 'added');
  assert.deepEqual(wt.keys, ['core.fsmonitor']);
});

await check('E3: extensions.* / core.repositoryformatversion are not allow-listed', () => {
  assert.ok(!isBenignGitConfigKey('extensions.worktreeConfig'));
  assert.ok(!isBenignGitConfigKey('core.repositoryformatversion'));
});

await check('E4: pre-block (O103) refuses direct writes to config.worktree files', () => {
  const { ws } = makeRepo();
  for (const cmd of [
    "printf '[core]\\n hooksPath=/tmp/x\\n' > .git/config.worktree",
    'cp x .git/worktrees/w/config.worktree',
    'git config --worktree core.hooksPath /tmp/x',
  ]) {
    const hits = findShellProtectedWrites(cmd, { cwd: ws, workspaceRoot: ws });
    assert.ok(hits.length > 0, cmd);
  }
  for (const p of ['.git/config.worktree', '.git/worktrees/w/config.worktree']) {
    const hits = findProtectedPathHits(
      'write_file',
      { path: p, content: '[core]\n\thooksPath = /tmp/x\n' },
      { cwd: ws, workspaceRoot: ws },
      false
    );
    assert.ok(hits.length > 0, p);
  }
});

// ── F. user-facing copy (UX) ──────────────────────────────────────────

function lastLines(changes, command = 'sh x.sh') {
  const marker = formatProtectedPathModifiedNotice(changes, true, command);
  const parsed = parseProtectedPathModMarker(marker);
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

await check('F1: last line names the key with original casing, zh + en', () => {
  const ch = configChanges((ws) => git(ws, 'config', 'core.hooksPath', '/tmp/secretdir'));
  const { zh, en } = lastLines(ch);
  assert.match(zh, /卡在：\.git\/config 改了 `core\.hooksPath`（不在安全清单内）/);
  assert.match(en, /\.git\/config changed `core\.hooksPath` \(not on the safe list\)/);
  assert.doesNotMatch(zh + en, /secretdir/);
});

await check('F2: more than 3 keys → 3 listed + 「等 N 个」 / "and N more"', () => {
  const ch = configChanges((ws) => {
    for (const k of ['a.one', 'b.two', 'c.three', 'd.four', 'e.five']) git(ws, 'config', k, '1');
  });
  const { zh, en } = lastLines(ch);
  assert.match(zh, /改了 `a\.one`、`b\.two`、`c\.three` 等 5 个（不在安全清单内）/);
  assert.doesNotMatch(zh, /d\.four/);
  assert.match(en, /changed `a\.one`, `b\.two`, `c\.three` and 2 more/);
});

await check('F3: delete / symlink / unparsable each say why', () => {
  const del = lastLines(configChanges((ws) => fs.rmSync(cfg(ws))));
  assert.match(del.zh, /\.git\/config 被删除/);
  assert.match(del.en, /\.git\/config was deleted/);
  const link = lastLines(
    configChanges((ws) => {
      const other = path.join(ws, 'other.cfg');
      fs.writeFileSync(other, fs.readFileSync(cfg(ws)));
      fs.rmSync(cfg(ws));
      fs.symlinkSync(other, cfg(ws));
    })
  );
  assert.match(link.zh, /\.git\/config 被换成软链/);
  assert.match(link.en, /replaced by a symlink/);
  const bad = lastLines(configChanges((ws) => fs.appendFileSync(cfg(ws), '[core\n')));
  assert.match(bad.zh, /\.git\/config 无法解析/);
  assert.match(bad.en, /\.git\/config could not be parsed/);
});

await check('F4: mixed benign + unlisted → only the unlisted key is named', () => {
  const ch = configChanges((ws) => {
    git(ws, 'config', 'user.name', 'x');
    git(ws, 'config', 'alias.st', '!sh /tmp/p');
  });
  const { zh } = lastLines(ch);
  assert.match(zh, /`alias\.st`/);
  assert.doesNotMatch(zh, /user\.name/);
});

// ── G. process-level `moss -p` ────────────────────────────────────────

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
  const home = fs.mkdtempSync(path.join(tmpRoot, 'phome-'));
  const proj = fs.mkdtempSync(path.join(tmpRoot, 'pproj-'));
  const cfgDir = path.join(home, '.config', 'moss');
  fs.mkdirSync(cfgDir, { recursive: true });
  spawnSync('git', ['init', '-q', proj], { env: gitEnv });
  const server = await startFake([command]);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    MOSS_CONFIG_DIR: cfgDir,
    MOSS_RUNTIME_DIR: path.join(home, 'runtime'),
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
    await runCli(['config', 'set', k, v], env, proj);
  const r = await runCli(['--trust-workspace', '--lang', lang, '-p', 'set name'], env, proj);
  server.close();
  const name = spawnSync('git', ['config', 'user.name'], {
    cwd: proj,
    env: gitEnv,
    encoding: 'utf8',
  });
  return { ...r, last: r.out.trim().split('\n').pop() ?? '', name: name.stdout.trim() };
}

for (const lang of ['zh', 'en']) {
  await check(
    `G1 (${lang}): moss -p runs \`git config user.name x\` → exit 0, not incomplete`,
    async () => {
      const r = await pRun(lang, 'git config user.name x');
      assert.equal(r.name, 'x', 'precondition: command actually ran');
      assert.equal(r.code, 0, `${r.last}\n${r.err.slice(-400)}`);
      assert.doesNotMatch(r.last, /未完成|Incomplete|已被修改|modified/);
    }
  );
}

await check('G2 (zh): moss -p runs `git remote add origin https://…` → exit 0', async () => {
  const r = await pRun(
    'zh',
    'git remote add origin https://example.com/r.git && git config branch.main.remote origin && git config branch.main.merge refs/heads/main'
  );
  assert.equal(r.code, 0, `${r.last}\n${r.err.slice(-400)}`);
  assert.doesNotMatch(r.last, /未完成|已被修改/);
});

await check('G3 (zh): moss -p runs `git remote add x ext::sh …` → exit 9', async () => {
  const r = await pRun('zh', "git remote add x 'ext::sh -c id'");
  assert.equal(r.code, 9, `${r.last}\n${r.err.slice(-400)}`);
  assert.match(r.out, /remote\.x\.url/);
});

if (failures > 0) {
  console.error(`# ${failures} failure(s)`);
  process.exit(1);
}
console.log('# o117 all ok');
