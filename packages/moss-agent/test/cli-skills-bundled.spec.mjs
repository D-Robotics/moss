/**
 * Bundled RDK knowledge pack — tested from the user's perspective:
 * a fresh Moss install (empty workspace) is RDK-aware out of the box because
 * the SkillRegistry scans the shipped `assets/rdk-knowledge/skills` by default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillRegistry, resolveBundledRdkSkillsDir } from '../dist/skills/index.js';

function freshWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skills-ws-'));
}

test('bundled RDK skills ship inside the package', () => {
  const dir = resolveBundledRdkSkillsDir();
  assert.ok(dir.endsWith(path.join('assets', 'rdk-knowledge', 'skills')), 'resolves to the bundle');
  assert.ok(fs.existsSync(dir), 'bundle directory is present (run sync:knowledge if missing)');
});

test('an empty workspace still loads RDK skills by default', () => {
  const ws = freshWorkspace();
  try {
    const skills = new SkillRegistry({ workspaceDir: ws }).list();
    const bundled = skills.filter((s) => s.sourcePath.includes('rdk-knowledge'));
    assert.ok(bundled.length >= 10, `expected the RDK pack, got ${bundled.length} bundled skills`);
    assert.ok(
      skills.some((s) => s.name === 'rdk-device'),
      'rdk-device (the flagship deployment skill) is discoverable'
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('the Apache-2.0 maintainer tooling skills are NOT bundled', () => {
  const ws = freshWorkspace();
  try {
    const names = new Set(new SkillRegistry({ workspaceDir: ws }).list().map((s) => s.name));
    assert.ok(!names.has('skill-creator'), 'skill-creator stays maintainer-only');
    assert.ok(!names.has('mcp-builder'), 'mcp-builder stays maintainer-only');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('includeBundledRdkSkills:false opts out cleanly', () => {
  const ws = freshWorkspace();
  try {
    const skills = new SkillRegistry({ workspaceDir: ws, includeBundledRdkSkills: false }).list();
    assert.equal(
      skills.filter((s) => s.sourcePath.includes('rdk-knowledge')).length,
      0,
      'no bundled skills when opted out'
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
