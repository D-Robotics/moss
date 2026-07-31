/**
 * rdk-capture-photo — tested from the user's perspective:
 * a Chinese "用这个开发板拍几张照片" request must match the bundled
 * skill via matchByText's substring-trigger path, so its body gets injected.
 * This is the exact failure mode the skill exists to fix: pure-Chinese
 * photo requests previously matched nothing (ascii token branch ignores
 * CJK), so moss fumbled with /dev/video / srcampy.Camera / cam-service.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillRegistry } from '../dist/skills/index.js';

function freshWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moss-capture-ws-'));
}

test('rdk-capture-photo ships in the bundled RDK pack', () => {
  const ws = freshWorkspace();
  try {
    const skills = new SkillRegistry({ workspaceDir: ws }).list();
    const skill = skills.find((s) => s.name === 'rdk-capture-photo');
    assert.ok(skill, 'rdk-capture-photo is bundled and discoverable');
    assert.ok(
      skill.trigger.includes('拍几张照片'),
      'trigger contains the user-typical Chinese fragment 拍几张照片'
    );
    assert.ok(
      skill.runtimePolicy?.requiresBoard === true,
      'requires board'
    );
    // body is read from disk via readSkillBody; here assert the file teaches the right path.
    const raw = fs.readFileSync(skill.sourcePath, 'utf-8');
    assert.ok(raw.includes('get_isp_data'), 'body teaches the correct get_isp_data tool');
    assert.ok(raw.includes('cam-service'), 'body warns about cam-service');
    assert.ok(raw.includes('不要'), 'body has a "do not" warnings section');
    assert.ok(raw.includes('killall cam-service'), 'body explicitly names the killall anti-pattern');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('matchByText matches a pure-Chinese photo request and returns rdk-capture-photo', () => {
  const ws = freshWorkspace();
  try {
    const registry = new SkillRegistry({ workspaceDir: ws });
    const matched = registry.matchByText('用这个开发板拍几张照片');
    const names = matched.map((s) => s.name);
    assert.ok(
      names.includes('rdk-capture-photo'),
      `expected rdk-capture-photo to match, got [${names.join(', ')}]`
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('matchByText does NOT misfire on a board-diagnostic request', () => {
  // "板子连不上" should match rdk-board-knowledge, NOT rdk-capture-photo.
  const ws = freshWorkspace();
  try {
    const registry = new SkillRegistry({ workspaceDir: ws });
    const names = registry.matchByText('板子连不上了怎么办').map((s) => s.name);
    assert.ok(
      !names.includes('rdk-capture-photo'),
      'rdk-capture-photo must not match an unrelated diagnostic request'
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
