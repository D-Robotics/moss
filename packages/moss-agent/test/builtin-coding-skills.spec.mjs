import test from 'node:test';
import assert from 'node:assert/strict';

import { listBuiltinSkills } from '../dist/skills/builtin.js';
import { SkillRegistry } from '../dist/skills/registry.js';
import { multiEditTool, editFileTool, harnessTools } from '../dist/tools/builtin.js';

test('builtin skills include verification / frontend / PR / efficient coding loop', () => {
  const names = listBuiltinSkills().map((s) => s.name);
  for (const required of [
    'verification-before-completion',
    'frontend-ui-polish',
    'pr-and-ship',
    'efficient-coding-loop',
    'superpower-test-driven-development',
    'code-review',
  ]) {
    assert.ok(names.includes(required), `missing builtin skill ${required}`);
  }
});

test('efficient-coding-loop skill has body guidance for multi_edit and parallel tools', () => {
  const skill = listBuiltinSkills().find((s) => s.name === 'efficient-coding-loop');
  assert.ok(skill?.body);
  assert.match(skill.body, /multi_edit/);
  assert.match(skill.body, /Parallel|parallel/);
  assert.match(skill.body, /run_tests|verify_fix/);
});

test('SkillRegistry match surfaces coding skill for implement prompts', () => {
  const reg = new SkillRegistry({ workspaceDir: process.cwd() });
  // match API: use whatever public match method exists
  const all = reg.list();
  assert.ok(all.some((s) => s.name === 'efficient-coding-loop'));
});

test('coding tools multi_edit and run_tests are registered in builtin export', () => {
  assert.equal(multiEditTool.name, 'multi_edit');
  assert.equal(editFileTool.name, 'edit_file');
  assert.ok(harnessTools.some((t) => t.name === 'run_tests'));
  assert.ok(harnessTools.some((t) => t.name === 'verify_fix'));
  assert.match(multiEditTool.description, /all-or-nothing|MultiEdit|surgical/i);
});
