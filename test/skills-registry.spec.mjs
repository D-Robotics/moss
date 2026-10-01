#!/usr/bin/env node
/**
 * Lightweight skills (v0.16-S3): SKILL.md discovery, progressive-disclosure
 * index budget, and the on-demand skill tool.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseSkillFile,
  loadSkills,
  buildSkillsPromptLayer,
  buildEmptySkillsHintLayer,
} from '../dist/core/skills/skill-registry.js';
import { createSkillTool } from '../dist/tools/skill-tool.js';

// ─── parseSkillFile ─────────────────────────────────────────────────────────

{
  const parsed = parseSkillFile(
    '---\nname: my-skill\ndescription: Does a thing\nwhen: editing code\n---\n\nBody here.'
  );
  assert.equal(parsed.frontmatter.name, 'my-skill');
  assert.equal(parsed.frontmatter.description, 'Does a thing');
  assert.equal(parsed.frontmatter.when, 'editing code');
  assert.equal(parsed.body, 'Body here.');

  const noFrontmatter = parseSkillFile('Just a body');
  assert.equal(noFrontmatter.body, 'Just a body');
}

// ─── loadSkills: discovery, missing dirs, workspace-wins precedence ─────────

async function writeSkill(dir, name, description, body) {
  const skillDir = path.join(dir, name);
  await fsPromises.mkdir(skillDir, { recursive: true });
  await fsPromises.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`
  );
}

{
  const ws = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'moss-skills-ws-'));
  const user = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'moss-skills-user-'));
  await writeSkill(ws, 'alpha', 'First skill', 'alpha body');
  await writeSkill(ws, 'beta', 'Second skill', 'beta body');
  await writeSkill(user, 'alpha', 'USER override', 'user body');
  await writeSkill(user, 'unrelated-no-desc', '');

  const skills = loadSkills([ws, user]);
  assert.deepEqual(
    skills.map((s) => s.name),
    ['alpha', 'beta'],
    'workspace wins on collision; undescribed skills skipped'
  );
  assert.equal(skills.find((s) => s.name === 'alpha')?.description, 'First skill');

  const missing = loadSkills([path.join(ws, 'does-not-exist')]);
  assert.deepEqual(missing, [], 'missing dirs yield no skills');

  // Index budget: one line per skill, ≤ ~200 chars each (≈40 tokens).
  const layer = buildSkillsPromptLayer(skills);
  assert.ok(layer && layer.includes('- alpha: First skill'));
  const perSkill = layer.length / skills.length;
  assert.ok(perSkill < 200, `index too verbose: ${perSkill} chars/skill`);
  assert.equal(buildSkillsPromptLayer([]), undefined, 'no layer without skills');
}

// ─── skill tool loads bodies on demand ──────────────────────────────────────

{
  const ws = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'moss-skills-tool-'));
  await writeSkill(ws, 'deep', 'Deep skill', '# Deep instructions\nDo the right thing.');
  const skills = loadSkills([ws]);
  const tool = createSkillTool(skills);

  const loaded = await tool.execute({ name: 'deep' }, {});
  assert.match(loaded, /# Skill: deep/);
  assert.match(loaded, /Do the right thing\./);

  const unknown = await tool.execute({ name: 'nope' }, {});
  assert.match(unknown, /Unknown skill "nope"/);
  assert.match(unknown, /deep/);
  assert.equal(tool.name, 'skill');
  assert.equal(tool.metadata?.sideEffectClass, 'readonly');
  void fs;
}

// ─── empty-skills hint: anchor the model to Moss's own dirs ─────────────────

{
  const hint = buildEmptySkillsHintLayer(['/ws/.moss/skills', '/u/.config/moss/skills']);
  assert.ok(hint.includes('No skills installed'), 'hint states the empty case');
  assert.ok(
    hint.includes(path.join('/ws/.moss/skills', '<name>', 'SKILL.md')),
    'hint shows the concrete SKILL.md path shape'
  );
  assert.ok(
    hint.includes('~/.claude/skills'),
    'hint names the foreign folders the model must not scan'
  );
}

console.log('[PASS] skills registry + skill tool');
