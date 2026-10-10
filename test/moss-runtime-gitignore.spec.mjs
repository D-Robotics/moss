/**
 * `.moss/.gitignore` hides runtime artifacts. It is written on the first runtime
 * artifact, not by read-only commands, and never by following a symlink.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ensureMossRuntimeGitignore } from '../dist/utils/workspace-paths.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'dist', 'cli.js');

function git(cwd, args) {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=moss@example.com', '-c', 'user.name=moss', ...args],
    { cwd, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function moss(cwd, args, home) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MOSS_CONFIG_DIR: path.join(home, 'moss-config'),
    },
  });
}

test('read-only config commands do not create .moss', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-runtime-ro-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  try {
    git(dir, ['init', '-q']);
    moss(dir, ['config', 'get', 'model'], home);
    moss(dir, ['config', 'show'], home);
    assert.equal(fs.existsSync(path.join(dir, '.moss')), false);
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-runtime-nogit-'));
    try {
      ensureMossRuntimeGitignore(bare);
      assert.equal(fs.existsSync(path.join(bare, '.moss')), false);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a .moss/.gitignore symlink is not followed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-runtime-link-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const mossDir = path.join(dir, '.moss');
  fs.mkdirSync(mossDir);
  try {
    git(dir, ['init', '-q']);
    const dangling = path.join(dir, 'missing-gitconfig');
    fs.symlinkSync(dangling, path.join(mossDir, '.gitignore'));
    ensureMossRuntimeGitignore(dir);
    moss(dir, ['config', 'get', 'model'], home);
    assert.equal(fs.existsSync(dangling), false);
    assert.equal(fs.lstatSync(path.join(mossDir, '.gitignore')).isSymbolicLink(), true);

    fs.unlinkSync(path.join(mossDir, '.gitignore'));
    const existing = path.join(dir, 'gitconfig');
    fs.writeFileSync(existing, 'keep-me\n');
    fs.symlinkSync(existing, path.join(mossDir, '.gitignore'));
    ensureMossRuntimeGitignore(dir);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'keep-me\n');

    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.rmSync(mossDir, { recursive: true, force: true });
    fs.symlinkSync(outside, mossDir);
    ensureMossRuntimeGitignore(dir);
    assert.equal(fs.existsSync(path.join(outside, '.gitignore')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid .git does not make a work tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-runtime-badgit-'));
  try {
    fs.symlinkSync(path.join(dir, 'missing-gitdir'), path.join(dir, '.git'));
    ensureMossRuntimeGitignore(dir);
    assert.equal(fs.existsSync(path.join(dir, '.moss')), false);
    fs.unlinkSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git'), 'not a gitdir\n');
    ensureMossRuntimeGitignore(dir);
    assert.equal(fs.existsSync(path.join(dir, '.moss')), false);
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /tmp/moss-missing-gitdir\n');
    ensureMossRuntimeGitignore(dir);
    assert.equal(fs.existsSync(path.join(dir, '.moss')), false);
    fs.rmSync(path.join(dir, '.git'), { force: true });
    fs.mkdirSync(path.join(dir, '.git'));
    ensureMossRuntimeGitignore(dir);
    assert.equal(fs.existsSync(path.join(dir, '.moss')), false, 'empty .git without HEAD');
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-runtime-stray-git-'));
    const child = path.join(parent, 'child');
    fs.mkdirSync(path.join(parent, '.git'));
    fs.mkdirSync(child);
    try {
      ensureMossRuntimeGitignore(child);
      assert.equal(fs.existsSync(path.join(child, '.moss')), false, 'ancestor .git without HEAD');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
    const emptyGitdir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-runtime-empty-gitdir-'));
    try {
      fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
      fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${emptyGitdir}\n`);
      ensureMossRuntimeGitignore(dir);
      assert.equal(fs.existsSync(path.join(dir, '.moss')), false, 'gitdir without HEAD');
    } finally {
      fs.rmSync(emptyGitdir, { recursive: true, force: true });
    }

    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-runtime-gitdir-'));
    try {
      git(real, ['init', '-q']);
      fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(real, '.git')}\n`);
      ensureMossRuntimeGitignore(dir);
      assert.equal(fs.existsSync(path.join(dir, '.moss', '.gitignore')), true);
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shared .moss files stay untracked and runtime files do not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-runtime-gitignore-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  try {
    git(dir, ['init', '-q']);
    const config = moss(dir, ['config', 'set', '--project', 'safetyMode', 'workspace-write'], home);
    assert.equal(config.status, 0, config.stderr || config.stdout);
    const skill = moss(dir, ['skill', 'create', 'demo-skill'], home);
    assert.equal(skill.status, 0, skill.stderr || skill.stdout);
    const mcp = moss(dir, ['mcp', 'add', '--project', 'local-echo', 'echo', 'hello'], home);
    assert.equal(mcp.status, 0, mcp.stderr || mcp.stdout);
    assert.equal(fs.existsSync(path.join(dir, '.moss', '.gitignore')), false);

    ensureMossRuntimeGitignore(dir);
    fs.mkdirSync(path.join(dir, '.moss', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.moss', 'agents', 'helper.md'), '# helper\n');
    fs.mkdirSync(path.join(dir, '.moss', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.moss', 'sessions', 'x.jsonl'), '{}\n');
    fs.mkdirSync(path.join(dir, '.moss', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.moss', 'logs', 'tui-frame.log'), 'frame\n');
    fs.writeFileSync(path.join(dir, '.moss', 'tasks.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, '.moss', 'evidence.jsonl'), '{}\n');

    const status = git(dir, ['status', '--porcelain', '-uall']);
    assert.match(status, /^\?\? \.moss\/config\.json$/m);
    assert.match(status, /^\?\? \.moss\/mcp\.json$/m);
    assert.match(status, /^\?\? \.moss\/skills\/demo-skill\/SKILL\.md$/m);
    assert.match(status, /^\?\? \.moss\/agents\/helper\.md$/m);
    assert.equal(status.includes('tasks.jsonl'), false, status);
    assert.equal(status.includes('evidence.jsonl'), false, status);
    assert.equal(status.includes('sessions'), false, status);
    assert.equal(status.includes('logs'), false, status);
    assert.equal(status.includes('.gitignore'), false, status);
    assert.equal(fs.existsSync(path.join(dir, '.git', 'info', 'exclude')), true);
    const exclude = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    assert.equal(exclude.includes('.moss'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
