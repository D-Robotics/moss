#!/usr/bin/env node
/**
 * ask_user_question TUI channel — option picker must not be swallowed by
 * the permission y/a/n chooser (Claude Code AskUserQuestion parity).
 */
import assert from 'node:assert/strict';

import { handleGlobalInput } from '../dist/cli/tui-input-handler.js';
import {
  parseAskUserQuestionOptions,
  isAskUserQuestionMultiSelect,
  askUserQuestionTool,
} from '../dist/tools/ask-user-question.js';
import {
  setCliUserQuestionAsker,
  getCliUserQuestionAsker,
  setCliApprovalAsker,
} from '../dist/cli/approval.js';
import { inputPlaceholder, visibleInput } from '../dist/cli/command-input.js';

assert.equal(visibleInput('secret', true), '••••••');
assert.equal(visibleInput('account', false), 'account');
assert.match(inputPlaceholder(true, false), /password input is hidden/);

// ── parse helpers ────────────────────────────────────────────────────────────

{
  const prompt =
    'Which approach?\n' +
    '  1. Minimal patch — smallest change\n' +
    '  2. Full refactor — broader cleanup\n' +
    '\nEnter a number, or free text for "Other".';
  const opts = parseAskUserQuestionOptions(prompt);
  assert.equal(opts.length, 2);
  assert.equal(opts[0].label, 'Minimal patch');
  assert.equal(opts[0].description, 'smallest change');
  assert.equal(opts[1].label, 'Full refactor');
  assert.equal(isAskUserQuestionMultiSelect(prompt), false);
  assert.equal(
    isAskUserQuestionMultiSelect(
      'Pick features\n  1. A\nEnter one or more numbers separated by commas, or free text.'
    ),
    true
  );
}

// ── dedicated asker channel ──────────────────────────────────────────────────

{
  setCliApprovalAsker(async () => 'approval-channel');
  setCliUserQuestionAsker(null);
  // Falls back to approval asker when no dedicated channel is set.
  assert.equal(typeof getCliUserQuestionAsker(), 'function');
  assert.equal(await getCliUserQuestionAsker()('q'), 'approval-channel');

  setCliUserQuestionAsker(async () => 'question-channel');
  assert.equal(await getCliUserQuestionAsker()('q'), 'question-channel');

  // Tool uses the dedicated channel.
  const out = await askUserQuestionTool.execute(
    {
      questions: [
        {
          question: 'Which approach?',
          options: [{ label: 'A (Recommended)' }, { label: 'B' }],
        },
      ],
    },
    {
      workspaceDir: process.cwd(),
      sessionKey: 'test',
      abortSignal: new AbortController().signal,
    }
  );
  assert.match(out, /User has answered/);
  assert.match(out, /question-channel|A \(Recommended\)|B/);

  setCliUserQuestionAsker(null);
  setCliApprovalAsker(null);
}

// ── TUI keyboard: number selects option label (not y/a/n) ────────────────────

function makeQuestionDeps(overrides = {}) {
  const calls = { setUserQuestion: [], resolve: [] };
  let state = {
    question:
      'Which approach?\n  1. Minimal patch — smallest\n  2. Full refactor — broader\n\nEnter a number, or free text for "Other".',
    options: [
      { label: 'Minimal patch', description: 'smallest' },
      { label: 'Full refactor', description: 'broader' },
    ],
    multiSelect: false,
    selectedIndex: 0,
    selectedIndices: [],
    freeform: '',
    resolve: (answer) => {
      calls.resolve.push(answer);
    },
    ...overrides.state,
  };
  const deps = {
    sessionPicker: null,
    setSessionPicker: () => {},
    modelPicker: null,
    setModelPicker: () => {},
    approval: null,
    setApproval: () => {},
    userQuestion: state,
    setUserQuestion: (updater) => {
      calls.setUserQuestion.push(updater);
      if (typeof updater === 'function') state = updater(state);
      else state = updater;
      deps.userQuestion = state;
    },
    input: '',
    setInput: () => {},
    setInputCursor: () => {},
    pendingAttachments: [],
    setPendingAttachments: () => {},
    setPendingAttachmentBlocks: () => {},
    suppressedAutoAttachInputRef: { current: null },
    activeRunControllerRef: { current: null },
    showFlash: () => {},
    requestStop: () => {},
    addTranscript: () => {},
    switchModelForSession: () => {},
    resumeSession: () => {},
    setToolsExpanded: () => {},
    setInteractionMode: () => {},
    disconnectDeviceForSession: () => '',
    removeAttachmentRefsFromInput: (s) => s,
    clampPromptCursor: (_i, c) => c,
    agent: {},
    ...overrides,
  };
  deps.calls = calls;
  return deps;
}

{
  const deps = makeQuestionDeps();
  // Press "2" → resolve with second option label (NOT approval 'y'/'a'/'n')
  const consumed = handleGlobalInput('2', {}, deps);
  assert.equal(consumed, true);
  assert.deepEqual(deps.calls.resolve, ['Full refactor']);
}

{
  const deps = makeQuestionDeps();
  // Arrow down then Enter selects option 2
  handleGlobalInput('', { downArrow: true }, deps);
  assert.equal(deps.userQuestion.selectedIndex, 1);
  handleGlobalInput('', { return: true }, deps);
  assert.deepEqual(deps.calls.resolve, ['Full refactor']);
}

{
  const deps = makeQuestionDeps();
  // Type freeform on Other slot
  handleGlobalInput('', { downArrow: true }, deps); // index 1
  handleGlobalInput('', { downArrow: true }, deps); // index 2 = Other
  handleGlobalInput('c', {}, deps);
  handleGlobalInput('u', {}, deps);
  handleGlobalInput('s', {}, deps);
  handleGlobalInput('t', {}, deps);
  handleGlobalInput('o', {}, deps);
  handleGlobalInput('m', {}, deps);
  assert.equal(deps.userQuestion.freeform, 'custom');
  handleGlobalInput('', { return: true }, deps);
  assert.deepEqual(deps.calls.resolve, ['custom']);
}

{
  // Multi-select: space toggles, Enter joins labels
  const deps = makeQuestionDeps({
    state: {
      multiSelect: true,
      selectedIndices: [],
    },
  });
  // force multiSelect on state after make
  deps.userQuestion.multiSelect = true;
  handleGlobalInput(' ', {}, deps); // toggle index 0
  assert.deepEqual(deps.userQuestion.selectedIndices, [0]);
  handleGlobalInput('', { downArrow: true }, deps);
  handleGlobalInput(' ', {}, deps); // toggle index 1
  assert.deepEqual(deps.userQuestion.selectedIndices, [0, 1]);
  handleGlobalInput('', { return: true }, deps);
  assert.deepEqual(deps.calls.resolve, ['Minimal patch, Full refactor']);
}

{
  // Esc declines
  const deps = makeQuestionDeps();
  handleGlobalInput('', { escape: true }, deps);
  assert.deepEqual(deps.calls.resolve, ['']);
}

// Permission approval still works and is NOT used for user questions when both present
{
  let approvalResolved = null;
  const deps = makeQuestionDeps();
  // userQuestion takes priority over approval
  deps.approval = {
    question: 'Allow once, [a]lways, or [N]o?',
    selectedIndex: 0,
    resolve: (a) => {
      approvalResolved = a;
    },
  };
  handleGlobalInput('2', {}, deps);
  assert.deepEqual(deps.calls.resolve, ['Full refactor']);
  assert.equal(approvalResolved, null, 'user question must not fall through to approval');
}

console.log('[PASS] ask_user_question TUI channel');
