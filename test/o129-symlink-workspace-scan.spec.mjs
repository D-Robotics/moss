#!/usr/bin/env node
/**
 * O129: Layer 2 script scan and protected-ancestor anchors must compare
 * realpath to realpath. Self-created symlinks, so it runs on Linux/macOS
 * (macOS CI additionally has /var → /private/var under os.tmpdir()).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const load = (rel) => import(pathToFileURL(path.join(distRoot, rel)).href);
const { findIndirectProtectedWrites, scanWorkspaceScript } = await load(
  'safety/indirect-write-detect.js'
);
const { findProtectedPathHits } = await load('safety/protected-paths.js');
const { protectedPathHeadline } = await load('cli/protected-path-prompt.js');

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`ok - ${label}`);
  } catch (err) {
    failures += 1;
    console.log(`not ok - ${label}: ${err?.message ?? err}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o129-'));
const realWs = path.join(root, 'real-ws');
const linkWs = path.join(root, 'link-ws');
const realHome = path.join(root, 'real-home');
const linkHome = path.join(root, 'link-home');
fs.mkdirSync(realWs, { recursive: true });
fs.mkdirSync(path.join(realHome, '.ssh'), { recursive: true });
let canSymlink = true;
try {
  fs.symlinkSync(realWs, linkWs, process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(realHome, linkHome, process.platform === 'win32' ? 'junction' : 'dir');
} catch {
  canSymlink = false;
}

const SSH_PY = "import os\nopen(os.path.expanduser('~/.ssh/authorized_keys'),'a').write('x')\n";
fs.writeFileSync(path.join(realWs, 'deploy.py'), SSH_PY);
fs.writeFileSync(path.join(realWs, 'env.js'), "require('fs').writeFileSync('.env', 'x')\n");

const ctxFor = (ws, home) => ({
  cwd: ws,
  home,
  workspaceRoot: ws,
  configDirs: [path.join(home, '.config', 'moss')],
  env: { HOME: home, PATH: process.env.PATH },
});

if (!canSymlink) {
  console.log('# skip: cannot create symlinks on this host');
} else {
  await check('workspace via symlink: script scanned (not outside-workspace)', () => {
    const r = scanWorkspaceScript('deploy.py', linkWs, linkWs);
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.ok(r.findings.length >= 1);
    assert.ok(findIndirectProtectedWrites('python3 deploy.py', linkWs, linkWs).length >= 1);
  });

  await check('workspace via symlink: exec hits for ~/.ssh and .env', () => {
    const ctx = ctxFor(linkWs, realHome);
    assert.ok(
      findProtectedPathHits('exec', { command: 'python3 deploy.py' }, ctx, false).length >= 1
    );
    const h = findProtectedPathHits('exec', { command: 'node env.js' }, ctx, false);
    assert.ok(h.length >= 1);
    assert.equal(h[0].source?.kind, 'script');
  });

  await check('reverse: real workspace, script reached via symlink into it', () => {
    const r = scanWorkspaceScript(path.join(linkWs, 'deploy.py'), realWs, realWs);
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.ok(
      findIndirectProtectedWrites(`python3 ${path.join(linkWs, 'deploy.py')}`, realWs, realWs)
        .length >= 1
    );
  });

  await check('HOME is a symlink: script writing ~/.ssh is a hit', () => {
    const h = findProtectedPathHits(
      'exec',
      { command: 'python3 deploy.py' },
      ctxFor(realWs, linkHome),
      false
    );
    assert.ok(h.length >= 1, JSON.stringify(h));
  });

  await check('HOME is a symlink: rm -rf of realpath HOME hits ssh anchor', () => {
    const h = findProtectedPathHits(
      'exec',
      { command: `rm -rf ${realHome}` },
      ctxFor(realWs, linkHome),
      false
    );
    assert.ok(
      h.some((x) => x.category === 'ssh'),
      JSON.stringify(h)
    );
  });

  await check('workspace symlink: rm -rf of realpath workspace hits git anchor', () => {
    const h = findProtectedPathHits(
      'exec',
      { command: `rm -rf ${realWs}` },
      ctxFor(linkWs, realHome),
      false
    );
    assert.ok(
      h.some((x) => x.category === 'git'),
      JSON.stringify(h)
    );
  });
}

await check('realpath failure (missing workspace): script still scanned, uncertain', () => {
  const missingWs = path.join(root, 'does-not-exist');
  const script = path.join(realWs, 'deploy.py');
  const r = scanWorkspaceScript(script, missingWs, missingWs);
  assert.ok(r.findings.length >= 1, JSON.stringify(r));
  assert.ok(r.findings.every((f) => f.uncertain === true));
  const f = findIndirectProtectedWrites(`python3 ${script}`, missingWs, missingWs);
  assert.ok(f.length >= 1 && f.every((x) => x.uncertain === true));
});

await check('existing script outside workspace: scanned read-only, uncertain, not silent', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'o129-out-'));
  const script = path.join(other, 'x.py');
  fs.writeFileSync(script, SSH_PY);
  const f = findIndirectProtectedWrites(`python3 ${script}`, realWs, realWs);
  assert.ok(f.length >= 1, 'outside script with ~/.ssh write must not be silent 0');
  assert.ok(f.every((x) => x.uncertain === true));
});

await check('EACCES script outside workspace: not silent when command names protected path', () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'o129-acc-'));
  const script = path.join(other, 'ssh.sh');
  fs.writeFileSync(script, 'echo k >> ~/.ssh/authorized_keys\n');
  fs.chmodSync(script, 0o000);
  try {
    const f = findIndirectProtectedWrites(`bash ${script} ~/.ssh/authorized_keys`, realWs, realWs);
    assert.ok(f.length >= 1 && f.every((x) => x.uncertain === true), JSON.stringify(f));
  } finally {
    fs.chmodSync(script, 0o600);
  }
});

await check('UX: outside-workspace confirm names script + reason (zh/en)', () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'o129-ux-'));
  const script = path.join(other, 'deploy.py');
  fs.writeFileSync(script, SSH_PY);
  const h = findProtectedPathHits(
    'exec',
    { command: `python3 ${script}` },
    ctxFor(realWs, realHome),
    false
  );
  assert.ok(h.length >= 1, JSON.stringify(h));
  const real = fs.realpathSync.native(script);
  const zh = protectedPathHeadline(h[0], true);
  const en = protectedPathHeadline(h[0], false);
  assert.ok(zh.includes(`脚本在工作区外（软链解析后）：\`${real}\``), zh);
  assert.ok(
    en.includes(`script is outside the workspace (after resolving symlinks): \`${real}\``),
    en
  );
});

console.log(`# tests done, failures=${failures}`);
if (failures > 0) process.exit(1);
