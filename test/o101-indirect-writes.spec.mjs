#!/usr/bin/env node
/**
 * O101 — indirect writes to protected paths (inline / script scan / post-run).
 * Spec: /workspace/specs/O101.md
 *
 * Red/green: every gated case must fail when the O101 modules are removed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o101-'));
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
  path.join(ws, '.moss'),
  path.join(ws, '.git'),
])
  fs.mkdirSync(d, { recursive: true });

const PRIVATE_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----\n';
const ENV_SECRET = 'API_TOKEN=super-secret-value-do-not-leak\n';

fs.writeFileSync(path.join(home, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAA user\n');
fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), PRIVATE_KEY);
fs.writeFileSync(path.join(ws, '.env'), ENV_SECRET);
fs.writeFileSync(path.join(ws, 'src', 'ok.ts'), 'export const ok = 1;\n');
fs.writeFileSync(
  path.join(ws, 'test', 'ok.spec.mjs'),
  'import test from "node:test"; test("x", () => {});'
);

const gitEnv = {
  ...process.env,
  HOME: home,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: ws, env: gitEnv });
fs.mkdirSync(path.join(ws, '.git', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(ws, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
execFileSync('git', ['add', 'src', 'test'], { cwd: ws, env: gitEnv });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: ws, env: gitEnv });

const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const load = async (rel) => {
  const p = path.join(distRoot, rel);
  return import(pathToFileURL(p).href);
};

let failures = 0;
function ok(label) {
  console.log(`ok - ${label}`);
}
function fail(label, err) {
  failures += 1;
  console.log(`not ok - ${label}: ${err?.message ?? err}`);
}
async function check(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (err) {
    fail(label, err);
  }
}

const { findProtectedPathHits } = await load('safety/protected-paths.js');
const { findIndirectProtectedWrites, scanWorkspaceScript, shouldSkipDeepScan, listInvokedScripts } =
  await load('safety/indirect-write-detect.js');
const {
  takeProtectedPathSnapshot,
  takeProtectedPathSnapshotAfter,
  diffProtectedPathSnapshots,
  filterExpectedGitMetadataChanges,
  formatProtectedPathModifiedNotice,
  parseProtectedPathModMarker,
  PROTECTED_PATH_MOD_MARKER,
  protectedPathModReason,
} = await load('safety/protected-path-snapshot.js');
const { createCliToolApprovalHook, setCliApprovalAsker } = await load('cli/approval.js');
const { setCliApprovalViewAsker } = await load('cli/approval-view.js');
const { createRunCompletionTracker, noteRunCompletionEvent } = await load('cli/run-completion.js');
const { resolveRunOutcome, formatOutcomeLine } = await load('cli/run-outcome.js');
const { protectedPathHeadline } = await load('cli/protected-path-prompt.js');

const ctx = {
  cwd: ws,
  home,
  workspaceRoot: ws,
  configDirs: [cfg],
  env: { HOME: home, PATH: process.env.PATH },
};

function hits(command) {
  return findProtectedPathHits('exec', { command }, ctx, false);
}

const EXEC_TOOL = {
  name: 'exec',
  description: 'exec',
  inputSchema: { type: 'object', properties: {} },
  metadata: { sideEffectClass: 'local_write' },
  execute: async () => 'ok',
};

function makeHook({ printMode = false } = {}) {
  const env = { HOME: home, MOSS_CONFIG_DIR: cfg, PATH: process.env.PATH };
  const hook = createCliToolApprovalHook('full-access', env, {
    workspaceDir: ws,
    interactionMode: () => 'full',
    approvalPolicy: 'never',
    ...(printMode ? { printMode: true } : {}),
  });
  return hook;
}

function md5(p) {
  return createHash('md5').update(fs.readFileSync(p)).digest('hex');
}

// ── A. Inline python / node / bash — -p denies, file unchanged ──────────

await check('A1: python3 -c writing .git/config is a protected hit', () => {
  const h = hits(`python3 -c "open('.git/config','a').write('x')"`);
  assert.ok(h.length >= 1, `expected hit, got ${JSON.stringify(h)}`);
  assert.ok(h.some((x) => x.category === 'git'));
  // O101-specific: inline source metadata (O97 alone has no source).
  assert.ok(
    h.some((x) => x.source?.kind === 'inline' && /python/.test(x.source.script ?? '')),
    `expected inline source, got ${JSON.stringify(h)}`
  );
});

await check('A2: node -e writing .env is a protected hit', () => {
  const h = hits(`node -e "require('fs').writeFileSync('.env','PWNED')"`);
  assert.ok(h.length >= 1);
  assert.ok(h.some((x) => x.category === 'env' || x.raw.includes('.env')));
  assert.ok(
    h.some((x) => x.source?.kind === 'inline' && /node/.test(x.source.script ?? '')),
    `expected inline source, got ${JSON.stringify(h)}`
  );
});

await check('A3: bash -c appending ~/.ssh/authorized_keys is a protected hit', () => {
  const h = hits(`bash -c 'echo k >> ~/.ssh/authorized_keys'`);
  assert.ok(h.length >= 1);
  assert.ok(h.some((x) => x.category === 'ssh'));
  assert.ok(
    h.some((x) => x.source?.kind === 'inline' && /bash/.test(x.source.script ?? '')),
    `expected inline source, got ${JSON.stringify(h)}`
  );
});

await check('A4: -p denies python3 -c and leaves .git/config unchanged', async () => {
  const before = md5(path.join(ws, '.git', 'config'));
  setCliApprovalAsker(null);
  setCliApprovalViewAsker(null);
  const hook = makeHook({ printMode: true });
  hook.setAsker(null);
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  const decision = await hook({
    tool: EXEC_TOOL,
    input: { command: `python3 -c "open('.git/config','a').write('EVIL')"` },
    toolCallId: 'o101-a4',
    sessionKey: 'o101',
  });
  assert.equal(decision.approved, false, 'must deny under -p');
  assert.match(decision.reason ?? '', /已拦截|Blocked/);
  assert.equal(md5(path.join(ws, '.git', 'config')), before);
});

await check('A5: -p denies node -e .env write; file unchanged', async () => {
  const before = md5(path.join(ws, '.env'));
  const hook = makeHook({ printMode: true });
  hook.setAsker(null);
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  const decision = await hook({
    tool: EXEC_TOOL,
    input: { command: `node -e "require('fs').writeFileSync('.env','PWNED')"` },
    toolCallId: 'o101-a5',
    sessionKey: 'o101',
  });
  assert.equal(decision.approved, false);
  assert.equal(md5(path.join(ws, '.env')), before);
});

await check('A6: -p denies bash -c ~/.ssh write; file unchanged', async () => {
  const target = path.join(home, '.ssh', 'authorized_keys');
  const before = md5(target);
  const hook = makeHook({ printMode: true });
  hook.setAsker(null);
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const decision = await hook({
      tool: EXEC_TOOL,
      input: { command: `bash -c 'echo k >> ~/.ssh/authorized_keys'` },
      toolCallId: 'o101-a6',
      sessionKey: 'o101',
    });
    assert.equal(decision.approved, false);
  } finally {
    process.env.HOME = prev;
  }
  assert.equal(md5(target), before);
});

// ── Layer 2: workspace scripts ──────────────────────────────────────────

await check('B-script: python script writing expanduser ~/.ssh is scanned', () => {
  const script = path.join(ws, 'deploy.py');
  fs.writeFileSync(
    script,
    "import os\nopen(os.path.expanduser('~/.ssh/authorized_keys'),'a').write('x')\n"
  );
  const findings = findIndirectProtectedWrites('python3 deploy.py', ws, ws);
  assert.ok(findings.length >= 1, JSON.stringify(findings));
  assert.ok(findings[0].source.script.includes('deploy.py'));
  assert.ok(findings[0].source.line >= 1);
  const h = hits('python3 deploy.py');
  assert.ok(h.length >= 1, `hits=${JSON.stringify(h)}`);
  assert.ok(h[0].source, 'source metadata required for UX');
});

await check('B-script: node script writing .env is scanned', () => {
  const script = path.join(ws, 's.js');
  fs.writeFileSync(script, "require('fs').writeFileSync('.env', 'x')\n");
  const h = hits('node s.js');
  assert.ok(h.length >= 1);
  assert.equal(h[0].source?.kind, 'script');
});

await check('B-script: bash script appending ~/.ssh is scanned', () => {
  const script = path.join(ws, 'x.sh');
  fs.writeFileSync(script, '#!/bin/bash\necho k >> ~/.ssh/authorized_keys\n');
  const h = hits('bash x.sh');
  assert.ok(h.length >= 1);
});

await check('B-ux: headline names script and line', () => {
  const script = path.join(ws, 'deploy2.py');
  fs.writeFileSync(
    script,
    "# header\nimport os\nopen(os.path.expanduser('~/.ssh/authorized_keys'),'a').write('x')\n"
  );
  const h = hits('python3 deploy2.py');
  assert.ok(h.length >= 1);
  const line = protectedPathHeadline(h[0], true);
  assert.match(line, /deploy2\.py/);
  assert.match(line, /第 \d+ 行|authorized_keys/);
});

// ── Layer 3: obfuscation bypass caught post-run ─────────────────────────

await check('C1: obfuscated path write detected by snapshot (layer 3)', () => {
  const before = takeProtectedPathSnapshot(ws, { home });
  // Bypass layers 1–2 with runtime join
  const script = path.join(ws, 'obfuscate.cjs');
  fs.writeFileSync(
    script,
    [
      "const fs=require('node:fs'),path=require('node:path');",
      'const h=process.env.HOME;',
      "const p=path.join(h,'.'+'ssh','authorized_keys');",
      "fs.appendFileSync(p,'BYPASS\\n');",
      '',
    ].join('\n')
  );
  // Confirm layers 1–2 do NOT see a protected literal write API pair clearly
  // (join obfuscation — may or may not hit; layer 3 is the guarantee)
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const result = spawnSync(process.execPath, [script], {
      cwd: ws,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8'), /BYPASS/);
  } finally {
    process.env.HOME = prev;
  }
  const after = takeProtectedPathSnapshotAfter(before, { home });
  const changes = diffProtectedPathSnapshots(before, after);
  assert.ok(
    changes.some((c) => c.path.includes('.ssh') || c.path.includes('authorized_keys')),
    `expected ssh change, got ${JSON.stringify(changes)}`
  );
  const notice = formatProtectedPathModifiedNotice(changes, true, 'node obfuscate.cjs');
  assert.match(notice, /已被修改/);
  assert.doesNotMatch(notice, /已拦截/);
  assert.ok(!notice.includes(PRIVATE_KEY.slice(0, 20)));
  assert.ok(!notice.includes('BYPASS')); // content must not appear
  // full hash must not appear (64 hex of sha256)
  assert.doesNotMatch(notice, /[a-f0-9]{64}/);
});

await check('C2: new .git/hooks/pre-commit detected', () => {
  const before = takeProtectedPathSnapshot(ws, { home });
  const hookPath = path.join(ws, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hookPath, '#!/bin/sh\necho hi\n');
  const after = takeProtectedPathSnapshotAfter(before, { home });
  const changes = diffProtectedPathSnapshots(before, after);
  assert.ok(
    changes.some((c) => c.kind === 'added' && c.path.includes('hooks/pre-commit')),
    JSON.stringify(changes)
  );
});

await check('C3: layer3 + model success claim → incomplete non-zero (O98)', () => {
  const tracker = createRunCompletionTracker();
  const changes = [{ path: '.git/hooks/pre-commit', kind: 'added' }];
  const notice = formatProtectedPathModifiedNotice(changes, true, 'python3 x.py');
  noteRunCompletionEvent(tracker, {
    type: 'tool_start',
    toolCallId: '1',
    toolName: 'exec',
    input: { command: 'python3 x.py' },
  });
  noteRunCompletionEvent(tracker, {
    type: 'tool_end',
    toolCallId: '1',
    toolName: 'exec',
    result: `ok\n${notice}`,
    isError: false,
  });
  assert.ok(tracker.protectedPathChanges?.length >= 1);
  const outcome = resolveRunOutcome({
    tracker,
    finalText: 'All done, everything succeeded.',
    request: 'install the hook',
  });
  assert.equal(outcome.status, 'incomplete');
  assert.notEqual(outcome.exitCode, 0);
  const line = formatOutcomeLine(outcome, 'zh');
  assert.match(line, /未完成/);
  assert.match(line, /受保护路径|修改/);
  assert.doesNotMatch(line, /已拦截/);
});

// ── D. No false positives ───────────────────────────────────────────────

await check('D1: npm test → 0 hits, skip deep scan', () => {
  assert.equal(shouldSkipDeepScan('npm test'), true);
  assert.equal(hits('npm test').length, 0);
});

await check('D2: pytest → 0 hits', () => {
  assert.equal(shouldSkipDeepScan('pytest'), true);
  assert.equal(hits('pytest -q').length, 0);
});

await check('D3: node --test → 0 hits', () => {
  assert.equal(shouldSkipDeepScan('node --test'), true);
  assert.equal(hits('node --test').length, 0);
});

await check('D4: git commit / checkout -b → 0 detection hits after git filter', () => {
  const before = takeProtectedPathSnapshot(ws, { home });
  execFileSync('git', ['checkout', '-qb', 'feature-o101'], { cwd: ws, env: gitEnv });
  fs.writeFileSync(path.join(ws, 'src', 'ok.ts'), 'export const ok = 2;\n');
  execFileSync('git', ['add', 'src/ok.ts'], { cwd: ws, env: gitEnv });
  execFileSync('git', ['commit', '-qm', 'feat'], { cwd: ws, env: gitEnv });
  const after = takeProtectedPathSnapshotAfter(before, { home });
  const raw = diffProtectedPathSnapshots(before, after);
  // Acceptance D: git porcelain must not produce detection hits. Layer 3 watches
  // HEAD/refs but filterExpectedGitMetadataChanges drops those for ordinary git.
  const afterCheckout = filterExpectedGitMetadataChanges('git checkout -b feature-o101', raw);
  const afterCommit = filterExpectedGitMetadataChanges('git commit -qm feat', raw);
  assert.equal(
    afterCheckout.length,
    0,
    `checkout filter should empty: ${JSON.stringify(afterCheckout)} (raw=${JSON.stringify(raw)})`
  );
  assert.equal(
    afterCommit.length,
    0,
    `commit filter should empty: ${JSON.stringify(afterCommit)} (raw=${JSON.stringify(raw)})`
  );
});

await check('D5: approval hook: git commit / npm test → approved without prompt', async () => {
  let asked = 0;
  const hook = makeHook();
  hook.setAsker(async () => {
    asked += 1;
    return 'n';
  });
  for (const command of ['git commit --allow-empty -qm x', 'git checkout -b z', 'npm test']) {
    const d = await hook({
      tool: EXEC_TOOL,
      input: { command },
      toolCallId: 'o101-d5',
      sessionKey: 'o101',
    });
    assert.equal(d.approved, true, command + ' → ' + JSON.stringify(d));
  }
  assert.equal(asked, 0, 'must not prompt');
  setCliApprovalAsker(null);
});

// ── E. No secret leakage ────────────────────────────────────────────────

await check('E: private key / .env value never in notice or outcome', () => {
  const changes = [
    { path: '~/.ssh/id_ed25519', kind: 'modified' },
    { path: '.env', kind: 'modified' },
  ];
  const notice = formatProtectedPathModifiedNotice(changes, false, 'node x.js');
  const reason = protectedPathModReason(changes, 'node x.js');
  const blob = notice + reason.en + reason.zh;
  assert.ok(!blob.includes('SECRETKEYMATERIAL'));
  assert.ok(!blob.includes('super-secret-value'));
  assert.ok(!blob.includes(PRIVATE_KEY.trim()));
  assert.ok(!blob.includes(ENV_SECRET.trim()));
  assert.match(notice, /modified|已被修改/);
});

// ── QA extras ───────────────────────────────────────────────────────────

await check('QA: scan failure outside workspace does not crash', () => {
  const r = scanWorkspaceScript('/etc/passwd', ws, ws);
  assert.equal(r.status, 'outside-workspace');
});

await check('QA: unavailable snapshot does not false-report modified', () => {
  const before = takeProtectedPathSnapshot(ws, { home });
  const after = takeProtectedPathSnapshotAfter(before, { home });
  // Untouched .env must not appear as modified.
  const changes = diffProtectedPathSnapshots(before, after).filter(
    (c) => c.path === '.env' || c.path.endsWith('/.env')
  );
  assert.equal(changes.length, 0);
  // Malicious script changing .env still reports.
  const b2 = takeProtectedPathSnapshot(ws, { home });
  fs.appendFileSync(path.join(ws, '.env'), 'x=1\n');
  const a2 = takeProtectedPathSnapshotAfter(b2, { home });
  const ch2 = diffProtectedPathSnapshots(b2, a2);
  assert.ok(ch2.some((c) => c.path.includes('.env')));
});

await check('QA: marker parse roundtrip', () => {
  const changes = [{ path: '.git/hooks/pre-commit', kind: 'added' }];
  const notice = formatProtectedPathModifiedNotice(changes, true);
  assert.ok(notice.includes(PROTECTED_PATH_MOD_MARKER));
  const parsed = parseProtectedPathModMarker(notice);
  assert.ok(parsed?.some((p) => p.path.includes('pre-commit')));
});

await check('overhead: snapshot pair < 50ms on fixture (target ≤20ms typical)', () => {
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) {
    const b = takeProtectedPathSnapshot(ws, { home });
    const a = takeProtectedPathSnapshotAfter(b, { home });
    diffProtectedPathSnapshots(b, a);
  }
  const avg = (Date.now() - t0) / 20;
  console.log(`# snapshot pair avg ${avg.toFixed(2)}ms`);
  assert.ok(avg < 50, `avg ${avg}ms too slow`);
});

await check('listInvokedScripts finds python/node/bash files', () => {
  assert.deepEqual(listInvokedScripts('python3 deploy.py'), ['deploy.py']);
  assert.deepEqual(listInvokedScripts('node s.js'), ['s.js']);
  assert.deepEqual(listInvokedScripts('bash x.sh'), ['x.sh']);
  assert.deepEqual(listInvokedScripts('python3 -c "print(1)"'), []);
});

console.log(`# tests done, failures=${failures}`);
if (failures > 0) process.exit(1);
console.log('# pass');
