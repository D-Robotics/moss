#!/usr/bin/env node
/**
 * O94 — protected paths need one confirmation even in full mode; -p denies.
 * Spec: /workspace/specs/O94.md + O94-qa.md (Q1–Q8). Every gated case runs the
 * real approval hook and then EXECUTES the call only if it was approved
 * (shell through bash with HOME pointed at a temp home; file tools as the
 * equivalent fs write), so "file not changed" is checked as a side effect.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCliToolApprovalHook, setCliApprovalAsker } from '../dist/cli/approval.js';
import { setCliApprovalViewAsker } from '../dist/cli/approval-view.js';
// Dynamic so a revert run reports per-case reds instead of one import crash.
const { findProtectedPathHits } = await import('../dist/safety/protected-paths.js').catch(
  () => ({})
);
const { detectShellWriteTargets } = await import('../dist/safety/shell-write-detect.js').catch(
  () => ({})
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o94-'));
const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
const cfg = path.join(home, '.config', 'moss');
for (const d of [
  home,
  ws,
  cfg,
  path.join(home, '.ssh'),
  path.join(ws, 'src'),
  path.join(ws, 'test'),
  path.join(ws, 'docs'),
  path.join(ws, '.moss'),
])
  fs.mkdirSync(d, { recursive: true });
const seed = {
  [path.join(home, '.bashrc')]: '# rc\n',
  [path.join(home, '.zshrc')]: '# zrc\n',
  [path.join(home, '.profile')]: 'a\n',
  [path.join(home, '.ssh', 'authorized_keys')]: 'ssh-ed25519 AAAA user\n',
  [path.join(home, '.ssh', 'id_rsa')]: 'KEY\n',
  [path.join(cfg, 'config.json')]: '{}\n',
  [path.join(cfg, 'workspace-trust.json')]: '{"trusted":[]}\n',
  [path.join(ws, '.env')]: 'TOKEN=x\n',
  [path.join(ws, '.env.local')]: 'A=1\n',
  [path.join(ws, '.moss', 'config.json')]: '{}\n',
  [path.join(ws, 'src', 'a.ts')]: 'export const a = 1;\n',
  [path.join(ws, 'test', 'a.spec.mjs')]: '// t\n',
  [path.join(ws, 'k')]: 'ssh-ed25519 EVIL\n',
  [path.join(ws, 'x')]: 'x\n',
};
for (const [f, c] of Object.entries(seed)) fs.writeFileSync(f, c);
const gitEnv = {
  ...process.env,
  HOME: home,
  // O130: on Windows os.homedir() (used for `~`) reads USERPROFILE, not HOME.
  USERPROFILE: home,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: ws, env: gitEnv });
execFileSync('git', ['add', 'src', 'test'], { cwd: ws, env: gitEnv });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: ws, env: gitEnv });
fs.symlinkSync(path.join(home, '.bashrc'), path.join(ws, 'rc-link'));
fs.symlinkSync(path.join(home, '.ssh'), path.join(ws, 'ssh-link'));
const caseInsensitiveFs = fs.existsSync(path.join(ws, '.GIT'));

const env = { HOME: home, USERPROFILE: home, MOSS_CONFIG_DIR: cfg, PATH: process.env.PATH };

function snapshot() {
  const out = {};
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      out[p] = '<missing>';
      return;
    }
    if (st.isSymbolicLink()) {
      out[p] = `link:${fs.readlinkSync(p)}`;
      return;
    }
    if (st.isDirectory()) {
      out[p] = '<dir>';
      for (const c of fs.readdirSync(p)) walk(path.join(p, c));
      return;
    }
    out[p] = fs.readFileSync(p, 'utf8');
  };
  walk(home);
  walk(path.join(ws, '.git'));
  for (const f of ['.env', '.env.local', '.moss']) walk(path.join(ws, f));
  return out;
}

const T = (name, sideEffectClass) => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
  metadata: { sideEffectClass },
  execute: async () => 'ok',
});
const EXEC = {
  name: 'exec',
  description: 'exec',
  inputSchema: { type: 'object', properties: {} },
  metadata: { sideEffectClass: 'local_write' },
  execute: async () => 'ok',
};

function runIfApproved(tool, input) {
  if (tool.name === 'exec') {
    try {
      execFileSync('bash', ['-c', input.command], {
        cwd: ws,
        env: { ...gitEnv, HOME: home },
        stdio: 'ignore',
      });
    } catch {
      /* command failure is fine */
    }
    return;
  }
  const p = path.resolve(ws, input.path ?? input.destination ?? '.env');
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, 'PWNED\n');
  } catch {
    /* ignore */
  }
}

let counter = 0;
/**
 * answer: string returned by the asker.
 * headless: fake non-TTY (legacy -p simulation).
 * printMode: real `-p` path — keep stdin as TTY, set printMode on the hook
 *   (QA BLOCK regression: TTY + -p must deny without hanging on defaultAskUser).
 */
async function decide(
  tool,
  input,
  { answer = '', headless = false, printMode = false, mode = 'full', hook, noExec = false } = {}
) {
  const asked = [];
  const errs = [];
  const h =
    hook ??
    createCliToolApprovalHook(mode === 'full' ? 'full-access' : 'workspace-write', env, {
      workspaceDir: ws,
      interactionMode: () => mode,
      ...(mode === 'full' ? { approvalPolicy: 'never' } : {}),
      ...(printMode ? { printMode: true } : {}),
    });
  const wasTTY = process.stdin.isTTY;
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  let undo = () => {};
  if (headless) {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    setCliApprovalAsker(null);
    h.setAsker(null);
  } else if (printMode) {
    // Real `moss -p` on a terminal: stdin stays TTY, no asker/TUI registered.
    // If the gate still falls through to defaultAskUser, the 2s race below fails.
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    setCliApprovalAsker(null);
    h.setAsker(null);
  } else {
    undo = h.setAsker(async (q) => {
      asked.push(q);
      return answer;
    });
  }
  let hangTimer;
  try {
    const run = h({ tool, input, toolCallId: `o94-${++counter}`, sessionKey: 'o94' });
    const decision = printMode
      ? await Promise.race([
          run,
          new Promise((_, reject) => {
            hangTimer = setTimeout(
              () => reject(new Error('printMode hung waiting for approval (>2s)')),
              2000
            );
          }),
        ])
      : await run;
    if (decision.approved && !noExec) runIfApproved(tool, input);
    return { decision, asked, errs, hook: h };
  } finally {
    if (hangTimer) clearTimeout(hangTimer);
    undo();
    console.error = origErr;
    Object.defineProperty(process.stdin, 'isTTY', { value: wasTTY, configurable: true });
  }
}

let pass = 0;
const failures = [];
async function check(fn, label) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${label ?? 'block'}: ${err.message.split('\n')[0]}`);
    console.log(`not ok - ${label ?? 'block'}: ${err.message.split('\n')[0]}`);
  }
}
const ok = (name) => {
  pass += 1;
  console.log(`ok - ${name}`);
};

// ── Q1/Q2/Q3/Q5: gated cases (full mode) ──────────────────────────────────
const gated = [
  ['shell rm -rf .git', EXEC, { command: 'rm -rf .git' }],
  ['shell rm .git/config', EXEC, { command: 'rm .git/config' }],
  ['shell echo >> ~/.bashrc', EXEC, { command: 'echo x >> ~/.bashrc' }],
  ['shell > .env', EXEC, { command: '> .env' }],
  ['shell cp k ~/.ssh/authorized_keys', EXEC, { command: 'cp k ~/.ssh/authorized_keys' }],
  ['shell mv x ~/.ssh/', EXEC, { command: 'mv x ~/.ssh/' }],
  ['shell tee -a ~/.zshrc', EXEC, { command: 'echo y | tee -a ~/.zshrc' }],
  ['shell sed -i ~/.profile', EXEC, { command: "sed -i 's/a/b/' ~/.profile" }],
  [
    'shell node -e writeFileSync(.env)',
    EXEC,
    { command: `node -e "require('fs').writeFileSync('.env','PWNED')"` },
  ],
  [
    'shell python3 -c open(.git/config)',
    EXEC,
    { command: `python3 -c "open('.git/config','w').write('x')"` },
  ],
  ['shell $HOME/.bashrc', EXEC, { command: 'echo x >> $HOME/.bashrc' }],
  ['shell ${HOME}/.ssh absolute', EXEC, { command: `echo x >> ${home}/.ssh/authorized_keys` }],
  ['shell ./.git/../.git/config', EXEC, { command: 'echo x > ./.git/../.git/config' }],
  ['shell src/../.env', EXEC, { command: 'echo x > src/../.env' }],
  [
    'shell ln -s ~/.ssh then append',
    EXEC,
    { command: 'ln -s ~/.ssh y && echo >> y/authorized_keys' },
  ],
  ['shell existing symlink to ~/.bashrc', EXEC, { command: 'echo x >> rc-link' }],
  ['shell existing symlink dir to ~/.ssh', EXEC, { command: 'cp k ssh-link/authorized_keys' }],
  ['shell case .GIT/config', EXEC, { command: 'echo x > .GIT/config' }],
  ['shell case .Env', EXEC, { command: 'echo x > .Env' }],
  ['shell eval (fail-closed)', EXEC, { command: `eval "echo x > .env"` }],
  ['shell bash -c (fail-closed)', EXEC, { command: `bash -c 'echo x >> ~/.bashrc'` }],
  ['shell cd ~/.ssh && rm id_rsa', EXEC, { command: 'cd ~/.ssh && rm id_rsa' }],
  ['shell find .git -delete', EXEC, { command: 'find .git -name "*.sample" -delete' }],
  ['shell chmod ~/.ssh/id_rsa', EXEC, { command: 'chmod 777 ~/.ssh/id_rsa' }],
  ['shell rm -rf . (deletes workspace .git)', EXEC, { command: 'rm -rf .' }],
  [
    'shell moss config.json',
    EXEC,
    { command: `echo '{"permissions":{"allow":["*"]}}' > ~/.config/moss/config.json` },
  ],
  [
    'shell workspace-trust.json (Q5)',
    EXEC,
    { command: `echo '{"trusted":["/"]}' > ~/.config/moss/workspace-trust.json` },
  ],
  ['shell project .moss/config.json', EXEC, { command: `echo '{}' > .moss/config.json` }],
  ['shell sudo wrapper', EXEC, { command: 'sudo rm -rf .git' }],
  ['file write_file .env', T('write_file', 'local_write'), { path: '.env', content: 'x' }],
  [
    'file edit_file .git/config',
    T('edit_file', 'local_write'),
    { path: '.git/config', old_string: 'a', new_string: 'b' },
  ],
  ['file multi_edit .env.local', T('multi_edit', 'local_write'), { path: '.env.local', edits: [] }],
  [
    'file move_file into .git/hooks',
    T('move_file', 'local_write'),
    { source: 'x', destination: '.git/hooks/pre-commit' },
  ],
  [
    'file apply_patch .env',
    T('apply_patch', 'local_write'),
    { patch: '*** Begin Patch\n*** Update File: .env\n@@\n-TOKEN=x\n+TOKEN=y\n*** End Patch' },
  ],
  [
    'file write_file .moss/config.json',
    T('write_file', 'local_write'),
    { path: '.moss/config.json', content: '{}' },
  ],
  [
    'file write_file .GIT/HEAD (case)',
    T('write_file', 'local_write'),
    { path: '.GIT/HEAD', content: 'x' },
  ],
  [
    'file write_file src/../.env',
    T('write_file', 'local_write'),
    { path: 'src/../.env', content: 'x' },
  ],
  [
    'file write_file ./.git/../.git/config',
    T('write_file', 'local_write'),
    { path: './.git/../.git/config', content: 'x' },
  ],
];

for (const [name, tool, input] of gated) {
  await check(async () => {
    // -p / headless: denied, stderr names the path, nothing changes.
    {
      const before = snapshot();
      const { decision, errs } = await decide(tool, input, { headless: true });
      assert.equal(decision.approved, false, `${name}: -p must deny`);
      assert.match(
        decision.reason,
        /^(Blocked:|已拦截：)/,
        `${name}: -p reason starts with Blocked`
      );
      assert.match(
        decision.reason,
        /protected path|受保护路径/,
        `${name}: -p reason says protected path`
      );
      assert.ok(
        errs.some((l) => /protected path|受保护路径/.test(l)),
        `${name}: -p prints one stderr reason`
      );
      assert.ok(
        errs.some((l) => /interactively|交互模式/.test(l)),
        `${name}: stderr says how to allow`
      );
      assert.deepEqual(snapshot(), before, `${name}: -p left protected files unchanged`);
    }
    // interactive full mode: asked exactly once, Enter (empty) denies, nothing changes.
    {
      const before = snapshot();
      const { decision, asked } = await decide(tool, input, { answer: '' });
      assert.equal(asked.length, 1, `${name}: full mode asks exactly once`);
      assert.match(asked[0], /protected path|受保护路径/, `${name}: prompt says why`);
      assert.match(
        asked[0],
        /default: deny|默认拒绝|\[N\]/,
        `${name}: prompt shows deny is default`
      );
      assert.equal(decision.approved, false, `${name}: Enter denies`);
      assert.match(
        decision.reason,
        /^(Blocked: the user denied|已拦截：用户拒绝)/,
        `${name}: denial starts with Blocked`
      );
      assert.deepEqual(snapshot(), before, `${name}: denied → protected files unchanged`);
    }
    ok(name);
  }, name);
}

// prompt names the raw path / operation
await check(async () => {
  const { asked } = await decide(EXEC, { command: 'echo x >> ~/.bashrc' }, { answer: 'n' });
  assert.match(asked[0], /~\/\.bashrc/, 'prompt shows the path as written');
  assert.match(
    asked[0],
    /^About to write to `~\/\.bashrc` \(shell startup file, a protected path\)/m,
    'first line = op + path + why'
  );
  ok('prompt first line names operation, path and reason');
});

// 'y' approves exactly once; 'a' grants this path for the session only.
await check(async () => {
  const hook = createCliToolApprovalHook('full-access', env, {
    workspaceDir: ws,
    interactionMode: () => 'full',
    approvalPolicy: 'never',
  });
  const r1 = await decide(
    T('write_file', 'local_write'),
    { path: '.env.local', content: 'x' },
    { answer: 'y', hook }
  );
  assert.equal(r1.decision.approved, true, 'y approves');
  const r2 = await decide(
    T('write_file', 'local_write'),
    { path: '.env.local', content: 'x' },
    { answer: '', hook }
  );
  assert.equal(r2.asked.length, 1, "'y' is one-shot: asked again next time");
  assert.equal(r2.decision.approved, false);
  const r3 = await decide(
    T('write_file', 'local_write'),
    { path: '.env.local', content: 'x' },
    { answer: 'a', hook }
  );
  assert.equal(r3.decision.approved, true);
  const r4 = await decide(
    T('write_file', 'local_write'),
    { path: '.env.local', content: 'x' },
    { answer: '', hook }
  );
  assert.equal(r4.asked.length, 0, "'a' covers the same path this session");
  assert.equal(r4.decision.approved, true);
  const r5 = await decide(
    T('write_file', 'local_write'),
    { path: '.env', content: 'x' },
    { answer: '', hook }
  );
  assert.equal(r5.asked.length, 1, "'a' does not cover other protected paths");
  const fresh = await decide(
    T('write_file', 'local_write'),
    { path: '.env.local', content: 'x' },
    { answer: '' }
  );
  assert.equal(fresh.asked.length, 1, "'a' is not persisted to a new session");
  fs.writeFileSync(path.join(ws, '.env.local'), 'A=1\n');
  ok("'y' once / 'a' same path this session only");
});

// Q6: denied edit, then the same path via exec / node -e is also gated.
await check(async () => {
  const hook = createCliToolApprovalHook('full-access', env, {
    workspaceDir: ws,
    interactionMode: () => 'full',
    approvalPolicy: 'never',
  });
  const before = snapshot();
  const e = await decide(
    T('edit_file', 'local_write'),
    { path: '.env', old_string: 'x', new_string: 'y' },
    { answer: 'n', hook }
  );
  assert.equal(e.decision.approved, false);
  for (const command of [
    "sed -i 's/x/y/' .env",
    `node -e "require('fs').appendFileSync('.env','y')"`,
    'echo y >> .env',
    "cat > .env <<'EOF'\ny\nEOF",
  ]) {
    const r = await decide(EXEC, { command }, { answer: 'n', hook });
    assert.equal(r.asked.length, 1, `retry via shell is asked: ${command}`);
    assert.equal(r.decision.approved, false, `retry via shell denied: ${command}`);
  }
  assert.deepEqual(snapshot(), before, 'after edit denial, shell retries changed nothing');
  ok('Q6 edit denied → exec/sed/node -e/heredoc retries are gated too');
});

// Manual mode: a protected write is asked once (not twice).
await check(async () => {
  const { asked, decision } = await decide(
    T('write_file', 'local_write'),
    { path: '.env', content: 'x' },
    { answer: 'y', mode: 'manual' }
  );
  assert.equal(asked.length, 1, 'manual mode asks exactly once for a protected path');
  assert.equal(decision.approved, true);
  fs.writeFileSync(path.join(ws, '.env'), 'TOKEN=x\n');
  ok('manual mode: single confirmation');
});

// A config deny rule still wins over the protected-path prompt.
await check(async () => {
  const hook = createCliToolApprovalHook('full-access', env, {
    workspaceDir: ws,
    interactionMode: () => 'full',
    approvalPolicy: 'never',
    deniedTools: ['write_file'],
  });
  const { asked, decision } = await decide(
    T('write_file', 'local_write'),
    { path: '.env', content: 'x' },
    { answer: 'y', hook }
  );
  assert.equal(decision.approved, false, 'deny rule wins');
  assert.equal(asked.length, 0, 'deny rule: no prompt');
  ok('deny rules still win (stricter, never looser)');
});

// ── Q4 guards: no prompt, approved in full mode (green on main too) ───────
const guards = [
  ['git commit', EXEC, { command: 'git commit --allow-empty -qm wip' }],
  ['git checkout -b', EXEC, { command: 'git checkout -q -b feat' }],
  ['git stash', EXEC, { command: 'git stash' }],
  ['git add + commit chain', EXEC, { command: 'git add -A src && git commit -qm x || true' }],
  [
    'git remote add url ending .git',
    EXEC,
    { command: 'git remote add origin https://github.com/D-Robotics/moss.git' },
  ],
  ['read .git/HEAD', EXEC, { command: 'cat .git/HEAD' }],
  ['ls .git', EXEC, { command: 'ls .git' }],
  ['cat .env (read)', EXEC, { command: 'cat .env' }],
  ['npm test', EXEC, { command: 'npm test' }],
  ['echo > out.txt', EXEC, { command: 'echo hi > out.txt' }],
  [
    'node -e writes normal file',
    EXEC,
    { command: `node -e "require('fs').writeFileSync('out.txt','x')"` },
  ],
  ['sed -i src file', EXEC, { command: "sed -i 's/1/2/' src/a.ts" }],
  ['rm -rf dist', EXEC, { command: 'rm -rf dist' }],
  ['write_file src/b.ts', T('write_file', 'local_write'), { path: 'src/b.ts', content: 'x' }],
  [
    'edit_file test/a.spec.mjs',
    T('edit_file', 'local_write'),
    { path: 'test/a.spec.mjs', old_string: 't', new_string: 'u' },
  ],
  [
    'write_file .envrc.example',
    T('write_file', 'local_write'),
    { path: '.envrc.example', content: 'x' },
  ],
  [
    'write_file docs/.git-notes.md',
    T('write_file', 'local_write'),
    { path: 'docs/.git-notes.md', content: 'x' },
  ],
  [
    'write_file .gitignore',
    T('write_file', 'local_write'),
    { path: '.gitignore', content: 'node_modules\n' },
  ],
  [
    'write_file .github/workflows/ci.yml',
    T('write_file', 'local_write'),
    { path: '.github/workflows/ci.yml', content: 'x' },
  ],
  [
    'write_file calc.py (first-install task)',
    T('write_file', 'local_write'),
    { path: 'calc.py', content: 'x' },
  ],
  ['read_file .git/config', T('read_file', 'readonly'), { path: '.git/config' }],
];
for (const [name, tool, input] of guards) {
  await check(async () => {
    const { asked, decision } = await decide(tool, input, { answer: 'n' });
    assert.equal(asked.length, 0, `guard ${name}: no prompt`);
    assert.equal(decision.approved, true, `guard ${name}: approved in full mode`);
    ok(`guard: ${name}`);
  }, `guard: ${name}`);
}

// ── policy vs detector: injected targets (independent of the shared detector) ──
await check(async () => {
  const ctx = (targets, uncertain) => ({
    cwd: ws,
    home,
    workspaceRoot: ws,
    configDirs: [cfg],
    env,
    shellWriteTargets: () => ({ targets, uncertain }),
  });
  const hits = (command, targets, uncertain) =>
    findProtectedPathHits('exec', { command }, ctx(targets, uncertain), false);
  assert.equal(
    hits('whatever', [path.join(home, '.bashrc')], false).length,
    1,
    'known protected target → hit'
  );
  assert.equal(
    hits('whatever', [path.join(ws, '.GIT', 'config')], false).length,
    1,
    'case variant target → hit'
  );
  assert.equal(
    hits('whatever', [path.join(ws, 'rc-link')], false).length,
    1,
    'symlink target resolved → hit'
  );
  assert.equal(
    hits('whatever', [path.join(ws, 'src', 'a.ts')], false).length,
    0,
    'normal target → no hit'
  );
  assert.equal(hits('whatever', [], false).length, 0, 'no targets, certain → no hit');
  assert.equal(
    hits('python script.py', [], true).length,
    0,
    'uncertain, no protected reference → no hit'
  );
  assert.equal(hits('node -e "x(\'.env\')"', [], true).length, 1, 'uncertain + names .env → hit');
  assert.equal(
    hits(`perl -e 1 ${cfg}/config.json`, [], true).length,
    1,
    'uncertain + names Moss config dir → hit'
  );
  assert.equal(
    hits('node -e "x(\'.env\')"', [], false).length,
    0,
    'certain + no protected target → no hit (detector is trusted)'
  );
  assert.equal(
    findProtectedPathHits(
      'exec',
      { command: 'rm -rf .git' },
      ctx([path.join(ws, '.git')], false),
      true
    ).length,
    0,
    'readonly exec is never gated'
  );
  ok('policy: injected detector (known target / uncertain+reference / uncertain only)');
}, 'policy: injected detector');

await check(async () => {
  // Shared O97 detector: HOME for ~ comes from process.env / os.homedir().
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home; // O130: Windows os.homedir() source
  try {
    const r = detectShellWriteTargets('echo x >> ~/.bashrc && rm -rf .git', ws);
    assert.ok(r.targets.includes(path.join(home, '.bashrc')), 'absolute ~ expansion');
    assert.ok(r.targets.includes(path.join(ws, '.git')), 'absolute relative target');
    assert.equal(r.uncertain, false);
    // O97 marks interpreter+script-file as uncertain; policy still skips when
    // mentions do not name a protected path (known limitation: script body).
    const script = detectShellWriteTargets('python script.py', ws);
    assert.equal(script.uncertain, true, 'script file → uncertain');
    assert.ok(
      !script.mentions.some(
        (m) => m.endsWith('.bashrc') || m.includes('/.git') || m.endsWith('.env')
      ),
      'script.py mentions do not name a protected path'
    );
    assert.equal(detectShellWriteTargets('node -e "1"', ws).uncertain, true);
    assert.deepEqual(detectShellWriteTargets('git commit -qm x', ws).targets, [], 'git owns .git/');
    assert.ok(Array.isArray(r.mentions), 'mentions present');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  }
  ok('shared detector shape: { targets, uncertain, mentions }');
}, 'shared detector shape');

// uncertain without a protected reference: no prompt (full) and allowed (-p)
await check(async () => {
  fs.writeFileSync(path.join(ws, 'script.py'), 'print(1)\n');
  for (const command of [
    'python3 script.py',
    `node -e "console.log(1)"`,
    'eval "echo hi"',
    'echo $(date) > out.txt',
  ]) {
    const r = await decide(EXEC, { command }, { answer: 'n' });
    assert.equal(r.asked.length, 0, `no prompt: ${command}`);
    assert.equal(r.decision.approved, true, `allowed in full: ${command}`);
  }
  ok('uncertain but no protected reference → no prompt');
}, 'uncertain no reference');

// QA: -p + uncertain + protected reference → deny, nothing changes
await check(async () => {
  for (const command of [
    `node -e "require('fs').appendFileSync(process.env.HOME+'/.bashrc','x')"`,
    `bash -c "$(echo cat) k >> .env"`,
    `xargs -I{} cp {} ~/.ssh/ <<< k`,
  ]) {
    const before = snapshot();
    const r = await decide(EXEC, { command }, { headless: true });
    assert.equal(r.decision.approved, false, `-p denies uncertain+protected: ${command}`);
    assert.match(r.decision.reason, /^Blocked: .*protected path/);
    assert.deepEqual(snapshot(), before, `-p unchanged: ${command}`);
  }
  ok('-p: uncertain + protected reference → denied');
}, '-p uncertain+protected');

// O90-style task flow: zero prompts end to end
await check(async () => {
  const hook = createCliToolApprovalHook('full-access', env, {
    workspaceDir: ws,
    interactionMode: () => 'full',
    approvalPolicy: 'never',
  });
  const flow = [
    [T('read_file', 'readonly'), { path: 'src/a.ts' }],
    [EXEC, { command: 'git status --short && git log -1 --oneline' }],
    [EXEC, { command: 'git diff' }],
    [T('edit_file', 'local_write'), { path: 'src/a.ts', old_string: '1', new_string: '2' }],
    [
      T('write_file', 'local_write'),
      { path: 'test/hooks-timeout-clamp.spec.mjs', content: '// t' },
    ],
    [EXEC, { command: 'npm run build && node test/hooks-timeout-clamp.spec.mjs' }],
    [EXEC, { command: 'npx prettier --write test/hooks-timeout-clamp.spec.mjs' }],
    [EXEC, { command: 'npm run check 2>&1 | tail -20' }],
    [EXEC, { command: 'git add -A src test && git commit -qm "fix: O90" || true' }],
    [EXEC, { command: 'git checkout -q -b fix/o90 && git stash list' }],
  ];
  let prompts = 0;
  for (const [tool, input] of flow) {
    const r = await decide(tool, input, { answer: 'n', hook, noExec: true });
    prompts += r.asked.length;
    assert.equal(r.decision.approved, true, `flow step allowed: ${input.command ?? input.path}`);
  }
  assert.equal(prompts, 0, 'O90-style flow: 0 confirmation prompts');
  ok('O90-style task flow → 0 prompts');
}, 'O90 flow');

// ── zh copy (UX 3/4/7) in a child process with a zh UI locale ─────────────
await check(async () => {
  const script = `
    import { createCliToolApprovalHook, setCliApprovalAsker } from ${JSON.stringify(new URL('../dist/cli/approval.js', import.meta.url).href)};
    const env = ${JSON.stringify(env)};
    const tool = { name: 'write_file', description: 'w', inputSchema: { type: 'object', properties: {} }, metadata: { sideEffectClass: 'local_write' }, execute: async () => 'ok' };
    const h = createCliToolApprovalHook('full-access', env, { workspaceDir: ${JSON.stringify(ws)}, interactionMode: () => 'full', approvalPolicy: 'never' });
    const asked = [];
    h.setAsker(async (q) => { asked.push(q); return ''; });
    const d = await h({ tool, input: { path: '.env', content: 'x' }, toolCallId: 'zh1' });
    h.setAsker(null); setCliApprovalAsker(null);
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const errs = []; console.error = (...a) => errs.push(a.join(' '));
    const d2 = await h({ tool, input: { path: '.env', content: 'x' }, toolCallId: 'zh2' });
    process.stdout.write(JSON.stringify({ asked, d, d2, errs }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      MOSS_LANG: 'zh',
      MOSS_UI_LANGUAGE: 'zh',
    },
    encoding: 'utf8',
  });
  const r = JSON.parse(out);
  if (/^已拦截/.test(r.d.reason)) {
    assert.match(r.asked[0], /^要写入 `\.env`（环境变量和密钥文件，受保护路径）/m, 'zh first line');
    assert.match(
      r.d.reason,
      /^已拦截：用户拒绝写入受保护路径 \.env/,
      'zh denial starts with 已拦截'
    );
    assert.match(r.d2.reason, /^已拦截：/, 'zh -p reason');
    assert.ok(
      r.errs.some((l) => /已拦截.*\.env.*受保护路径.*不带 -p 交互运行/.test(l)),
      'zh stderr line names path + how to allow'
    );
    ok('zh copy: prompt / denial / -p stderr');
  } else {
    console.log(
      `skip - zh copy: child process did not resolve a zh UI locale (${r.d.reason.slice(0, 40)})`
    );
  }
});

// ── QA BLOCK regression: TTY + printMode (-p) must deny without hanging ────
await check(async () => {
  const before = snapshot();
  // Keep isTTY true; printMode flag alone must trigger auto-deny.
  const { decision, asked, errs } = await decide(
    EXEC,
    { command: 'rm -rf .git' },
    { printMode: true }
  );
  assert.equal(decision.approved, false, 'TTY+-p must deny');
  assert.equal(asked.length, 0, 'TTY+-p must not call any asker');
  assert.match(decision.reason, /^(Blocked:|已拦截：)/, 'TTY+-p reason');
  assert.match(decision.reason, /protected path|受保护路径/, 'TTY+-p says protected');
  assert.ok(
    errs.some((l) => /protected path|受保护路径/.test(l)),
    'TTY+-p prints stderr notice'
  );
  assert.deepEqual(snapshot(), before, 'TTY+-p left files unchanged');
  ok('TTY + printMode (-p): immediate deny, no hang');
}, 'TTY+printMode deny');

// Same regression via argv `-p` (no printMode option) while stdin stays TTY.
await check(async () => {
  const before = snapshot();
  const prevArgv = process.argv.slice();
  process.argv = [process.execPath, 'moss', '-p', 'rm protected'];
  try {
    const asked = [];
    const errs = [];
    const h = createCliToolApprovalHook('full-access', env, {
      workspaceDir: ws,
      interactionMode: () => 'full',
      approvalPolicy: 'never',
      // deliberately omit printMode — argv must be enough
    });
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    setCliApprovalAsker(null);
    h.setAsker(null);
    const origErr = console.error;
    console.error = (...a) => errs.push(a.join(' '));
    let hangTimer;
    try {
      const decision = await Promise.race([
        h({
          tool: EXEC,
          input: { command: 'echo x >> ~/.bashrc' },
          toolCallId: 'o94-argv-p',
          sessionKey: 'o94',
        }),
        new Promise((_, reject) => {
          hangTimer = setTimeout(
            () => reject(new Error('argv -p hung waiting for approval (>2s)')),
            2000
          );
        }),
      ]);
      assert.equal(decision.approved, false, 'argv -p must deny');
      assert.equal(asked.length, 0, 'argv -p must not ask');
      assert.ok(
        errs.some((l) => /protected path|受保护路径/.test(l)),
        'argv -p stderr'
      );
      assert.deepEqual(snapshot(), before, 'argv -p unchanged');
    } finally {
      if (hangTimer) clearTimeout(hangTimer);
      console.error = origErr;
      Object.defineProperty(process.stdin, 'isTTY', { value: wasTTY, configurable: true });
    }
  } finally {
    process.argv = prevArgv;
  }
  ok('TTY + argv -p: immediate deny via argvRequestsPrintMode');
}, 'TTY+argv -p deny');

// rm → Chinese 「删除」 (and English delete), not generic write.
await check(async () => {
  if (!findProtectedPathHits) throw new Error('findProtectedPathHits missing');
  const hits = findProtectedPathHits(
    'exec',
    { command: 'rm -rf .git' },
    { cwd: ws, workspaceRoot: ws, configDirs: [cfg], env, home },
    false
  );
  assert.ok(hits.length > 0, 'rm .git is a hit');
  assert.equal(hits[0].operation, 'delete', 'rm maps to delete operation');
  const { protectedPathHeadline } = await import('../dist/cli/protected-path-prompt.js');
  assert.match(protectedPathHeadline(hits[0], true), /要删除/, 'zh rm label is 删除');
  assert.match(protectedPathHeadline(hits[0], false), /About to delete/, 'en rm label is delete');
  ok('rm → delete / 「删除」');
}, 'rm delete label');

if (!caseInsensitiveFs)
  console.log(
    'note - case-sensitive FS: case variants are still matched case-insensitively (stricter)'
  );
setCliApprovalViewAsker(null);
fs.rmSync(root, { recursive: true, force: true });
console.log(`# o94-protected-paths: ${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
