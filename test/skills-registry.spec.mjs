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
  skillSlashName,
} from '../dist/core/skills/skill-registry.js';
import {
  announceCatalogSkip,
  catalogSkipAnnounced,
  formatCatalogSkipNotice,
  rememberCatalogSkip,
} from '../dist/cli/catalog-skip-notice.js';
import { shellPaletteRows } from '../dist/cli/tui/app-helpers.js';
import { resolveUserCommand, skillSlashToken } from '../dist/cli/commands/custom-commands.js';
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

// ─── unfilled templates and skill resource dirs are not skills ──────────────

async function writeManifest(skillDir, frontmatter, body = 'body') {
  await fsPromises.mkdir(skillDir, { recursive: true });
  const header = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  await fsPromises.writeFile(path.join(skillDir, 'SKILL.md'), `---\n${header}\n---\n\n${body}\n`);
}

{
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'moss-skills-skip-'));
  await writeManifest(path.join(root, 'good'), {
    name: 'good',
    description: 'A real skill',
  });
  await writeManifest(path.join(root, 'skill-creator'), {
    name: 'skill-creator',
    description: 'Creates skills',
  });
  await writeManifest(path.join(root, 'skill-creator', 'templates', 'skill'), {
    name: '{{name}}',
    description: '{{description}}',
  });
  await writeManifest(path.join(root, 'skill-creator', 'assets', 'sample'), {
    name: 'sample-asset',
    description: 'Should not load from assets',
  });
  await writeManifest(path.join(root, 'skill-creator', 'examples', 'demo'), {
    name: 'demo-example',
    description: 'Should not load from examples',
  });
  await writeManifest(path.join(root, 'skill-creator', 'references', 'extra'), {
    name: 'extra-ref',
    description: 'A nested skill outside resource dirs',
  });
  await writeManifest(path.join(root, 'filled-name'), {
    name: 'filled-name',
    description: '{{description}}',
  });
  await writeManifest(path.join(root, 'empty-desc'), { name: 'empty-desc', description: '' });
  await writeManifest(path.join(root, 'bad-name'), { name: 'bad name', description: 'Broken' });
  await writeManifest(path.join(root, 'colon-ok'), {
    name: 'rdk:docs',
    description: 'Colon is a valid name character',
  });

  const skips = [];
  const skills = loadSkills([root, root], {
    onSkip(skip) {
      skips.push(skip);
    },
  });
  assert.deepEqual(
    skills.map((skill) => skill.name).sort(),
    ['bad name', 'good', 'rdk:docs', 'skill-creator'].sort(),
    'unfilled templates are skipped; an invalid name stays in the catalog'
  );
  assert.ok(
    !skills.some((skill) => skill.name.includes('{') || skill.name.includes('}')),
    'registered skill names contain no braces'
  );
  assert.equal(
    skills.filter((skill) => skill.name === 'sample-asset' || skill.name === 'demo-example').length,
    0,
    'skills are not loaded from templates, assets, or examples'
  );

  const reasons = new Map(skips.map((skip) => [skip.file, skip.reason]));
  assert.equal(reasons.size, skips.length, 'each skipped skill file is named once');
  assert.equal(
    reasons.get(path.join(root, 'skill-creator', 'templates', 'skill', 'SKILL.md')),
    undefined,
    'a SKILL.md inside a skill is not walked and not registered'
  );
  assert.equal(
    reasons.get(path.join(root, 'skill-creator', 'references', 'extra', 'SKILL.md')),
    undefined
  );
  assert.equal(reasons.get(path.join(root, 'filled-name', 'SKILL.md')), 'placeholder');
  assert.equal(reasons.get(path.join(root, 'empty-desc', 'SKILL.md')), 'empty');
  assert.equal(reasons.get(path.join(root, 'bad-name', 'SKILL.md')), undefined);
  assert.equal(
    [...reasons.values()].includes('invalid-name'),
    false,
    'an invalid skill name is not a skip'
  );

  const template = path.join(root, 'skill-creator', 'templates', 'skill', 'SKILL.md');
  const en = formatCatalogSkipNotice(template, 'placeholder', 'en');
  const zh = formatCatalogSkipNotice(template, 'placeholder', 'zh-CN');
  assert.equal(en, `Skipped ${template}: name or description is an unfilled template placeholder`);
  assert.ok(zh.startsWith(`已跳过 ${template}：`), 'skip notice is localized');
  assert.match(zh, /模板占位符/);
}

// ─── project .moss/skills/_template is not a skill ──────────────────────────
// skill-creator drops SKILL.md at `.moss/skills/_template/` with the frontmatter
// still set to `{{name}}` / `{{description}}`. Indexing that folder made `/{{name}}`
// a slash entry and sent `Use the "{{name}}" skill ({{description}})…` to the model.
{
  const project = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'moss-skills-project-'));
  const skillsDir = path.join(project, '.moss', 'skills');
  await writeManifest(
    path.join(skillsDir, '_template'),
    { name: '{{name}}', description: '{{description}}' },
    'Use the "{{name}}" skill ({{description}}) for this task.'
  );
  await writeManifest(path.join(skillsDir, '_draft'), {
    name: 'draft-skill',
    description: 'Filled in, but the folder is still scratch',
  });
  await writeManifest(path.join(skillsDir, '.hidden'), {
    name: 'hidden-skill',
    description: 'A dot folder is not an installed skill',
  });
  await writeManifest(path.join(skillsDir, 'greet'), {
    name: 'greet',
    description: 'say hello',
  });

  const skips = [];
  const skills = loadSkills([skillsDir], {
    onSkip(skip) {
      skips.push(skip);
    },
  });
  assert.deepEqual(
    skills.map((skill) => skill.name),
    ['greet'],
    'a _template skill folder is not indexed'
  );
  assert.equal(
    skips.find((skip) => skip.file.endsWith(`${path.sep}_template${path.sep}SKILL.md`))?.reason,
    'hidden-dir'
  );
  assert.equal(
    skips.find((skip) => skip.file.endsWith(`${path.sep}_draft${path.sep}SKILL.md`))?.reason,
    'hidden-dir'
  );
  assert.equal(
    skips.find((skip) => skip.file.endsWith(`${path.sep}.hidden${path.sep}SKILL.md`))?.reason,
    'hidden-dir'
  );

  const tool = createSkillTool(skills);
  const listed = await tool.execute({ name: '{{name}}' }, {});
  assert.match(listed, /^Unknown skill "\{\{name\}\}"/);
  assert.equal(
    listed.split('Available skills: ')[1],
    'greet',
    '_template must not appear in the skill tool list'
  );
  assert.equal(listed.includes('draft-skill'), false);
  assert.equal(listed.includes('hidden-skill'), false);
  assert.equal(listed.includes('Use the'), false);

  const menu = shellPaletteRows(
    '/',
    skills.map((skill) => [`/${skill.name}`, skill.description])
  );
  assert.ok(
    menu.some(([command]) => command === '/greet'),
    'a real project skill stays in the slash menu'
  );
  assert.equal(
    menu.some(
      ([command, description]) =>
        command.includes('_template') ||
        command.includes('{{') ||
        description.includes('{{') ||
        command === '/draft-skill' ||
        command === '/hidden-skill' ||
        command === '/_template'
    ),
    false,
    '_template must not appear in the slash menu'
  );

  const resolved = resolveUserCommand('/{{name}}', {
    builtinNames: new Set(),
    customCommands: [],
    skills,
  });
  assert.equal(resolved.kind, 'unknown');
  assert.equal(String(resolved.prompt ?? '').includes('Use the'), false);
}

// Names that load on main stay loadable: Unicode, dots, a directory-name
// fallback (spaces collapsed to `-`), and a description that mentions `{{var}}`.
// A nested SKILL.md is not a second skill.
{
  assert.equal(skillSlashName('My Skill'), 'My-Skill');
  assert.equal(skillSlashName('c++-helper'), 'c++-helper');
  assert.equal(skillSlashName('Deploy (prod)'), 'Deploy-(prod)');
  assert.equal(skillSlashName('rdk.x5'), 'rdk.x5');

  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'moss-skills-names-'));
  await writeManifest(path.join(root, 'serial'), {
    name: '串口调试',
    description: '查看串口日志',
  });
  await writeManifest(path.join(root, 'camera'), {
    name: 'cam-v2.1',
    description: '相机 v2.1',
  });
  await fsPromises.mkdir(path.join(root, 'rdk.x5'), { recursive: true });
  await fsPromises.writeFile(
    path.join(root, 'rdk.x5', 'SKILL.md'),
    '---\ndescription: 板级手册\n---\n\nbody\n'
  );
  await fsPromises.mkdir(path.join(root, 'My Skill'), { recursive: true });
  await fsPromises.writeFile(
    path.join(root, 'My Skill', 'SKILL.md'),
    '---\ndescription: a folder whose name has a space\n---\n\nbody\n'
  );
  await writeManifest(path.join(root, 'cpp'), {
    name: 'c++-helper',
    description: 'compiles C++',
  });
  await writeManifest(path.join(root, 'deploy'), {
    name: 'Deploy (prod)',
    description: 'production deploy',
  });
  await writeManifest(path.join(root, 'spaced-name'), {
    name: 'My Skill',
    description: 'frontmatter keeps the space',
  });
  await writeManifest(path.join(root, 'gpio-check'), {
    name: 'gpio-check',
    description: '使用 {{var}} 设置引脚',
  });
  await writeManifest(path.join(root, 'gpio-check', 'reference', 'inner'), {
    name: 'inner-skill',
    description: 'must not be registered',
  });
  await writeManifest(path.join(root, 'still-template'), {
    name: 'still-template',
    description: '{{description}}',
  });

  const skips = [];
  const skills = loadSkills([root], {
    onSkip(skip) {
      skips.push(skip);
    },
  });
  assert.deepEqual(
    skills.map((skill) => skill.name).sort(),
    [
      'Deploy (prod)',
      'My Skill',
      'c++-helper',
      'cam-v2.1',
      'gpio-check',
      'rdk.x5',
      '串口调试',
    ].sort()
  );
  assert.equal(
    skills.some((skill) => skill.name === 'My-Skill'),
    false
  );
  assert.equal(skills.find((skill) => skill.name === 'My Skill')?.name, 'My Skill');
  assert.equal(
    skills.find((skill) => skill.name === 'gpio-check')?.description,
    '使用 {{var}} 设置引脚'
  );
  assert.equal(
    skills.some((skill) => skill.name === 'inner-skill'),
    false,
    'gpio-check/reference/inner/SKILL.md is not a skill'
  );
  assert.equal(
    skips.some((skip) => skip.file.includes(`${path.sep}inner${path.sep}`)),
    false
  );
  assert.equal(
    skips.find((skip) => skip.file.endsWith(`${path.sep}still-template${path.sep}SKILL.md`))
      ?.reason,
    'placeholder'
  );

  const tool = createSkillTool(skills);
  assert.match(await tool.execute({ name: 'My Skill' }, {}), /# Skill: My Skill/);
  assert.match(await tool.execute({ name: 'c++-helper' }, {}), /# Skill: c\+\+-helper/);
  assert.match(await tool.execute({ name: 'Deploy (prod)' }, {}), /# Skill: Deploy \(prod\)/);
  assert.match(await tool.execute({ name: 'bad name' }, {}), /Unknown skill "bad name"/);

  const aliasOnly = resolveUserCommand('/My-Skill', {
    builtinNames: new Set(),
    customCommands: [],
    skills: [{ name: 'My Skill', description: 'from the folder' }],
  });
  assert.equal(aliasOnly.kind, 'skill');
  assert.match(aliasOnly.prompt, /Use the "My Skill" skill \(from the folder\)/);

  const exactWins = resolveUserCommand('/My-Skill', {
    builtinNames: new Set(),
    customCommands: [],
    skills: [
      { name: 'My Skill', description: 'from the folder' },
      { name: 'My-Skill', description: 'exact skill' },
    ],
  });
  assert.equal(exactWins.kind, 'skill');
  assert.match(exactWins.prompt, /Use the "My-Skill" skill \(exact skill\)/);
  assert.equal(String(exactWins.prompt).includes('from the folder'), false);

  const noSlash = resolveUserCommand('/c++-helper', {
    builtinNames: new Set(),
    customCommands: [],
    skills: [{ name: 'c++-helper', description: 'compiles C++' }],
  });
  assert.equal(noSlash.kind, 'unknown');
  assert.equal(skillSlashToken({ name: 'My Skill', description: 'from the folder' }), '/My-Skill');
  assert.equal(skillSlashToken({ name: 'c++-helper', description: 'compiles C++' }), undefined);
  assert.equal(
    skillSlashToken({ name: 'Deploy (prod)', description: 'production deploy' }),
    undefined
  );

  const project = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'moss-skills-once-'));
  const template = path.join(project, '.moss', 'skills', '_template', 'SKILL.md');
  assert.equal(catalogSkipAnnounced(project, template), false);
  rememberCatalogSkip(project, template);
  assert.equal(catalogSkipAnnounced(project, template), true);
  rememberCatalogSkip(project, template);
  const record = fs.readFileSync(
    path.join(project, '.moss', 'runtime', 'catalog-skip-notices'),
    'utf8'
  );
  assert.equal(record, `${path.resolve(template)}\n`);
  const other = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'moss-skills-once-b-'));
  assert.equal(catalogSkipAnnounced(other, template), false);

  const linked = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'moss-skills-link-'));
  const outside = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'moss-skills-outside-'));
  fs.mkdirSync(path.join(linked, '.moss'));
  fs.symlinkSync(outside, path.join(linked, '.moss', 'runtime'));
  rememberCatalogSkip(linked, template);
  assert.equal(fs.existsSync(path.join(outside, 'catalog-skip-notices')), false);

  const hidden = path.join(project, '.moss', 'skills', '.hidden', 'SKILL.md');
  const drafts = path.join(project, '.moss', 'skills', '_drafts', 'SKILL.md');
  const badCommand = path.join(project, '.moss', 'commands', 'Bad Name.md');
  const lines = [];
  announceCatalogSkip(project, hidden, 'hidden-dir', 'en', (line) => lines.push(line));
  announceCatalogSkip(project, hidden, 'hidden-dir', 'en', (line) => lines.push(line));
  announceCatalogSkip(project, drafts, 'hidden-dir', 'en', (line) => lines.push(line));
  announceCatalogSkip(project, drafts, 'hidden-dir', 'en', (line) => lines.push(line));
  announceCatalogSkip(project, badCommand, 'invalid-name', 'en', (line) => lines.push(line));
  announceCatalogSkip(project, badCommand, 'invalid-name', 'en', (line) => lines.push(line));
  assert.equal(lines.length, 3, 'hidden folders and invalid command names are announced once');
  assert.ok(lines.some((line) => line.includes('.hidden')));
  assert.ok(lines.some((line) => line.includes('_drafts')));
  assert.ok(lines.some((line) => line.includes('Bad Name.md')));
}

console.log('[PASS] skills registry + skill tool');
