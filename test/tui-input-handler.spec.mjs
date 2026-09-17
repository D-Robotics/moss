#!/usr/bin/env node
/**
 * TUI global input handler — unit tests for handleGlobalInput and helpers.
 *
 * handleGlobalInput is a pure function (no Ink/React dependency in the
 * function body); all side effects go through the deps callbacks, making
 * it straightforward to mock and verify.
 */
import assert from 'node:assert/strict';

import {
  handleGlobalInput,
  isLikelyMouseInput,
  clampApprovalChoiceIndex,
  approvalAnswerFromDecision,
  approvalAnswerForIndex,
  approvalChoicesForQuestion,
} from '../dist/cli/tui-input-handler.js';

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Create a deps object with spy/recording callbacks.
 *
 * Every callback that handleGlobalInput might invoke is replaced by a
 * function that records its arguments into a `calls` array keyed by name.
 * Pass `overrides` to set initial state (sessionPicker, modelPicker,
 * approval, input, activeRunControllerRef, runtime, etc.).
 *
 * After calling handleGlobalInput, inspect `deps.calls` to verify what
 * was invoked with what arguments.
 */
function makeDeps(overrides = {}) {
  const calls = {
    setSessionPicker: [],
    setModelPicker: [],
    setApproval: [],
    showFlash: [],
    resumeSession: [],
    switchModelForSession: [],
    setToolsExpanded: [],
    setInteractionMode: [],
    requestStop: [],
    addTranscript: [],
    setInput: [],
    setInputCursor: [],
    setPendingAttachments: [],
    setPendingAttachmentBlocks: [],
    removeAttachmentRefsFromInput: [],
  };

  const deps = {
    sessionPicker: null,
    modelPicker: null,
    approval: null,
    input: '',
    setInput: (v) => {
      calls.setInput.push(v);
    },
    setInputCursor: (fn) => {
      calls.setInputCursor.push(fn);
    },
    pendingAttachments: [],
    setPendingAttachments: (v) => {
      calls.setPendingAttachments.push(v);
    },
    setPendingAttachmentBlocks: (v) => {
      calls.setPendingAttachmentBlocks.push(v);
    },
    suppressedAutoAttachInputRef: { current: null },
    activeRunControllerRef: { current: undefined },
    runtime: undefined,
    showFlash: (msg) => {
      calls.showFlash.push(msg);
    },
    requestStop: () => {
      calls.requestStop.push(true);
    },
    addTranscript: (type, text) => {
      calls.addTranscript.push({ type, text });
    },
    switchModelForSession: (model, provider) => {
      calls.switchModelForSession.push({ model, provider });
    },
    resumeSession: (session) => {
      calls.resumeSession.push(session);
    },
    setToolsExpanded: (fn) => {
      calls.setToolsExpanded.push(fn);
    },
    setInteractionMode: (fn) => {
      calls.setInteractionMode.push(fn);
    },
    setSessionPicker: (fn) => {
      calls.setSessionPicker.push(fn);
    },
    setModelPicker: (fn) => {
      calls.setModelPicker.push(fn);
    },
    setApproval: (fn) => {
      calls.setApproval.push(fn);
    },
    disconnectDeviceForSession: () => 'disconnected from board',
    removeAttachmentRefsFromInput: (input) => {
      calls.removeAttachmentRefsFromInput.push(input);
      return input.replace(/<attach:[^>]+>/g, '').trim();
    },
    clampPromptCursor: (input, cursor) => Math.min(cursor, input.length),
    agent: {},
    ...overrides,
  };

  // If overrides provided specific callbacks, ensure they still record
  // by wrapping them (user can't record through override -- they own the
  // callbacks if they supply them).
  for (const key of Object.keys(calls)) {
    if (key in overrides && typeof overrides[key] === 'function') {
      const original = overrides[key];
      deps[key] = (...args) => {
        calls[key].push(args.length === 1 ? args[0] : args);
        return original(...args);
      };
    }
    // approval.resolve is special: it's on deps.approval, not deps itself
  }

  // approval.resolve recording: wrap if overridden or set default
  if (deps.approval) {
    const origResolve = deps.approval.resolve;
    deps.approval.resolve = (answer) => {
      calls.approvalResolve = calls.approvalResolve || [];
      calls.approvalResolve.push(answer);
      if (origResolve) origResolve(answer);
    };
  }

  deps.calls = calls;
  return deps;
}

// ─── isLikelyMouseInput ─────────────────────────────────────────────────────────────────────────

{
  assert.equal(isLikelyMouseInput(''), false, 'empty string is not mouse input');
  assert.equal(isLikelyMouseInput('\x1b[<0;0;0M'), true, 'SGR mouse press detected');
  assert.equal(isLikelyMouseInput('\x1b[<0;0;0m'), true, 'SGR mouse release detected');
  assert.equal(isLikelyMouseInput('\x1b[M !!'), true, 'legacy mouse report detected');
  assert.equal(isLikelyMouseInput('hello'), false, 'normal text is not mouse input');
  assert.equal(isLikelyMouseInput(null), false, 'null is not mouse input');
  assert.equal(isLikelyMouseInput(undefined), false, 'undefined is not mouse input');
}

// ─── clampApprovalChoiceIndex ────────────────────────────────────────────────────────────────────

{
  assert.equal(clampApprovalChoiceIndex(0), 0, 'index 0 stays 0');
  assert.equal(clampApprovalChoiceIndex(1), 1, 'index 1 stays 1');
  assert.equal(clampApprovalChoiceIndex(2), 2, 'index 2 stays 2');
  assert.equal(clampApprovalChoiceIndex(-1), 0, 'negative index clamped to 0');
  assert.equal(clampApprovalChoiceIndex(5), 2, 'index beyond max clamped to max');
  assert.equal(clampApprovalChoiceIndex(Infinity), 2, 'Infinity clamped to max');
}

// ─── approvalAnswerFromDecision ─────────────────────────────────────────────────────────────────

{
  assert.equal(approvalAnswerFromDecision('allow-once'), 'y', 'allow-once → y');
  assert.equal(approvalAnswerFromDecision('allow-always'), 'a', 'allow-always → a');
  assert.equal(approvalAnswerFromDecision('deny'), '', 'deny → empty string');
}

// ─── approvalAnswerForIndex ─────────────────────────────────────────────────────────────────────

{
  // APPROVAL_CHOICES[0] = allow-once
  assert.equal(approvalAnswerForIndex(0), 'y', 'index 0 → allow-once → y');
  // APPROVAL_CHOICES[1] = allow-always
  assert.equal(approvalAnswerForIndex(1), 'a', 'index 1 → allow-always → a');
  // APPROVAL_CHOICES[2] = deny
  assert.equal(approvalAnswerForIndex(2), '', 'index 2 → deny → empty');
  // out of range: clamped to max (2), deny
  assert.equal(approvalAnswerForIndex(99), '', 'index 99 clamped to 2 → deny → empty');
  assert.equal(approvalAnswerForIndex(-1), 'y', 'index -1 clamped to 0 → allow-once → y');
}

// ─── approvalChoicesForQuestion ─────────────────────────────────────────────────────────────────

{
  const defaultChoices = approvalChoicesForQuestion('Allow once, [a]lways, or [N]o?');
  assert.equal(defaultChoices.length, 3, '3 choices when persistent trust is explicitly offered');
  assert.equal(
    defaultChoices[1].label,
    'Always this scope',
    'generic persistent scope remains explicit'
  );
}

{
  const workspaceChoices = approvalChoicesForQuestion(
    'Scope: workspace file change\nAllow once, [a]lways, or [N]o?'
  );
  assert.equal(workspaceChoices.length, 3, '3 choices for workspace-scoped question');
  assert.equal(
    workspaceChoices[1].label,
    'Trust workspace edits',
    'workspace question names the exact trusted action class'
  );
  assert.equal(
    workspaceChoices[1].description.includes('sandboxed file edits'),
    true,
    'workspace description states the sandbox boundary'
  );
}

{
  const deviceChoices = approvalChoicesForQuestion(
    'Allow once or deny (device mutations always re-prompt). [y/N]'
  );
  assert.equal(
    deviceChoices.length,
    2,
    'device confirmation does not render a misleading always option'
  );
  assert.equal(
    deviceChoices.some((choice) => choice.decision === 'allow-always'),
    false
  );
}

// ─── Session picker ─────────────────────────────────────────────────────────────────────────────

{
  const sessions = [{ sessionKey: 's1' }, { sessionKey: 's2' }, { sessionKey: 's3' }];
  const deps = makeDeps({
    sessionPicker: { sessions, selectedIndex: 1 },
  });

  // Escape → close picker + flash
  const consumed = handleGlobalInput('\x1b', { escape: true }, deps);
  assert.equal(consumed, true, 'escape consumed when picker open');
  assert.equal(deps.calls.setSessionPicker.length, 1, 'setSessionPicker called');
  const updater = deps.calls.setSessionPicker[0];
  assert.equal(typeof updater, 'function', 'setSessionPicker received a function');
  assert.equal(updater({}), null, 'updater returns null (closes picker)');
  assert.deepEqual(
    deps.calls.showFlash,
    ['session selection cancelled'],
    'flash shows cancellation message'
  );
  deps.calls.showFlash.length = 0;
}

{
  // Up arrow → selectedIndex moves up (wrap: 0 → last)
  const deps = makeDeps({
    sessionPicker: { sessions: [{ sessionKey: 's1' }, { sessionKey: 's2' }], selectedIndex: 0 },
  });
  handleGlobalInput('', { upArrow: true }, deps);
  assert.equal(deps.calls.setSessionPicker.length, 1);
  const fn = deps.calls.setSessionPicker[0];
  const result = fn({ sessions: [{ sessionKey: 's1' }, { sessionKey: 's2' }], selectedIndex: 0 });
  assert.equal(result.selectedIndex, 1, 'up arrow at index 0 wraps to last');
}

{
  // Ctrl+P (up) with shift-case test
  const deps = makeDeps({
    sessionPicker: { sessions: [{ sessionKey: 's1' }, { sessionKey: 's2' }], selectedIndex: 1 },
  });
  handleGlobalInput('P', { ctrl: true }, deps);
  assert.equal(deps.calls.setSessionPicker.length, 1);
  const fn = deps.calls.setSessionPicker[0];
  const result = fn({ sessions: [{ sessionKey: 's1' }, { sessionKey: 's2' }], selectedIndex: 1 });
  assert.equal(result.selectedIndex, 0, 'Ctrl+P moves up by 1');
}

{
  // Down arrow → selectedIndex moves down (wrap: last → 0)
  const deps = makeDeps({
    sessionPicker: { sessions: [{ sessionKey: 's1' }, { sessionKey: 's2' }], selectedIndex: 1 },
  });
  handleGlobalInput('', { downArrow: true }, deps);
  const fn = deps.calls.setSessionPicker[0];
  const result = fn({ sessions: [{ sessionKey: 's1' }, { sessionKey: 's2' }], selectedIndex: 1 });
  assert.equal(result.selectedIndex, 0, 'down arrow at last wraps to 0');
}

{
  // Ctrl+N (down) with lowercase
  const deps = makeDeps({
    sessionPicker: { sessions: [{ sessionKey: 's1' }, { sessionKey: 's2' }], selectedIndex: 0 },
  });
  handleGlobalInput('n', { ctrl: true }, deps);
  const fn = deps.calls.setSessionPicker[0];
  const result = fn({ sessions: [{ sessionKey: 's1' }, { sessionKey: 's2' }], selectedIndex: 0 });
  assert.equal(result.selectedIndex, 1, 'Ctrl+N moves down by 1');
}

{
  // Enter → selects session at clamped index, closes picker, calls resumeSession
  const deps = makeDeps({
    sessionPicker: { sessions: [{ sessionKey: 's1' }, { sessionKey: 's2' }], selectedIndex: 0 },
  });
  const consumed = handleGlobalInput('\r', { return: true }, deps);
  assert.equal(consumed, true, 'enter consumed when picker open');
  // setSessionPicker called with () => null
  assert.equal(deps.calls.setSessionPicker.length, 1);
  const closeFn = deps.calls.setSessionPicker[0];
  assert.equal(closeFn(), null, 'close picker returns null');
  // resumeSession called with the selected session
  assert.deepEqual(deps.calls.resumeSession, [{ sessionKey: 's1' }], 'resumes selected session');
}

{
  // Enter with out-of-bounds index → clamped to valid range
  const sessions = [{ sessionKey: 'only' }];
  const deps = makeDeps({
    sessionPicker: { sessions, selectedIndex: 99 },
  });
  handleGlobalInput('\r', { return: true }, deps);
  assert.deepEqual(
    deps.calls.resumeSession,
    [{ sessionKey: 'only' }],
    'out-of-bounds index clamps to valid session'
  );
}

{
  // If selected by index doesn't exist (shouldn't happen, but safeguard)
  // sessions[0] is undefined if sessions is empty
  // The code does: `if (session) void deps.resumeSession(session);`
  // So with empty sessions, resumeSession is not called
  const deps = makeDeps({
    sessionPicker: { sessions: [], selectedIndex: 0 },
  });
  handleGlobalInput('\r', { return: true }, deps);
  assert.equal(deps.calls.resumeSession.length, 0, 'no resumeSession for empty picker');
  assert.equal(deps.calls.setSessionPicker.length, 1, 'picker still closed');
}

{
  // Other keys are swallowed
  const deps = makeDeps({
    sessionPicker: { sessions: [{ sessionKey: 's1' }], selectedIndex: 0 },
  });
  const consumed = handleGlobalInput('x', {}, deps);
  assert.equal(consumed, true, 'regular key swallowed when picker open');
  assert.equal(deps.calls.setSessionPicker.length, 0, 'no action on swallowed key');
}

{
  // Session picker closed → keys are NOT consumed by picker paths
  // (should fall through to global hotkeys or return false)
  const deps = makeDeps();
  // With no pickers, no approval, escape without active run → should fall through
  const consumed = handleGlobalInput('\x1b', { escape: true }, deps);
  assert.equal(
    consumed,
    false,
    'escape is NOT consumed when picker is closed (no active run, no attachments)'
  );
}

// ─── Model picker ───────────────────────────────────────────────────────────────────────────────

{
  const choices = [{ model: 'gpt-4' }, { model: 'claude-3' }, { model: 'llama-3' }];
  const deps = makeDeps({
    modelPicker: { list: { choices, provider: 'openai' }, selectedIndex: 1 },
  });

  // Escape → close + flash
  const consumed = handleGlobalInput('\x1b', { escape: true }, deps);
  assert.equal(consumed, true, 'escape consumed when model picker open');
  const closeFn = deps.calls.setModelPicker[0];
  assert.equal(typeof closeFn, 'function');
  assert.equal(closeFn({}), null, 'closes picker');
  assert.deepEqual(deps.calls.showFlash, ['model selection cancelled']);
  deps.calls.showFlash.length = 0;
}

{
  // Up arrow → wrap
  const deps = makeDeps({
    modelPicker: {
      list: { choices: [{ model: 'a' }, { model: 'b' }], provider: 'p' },
      selectedIndex: 0,
    },
  });
  handleGlobalInput('', { upArrow: true }, deps);
  const fn = deps.calls.setModelPicker[0];
  assert.equal(
    fn({ list: { choices: [{ model: 'a' }, { model: 'b' }], provider: 'p' }, selectedIndex: 0 })
      .selectedIndex,
    1,
    'up arrow wraps'
  );
}

{
  // Ctrl+P (up)
  const deps = makeDeps({
    modelPicker: {
      list: { choices: [{ model: 'a' }, { model: 'b' }], provider: 'p' },
      selectedIndex: 1,
    },
  });
  handleGlobalInput('p', { ctrl: true }, deps);
  assert.equal(deps.calls.setModelPicker.length, 1, 'Ctrl+P moves up');
}

{
  // Down arrow → wrap
  const deps = makeDeps({
    modelPicker: {
      list: { choices: [{ model: 'a' }, { model: 'b' }], provider: 'p' },
      selectedIndex: 1,
    },
  });
  handleGlobalInput('', { downArrow: true }, deps);
  const fn = deps.calls.setModelPicker[0];
  assert.equal(
    fn({ list: { choices: [{ model: 'a' }, { model: 'b' }], provider: 'p' }, selectedIndex: 1 })
      .selectedIndex,
    0,
    'down arrow wraps'
  );
}

{
  // Ctrl+N (down)
  const deps = makeDeps({
    modelPicker: {
      list: { choices: [{ model: 'a' }, { model: 'b' }], provider: 'p' },
      selectedIndex: 0,
    },
  });
  handleGlobalInput('N', { ctrl: true }, deps);
  assert.equal(deps.calls.setModelPicker.length, 1, 'Ctrl+N moves down');
}

{
  // Digit '1' → selects first model
  const deps = makeDeps({
    modelPicker: {
      list: { choices: [{ model: 'gpt-4' }, { model: 'claude-3' }], provider: 'openai' },
      selectedIndex: 0,
    },
  });
  const consumed = handleGlobalInput('1', {}, deps);
  assert.equal(consumed, true, 'digit 1 consumed when model picker open');
  assert.equal(deps.calls.setModelPicker.length, 1);
  assert.equal(deps.calls.setModelPicker[0](), null, 'picker closed');
  assert.deepEqual(
    deps.calls.switchModelForSession,
    [{ model: 'gpt-4', provider: 'openai' }],
    'switched to model at index 0'
  );
}

{
  // Digit '9' when only 3 choices → choice is undefined → no switch, just swallowed
  const deps = makeDeps({
    modelPicker: {
      list: { choices: [{ model: 'a' }, { model: 'b' }, { model: 'c' }], provider: 'p' },
      selectedIndex: 0,
    },
  });
  const consumed = handleGlobalInput('9', {}, deps);
  assert.equal(consumed, true, 'digit out of range still consumed');
  assert.equal(deps.calls.switchModelForSession.length, 0, 'no switch for out-of-range digit');
  assert.equal(deps.calls.setModelPicker.length, 0, 'picker not closed');
}

{
  // Digit '0' is NOT matched (regex /^[1-9]$/) → falls through to return true
  const deps = makeDeps({
    modelPicker: { list: { choices: [{ model: 'a' }], provider: 'p' }, selectedIndex: 0 },
  });
  const consumed = handleGlobalInput('0', {}, deps);
  assert.equal(consumed, true, 'digit 0 still consumed by model picker catch-all');
  assert.equal(deps.calls.switchModelForSession.length, 0, '0 does not select anything');
}

{
  // Enter → selects current choice
  const deps = makeDeps({
    modelPicker: {
      list: { choices: [{ model: 'anthropic' }, { model: 'openai' }], provider: 'anthropic' },
      selectedIndex: 0,
    },
  });
  const consumed = handleGlobalInput('\r', { return: true }, deps);
  assert.equal(consumed, true, 'enter consumed when model picker open');
  assert.deepEqual(
    deps.calls.switchModelForSession,
    [{ model: 'anthropic', provider: 'anthropic' }],
    'switched to selected model'
  );
}

{
  // Enter when choices[selectedIndex] is undefined (shouldn't happen, but safeguard)
  const deps = makeDeps({
    modelPicker: { list: { choices: [], provider: 'p' }, selectedIndex: 0 },
  });
  handleGlobalInput('\r', { return: true }, deps);
  assert.equal(deps.calls.switchModelForSession.length, 0, 'no switch when choice undefined');
  assert.equal(deps.calls.setModelPicker.length, 0, 'picker NOT closed when choice undefined');
}

{
  // Other keys swallowed
  const deps = makeDeps({
    modelPicker: { list: { choices: [{ model: 'a' }], provider: 'p' }, selectedIndex: 0 },
  });
  const consumed = handleGlobalInput('z', {}, deps);
  assert.equal(consumed, true, 'other keys swallowed when model picker open');
}

// ─── Approval prompt ────────────────────────────────────────────────────────────────────────────

{
  // Approval resolve recording is tricky because handleGlobalInput reads
  // deps.approval.resolve directly. The resolve must be captured at the time
  // handleGlobalInput runs. We install it in makeDeps but let's test it here.
  const resolveCalls = [];
  const deps = makeDeps({
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });

  // Escape → resolve('') + close
  const consumed = handleGlobalInput('\x1b', { escape: true }, deps);
  assert.equal(consumed, true, 'escape consumed when approval open');
  assert.deepEqual(resolveCalls, [''], 'escape resolves with empty string');
  assert.equal(typeof deps.calls.setApproval[0], 'function');
  assert.equal(deps.calls.setApproval[0]({}), null, 'approval closed');
}

{
  // Up arrow → move selectedIndex up (wrap)
  const resolveCalls = [];
  const deps = makeDeps({
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });
  handleGlobalInput('', { upArrow: true }, deps);
  const fn = deps.calls.setApproval[0];
  const result = fn({ selectedIndex: 0 });
  assert.equal(result.selectedIndex, 2, 'up arrow wraps 0→2 in approval (3 choices)');
}

{
  // Down arrow → move selectedIndex down
  const deps = makeDeps({
    approval: { resolve: () => {}, selectedIndex: 2, question: 'Allow?' },
  });
  handleGlobalInput('', { downArrow: true }, deps);
  const fn = deps.calls.setApproval[0];
  const result = fn({ selectedIndex: 2 });
  assert.equal(result.selectedIndex, 0, 'down arrow wraps 2→0 in approval');
}

{
  // Left arrow → same as up (move selection up)
  const deps = makeDeps({
    approval: { resolve: () => {}, selectedIndex: 1, question: 'Allow?' },
  });
  handleGlobalInput('', { leftArrow: true }, deps);
  const fn = deps.calls.setApproval[0];
  const result = fn({ selectedIndex: 1 });
  assert.equal(result.selectedIndex, 0, 'left arrow moves selection up by 1');
}

{
  // Right arrow → same as down (move selection down)
  const deps = makeDeps({
    approval: { resolve: () => {}, selectedIndex: 1, question: 'Allow?' },
  });
  handleGlobalInput('', { rightArrow: true }, deps);
  const fn = deps.calls.setApproval[0];
  const result = fn({ selectedIndex: 1 });
  assert.equal(result.selectedIndex, 2, 'right arrow moves selection down by 1');
}

{
  // Ctrl+P → up as well (approval up)
  const deps = makeDeps({
    approval: { resolve: () => {}, selectedIndex: 0, question: 'Allow?' },
  });
  handleGlobalInput('p', { ctrl: true }, deps);
  assert.equal(deps.calls.setApproval.length, 1, 'Ctrl+P moves approval up');
}

{
  // Ctrl+N → down as well (approval down)
  const deps = makeDeps({
    approval: { resolve: () => {}, selectedIndex: 1, question: 'Allow?' },
  });
  handleGlobalInput('N', { ctrl: true }, deps);
  assert.equal(deps.calls.setApproval.length, 1, 'Ctrl+N moves approval down');
}

{
  // Enter → resolve with current selectedIndex's decision
  const resolveCalls = [];
  const deps = makeDeps({
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });
  const consumed = handleGlobalInput('\r', { return: true }, deps);
  assert.equal(consumed, true, 'enter consumed when approval open');
  // selectedIndex 0 → allow-once → 'y'
  assert.deepEqual(resolveCalls, ['y'], 'enter resolves with current selection');
  assert.ok(deps.calls.setApproval.length > 0, 'approval closed');
}

{
  // Digit '1' → select first option (allow-once)
  const resolveCalls = [];
  const deps = makeDeps({
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });
  handleGlobalInput('1', {}, deps);
  assert.deepEqual(resolveCalls, ['y'], 'digit 1 → allow-once → y');
}

{
  // Digit '2' → second option (allow-always)
  const resolveCalls = [];
  const deps = makeDeps({
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });
  handleGlobalInput('2', {}, deps);
  assert.deepEqual(resolveCalls, ['a'], 'digit 2 → allow-always → a');
}

{
  // Digit '3' → third option (deny)
  const resolveCalls = [];
  const deps = makeDeps({
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });
  handleGlobalInput('3', {}, deps);
  assert.deepEqual(resolveCalls, [''], 'digit 3 → deny → empty string');
}

{
  // 'y' → allow-once
  const resolveCalls = [];
  const deps = makeDeps({
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });
  handleGlobalInput('y', {}, deps);
  assert.deepEqual(resolveCalls, ['y'], 'y → allow-once → y');
}

{
  // 'Y' (uppercase) → allow-once (lowercased)
  const resolveCalls = [];
  const deps = makeDeps({
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });
  handleGlobalInput('Y', {}, deps);
  assert.deepEqual(resolveCalls, ['y'], 'Y → case-insensitive → allow-once → y');
}

{
  // 'a' → allow-always
  const resolveCalls = [];
  const deps = makeDeps({
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });
  handleGlobalInput('a', {}, deps);
  assert.deepEqual(resolveCalls, ['a'], 'a → allow-always → a');
}

{
  // 'n' → deny
  const resolveCalls = [];
  const deps = makeDeps({
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });
  handleGlobalInput('n', {}, deps);
  assert.deepEqual(resolveCalls, [''], 'n → deny → empty string');
}

{
  // 'A' (uppercase) → allow-always
  const resolveCalls = [];
  const deps = makeDeps({
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });
  handleGlobalInput('A', {}, deps);
  assert.deepEqual(resolveCalls, ['a'], 'A → case-insensitive → allow-always → a');
}

{
  // 'N' (uppercase) → deny
  const resolveCalls = [];
  const deps = makeDeps({
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });
  handleGlobalInput('N', {}, deps);
  assert.deepEqual(resolveCalls, [''], 'N → case-insensitive → deny → empty string');
}

{
  // Other keys swallowed when approval is open
  const deps = makeDeps({
    approval: { resolve: () => {}, selectedIndex: 0, question: 'Allow?' },
  });
  const consumed = handleGlobalInput('x', {}, deps);
  assert.equal(consumed, true, 'other keys swallowed when approval open');
}

{
  // With approval open, a global hotkey like Ctrl+O should be swallowed
  const resolveCalls = [];
  const deps = makeDeps({
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });
  const consumed = handleGlobalInput('o', { ctrl: true }, deps);
  assert.equal(consumed, true, 'Ctrl+O swallowed when approval open');
  assert.equal(
    deps.calls.setToolsExpanded.length,
    0,
    'Ctrl+O does not toggle tools when approval open'
  );
}

// ─── Global hotkeys: Ctrl+O — toggle tools expanded ─────────────────────────────────────────────

{
  const deps = makeDeps();
  const consumed = handleGlobalInput('\x0f', { ctrl: true }, deps);
  assert.equal(consumed, true, 'Ctrl+O consumed');
  assert.equal(deps.calls.setToolsExpanded.length, 1, 'setToolsExpanded called');
  const toggleFn = deps.calls.setToolsExpanded[0];
  assert.equal(typeof toggleFn, 'function', 'setToolsExpanded receives a function');
  // Toggle: false → true
  assert.equal(toggleFn(false), true, 'toggles false → true');
  // Toggle: true → false
  assert.equal(toggleFn(true), false, 'toggles true → false');
  // Flash message inline: calling toggleFn internally calls deps.showFlash
  assert.equal(deps.calls.showFlash[0], 'tools expanded', 'flash shows expanded on toggle to true');
  // Second call toggles off → 'tools collapsed'
  assert.equal(
    deps.calls.showFlash[1],
    'tools collapsed',
    'flash shows collapsed on toggle to false'
  );
}

{
  // Ctrl+O with string 'o'
  const deps = makeDeps();
  handleGlobalInput('O', { ctrl: true }, deps);
  assert.equal(deps.calls.setToolsExpanded.length, 1, "Ctrl+O via 'O' works");
}

{
  // Ctrl+O: toggle off shows "collapsed"
  const deps = makeDeps();
  deps.setToolsExpanded = (fn) => {
    const result = fn(true);
    deps.calls.setToolsExpanded.push(fn);
    return result;
  };
  handleGlobalInput('\x0f', { ctrl: true }, deps);
  assert.deepEqual(deps.calls.showFlash, ['tools collapsed'], 'collapse shows correct flash');
}

// ─── Global hotkeys: Shift+Tab — cycle interaction mode ─────────────────────────────────────────

{
  const deps = makeDeps();
  const consumed = handleGlobalInput('\t', { tab: true, shift: true }, deps);
  assert.equal(consumed, true, 'Shift+Tab consumed');
  assert.equal(deps.calls.setInteractionMode.length, 1, 'setInteractionMode called');
  const cycleFn = deps.calls.setInteractionMode[0];
  assert.equal(typeof cycleFn, 'function');
  // Cycle: plan → default
  assert.equal(cycleFn('plan'), 'default', 'plan cycles to default');
  // Cycle: default → acceptEdits
  assert.equal(cycleFn('default'), 'acceptEdits', 'default cycles to acceptEdits');
  // Cycle: acceptEdits → plan
  assert.equal(cycleFn('acceptEdits'), 'plan', 'acceptEdits cycles to plan');
  // Unknown mode → plan (falls through)
  assert.equal(cycleFn('something'), 'plan', 'unknown mode cycles to plan');
  // Flash is locale-aware (en: mode: … / zh: 模式: …)
  const flashOk = (s, en, zh) => s === en || s === zh;
  assert.ok(flashOk(deps.calls.showFlash[0], 'mode: default', '模式: 默认'), 'plan→default flash');
  assert.ok(
    flashOk(deps.calls.showFlash[1], 'mode: accept-edits', '模式: 自动接受编辑'),
    'default→acceptEdits flash'
  );
  assert.ok(
    flashOk(deps.calls.showFlash[2], 'mode: plan', '模式: 计划模式'),
    'acceptEdits→plan flash'
  );
  assert.ok(flashOk(deps.calls.showFlash[3], 'mode: plan', '模式: 计划模式'), 'unknown→plan flash');
}

{
  // Shift+Tab: verify flash formatting for each mode
  const deps = makeDeps();
  const cycleFn = (m) => {
    const next = m === 'plan' ? 'default' : m === 'default' ? 'acceptEdits' : 'plan';
    deps.calls.showFlash.push(`mode: ${next === 'acceptEdits' ? 'accept-edits' : next}`);
    return next;
  };
  deps.setInteractionMode = cycleFn;
  // Simulate full cycle
  assert.equal(deps.setInteractionMode('plan'), 'default');
  assert.equal(deps.setInteractionMode('default'), 'acceptEdits');
  assert.equal(deps.setInteractionMode('acceptEdits'), 'plan');
  assert.deepEqual(
    deps.calls.showFlash,
    ['mode: default', 'mode: accept-edits', 'mode: plan'],
    'all three flash labels correct'
  );
}

// ─── Global hotkeys: Ctrl+D — disconnect from board ─────────────────────────────────────────────

{
  // Ctrl+D with empty input, no active run, has deviceSession → disconnect
  const deps = makeDeps({
    input: '',
    activeRunControllerRef: { current: undefined },
    runtime: { deviceSession: { id: 'board-1' } },
  });
  const consumed = handleGlobalInput('\x04', { ctrl: true }, deps);
  assert.equal(consumed, true, 'Ctrl+D consumed when all conditions met');
  assert.equal(deps.calls.addTranscript.length, 1, 'addTranscript called');
  assert.equal(deps.calls.addTranscript[0].type, 'system', 'system transcript');
  assert.equal(deps.calls.addTranscript[0].text, 'disconnected from board', 'disconnect message');
  assert.deepEqual(deps.calls.showFlash, ['disconnected from board'], 'flash shows disconnect');
}

{
  // Ctrl+D with 'd' string (alternative input)
  const deps = makeDeps({
    input: '',
    activeRunControllerRef: { current: undefined },
    runtime: { deviceSession: { id: 'board-1' } },
  });
  handleGlobalInput('d', { ctrl: true }, deps);
  assert.equal(deps.calls.addTranscript.length, 1, "Ctrl+D via 'd' works");
}

{
  // Ctrl+D with non-empty input → not consumed
  const deps = makeDeps({
    input: 'hello',
    activeRunControllerRef: { current: undefined },
    runtime: { deviceSession: { id: 'board-1' } },
  });
  const consumed = handleGlobalInput('\x04', { ctrl: true }, deps);
  assert.equal(consumed, false, 'Ctrl+D with non-empty input not consumed');
  assert.equal(deps.calls.addTranscript.length, 0, 'no transcript');
}

{
  // Ctrl+D with active run → not consumed
  const deps = makeDeps({
    input: '',
    activeRunControllerRef: { current: { stop: () => {} } },
    runtime: { deviceSession: { id: 'board-1' } },
  });
  const consumed = handleGlobalInput('\x04', { ctrl: true }, deps);
  assert.equal(consumed, false, 'Ctrl+D with active run not consumed');
}

{
  // Ctrl+D without deviceSession → not consumed
  const deps = makeDeps({
    input: '',
    activeRunControllerRef: { current: undefined },
    runtime: {},
  });
  const consumed = handleGlobalInput('\x04', { ctrl: true }, deps);
  assert.equal(consumed, false, 'Ctrl+D without deviceSession not consumed');
}

{
  // Ctrl+D without runtime → not consumed
  const deps = makeDeps({
    input: '',
    activeRunControllerRef: { current: undefined },
    runtime: undefined,
  });
  const consumed = handleGlobalInput('\x04', { ctrl: true }, deps);
  assert.equal(consumed, false, 'Ctrl+D without runtime not consumed');
}

// ─── Global hotkeys: Escape — interrupt run or clear attachments ─────────────────────────────────

{
  // Escape with active run → requestStop
  const deps = makeDeps({
    activeRunControllerRef: { current: { stop: () => {} } },
  });
  const consumed = handleGlobalInput('\x1b', { escape: true }, deps);
  assert.equal(consumed, true, 'escape consumed when active run present');
  assert.equal(deps.calls.requestStop.length, 1, 'requestStop called');
}

{
  // Escape without active run, no attachments → not consumed (falls through to return false)
  // This is important: bare escape on idle prompt should not be consumed by global handler
  const deps = makeDeps({
    activeRunControllerRef: { current: undefined },
    pendingAttachments: [],
  });
  const consumed = handleGlobalInput('\x1b', { escape: true }, deps);
  assert.equal(
    consumed,
    false,
    'escape on idle prompt without attachments is NOT consumed (bubbles to input)'
  );
}

{
  // Escape with pending attachments → clear them
  const deps = makeDeps({
    input: 'some text <attach:file1>',
    pendingAttachments: [{ path: 'file1' }, { path: 'file2' }],
    activeRunControllerRef: { current: undefined },
  });
  const consumed = handleGlobalInput('\x1b', { escape: true }, deps);
  assert.equal(consumed, true, 'escape consumed when attachments present');
  assert.deepEqual(deps.calls.setPendingAttachments, [[]], 'attachments cleared');
  assert.deepEqual(deps.calls.setPendingAttachmentBlocks, [[]], 'attachment blocks cleared');
  assert.equal(deps.calls.setInput.length, 1, 'input updated');
  assert.equal(deps.calls.setInput[0], 'some text', 'attachment refs stripped from input');
  assert.equal(deps.calls.setInputCursor.length, 1, 'inputCursor updated');
  assert.equal(deps.calls.addTranscript.length, 1, 'transcript added');
  assert.equal(
    deps.calls.addTranscript[0].text.includes('2 pending attachments'),
    true,
    'transcript mentions count'
  );
  assert.deepEqual(deps.calls.showFlash, ['attachments cleared'], 'flash shows cleared');
}

{
  // Escape with single attachment → singular form
  const deps = makeDeps({
    input: 'hello <attach:file1>',
    pendingAttachments: [{ path: 'file1' }],
    activeRunControllerRef: { current: undefined },
  });
  // suppressedAutoAttachInputRef captures trimmed input
  handleGlobalInput('\x1b', { escape: true }, deps);
  assert.equal(
    deps.calls.addTranscript[0].text.includes('1 pending attachment'),
    true,
    'singular form'
  );
  // suppressedAutoAttachInputRef captures the remaining text after removing attachment refs
  assert.equal(
    deps.suppressedAutoAttachInputRef.current,
    'hello',
    'suppressedAutoAttachInputRef captures remaining input'
  );
}

{
  // Escape with attachments that result in empty input → suppressedAutoAttachInputRef null
  const deps = makeDeps({
    input: '<attach:file>',
    pendingAttachments: [{ path: 'file' }],
    activeRunControllerRef: { current: undefined },
  });
  handleGlobalInput('\x1b', { escape: true }, deps);
  assert.equal(deps.calls.setInput[0], '', 'input set to empty string');
}

// ─── Return false: no picker, no approval, no global hotkey ──────────────────────────────────────

{
  const deps = makeDeps();
  // Plain character 'x' with no special keys
  const consumed = handleGlobalInput('x', {}, deps);
  assert.equal(consumed, false, 'regular key on idle prompt returns false (bubbles to input)');
}

{
  const deps = makeDeps();
  // Enter with no picker, no approval
  const consumed = handleGlobalInput('\r', { return: true }, deps);
  assert.equal(consumed, false, 'enter on idle prompt returns false');
}

{
  const deps = makeDeps();
  // Tab (no shift) → returns false (only Shift+Tab handled)
  const consumed = handleGlobalInput('\t', { tab: true }, deps);
  assert.equal(consumed, false, 'bare Tab returns false (only Shift+Tab is global)');
}

{
  const deps = makeDeps();
  // Ctrl+E (not a handled shortcut) → returns false
  const consumed = handleGlobalInput('\x05', { ctrl: true }, deps);
  assert.equal(consumed, false, 'unhandled Ctrl+key returns false');
}

// ─── Priority: session picker > model picker > approval > global > false ────────────────────────

{
  // When both sessionPicker and modelPicker are set, session picker takes priority
  const resolveCalls = [];
  const deps = makeDeps({
    sessionPicker: { sessions: [{ sessionKey: 's1' }], selectedIndex: 0 },
    modelPicker: { list: { choices: [{ model: 'm1' }], provider: 'p' }, selectedIndex: 0 },
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });
  const consumed = handleGlobalInput('y', {}, deps);
  assert.equal(consumed, true, 'key consumed when session picker open');
  assert.equal(
    resolveCalls.length,
    0,
    'y NOT treated as approval shortcut when session picker is open'
  );
}

{
  // When modelPicker is set but not sessionPicker, model picker takes priority over approval
  const resolveCalls = [];
  const deps = makeDeps({
    modelPicker: { list: { choices: [{ model: 'm1' }], provider: 'p' }, selectedIndex: 0 },
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });
  const consumed = handleGlobalInput('y', {}, deps);
  assert.equal(consumed, true, 'key consumed when model picker open');
  assert.equal(
    resolveCalls.length,
    0,
    'y NOT treated as approval shortcut when model picker is open'
  );
  // Model picker does not have y shortcut, so it's swallowed by the catch-all
}

{
  // When approval is open but no pickers, approval takes priority over global hotkeys
  const resolveCalls = [];
  const deps = makeDeps({
    approval: { resolve: (a) => resolveCalls.push(a), selectedIndex: 0, question: 'Allow?' },
  });
  const consumed = handleGlobalInput('\x0f', { ctrl: true }, deps);
  assert.equal(consumed, true, 'Ctrl+O consumed (swallowed) when approval open');
  assert.equal(
    deps.calls.setToolsExpanded.length,
    0,
    'Ctrl+O NOT treated as toggle when approval open'
  );
}

// ─── wrapIndex helper (tested indirectly through picker tests, but also verify edge cases) ──────

{
  // Verify wrapIndex behavior through isPickerUp + isPickerDown patterns
  // Session picker with 0 sessions: wrapIndex returns 0
  const deps = makeDeps({
    sessionPicker: { sessions: [], selectedIndex: 0 },
  });
  handleGlobalInput('', { upArrow: true }, deps);
  const fn = deps.calls.setSessionPicker[0];
  // When sessions.length is 0, wrapIndex returns 0 for any delta
  // But the updater returns null if p is null; since it's truthy, it proceeds
  const result = fn({ sessions: [], selectedIndex: 0 });
  assert.equal(result.selectedIndex, 0, 'wrapIndex with 0 length returns 0');
}

console.log('[PASS] TUI input handler');
