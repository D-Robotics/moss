#!/usr/bin/env node
/**
 * D11 `context: fork` probe — a forked skill runs its body in an isolated
 * sub-agent and returns only a summary; inline skills keep loading the body.
 *
 * Deterministic: the sub-agent runner is a fake that records its parameters.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const { createSkillTool } = await import(
  pathToFileURL(path.join(root, 'dist/core/skills/skill-tool.js')).href
);
const { loadSkillCatalog } = await import(
  pathToFileURL(path.join(root, 'dist/core/skills/skill-registry.js')).href
);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-fork-'));
const skillDir = path.join(workspace, '.moss/skills');
fs.mkdirSync(path.join(skillDir, 'forked'), { recursive: true });
fs.mkdirSync(path.join(skillDir, 'inline'), { recursive: true });
fs.mkdirSync(path.join(skillDir, 'odd'), { recursive: true });
fs.writeFileSync(
  path.join(skillDir, 'forked/SKILL.md'),
  [
    '---',
    'name: forked',
    'description: Forked demo',
    'context: fork',
    'model: demo-model',
    'disallowed-tools: exec',
    '---',
    '',
    'Say $ARGUMENTS and nothing else.',
    '',
  ].join('\n')
);
fs.writeFileSync(
  path.join(skillDir, 'inline/SKILL.md'),
  ['---', 'name: inline', 'description: Inline demo', '---', '', 'INLINE-BODY', ''].join('\n')
);
fs.mkdirSync(path.join(skillDir, 'when'), { recursive: true });
fs.writeFileSync(
  path.join(skillDir, 'when/SKILL.md'),
  [
    '---',
    'name: when',
    'description: Spec when_to_use spelling',
    'when_to_use: Use this when the user says the magic word.',
    '---',
    '',
    'WHEN-BODY',
    '',
  ].join('\n')
);
fs.writeFileSync(
  path.join(skillDir, 'odd/SKILL.md'),
  [
    '---',
    'name: odd',
    'description: Odd context',
    'context: background',
    '---',
    '',
    'ODD-BODY',
    '',
  ].join('\n')
);

const skills = loadSkillCatalog([{ dir: skillDir, scope: 'workspace' }]);
const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]));

const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push(`PASS ${name}`);
  } catch (err) {
    checks.push(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

check('frontmatter context/model/disallowed-tools are parsed', () => {
  assert.equal(byName.forked.context, 'fork');
  assert.equal(byName.forked.model, 'demo-model');
  assert.deepEqual(byName.forked.disallowedTools, ['exec']);
});

check('spec `when_to_use` maps to the catalog trigger hint', () => {
  assert.match(byName.when.when ?? '', /magic word/);
});

check('an unsupported context is a warning and the skill runs inline', () => {
  assert.equal(byName.odd.context, undefined);
  assert.ok(byName.odd.issues.some((issue) => issue.code === 'unknown-context'));
});

const calls = [];
const fakeSpawn = async (params) => {
  calls.push(params);
  return {
    runId: 'run-1',
    sessionKey: 'fork-probe',
    summary: 'FORK-OK',
    success: true,
    turns: 2,
    durationMs: 1200,
  };
};
const makeCtx = (spawnSubagent) => ({
  workspaceDir: workspace,
  sessionKey: 'fork-probe',
  runId: 'fork-probe',
  ...(spawnSubagent ? { spawnSubagent } : {}),
});

let forkOutput = '';
const tool = createSkillTool(() => skills);
await (async () => {
  try {
    forkOutput = await tool.execute({ name: 'forked', args: 'hello' }, makeCtx(fakeSpawn));
    checks.push('PASS the fork tool call resolves');
  } catch (err) {
    checks.push(
      `FAIL the fork tool call resolves: ${err instanceof Error ? err.message : String(err)}`
    );
  }
})();

check('a forked skill returns the sub-agent summary with provenance', () => {
  assert.match(forkOutput, /forked sub-agent run-1/);
  assert.match(forkOutput, /FORK-OK/);
  assert.match(forkOutput, /2 turn\(s\)/);
});

check('the child task is the expanded body, with model and denied tools forwarded', () => {
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.task.trim(), 'Say hello and nothing else.');
  assert.equal(call.model, 'demo-model');
  assert.deepEqual(call.deniedTools, ['exec']);
  assert.equal(call.maxTurns, 20);
  assert.equal(call.label, 'skill-forked');
});

check('a host without sub-agents gets an actionable message, not a throw', async () => {
  const inlineTool = createSkillTool(() => skills);
  const output = await inlineTool.execute({ name: 'forked' }, makeCtx(undefined));
  assert.match(output, /no sub-agent runner/);
});

check('inline skills still load the body and never spawn', async () => {
  calls.length = 0;
  const output = await tool.execute({ name: 'inline' }, makeCtx(fakeSpawn));
  assert.match(output, /INLINE-BODY/);
  assert.equal(calls.length, 0);
});

for (const line of checks) console.log(`[skill-fork] ${line}`);
fs.rmSync(workspace, { recursive: true, force: true });
const failed = checks.filter((line) => line.startsWith('FAIL'));
if (failed.length > 0) {
  console.error(`[skill-fork] ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`[skill-fork] ${checks.length} checks passed`);
