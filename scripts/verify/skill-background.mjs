#!/usr/bin/env node
/**
 * D11 `background: true` probe — the skill body starts as a background
 * sub-agent task and the loading turn does not block on it.
 *
 * Deterministic: the sub-agent runner is a deferred fake, the async task
 * registry is the production in-memory one, and the probe asserts that the
 * tool call returns before the runner resolves, that the task reaches
 * completed/failed with the child summary, and that the failure contracts
 * (missing host capability, empty child output) are readable.
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
const { createInMemoryMossAsyncTaskRegistry } = await import(
  pathToFileURL(path.join(root, 'dist/contracts/async-task.js')).href
);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-background-'));
const skillDir = path.join(workspace, '.moss/skills');
const writeSkill = (name, lines) => {
  fs.mkdirSync(path.join(skillDir, name), { recursive: true });
  fs.writeFileSync(path.join(skillDir, name, 'SKILL.md'), lines.join('\n'));
};
writeSkill('bg', [
  '---',
  'name: bg',
  'description: Background demo',
  'background: true',
  'model: bg-model',
  'allowed-tools: read_file',
  '---',
  '',
  'BG-BODY $ARGUMENTS',
  '',
]);
writeSkill('inline', [
  '---',
  'name: inline',
  'description: Inline demo',
  '---',
  '',
  'INLINE-BODY',
  '',
]);
writeSkill('both', [
  '---',
  'name: both',
  'description: Background wins over fork',
  'context: fork',
  'background: true',
  '---',
  '',
  'BOTH-BODY',
  '',
]);
writeSkill('bad', [
  '---',
  'name: bad',
  'description: Bad background',
  'background: maybe',
  '---',
  '',
  'BAD-BODY',
  '',
]);

const skills = loadSkillCatalog([{ dir: skillDir, scope: 'workspace' }]);
const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]));
const checks = [];
const check = async (name, fn) => {
  try {
    await fn();
    checks.push(`PASS ${name}`);
  } catch (err) {
    checks.push(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

await check('frontmatter background is parsed; an invalid value is a warning', async () => {
  assert.equal(byName.bg.background, true);
  assert.equal(byName.inline.background, undefined);
  assert.equal(byName.both.background, true);
  assert.equal(byName.bad.background, undefined);
  assert.ok(byName.bad.issues.some((issue) => issue.code === 'unknown-background'));
});

await check('the load returns a task id before the child finishes', async () => {
  const registry = createInMemoryMossAsyncTaskRegistry();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const spawn = async (params) => {
    calls.push(params);
    await gate;
    return {
      runId: 'bg-run-1',
      sessionKey: 'bg-probe',
      summary: 'BG-OK',
      success: true,
      turns: 3,
      durationMs: 900,
    };
  };
  const tool = createSkillTool(() => skills);
  const ctx = {
    workspaceDir: workspace,
    sessionKey: 'bg-probe',
    runId: 'bg-probe',
    spawnSubagent: spawn,
    asyncTaskRegistry: registry,
  };
  const started = await tool.execute({ name: 'bg', args: 'hello' }, ctx);
  assert.match(started, /background task .*\/skill-[0-9a-f]{8}\) STARTED/);
  assert.match(started, /subagent_status/);
  const taskId = /background task (\S+)\) STARTED/.exec(started)[1];
  assert.equal(calls.length, 1, 'the child must be spawned once');
  assert.equal(calls[0].task.trim(), 'BG-BODY hello');
  assert.equal(calls[0].model, 'bg-model');
  assert.deepEqual(calls[0].allowedTools, ['read_file']);
  assert.equal(registry.status(taskId)?.status, 'running');
  release();
  const completion = await registry.wait(taskId);
  assert.equal(completion.success, true);
  assert.equal(completion.status, 'completed');
  assert.equal(completion.summary, 'BG-OK');
  assert.equal(completion.data.runId, 'bg-run-1');
});

await check('empty child output is a failed background task', async () => {
  const registry = createInMemoryMossAsyncTaskRegistry();
  const spawn = async () => ({
    runId: 'bg-run-2',
    sessionKey: 'bg-probe',
    summary: '   ',
    success: true,
  });
  const tool = createSkillTool(() => skills);
  const started = await tool.execute(
    { name: 'bg', args: 'empty' },
    {
      workspaceDir: workspace,
      sessionKey: 'bg-probe',
      runId: 'bg-probe',
      spawnSubagent: spawn,
      asyncTaskRegistry: registry,
    }
  );
  const taskId = /background task (\S+)\) STARTED/.exec(started)[1];
  const completion = await registry.wait(taskId);
  assert.equal(completion.success, false);
  assert.equal(completion.status, 'failed');
  assert.match(completion.summary, /empty output treated as failure/);
});

await check('no background runner is a readable error, not a silent inline run', async () => {
  let spawned = false;
  const tool = createSkillTool(() => skills);
  const output = await tool.execute(
    { name: 'bg' },
    {
      workspaceDir: workspace,
      sessionKey: 'bg-probe',
      runId: 'bg-probe',
      spawnSubagent: async () => {
        spawned = true;
        return { runId: 'x', sessionKey: 'x', summary: 'x', success: true };
      },
      // no asyncTaskRegistry
    }
  );
  assert.match(output, /no background sub-agent runner/);
  assert.equal(spawned, false);
});

await check('background wins over context: fork instead of forking inline', async () => {
  const registry = createInMemoryMossAsyncTaskRegistry();
  let calls = 0;
  const spawn = async () => {
    calls += 1;
    return { runId: 'bg-run-3', sessionKey: 'bg-probe', summary: 'BOTH-OK', success: true };
  };
  const tool = createSkillTool(() => skills);
  const output = await tool.execute(
    { name: 'both' },
    {
      workspaceDir: workspace,
      sessionKey: 'bg-probe',
      runId: 'bg-probe',
      spawnSubagent: spawn,
      asyncTaskRegistry: registry,
    }
  );
  assert.match(output, /STARTED/);
  assert.doesNotMatch(output, /forked sub-agent/);
  assert.equal(calls, 1);
  const taskId = /background task (\S+)\) STARTED/.exec(output)[1];
  await registry.wait(taskId);
});

await check('a normal skill still loads inline', async () => {
  const tool = createSkillTool(() => skills);
  const output = await tool.execute(
    { name: 'inline' },
    { workspaceDir: workspace, sessionKey: 'bg-probe', runId: 'bg-probe' }
  );
  assert.match(output, /INLINE-BODY/);
  assert.doesNotMatch(output, /STARTED/);
});

for (const line of checks) console.log(`[skill-background] ${line}`);
const failed = checks.filter((line) => line.startsWith('FAIL'));
fs.rmSync(workspace, { recursive: true, force: true });
if (failed.length > 0) {
  console.error(`[skill-background] ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`[skill-background] ${checks.length} checks passed`);
