#!/usr/bin/env node
/**
 * Skills usability — create scaffolds a loadable SKILL.md; the skill tool
 * injects $ARGUMENTS; repeated loads hit the session cache (mtime-keyed);
 * /learn ghost references stay dead.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runSkillCommand } from '../dist/cli/skill-commands.js';
import { loadSkills } from '../dist/core/skills/skill-registry.js';
import { createSkillTool } from '../dist/tools/skill-tool.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skill-ws-'));
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skill-cfg-'));

const stdout = [];
const stderr = [];
const prevOut = process.stdout.write.bind(process.stdout);
const prevErr = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk) => {
  stdout.push(String(chunk));
  return true;
};
process.stderr.write = (chunk) => {
  stderr.push(String(chunk));
  return true;
};

try {
  // ─── create → scaffold → discovered ──────────────────────────────────────
  let code = await runSkillCommand(['create', 'deploy-check'], {
    workspaceDir: ws,
    configDir: cfg,
  });
  assert.equal(code, 0, 'create exits 0');
  const scaffoldPath = path.join(ws, '.moss', 'skills', 'deploy-check', 'SKILL.md');
  const scaffold = fs.readFileSync(scaffoldPath, 'utf8');
  assert.ok(scaffold.includes('name: deploy-check'), 'frontmatter carries the name');
  assert.ok(scaffold.includes('$ARGUMENTS'), 'template teaches the args placeholder');

  code = await runSkillCommand(['create', 'deploy-check'], { workspaceDir: ws, configDir: cfg });
  assert.equal(code, 1, 'duplicate create refuses');

  const skills = loadSkills([path.join(ws, '.moss', 'skills'), path.join(cfg, 'skills')]);
  assert.ok(
    skills.some((s) => s.name === 'deploy-check' && s.description.length > 0),
    'scaffold is discovered once the description is filled'
  );

  // ─── args injection through the tool ─────────────────────────────────────
  fs.writeFileSync(
    scaffoldPath,
    '---\nname: deploy-check\ndescription: check the robot before deploy\n---\nTarget: $ARGUMENTS. Verify camera $ARGUMENTS.',
    'utf8'
  );
  const tool = createSkillTool(loadSkills([path.join(ws, '.moss', 'skills')]));
  const loaded = await tool.execute({ name: 'deploy-check', args: 'arm-2' }, {});
  assert.ok(String(loaded).includes('Target: arm-2.'), 'placeholder is replaced');
  assert.ok(!String(loaded).includes('$ARGUMENTS'), 'no placeholder leaks through');
  assert.ok(String(loaded).includes('# Skill: deploy-check'), 'header present');

  // Missing-args call leaves placeholders empty (visible, not confusing).
  const noArgs = await tool.execute({ name: 'deploy-check' }, {});
  assert.ok(String(noArgs).includes('Target: .'), 'no-args replaces with empty');

  // ─── session cache: same mtime = no re-read ──────────────────────────────
  const reads = [];
  const origRead = fs.readFileSync;
  fs.readFileSync = (...call) => {
    reads.push(String(call[0]));
    return origRead(...call);
  };
  try {
    await tool.execute({ name: 'deploy-check' }, {});
    await tool.execute({ name: 'deploy-check' }, {});
    const bodyReads = reads.filter((p) => p.includes('deploy-check'));
    assert.equal(
      bodyReads.length,
      0,
      'second load hits the cache (parseSkillFile path bypassed via cache)'
    );
    // Touch the file → mtime changes → cache invalidates.
    const now = new Date();
    fs.utimesSync(scaffoldPath, now, now);
    await tool.execute({ name: 'deploy-check' }, {});
    assert.equal(
      reads.filter((p) => p.includes('deploy-check')).length,
      1,
      'mtime change invalidates the cache'
    );
  } finally {
    fs.readFileSync = origRead;
  }

  // ─── list ────────────────────────────────────────────────────────────────
  stdout.length = 0;
  code = await runSkillCommand(['list'], { workspaceDir: ws, configDir: cfg });
  assert.equal(code, 0);
  assert.ok(stdout.join('').includes('deploy-check'), 'list shows the skill');

  // ─── /learn ghost: dispatching it answers as an unknown command ──────────
  const { findRegistryCommand } = await import('../dist/cli/commands/registry.js');
  assert.equal(findRegistryCommand('/learn'), null, '/learn has no handler (ghost)');
} finally {
  process.stdout.write = prevOut;
  process.stderr.write = prevErr;
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(cfg, { recursive: true, force: true });
}

console.log('[PASS] skill usability (create + args + cache)');
process.exit(0);
