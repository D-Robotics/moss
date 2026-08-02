import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SkillRegistry } from '../dist/skills/index.js';

function freshWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moss-isp-tuning-ws-'));
}

test('rdk-isp-tuning ships with the safety and validation workflow', () => {
  const ws = freshWorkspace();
  try {
    const skills = new SkillRegistry({ workspaceDir: ws }).list();
    const skill = skills.find((candidate) => candidate.name === 'rdk-isp-tuning');
    assert.ok(skill, 'rdk-isp-tuning is bundled and discoverable');
    assert.equal(skill.runtimePolicy?.requiresBoard, true, 'requires a connected board');
    assert.ok(skill.trigger.includes('ISP调参'), 'contains the main Chinese trigger');

    const raw = fs.readFileSync(skill.sourcePath, 'utf-8');
    assert.match(raw, /只修改用户指定模式对应的 JSON/);
    assert.match(raw, /不得顺手修改同 sensor 的 3264×2448 JSON/);
    assert.match(raw, /systemctl is-active cam-service/);
    assert.match(raw, /baseline→candidate→baseline/);
    assert.match(raw, /逐像素完全相同/);
    assert.match(raw, /不能单独证明 3DNR/);
    assert.match(raw, /噪声只下降约 1%，边缘却下降约 2%/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('matchByText routes Chinese ISP quality requests to rdk-isp-tuning', () => {
  const ws = freshWorkspace();
  try {
    const registry = new SkillRegistry({ workspaceDir: ws });
    for (const prompt of [
      '帮我给这个摄像头做ISP调参',
      '把图像质量调到最好',
      '调整降噪和锐化，让画质对齐参考图',
    ]) {
      const names = registry.matchByText(prompt).map((skill) => skill.name);
      assert.ok(names.includes('rdk-isp-tuning'), `${prompt} should match rdk-isp-tuning`);
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('rdk-isp-tuning does not misfire on a plain photo request', () => {
  const ws = freshWorkspace();
  try {
    const registry = new SkillRegistry({ workspaceDir: ws });
    const names = registry.matchByText('用开发板拍一张照片').map((skill) => skill.name);
    assert.ok(names.includes('rdk-capture-photo'), 'plain capture still matches rdk-capture-photo');
    assert.ok(!names.includes('rdk-isp-tuning'), 'plain capture does not match tuning');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
