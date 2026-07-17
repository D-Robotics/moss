#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectRecentToolPaths,
  discoverSkillNamesNearPath,
  evaluateSkillDiscoveryNudge,
} from '../dist/core/loop/skill-discovery-nudge.js';

function toolUseRead(pathRel) {
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'r1',
        name: 'read_file',
        input: { path: pathRel },
      },
    ],
  };
}

// collectRecentToolPaths
{
  const paths = collectRecentToolPaths([
    { role: 'user', content: 'hi' },
    toolUseRead('src/a.ts'),
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'l1', name: 'list_directory', input: { path: 'pkg' } }],
    },
  ]);
  assert.ok(paths.includes('pkg'));
  assert.ok(paths.includes('src/a.ts'));
}

// discoverSkillNamesNearPath
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skill-disc-'));
  try {
    const nested = path.join(dir, 'packages', 'app', 'src');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'main.ts'), 'export {}\n');
    const skillDir = path.join(dir, 'packages', 'app', '.claude', 'skills', 'local-helper');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: local-helper\ndescription: help\n---\nbody\n',
    );

    const names = discoverSkillNamesNearPath(path.join(nested, 'main.ts'), dir);
    assert.ok(names.includes('local-helper'), `expected local-helper in ${names.join(',')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// evaluateSkillDiscoveryNudge fires once with names
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skill-disc2-'));
  try {
    const fileDir = path.join(dir, 'src');
    fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(path.join(fileDir, 'x.ts'), 'export {}\n');
    const skillDir = path.join(dir, '.moss', 'skills', 'proj-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: proj-skill\n---\n');

    const reported = new Set();
    const r = evaluateSkillDiscoveryNudge({
      messages: [toolUseRead('src/x.ts')],
      workspaceDir: dir,
      attempts: 0,
      reportedNames: reported,
    });
    assert.equal(r.fire, true);
    assert.ok(r.names.includes('proj-skill'));
    assert.match(r.correction, /load_skill/);

    // second attempt blocked
    reported.add('proj-skill');
    const r2 = evaluateSkillDiscoveryNudge({
      messages: [toolUseRead('src/x.ts')],
      workspaceDir: dir,
      attempts: 1,
      reportedNames: reported,
    });
    assert.equal(r2.fire, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// no paths → no fire
{
  const r = evaluateSkillDiscoveryNudge({
    messages: [{ role: 'user', content: 'hi' }],
    workspaceDir: process.cwd(),
    attempts: 0,
    reportedNames: new Set(),
  });
  assert.equal(r.fire, false);
}

// multi_edit / apply_patch paths are collected for discovery
{
  const paths = collectRecentToolPaths([
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'm1',
          name: 'multi_edit',
          input: {
            edits: [
              { path: 'pkg/a.ts', old_string: 'x', new_string: 'y' },
              { path: 'pkg/b.ts', old_string: 'x', new_string: 'y' },
            ],
          },
        },
      ],
    },
  ]);
  assert.ok(paths.includes('pkg/a.ts'));
  assert.ok(paths.includes('pkg/b.ts'));
}

console.log('[PASS] skill-discovery-nudge');
