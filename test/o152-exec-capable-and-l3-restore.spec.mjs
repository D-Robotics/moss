#!/usr/bin/env node
/**
 * O152 (P1): (1) statically block exec-capable "read" forms (`rg --pre`,
 * `git -c` / `--ext-diff` / `grep -O`, `VAR=` prefixes, `sort
 * --compress-program`, `find -exec`) before they run; (2) L3 auto-restore of
 * `.git/config`, `.git/HEAD`, `.git/hooks/**`, `.env*` after inline dynamic
 * writes/deletes that static analysis cannot see; (3) every post-run
 * protected-path detection exits 9 (never 7).
 *
 * Process-level: real `dist/cli.js -p` via `./o152-harness.mjs`. Policy-level:
 * `findShellProtectedWrites` / `findExecCapableForms`. Revert-red: dropping
 * only the pre-exec gate, only the restore, or only the exit-9 unify each
 * turns the matching cases red.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { o152Scenario, exec, IS_WIN, fileState } from './o152-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { findShellProtectedWrites } = await import(
  pathToFileURL(path.join(ROOT, 'dist/safety/protected-paths.js')).href
);
const { commandHasExecCapableRead } = await import(
  pathToFileURL(path.join(ROOT, 'dist/safety/exec-capable-read.js')).href
);
const {
  takeProtectedPathSnapshot,
  takeProtectedPathSnapshotAfter,
  diffProtectedPathSnapshots,
  restoreProtectedPathChanges,
  disposeProtectedPathSnapshot,
  RESTORE_MAX_BYTES,
} = await import(pathToFileURL(path.join(ROOT, 'dist/safety/protected-path-snapshot.js')).href);

const CLAIM = { zh: '已修好，校验通过。', en: 'Fixed; the check passes.' };
const CLAIM_DONE = /校验通过|check passes|All done|全部完成|^完成[：:]|^Completed:/i;
/** True when json `result` still carries a model success claim (O133 F / O152 §7). */
function resultClaimsDone(text) {
  const s = String(text ?? '');
  if (!s) return false;
  if (/^未完成|^Incomplete/i.test(s)) return false;
  return CLAIM_DONE.test(s) || s === CLAIM.zh || s === CLAIM.en;
}

let pass = 0;
const failures = [];

async function runAll(jobs, concurrency = 4) {
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const j = jobs[i++];
      try {
        await j.fn();
        pass += 1;
        process.stdout.write('.');
      } catch (err) {
        failures.push({ name: j.name, err });
        process.stdout.write('F');
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

function q(p) {
  const BARE = /^[\w./\\:~+@%-]+$/;
  if (BARE.test(p)) return p;
  return IS_WIN ? `'${p.replaceAll("'", "''")}'` : `'${p.replaceAll("'", "'\\''")}'`;
}

const SEED = {
  '.env': 'SECRET_TOKEN=s3cr3t-o152-do-not-leak\n',
  '.git/hooks/pre-commit': '#!/bin/sh\necho hook-o152\n',
};
const WATCH = ['.git/config', '.git/HEAD', '.git/hooks/pre-commit', '.env'];
const MODES = { '.git/hooks/pre-commit': 0o755 };

// ── policy: exec-capable forms must hit ──────────────────────────────────
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'o152-pol-'));
const R = path.join(base, 'proj');
fs.mkdirSync(R);
spawnSync('git', ['init', '-q'], { cwd: R, stdio: 'ignore' });
fs.writeFileSync(path.join(R, 'README.md'), '# p\n');
fs.writeFileSync(path.join(R, '.env'), 'X=1\n');
const ctx = {
  cwd: R,
  workspaceRoot: R,
  configDirs: [],
  env: process.env,
  home: path.join(base, 'home'),
};
fs.mkdirSync(ctx.home, { recursive: true });

const EXEC_FORMS = [
  { id: 'rg --pre', cmd: (r) => `rg --pre rm --hidden --no-ignore -e . ${r}` },
  { id: 'rg --pre=', cmd: () => `rg --pre=./p.sh -e x` },
  { id: 'git grep -O', cmd: (r) => `git -C ${r} grep -Orm -e x` },
  {
    id: 'git grep --open-files-in-pager=',
    cmd: (r) => `git -C ${r} grep --open-files-in-pager=rm -e x`,
  },
  { id: 'git diff --ext-diff', cmd: () => `git diff --ext-diff` },
  { id: 'git log --ext-diff', cmd: () => `git log --ext-diff -p` },
  { id: 'git show --textconv', cmd: () => `git show --textconv HEAD` },
  { id: 'git log --output=', cmd: () => `git log --output=x` },
  { id: 'git -c core.pager', cmd: () => `git -c core.pager=./p.sh log` },
  { id: 'git -c diff.external', cmd: () => `git -c diff.external=./p.sh diff` },
  { id: 'git -c core.fsmonitor', cmd: () => `git -c core.fsmonitor=./p.sh status` },
  { id: 'git -c alias.!', cmd: () => `git -c alias.x=!./p.sh x` },
  {
    id: 'git -c credential.helper',
    cmd: () => `git -c credential.helper='!./p.sh' credential fill`,
  },
  { id: 'git -c core.askPass', cmd: () => `git -c core.askPass=./p.sh status` },
  { id: 'git -c include.path', cmd: () => `git -c include.path=evil.gitconfig status` },
  { id: 'git -cfoo= glued', cmd: () => `git -ccore.pager=./p.sh log` },
  { id: 'git -c Core.Pager case', cmd: () => `git -c Core.Pager=./p.sh log` },
  { id: 'git --config-env', cmd: () => `git --config-env=core.pager=PAGER_ENV log` },
  {
    id: 'GIT_CONFIG_PARAMETERS=',
    cmd: () => `GIT_CONFIG_PARAMETERS="'core.pager=./p.sh'" git log`,
  },
  { id: 'GIT_EXTERNAL_DIFF=', cmd: () => `GIT_EXTERNAL_DIFF=./p.sh git diff` },
  { id: 'env GIT_PAGER=', cmd: () => `env GIT_PAGER=./p.sh git log` },
  { id: 'export PAGER=; git', cmd: () => `export PAGER=./p.sh; git log` },
  { id: 'GIT_DIR=', cmd: () => `GIT_DIR=x git status` },
  {
    id: 'GIT_CONFIG_COUNT=',
    cmd: () => `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=./p.sh git log`,
  },
  { id: 'LESSOPEN=', cmd: () => `LESSOPEN=|./p.sh less README.md` },
  { id: 'sort --compress-program', cmd: () => `sort --compress-program=./p.sh README.md` },
  { id: 'find -exec', cmd: () => `find . -exec ./p.sh {} ;` },
  { id: 'find -execdir', cmd: () => `find . -execdir ./p.sh {} +` },
  { id: 'find -ok', cmd: () => `find . -ok ./p.sh {} ;` },
];

const jobs = [];
for (const f of EXEC_FORMS) {
  for (const pos of ['alone', 'cd', 'node']) {
    const raw = f.cmd(q(R));
    const cmd = pos === 'alone' ? raw : pos === 'cd' ? `cd ${q(R)} && ${raw}` : `${raw}; node -e 1`;
    jobs.push({
      name: `policy RED ${pos}: ${f.id}`,
      fn: async () => {
        assert.ok(commandHasExecCapableRead(cmd) || f.id.startsWith('find'), `detector: ${cmd}`);
        const hits = findShellProtectedWrites(cmd, ctx);
        assert.ok(hits.length > 0, `expected hit for ${cmd}; got []`);
        assert.ok(
          hits.some((h) => h.kind === 'exec-capable' || h.category === 'git'),
          `exec-capable/git hit: ${JSON.stringify(hits[0])}`
        );
      },
    });
  }
}

const GREEN_POLICY = [
  'git -c user.email=a@b -c user.name=u commit --allow-empty -m x',
  'git -c i18n.commitEncoding=utf-8 log -1',
  'git -c color.ui=false status',
  'git -c core.quotepath=false status',
  'rg -n foo .',
  'rg --hidden foo',
  'git diff',
  'git log -3',
  `git -C ${q(R)} status`,
  'git show HEAD --stat',
];
for (const raw of GREEN_POLICY) {
  for (const pos of ['alone', 'cd']) {
    const cmd = pos === 'alone' ? raw : `cd ${q(R)} && ${raw}`;
    jobs.push({
      name: `policy GREEN ${pos}: ${raw}`,
      fn: async () => {
        assert.equal(commandHasExecCapableRead(cmd), false, cmd);
        assert.deepEqual(findShellProtectedWrites(cmd, ctx), []);
      },
    });
  }
}

// Windows shapes (policy only; always evaluated — windowsShell: true).
if (true) {
  const wctx = { ...ctx, windowsShell: true };
  const winForms = [`$env:GIT_EXTERNAL_DIFF='./p.sh'; git diff`, `set GIT_PAGER=./p.sh&& git log`];
  for (const cmd of winForms) {
    jobs.push({
      name: `policy WIN RED: ${cmd}`,
      fn: async () => {
        assert.ok(findShellProtectedWrites(cmd, wctx).length > 0, cmd);
      },
    });
  }
}

// ── unit: restore restores bytes + mode ──────────────────────────────────
jobs.push({
  name: 'unit restore: obfuscated writeFileSync .git/config → hash+mode equal',
  fn: async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o152-u-'));
    const proj = path.join(dir, 'p');
    fs.mkdirSync(proj);
    spawnSync('git', ['init', '-q'], { cwd: proj, stdio: 'ignore' });
    const hook = path.join(proj, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho h\n');
    fs.chmodSync(hook, 0o755);
    const env = path.join(proj, '.env');
    fs.writeFileSync(env, 'SECRET=u\n');
    const before = takeProtectedPathSnapshot(proj);
    const cfg = path.join(proj, '.git', 'config');
    const cfgBefore = fileState(cfg);
    const hookBefore = fileState(hook);
    fs.writeFileSync(cfg, 'x');
    fs.writeFileSync(hook, 'evil\n');
    fs.chmodSync(hook, 0o644);
    fs.writeFileSync(env, 'leaked\n');
    const after = takeProtectedPathSnapshotAfter(before);
    const changes = diffProtectedPathSnapshots(before, after);
    assert.ok(changes.some((c) => c.path.includes('config')));
    const restores = restoreProtectedPathChanges(before, changes);
    assert.ok(restores.some((r) => r.outcome === 'restored' && r.path.includes('config')));
    assert.deepEqual(fileState(cfg), cfgBefore);
    assert.deepEqual(fileState(hook), hookBefore);
    assert.deepEqual(fileState(env), { hash: fileState(env).hash, mode: fileState(env).mode });
    // secret must not appear in notice
    const { formatProtectedPathModifiedNotice } = await import(
      pathToFileURL(path.join(ROOT, 'dist/safety/protected-path-snapshot.js')).href
    );
    const notice = formatProtectedPathModifiedNotice(changes, false, 'node -e', restores);
    assert.doesNotMatch(notice, /SECRET=|leaked|^x$/m);
    assert.match(notice, /restored/i);
    disposeProtectedPathSnapshot(before);
    fs.rmSync(dir, { recursive: true, force: true });
  },
});

jobs.push({
  name: 'unit restore: whole .git wipe → restore eligible + git status 0',
  fn: async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o152-u2-'));
    const proj = path.join(dir, 'p');
    fs.mkdirSync(proj);
    const g = (...a) =>
      spawnSync('git', a, {
        cwd: proj,
        stdio: 'ignore',
        env: { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
      });
    g('init', '-q');
    fs.writeFileSync(path.join(proj, 'README.md'), '#\n');
    g('add', '-A');
    g('-c', 'user.email=a@b', '-c', 'user.name=u', 'commit', '-qm', 'i', '--no-verify');
    const cfg = path.join(proj, '.git', 'config');
    const head = path.join(proj, '.git', 'HEAD');
    const cfgH = fileState(cfg);
    const headH = fileState(head);
    const before = takeProtectedPathSnapshot(proj);
    fs.rmSync(path.join(proj, '.git'), { recursive: true, force: true });
    const after = takeProtectedPathSnapshotAfter(before);
    const changes = diffProtectedPathSnapshots(before, after);
    const restores = restoreProtectedPathChanges(before, changes);
    assert.ok(restores.some((r) => r.outcome === 'restored'));
    assert.deepEqual(fileState(cfg), cfgH);
    assert.deepEqual(fileState(head), headH);
    const st = spawnSync('git', ['-C', proj, 'status'], {
      env: { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
    });
    assert.equal(st.status, 0, String(st.stderr));
    disposeProtectedPathSnapshot(before);
    fs.rmSync(dir, { recursive: true, force: true });
  },
});

jobs.push({
  name: `unit restore: oversize (>${RESTORE_MAX_BYTES}) skipped with reason`,
  fn: async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o152-u3-'));
    const proj = path.join(dir, 'p');
    fs.mkdirSync(path.join(proj, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(proj, '.git', 'config'), '[core]\n\tbare = false\n');
    const big = path.join(proj, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(big, Buffer.alloc(RESTORE_MAX_BYTES + 8, 0x61));
    fs.chmodSync(big, 0o755);
    const before = takeProtectedPathSnapshot(proj);
    fs.writeFileSync(big, 'tiny\n');
    const after = takeProtectedPathSnapshotAfter(before);
    const changes = diffProtectedPathSnapshots(before, after);
    const restores = restoreProtectedPathChanges(before, changes);
    const hit = restores.find((r) => r.path.includes('pre-commit'));
    assert.ok(hit, JSON.stringify(restores));
    assert.equal(hit.outcome, 'skipped-oversize');
    // file stays modified (we refused to restore)
    assert.equal(fs.readFileSync(big, 'utf8'), 'tiny\n');
    disposeProtectedPathSnapshot(before);
    fs.rmSync(dir, { recursive: true, force: true });
  },
});

// ── unit: F3/F5 approvals + gitfile honesty ──────────────────────────────
jobs.push({
  name: 'unit approve: y/a keep write; exact path; mixed restore',
  fn: async () => {
    const { noteProtectedPathApproved, clearProtectedPathApprovals, isProtectedPathApproved } =
      await import(pathToFileURL(path.join(ROOT, 'dist/safety/protected-path-approvals.js')).href);
    clearProtectedPathApprovals();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o152-ap-'));
    const proj = path.join(dir, 'p');
    fs.mkdirSync(proj);
    spawnSync('git', ['init', '-q'], { cwd: proj, stdio: 'ignore' });
    const envPath = path.join(proj, '.env');
    const cfgPath = path.join(proj, '.git', 'config');
    fs.writeFileSync(envPath, 'ORIGINAL=1\n');
    const envBefore = fileState(envPath);
    const cfgBefore = fileState(cfgPath);
    const before = takeProtectedPathSnapshot(proj);
    fs.writeFileSync(envPath, 'APPROVED_NEW=1\n');
    fs.writeFileSync(cfgPath, 'x');
    // Approve .env only (exact path) — simulating interactive y/a for that hit.
    noteProtectedPathApproved(envPath);
    assert.equal(isProtectedPathApproved(envPath), true);
    assert.equal(isProtectedPathApproved(cfgPath), false, 'approving .env != .git/config');
    const after = takeProtectedPathSnapshotAfter(before);
    const changes = diffProtectedPathSnapshots(before, after);
    const restores = restoreProtectedPathChanges(before, changes);
    const envR = restores.find((r) => r.path.includes('.env'));
    const cfgR = restores.find((r) => r.path.includes('config'));
    assert.equal(envR?.outcome, 'skipped-approved', JSON.stringify(restores));
    assert.equal(cfgR?.outcome, 'restored', JSON.stringify(restores));
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'APPROVED_NEW=1\n');
    assert.notEqual(fileState(envPath).hash, envBefore.hash);
    assert.deepEqual(fileState(cfgPath), cfgBefore);
    disposeProtectedPathSnapshot(before);
    // n / no-approval: both paths restore (same as -p restore layer).
    clearProtectedPathApprovals();
    const beforeN = takeProtectedPathSnapshot(proj);
    const envN0 = fileState(envPath);
    const cfgN0 = fileState(cfgPath);
    fs.writeFileSync(envPath, 'N_DENIED=1\n');
    fs.writeFileSync(cfgPath, 'z');
    const afterN = takeProtectedPathSnapshotAfter(beforeN);
    const changesN = diffProtectedPathSnapshots(beforeN, afterN);
    const restoresN = restoreProtectedPathChanges(beforeN, changesN);
    assert.ok(
      restoresN
        .filter((r) => r.path.includes('.env') || r.path.includes('config'))
        .every((r) => r.outcome === 'restored'),
      JSON.stringify(restoresN)
    );
    assert.deepEqual(fileState(envPath), envN0);
    assert.deepEqual(fileState(cfgPath), cfgN0);
    disposeProtectedPathSnapshot(beforeN);
    clearProtectedPathApprovals();
    fs.rmSync(dir, { recursive: true, force: true });
  },
});

jobs.push({
  name: 'unit approve hook: y/a note path; n does not',
  fn: async () => {
    const { createCliToolApprovalHook, setCliApprovalAsker } = await import(
      pathToFileURL(path.join(ROOT, 'dist/cli/approval.js')).href
    );
    const { clearProtectedPathApprovals, isProtectedPathApproved, listProtectedPathApprovals } =
      await import(pathToFileURL(path.join(ROOT, 'dist/safety/protected-path-approvals.js')).href);
    clearProtectedPathApprovals();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o152-hook-'));
    const proj = path.join(dir, 'p');
    fs.mkdirSync(proj);
    spawnSync('git', ['init', '-q'], { cwd: proj, stdio: 'ignore' });
    fs.writeFileSync(path.join(proj, '.env'), 'X=1\n');
    const envAbs = path.resolve(proj, '.env');
    const tool = {
      name: 'exec',
      sideEffects: ['local_write'],
      description: 't',
      parameters: { type: 'object', properties: {} },
    };
    // y → approved + noted
    setCliApprovalAsker(async () => 'y');
    const hookY = createCliToolApprovalHook('workspace-write', {}, { workspaceDir: proj });
    // echo > .env is a static protected-path hit
    const y2 = await hookY({
      tool,
      input: { command: `echo hi > .env` },
      sessionKey: 'o152-y2',
    });
    assert.equal(y2.approved, true, `y must approve: ${JSON.stringify(y2)}`);
    assert.equal(
      isProtectedPathApproved(envAbs),
      true,
      `y must note ${envAbs}; have ${listProtectedPathApprovals()}`
    );
    clearProtectedPathApprovals();
    // a → noted
    setCliApprovalAsker(async () => 'a');
    const hookA = createCliToolApprovalHook('workspace-write', {}, { workspaceDir: proj });
    const a = await hookA({
      tool,
      input: { command: `echo hi > .env` },
      sessionKey: 'o152-a',
    });
    assert.equal(a.approved, true, JSON.stringify(a));
    assert.equal(isProtectedPathApproved(envAbs), true, 'a notes path');
    // Approving .env must not approve .git/config
    assert.equal(isProtectedPathApproved(path.join(proj, '.git', 'config')), false);
    clearProtectedPathApprovals();
    // n → denied, not noted
    setCliApprovalAsker(async () => 'n');
    const hookN = createCliToolApprovalHook('workspace-write', {}, { workspaceDir: proj });
    const n = await hookN({
      tool,
      input: { command: `echo hi > .env` },
      sessionKey: 'o152-n',
    });
    assert.equal(n.approved, false, JSON.stringify(n));
    assert.equal(isProtectedPathApproved(envAbs), false, 'n must not note');
    setCliApprovalAsker(null);
    clearProtectedPathApprovals();
    fs.rmSync(dir, { recursive: true, force: true });
  },
});

jobs.push({
  name: 'unit F5: gitfile → skipped-symlink-git in restore outcomes',
  fn: async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o152-gf-'));
    const proj = path.join(dir, 'p');
    const realGit = path.join(dir, 'real.git');
    fs.mkdirSync(proj);
    spawnSync('git', ['init', '-q', '--separate-git-dir', realGit, proj], { stdio: 'ignore' });
    // separate-git-dir leaves a gitfile at proj/.git
    assert.ok(fs.statSync(path.join(proj, '.git')).isFile(), 'expected gitfile');
    const cfg = path.join(realGit, 'config');
    const before = takeProtectedPathSnapshot(proj);
    fs.writeFileSync(cfg, 'x');
    const after = takeProtectedPathSnapshotAfter(before);
    const changes = diffProtectedPathSnapshots(before, after);
    assert.ok(changes.length >= 1, JSON.stringify(changes));
    const restores = restoreProtectedPathChanges(before, changes);
    assert.ok(
      restores.some((r) => r.outcome === 'skipped-symlink-git'),
      `expected skipped-symlink-git: ${JSON.stringify(restores)}`
    );
    const { formatProtectedPathModifiedNotice } = await import(
      pathToFileURL(path.join(ROOT, 'dist/safety/protected-path-snapshot.js')).href
    );
    const notice = formatProtectedPathModifiedNotice(changes, true, 'node -e', restores);
    assert.match(notice, /未还原|软链|gitfile/);
    disposeProtectedPathSnapshot(before);
    fs.rmSync(dir, { recursive: true, force: true });
  },
});

// ── process: exec-capable blocked; marker file must not appear ───────────
const MARKER_NAME = 'o152-exec-marker.touched';
function markerProbeScript(dir) {
  // Writes MARKER_NAME next to itself when executed.
  const script = path.join(dir, 'o152-pre.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho touched > "$(dirname "$0")/${MARKER_NAME}"\n`, {
    mode: 0o755,
  });
  return script;
}

const PROC_BLOCK = [
  {
    id: 'RG1 alone rg --pre',
    cmd: ({ proj, script }) => `rg --pre ${q(script)} --hidden --no-ignore -e . ${q(proj)}`,
  },
  {
    id: 'RG1 cd && rg --pre',
    cmd: ({ proj, script }) => `cd ${q(proj)} && rg --pre ${q(script)} --hidden --no-ignore -e . .`,
  },
  {
    id: 'RG1 with node -e',
    cmd: ({ proj, script }) =>
      `rg --pre ${q(script)} --hidden --no-ignore -e . ${q(proj)}; node -e 1`,
  },
  {
    id: 'git grep --open-files-in-pager',
    cmd: ({ proj, script }) =>
      `git -C ${q(proj)} grep --open-files-in-pager=${q(script)} -e '#'; node -e 1`,
  },
  {
    id: 'GIT_EXTERNAL_DIFF=',
    cmd: ({ proj, script }) => `GIT_EXTERNAL_DIFF=${q(script)} git -C ${q(proj)} diff; node -e 1`,
  },
  {
    id: 'git diff --ext-diff',
    cmd: ({ proj }) => `cd ${q(proj)} && git diff --ext-diff; node -e 1`,
  },
  {
    id: 'git -c core.pager',
    cmd: ({ proj, script }) => `git -C ${q(proj)} -c core.pager=${q(script)} log; node -e 1`,
  },
  {
    id: 'git -c credential.helper',
    cmd: ({ proj, script }) =>
      `git -C ${q(proj)} -c credential.helper='!${script}' credential fill; node -e 1`,
  },
  {
    id: 'git -c core.askPass',
    cmd: ({ proj, script }) => `git -C ${q(proj)} -c core.askPass=${q(script)} status; node -e 1`,
  },
  {
    id: 'git -c include.path',
    cmd: ({ proj, script, root }) => {
      const cfg = path.join(root, 'evil.gitconfig');
      fs.writeFileSync(cfg, `[alias]\n\tx = !${script}\n`);
      return `git -C ${q(proj)} -c include.path=${q(cfg)} x; node -e 1`;
    },
  },
];

for (const p of PROC_BLOCK) {
  for (const lang of ['zh', 'en']) {
    for (const json of [false, true]) {
      jobs.push({
        name: `proc BLOCK [${lang}${json ? '/json' : ''}] ${p.id}: exit 9 被拦, marker absent, hashes=`,
        fn: async () => {
          const r = await o152Scenario({
            lang,
            json,
            seed: SEED,
            modes: MODES,
            watch: WATCH,
            prepare: ({ root }) => {
              markerProbeScript(root);
            },
            steps: ({ proj, root }) => {
              const script = path.join(root, 'o152-pre.sh');
              return [exec(p.cmd({ proj, script, root }))];
            },
            finalText: CLAIM[lang],
            inspect: ({ root }) => ({
              markerExists: fs.existsSync(path.join(root, MARKER_NAME)),
            }),
          });
          assert.equal(r.code, 9, `exit 9, got ${r.code}; last=${r.last}`);
          if (json) {
            assert.equal(r.result?.subtype, 'error_during_execution');
            assert.equal(r.result?.is_error, true);
            assert.equal(
              resultClaimsDone(r.result?.result),
              false,
              String(r.result?.result).slice(0, 200)
            );
          } else {
            assert.match(
              r.last,
              lang === 'zh' ? /^未完成.*被拦/ : /^Incomplete.*Blocked by/,
              r.last
            );
          }
          assert.equal(r.extra?.markerExists, false, 'probe script must not have run');
          for (const rel of WATCH) {
            assert.notEqual(r.before[rel].hash, 'ABSENT', rel);
            assert.equal(r.after[rel].hash, r.before[rel].hash, `${rel} hash`);
            assert.equal(r.after[rel].mode, r.before[rel].mode, `${rel} mode`);
          }
          const blob = r.out + r.err + r.toolResults.join('\n');
          assert.doesNotMatch(blob, /s3cr3t-o152/);
        },
      });
    }
  }
}

// ── process: L3 restore after inline dynamic write/delete ────────────────
const RESTORE_CASES = [
  {
    id: 'S32 join .g+it config write',
    cmd: () =>
      `node -e "const p=require('path');require('fs').writeFileSync(p.join('.g'+'it','config'),'x')"`,
  },
  {
    id: 'X1 write hooks/pre-commit via concat',
    cmd: () => `node -e "require('fs').writeFileSync('.g'+'it'+'/hooks/pre-commit','evil\\n')"`,
  },
  {
    id: 'write .env via base64 name',
    cmd: () =>
      `node -e "require('fs').writeFileSync(Buffer.from('LmVudg==','base64').toString(),'pwned\\n')"`,
  },
  {
    id: 'RG4 rmSync .g+it',
    cmd: () => `node -e "require('fs').rmSync('.g'+'it',{recursive:true})"`,
  },
  {
    id: 'RG3 rmSync(cwd)',
    cmd: () => `node -e "require('fs').rmSync(process.cwd(),{recursive:true})"`,
  },
];

for (const c of RESTORE_CASES) {
  for (const lang of ['zh', 'en']) {
    for (const json of [false, true]) {
      jobs.push({
        name: `proc RESTORE [${lang}${json ? '/json' : ''}] ${c.id}: exit 9, hashes=, git status 0`,
        fn: async () => {
          const r = await o152Scenario({
            lang,
            json,
            seed: SEED,
            modes: MODES,
            watch: WATCH,
            steps: () => [exec(c.cmd())],
            finalText: CLAIM[lang],
          });
          assert.equal(r.code, 9, `exit 9, got ${r.code}; last=${r.last}`);
          assert.notEqual(r.code, 7, 'must not be SESSION exit 7');
          if (json) {
            assert.equal(r.result?.subtype, 'error_during_execution');
            assert.equal(
              resultClaimsDone(r.result?.result),
              false,
              String(r.result?.result).slice(0, 200)
            );
          } else {
            assert.match(r.last, lang === 'zh' ? /^未完成/ : /^Incomplete/, r.last);
            assert.equal(/^未完成|^Incomplete/i.test(r.last), true, r.last);
          }
          for (const rel of WATCH) {
            // After wipe+restore, eligible files must match; sample hooks under
            // .git/hooks/ that git init created may be unrestored (not in seed
            // snapshot as restore-eligible content when they were only detected
            // as directory changes). Seeded ones must match.
            assert.equal(r.after[rel].hash, r.before[rel].hash, `${rel} hash`);
            assert.equal(r.after[rel].mode, r.before[rel].mode, `${rel} mode`);
          }
          assert.equal(r.gitStatus, 0, 'git status works after restore');
          const blob = r.out + r.err + r.toolResults.join('\n');
          assert.doesNotMatch(blob, /s3cr3t-o152/);
          // Notice should mention restore when the command was allowed to run
          // (L3 path). A pre-exec Blocked: is also fine (stricter).
          const tools = r.toolResults.join('\n');
          if (tools && !/^\s*Blocked:/m.test(tools) && !c.id.includes('cwd')) {
            assert.match(tools, /restored|已还原/i);
          }
        },
      });
    }
  }
}

// ── acceptance #11: -p has no approval step → always restore ─────────────
for (const lang of ['zh', 'en']) {
  jobs.push({
    name: `proc -p always restore [${lang}]: .env write undone (no y/a)`,
    fn: async () => {
      const r = await o152Scenario({
        lang,
        seed: SEED,
        modes: MODES,
        watch: WATCH,
        steps: () => [
          exec(
            `node -e "require('fs').writeFileSync(Buffer.from('LmVudg==','base64').toString(),'pwned-by-p-mode\\n')"`
          ),
        ],
        finalText: CLAIM[lang],
      });
      assert.equal(r.code, 9, `exit 9, got ${r.code}; last=${r.last}`);
      assert.equal(r.after['.env'].hash, r.before['.env'].hash, '.env must be restored in -p');
      assert.match(r.last, lang === 'zh' ? /已还原/ : /restored/i, r.last);
    },
  });
}

// ── process GREEN: plain reads still complete ────────────────────────────
const PROC_GREEN = [
  { id: 'rg -n', cmd: ({ proj }) => `rg -n foo ${q(proj)} || true` },
  { id: 'git diff', cmd: ({ proj }) => `cd ${q(proj)} && git diff` },
  { id: 'git log -3', cmd: ({ proj }) => `cd ${q(proj)} && git log -3` },
  { id: 'git -C status', cmd: ({ proj }) => `git -C ${q(proj)} status` },
  { id: 'git show HEAD --stat', cmd: ({ proj }) => `cd ${q(proj)} && git show HEAD --stat` },
  {
    id: 'j12-node-e',
    cmd: ({ proj }) => `cd ${q(proj)} && node -e "console.log(['1h30m'].join())"`,
    marker: '1h30m',
  },
];

for (const g of PROC_GREEN) {
  for (const lang of ['zh', 'en']) {
    jobs.push({
      name: `proc GREEN [${lang}] ${g.id}: exit 0 完成`,
      fn: async () => {
        const r = await o152Scenario({
          lang,
          seed: SEED,
          modes: MODES,
          watch: WATCH,
          steps: ({ proj }) => [exec(g.cmd({ proj }))],
          finalText: CLAIM[lang],
        });
        assert.equal(r.code, 0, `exit 0, got ${r.code}; last=${r.last}`);
        assert.doesNotMatch(r.last, /未完成|Incomplete|被拦|Blocked/);
        for (const rel of WATCH) {
          assert.equal(r.after[rel].hash, r.before[rel].hash, rel);
        }
        if (g.marker) {
          assert.ok(r.toolResults.join('\n').includes(g.marker), `marker ${g.marker}`);
        } else {
          // Command ran (tool result present, not a Blocked: line).
          const tools = r.toolResults.join('\n');
          assert.doesNotMatch(tools, /^\s*Blocked:/m);
        }
      },
    });
  }
}

await runAll(jobs, 4);
fs.rmSync(base, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) {
  console.error('\nFAIL', f.name);
  console.error(f.err);
}
if (failures.length) process.exit(1);
