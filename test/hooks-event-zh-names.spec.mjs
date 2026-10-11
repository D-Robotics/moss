#!/usr/bin/env node
/**
 * O91: Moss-format hook events show Chinese display names in the zh UI.
 * Config keys / machine surface stay English. Copy-table is the single source.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOOK_EVENT_ZH_NAMES,
  hookEventDisplayName,
  hookEventZhName,
  isMossHookEventId,
} from '../dist/cli/hook-event-names.js';
import { formatHookFailure, createConfiguredHookCallbacks } from '../dist/cli/hooks.js';
import { mergeHooksConfig } from '../dist/cli/config.js';
import { clearUiLanguage } from '../dist/cli/cli-locale.js';
import { installUiLanguage } from '../dist/utils/ui-language.js';

/** Spec table (O91.md) — the 8 user-facing Moss-format events. */
const SPEC_TABLE = Object.freeze({
  PreToolUse: '工具使用前',
  PostToolUse: '工具使用后',
  UserPromptSubmit: '提交用户提示前',
  PermissionRequest: '权限请求时',
  SessionStart: '会话开始时',
  Notification: '通知时',
  Stop: '停止前',
  SubagentStop: '子代理停止前',
});

const EXTRA_TABLE = Object.freeze({
  PreCompact: '压缩前',
  PostCompact: '压缩后',
  SessionEnd: '会话结束时',
});

function setLang(lang) {
  clearUiLanguage();
  installUiLanguage({ language: lang, source: 'flag', setting: 'auto' });
}

function spawnFailedHook() {
  return {
    command: 'moss-o91-missing',
    source: '/tmp/o91/.moss/config.json',
    blocking: true,
  };
}

function spawnFailedResult() {
  return { outcome: 'spawn_failed', exitCode: 127, stdout: '', stderr: 'not found' };
}

test('O91 copy table: 8 spec events match O91.md exactly (no 「钩子」 suffix)', () => {
  for (const [id, zh] of Object.entries(SPEC_TABLE)) {
    assert.equal(HOOK_EVENT_ZH_NAMES[id], zh, id);
    assert.equal(hookEventZhName(id), zh, id);
    assert.ok(!zh.endsWith('钩子'), `${id} table value must not end with 钩子`);
  }
});

test('O91 extras (PreCompact/PostCompact/SessionEnd) follow same suffix-free pattern', () => {
  for (const [id, zh] of Object.entries(EXTRA_TABLE)) {
    assert.equal(HOOK_EVENT_ZH_NAMES[id], zh, id);
    assert.ok(!zh.endsWith('钩子'), `${id} must not end with 钩子 (avoid 钩子钩子)`);
  }
});

test('hookEventDisplayName: en returns English id; zh returns table name', () => {
  for (const id of Object.keys(SPEC_TABLE)) {
    assert.equal(hookEventDisplayName(id, false), id);
    assert.equal(hookEventDisplayName(id, true), SPEC_TABLE[id]);
  }
});

test('isMossHookEventId accepts config keys only', () => {
  assert.equal(isMossHookEventId('Stop'), true);
  assert.equal(isMossHookEventId('停止前'), false);
  assert.equal(isMossHookEventId('Nope'), false);
});

test('[zh] formatHookFailure names Stop/UserPromptSubmit/PermissionRequest with 中文名+钩子, no bare id label', () => {
  setLang('zh');
  const hook = spawnFailedHook();
  const result = spawnFailedResult();
  for (const event of ['Stop', 'UserPromptSubmit', 'PermissionRequest']) {
    const text = formatHookFailure(event, hook, result, true);
    const name = SPEC_TABLE[event];
    assert.match(text, new RegExp(`已拦截：${name}钩子未能启动。`), event);
    assert.doesNotMatch(
      text,
      new RegExp(`已拦截：${event}`),
      `${event}: bare id must not be the label`
    );
    assert.doesNotMatch(text, /钩子钩子/, event);
  }
});

test('[en] formatHookFailure keeps English event ids', () => {
  setLang('en');
  const hook = spawnFailedHook();
  const result = spawnFailedResult();
  for (const event of ['Stop', 'UserPromptSubmit', 'PermissionRequest']) {
    const text = formatHookFailure(event, hook, result, true);
    assert.match(text, new RegExp(`Blocked: ${event} hook could not start\\.`), event);
    assert.doesNotMatch(text, /停止前|提交用户提示前|权限请求时|工具使用前/, event);
  }
});

test('English event keys still load into hooks config (machine surface unchanged)', () => {
  const merged = mergeHooksConfig(undefined, {
    Stop: [{ command: 'echo-stop' }],
    UserPromptSubmit: [{ command: 'echo-ups' }],
    PermissionRequest: [{ command: 'echo-perm' }],
    PreToolUse: [{ command: 'echo-pre' }],
  });
  assert.equal(merged.Stop[0].command, 'echo-stop');
  assert.equal(merged.UserPromptSubmit[0].command, 'echo-ups');
  assert.equal(merged.PermissionRequest[0].command, 'echo-perm');
  assert.equal(merged.PreToolUse[0].command, 'echo-pre');

  // Callbacks wire from the English-keyed config without throwing.
  const cbs = createConfiguredHookCallbacks(
    {
      Stop: [{ command: 'true', blocking: true }],
      PreToolUse: [{ command: 'true', blocking: true }],
    },
    { workspaceDir: process.cwd() }
  );
  assert.equal(typeof cbs.runStop, 'function');
  assert.equal(typeof cbs.onBeforeToolExec, 'function');
});
