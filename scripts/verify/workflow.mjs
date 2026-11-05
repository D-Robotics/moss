#!/usr/bin/env node
/**
 * D5 declarative orchestration probe.
 *
 * Deterministic parts import the compiled plan/runner modules and use a fake
 * step runner (waves, failure isolation, resume, concurrency, state file).
 * The end-to-end part runs one real single-step plan in mock mode, so the
 * child-session wiring, state file and CLI exit codes are exercised for real
 * without a model call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const dist = (relative) => pathToFileURL(path.join(root, 'dist', relative)).href;
const planModule = await import(dist('core/workflow/workflow-plan.js'));
const runnerModule = await import(dist('core/workflow/workflow-runner.js'));
const cli = path.join(root, 'dist/cli.js');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-workflow-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-workflow-home-'));
const env = {
  ...process.env,
  HOME: home,
  MOSS_NO_RDK_DOCS: '1',
  MOSS_LANG: 'en',
  MOSS_NO_TUI: '1',
};
const checks = [];
const check = async (name, fn) => {
  try {
    await fn();
    checks.push(`PASS ${name}`);
  } catch (err) {
    checks.push(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

const validPlan = {
  name: 'demo',
  concurrency: 2,
  steps: [
    { id: 'scan', task: 'scan the tree' },
    { id: 'fix', task: 'fix one file', dependsOn: ['scan'], writePaths: ['src/a.ts'] },
    { id: 'report', task: 'report', dependsOn: ['fix'] },
    { id: 'docs', task: 'update docs' },
  ],
};

await check('a valid plan parses with defaults and keeps step fields', async () => {
  const parsed = planModule.parseWorkflowPlan(validPlan);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.plan.name, 'demo');
  assert.equal(parsed.plan.concurrency, 2);
  assert.deepEqual(parsed.plan.steps[1].dependsOn, ['scan']);
  assert.deepEqual(parsed.plan.steps[1].writePaths, ['src/a.ts']);
});

await check('invalid plans collect every issue instead of throwing', async () => {
  const cases = [
    [{ name: 'demo', steps: [] }, /non-empty array/],
    [{ name: 'BAD NAME', steps: [{ id: 'a', task: 'x' }] }, /name must be lowercase/],
    [{ name: 'demo', concurrency: 9, steps: [{ id: 'a', task: 'x' }] }, /concurrency must/],
    [
      {
        name: 'demo',
        steps: [
          { id: 'a', task: 'x' },
          { id: 'a', task: 'y' },
        ],
      },
      /duplicate id/,
    ],
    [{ name: 'demo', steps: [{ id: 'a', task: 'x', dependsOn: ['nope'] }] }, /unknown dependency/],
    [
      {
        name: 'demo',
        steps: [
          { id: 'a', task: 'x', dependsOn: ['b'] },
          { id: 'b', task: 'y', dependsOn: ['a'] },
        ],
      },
      /dependency cycle/,
    ],
    [{ name: 'demo', steps: [{ id: 'a', task: '' }] }, /task must be a non-empty string/],
  ];
  for (const [raw, pattern] of cases) {
    const parsed = planModule.parseWorkflowPlan(raw);
    assert.equal(parsed.plan, undefined);
    assert.match(parsed.issues.map((issue) => issue.message).join('; '), pattern);
  }
});

await check('waves respect dependencies and keep plan order', async () => {
  const { plan } = planModule.parseWorkflowPlan(validPlan);
  const waves = planModule.planWaves(plan);
  assert.deepEqual(
    waves.map((wave) => wave.map((step) => step.id)),
    [['scan', 'docs'], ['fix'], ['report']]
  );
});

await check('a failed step blocks dependents but not independent steps', async () => {
  const { plan } = planModule.parseWorkflowPlan(validPlan);
  const runId = 'run-failure';
  const state = runnerModule.createWorkflowState({
    runId,
    plan,
    planFile: path.join(workspace, 'plan.json'),
    workspaceDir: workspace,
  });
  const called = [];
  await runnerModule.runWorkflow({
    plan,
    state,
    workspaceDir: workspace,
    runner: async (step) => {
      called.push(step.id);
      if (step.id === 'fix') return { passed: false, output: 'boom', error: 'step exited 1' };
      return { passed: true, output: `${step.id} ok` };
    },
  });
  const status = Object.fromEntries(state.steps.map((entry) => [entry.id, entry.status]));
  assert.equal(status.scan, 'passed');
  assert.equal(status.docs, 'passed');
  assert.equal(status.fix, 'failed');
  assert.equal(status.report, 'blocked');
  assert.equal(runnerModule.workflowExitCode(state), 1);
  assert.ok(called.includes('docs'), 'independent step still ran');
  const persisted = runnerModule.loadWorkflowState(workspace, runId);
  assert.equal(persisted.steps.find((entry) => entry.id === 'report').status, 'blocked');
});

await check('a passing state resumes without rerunning passed steps', async () => {
  const { plan } = planModule.parseWorkflowPlan(validPlan);
  const runId = 'run-resume';
  const state = runnerModule.createWorkflowState({
    runId,
    plan,
    planFile: path.join(workspace, 'plan.json'),
    workspaceDir: workspace,
  });
  const calls = [];
  const runner = async (step) => {
    calls.push(step.id);
    return { passed: true, output: `${step.id} ok` };
  };
  await runnerModule.runWorkflow({ plan, state, workspaceDir: workspace, runner });
  assert.equal(calls.length, 4);
  calls.length = 0;
  const resumed = runnerModule.loadWorkflowState(workspace, runId);
  await runnerModule.runWorkflow({ plan, state: resumed, workspaceDir: workspace, runner });
  assert.deepEqual(calls, []);
  assert.equal(runnerModule.workflowExitCode(resumed), 0);
});

await check('resume retries a failed step and unblocks its dependents', async () => {
  const { plan } = planModule.parseWorkflowPlan(validPlan);
  const runId = 'run-retry';
  const state = runnerModule.createWorkflowState({
    runId,
    plan,
    planFile: path.join(workspace, 'plan.json'),
    workspaceDir: workspace,
  });
  const first = [];
  await runnerModule.runWorkflow({
    plan,
    state,
    workspaceDir: workspace,
    runner: async (step) => {
      first.push(step.id);
      if (step.id === 'fix') return { passed: false, output: 'boom', error: 'step exited 1' };
      return { passed: true, output: `${step.id} ok` };
    },
  });
  assert.equal(
    state.steps.find((entry) => entry.id === 'report').status,
    'blocked',
    'the dependent must start blocked'
  );
  const calls = [];
  const resumed = runnerModule.loadWorkflowState(workspace, runId);
  await runnerModule.runWorkflow({
    plan,
    state: resumed,
    workspaceDir: workspace,
    runner: async (step) => {
      calls.push(step.id);
      return { passed: true, output: `${step.id} ok` };
    },
  });
  assert.deepEqual(calls, ['fix', 'report'], 'the failed step and its blocked dependent rerun');
  const status = Object.fromEntries(resumed.steps.map((entry) => [entry.id, entry.status]));
  assert.equal(status.fix, 'passed');
  assert.equal(status.report, 'passed');
  assert.equal(runnerModule.workflowExitCode(resumed), 0);
});

await check('concurrency stays within the plan limit', async () => {
  const { plan } = planModule.parseWorkflowPlan({
    name: 'wide',
    concurrency: 2,
    steps: [
      { id: 'a', task: 'a' },
      { id: 'b', task: 'b' },
      { id: 'c', task: 'c' },
      { id: 'd', task: 'd' },
    ],
  });
  const state = runnerModule.createWorkflowState({
    runId: 'run-concurrency',
    plan,
    planFile: path.join(workspace, 'plan.json'),
    workspaceDir: workspace,
  });
  let active = 0;
  let peak = 0;
  await runnerModule.runWorkflow({
    plan,
    state,
    workspaceDir: workspace,
    runner: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return { passed: true, output: 'ok' };
    },
  });
  assert.ok(peak <= 2, `peak concurrency was ${String(peak)}`);
  assert.equal(runnerModule.workflowExitCode(state), 0);
});

const run = (args) =>
  captureProcess(process.execPath, [cli, ...args], { cwd: workspace, env, timeoutMs: 120_000 });

await check('CLI dry-run prints waves and runs nothing', async () => {
  fs.writeFileSync(path.join(workspace, 'plan.json'), JSON.stringify(validPlan));
  const dir = path.join(workspace, '.moss', 'workflows');
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  const result = await run(['workflow', 'run', 'plan.json', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wave 1: scan \| docs/);
  assert.match(result.stdout, /wave 2: fix after scan/);
  const after = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  assert.equal(after, before, 'dry-run must not create a run state');
});

await check('CLI rejects an invalid plan with every issue and exit 1', async () => {
  fs.writeFileSync(
    path.join(workspace, 'bad.json'),
    JSON.stringify({ name: 'bad', steps: [{ id: 'a', task: 'x', dependsOn: ['missing'] }] })
  );
  const result = await run(['workflow', 'run', 'bad.json']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /unknown dependency "missing"/);
});

await check('CLI runs one real mock step, records state, resumes and lists it', async () => {
  fs.writeFileSync(
    path.join(workspace, 'single.json'),
    JSON.stringify({ name: 'single', steps: [{ id: 'scan', task: 'Report the word ok.' }] })
  );
  const result = await run(['workflow', 'run', 'single.json', '--mock']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /1 passed/);
  const list = await run(['workflow', 'list', '--json']);
  const payload = JSON.parse(list.stdout);
  assert.equal(payload.schema, 'moss_workflows.v1');
  const state = payload.runs.find((entry) => entry.name === 'single');
  assert.ok(state, 'run appears in workflow list');
  assert.equal(state.steps[0].status, 'passed');
  const status = await run(['workflow', 'status', state.runId]);
  assert.equal(status.status, 0, status.stderr);
  const resume = await run(['workflow', 'resume', state.runId, '--mock']);
  assert.equal(resume.status, 0, `${resume.stdout}\n${resume.stderr}`);
  assert.match(resume.stdout, /1 passed/);
});

await check('CLI status for an unknown run exits 1', async () => {
  const result = await run(['workflow', 'status', 'no-such-run']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no workflow run/);
});

for (const line of checks) console.log(`[workflow] ${line}`);
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
const failed = checks.filter((line) => line.startsWith('FAIL'));
if (failed.length > 0) {
  console.error(`[workflow] ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`[workflow] ${checks.length} checks passed`);
