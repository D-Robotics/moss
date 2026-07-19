#!/usr/bin/env node
/**
 * Plan-mode exit UX — /mode command + plan approve leaves plan mode.
 * Coding-first: users must not stay stuck in read-only after approving a plan.
 */
import assert from 'node:assert/strict';

import {
  formatCliInteractionModeLabel,
  getCliInteractionMode,
  inferCliInteractionModeFromMessages,
  parseCliInteractionMode,
  setCliInteractionMode,
  setCliUserQuestionAsker,
  subscribeCliInteractionMode,
} from '../dist/cli/approval.js';
import { runRegistryCommand } from '../dist/cli/commands/registry.js';
import {
  planTool,
  resetPlanControllerForTests,
} from '../dist/plan-execute/plan-tools.js';

function ctx(overrides = {}) {
  const lines = [];
  return {
    lines,
    agent: { config: { model: 'test-model', sessionStore: { loadMessages: async () => [] } } },
    runtime: undefined,
    sessionKey: 'test',
    workspace: process.cwd(),
    locale: 'en_US.UTF-8',
    surface: 'tui',
    say: (_kind, text) => lines.push(String(text)),
    prefillInput: () => {},
    setInteractionMode: overrides.setInteractionMode,
    ...overrides,
  };
}

// ── parse / labels ───────────────────────────────────────────────────────────

{
  assert.equal(parseCliInteractionMode('plan'), 'plan');
  assert.equal(parseCliInteractionMode('default'), 'default');
  assert.equal(parseCliInteractionMode('accept-edits'), 'acceptEdits');
  assert.equal(parseCliInteractionMode('acceptEdits'), 'acceptEdits');
  assert.equal(parseCliInteractionMode('自动接受编辑'), 'acceptEdits');
  assert.equal(parseCliInteractionMode('nope'), null);
  assert.equal(formatCliInteractionModeLabel('plan', true), '计划模式');
  assert.equal(formatCliInteractionModeLabel('acceptEdits', false), 'accept-edits');
}

// ── subscribeCliInteractionMode ──────────────────────────────────────────────

{
  setCliInteractionMode('default');
  const seen = [];
  const unsub = subscribeCliInteractionMode((m) => seen.push(m));
  setCliInteractionMode('plan');
  setCliInteractionMode('plan'); // no-op same mode
  setCliInteractionMode('default');
  unsub();
  setCliInteractionMode('acceptEdits');
  assert.deepEqual(seen, ['plan', 'default']);
  setCliInteractionMode('default');
}

// ── /mode command ────────────────────────────────────────────────────────────

{
  setCliInteractionMode('default');
  const c = ctx();
  const modes = [];
  c.setInteractionMode = (m) => modes.push(m);
  const handled = await runRegistryCommand('/mode plan', c);
  assert.equal(handled, true);
  assert.equal(getCliInteractionMode(), 'plan');
  assert.deepEqual(modes, ['plan']);
  assert.ok(c.lines.some((l) => /plan|计划/i.test(l)));

  const handled2 = await runRegistryCommand('/mode default', c);
  assert.equal(handled2, true);
  assert.equal(getCliInteractionMode(), 'default');

  const bad = ctx();
  await runRegistryCommand('/mode banana', bad);
  assert.ok(bad.lines.some((l) => /Usage|用法/i.test(l)));
}

// /plan alias
{
  setCliInteractionMode('default');
  const c = ctx({ locale: 'zh_CN.UTF-8' });
  await runRegistryCommand('/plan', c); // status via alias when no args? /plan is alias of /mode with empty args
  // Empty args on alias: findRegistryCommand('/plan') → mode command with args ''
  assert.equal(getCliInteractionMode(), 'default');
  assert.ok(c.lines.some((l) => /当前交互模式|Interaction mode/i.test(l)));
}

// ── plan approve leaves plan mode ────────────────────────────────────────────

{
  resetPlanControllerForTests();
  setCliInteractionMode('plan');
  assert.equal(getCliInteractionMode(), 'plan');

  const createOut = await planTool.execute(
    {
      action: 'create',
      goal: 'Ship sticky todo panel',
      steps: [
        { description: 'Explore TUI tool_end path' },
        { description: 'Implement panel + tests' },
        { description: 'Verify with npm test' },
      ],
    },
    {
      workspaceDir: process.cwd(),
      sessionKey: 'plan-exit',
      abortSignal: new AbortController().signal,
    },
  );
  assert.match(String(createOut), /plan/i);
  const planId =
    String(createOut).match(/^ID:\s*(\S+)/m)?.[1] ||
    String(createOut).match(/Plan created:\s*(\S+)/i)?.[1] ||
    String(createOut).match(/\b(plan-\d+-[a-z0-9]+)\b/i)?.[1];
  assert.ok(planId, `expected plan id in create output:\n${createOut}`);

  // Non-interactive plan mode: no asker → still approves (automation/headless).
  setCliUserQuestionAsker(null);
  const approveOut = await planTool.execute(
    { action: 'approve', planId },
    {
      workspaceDir: process.cwd(),
      sessionKey: 'plan-exit',
      abortSignal: new AbortController().signal,
    },
  );
  assert.match(String(approveOut), /approved/i);
  assert.equal(
    getCliInteractionMode(),
    'default',
    'plan approve must leave interactionMode=plan so coding tools can run',
  );
  assert.match(String(approveOut), /Left plan mode|default/i);

  resetPlanControllerForTests();
  setCliInteractionMode('default');
}

// Interactive plan mode: user can decline and stay in plan mode
{
  resetPlanControllerForTests();
  setCliInteractionMode('plan');
  setCliUserQuestionAsker(async () => 'n');
  const createOut = await planTool.execute(
    {
      action: 'create',
      goal: 'Need user confirm',
      steps: [
        { description: 'Step one' },
        { description: 'Step two' },
        { description: 'Step three' },
      ],
    },
    {
      workspaceDir: process.cwd(),
      sessionKey: 'plan-decline',
      abortSignal: new AbortController().signal,
    },
  );
  const planId =
    String(createOut).match(/^ID:\s*(\S+)/m)?.[1] ||
    String(createOut).match(/Plan created:\s*(\S+)/i)?.[1] ||
    String(createOut).match(/\b(plan-\d+-[a-z0-9]+)\b/i)?.[1];
  assert.ok(planId, `expected plan id:\n${createOut}`);
  const declined = await planTool.execute(
    { action: 'approve', planId },
    {
      workspaceDir: process.cwd(),
      sessionKey: 'plan-decline',
      abortSignal: new AbortController().signal,
    },
  );
  assert.match(String(declined), /not approved|Staying in plan mode/i);
  assert.equal(getCliInteractionMode(), 'plan', 'declined approve keeps plan mode');
  setCliUserQuestionAsker(null);
  resetPlanControllerForTests();
  setCliInteractionMode('default');
}

// Interactive plan mode: user yes leaves plan mode
{
  resetPlanControllerForTests();
  setCliInteractionMode('plan');
  setCliUserQuestionAsker(async () => 'yes');
  const createOut = await planTool.execute(
    {
      action: 'create',
      goal: 'Need user confirm approve',
      steps: [
        { description: 'Step one' },
        { description: 'Step two' },
        { description: 'Step three' },
      ],
    },
    {
      workspaceDir: process.cwd(),
      sessionKey: 'plan-yes',
      abortSignal: new AbortController().signal,
    },
  );
  const planId =
    String(createOut).match(/^ID:\s*(\S+)/m)?.[1] ||
    String(createOut).match(/Plan created:\s*(\S+)/i)?.[1] ||
    String(createOut).match(/\b(plan-\d+-[a-z0-9]+)\b/i)?.[1];
  assert.ok(planId, `expected plan id:\n${createOut}`);
  const approved = await planTool.execute(
    { action: 'approve', planId },
    {
      workspaceDir: process.cwd(),
      sessionKey: 'plan-yes',
      abortSignal: new AbortController().signal,
    },
  );
  assert.match(String(approved), /approved/i);
  assert.match(String(approved), /User confirmed leaving plan mode|Left plan mode/i);
  assert.equal(getCliInteractionMode(), 'default');
  setCliUserQuestionAsker(null);
  resetPlanControllerForTests();
  setCliInteractionMode('default');
}

// ── infer mode from session history (resume, no extra persistence) ───────────

{
  assert.equal(inferCliInteractionModeFromMessages([]), null);
  assert.equal(
    inferCliInteractionModeFromMessages([
      {
        role: 'user',
        content:
          '[Plan mode] Explore the codebase read-only...\n\nDesign the sticky todo panel',
      },
    ]),
    'plan',
  );
  assert.equal(
    inferCliInteractionModeFromMessages([
      { role: 'user', content: '[Plan mode] ...\n\nDesign X' },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content:
              'Plan plan-1 approved. Left plan mode → default (mutations allowed).',
          },
        ],
      },
    ]),
    'default',
    'leaving plan mode wins over earlier plan header',
  );
  assert.equal(
    inferCliInteractionModeFromMessages([
      { role: 'user', content: '/mode accept-edits' },
    ]),
    'acceptEdits',
  );
  assert.equal(
    inferCliInteractionModeFromMessages([
      { role: 'user', content: '[计划模式] 你现在处于 plan 模式…\n\n写个方案' },
    ]),
    'plan',
  );
}

console.log('[PASS] interaction mode exit');
