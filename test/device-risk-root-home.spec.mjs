#!/usr/bin/env node
/**
 * G4: boards default to the root SSH user, whose home is the protected /root
 * tree. `~`/`$HOME` in device commands and paths must classify against the
 * session's real user, and the confirmation prompt must say the session is
 * root. Legacy callers without a user keep the /home/_user placeholder.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDeviceOperation } from '../dist/safety/device-risk.js';
import { deviceDestructivePrompt } from '../dist/cli/device-safety-prompt.js';

function exec(command, remoteUser) {
  return classifyDeviceOperation({
    toolName: 'device_exec',
    sideEffect: 'device_mutation',
    command,
    ...(remoteUser ? { remoteUser } : {}),
  });
}

test('a root session judges ~ writes by the /root tree they actually touch', () => {
  for (const command of [
    'rm -rf ~/data',
    'rm -rf $HOME/data',
    'rm -rf ${HOME}/data',
    'echo broken > ~/.bashrc',
  ]) {
    const judged = exec(command, 'root');
    assert.ok(judged, `${command} should classify`);
    assert.equal(judged.tier, 'destructive', `${command} on root must be destructive`);
  }
});

test('a root deploy into ~ is a system-path write', () => {
  const judged = classifyDeviceOperation({
    toolName: 'device_deploy',
    sideEffect: 'device_mutation',
    remotePath: '~/app',
    remoteUser: 'root',
  });
  assert.ok(judged);
  assert.equal(judged.tier, 'destructive');
  assert.ok(judged.operand.includes('/root/app'), `operand shows the real path: ${judged.operand}`);
});

test('a non-root user keeps ordinary home semantics', () => {
  const judged = exec('rm -rf ~/data', 'sunrise');
  assert.ok(judged);
  assert.equal(judged.tier, 'reversible', '~/data of a normal user is not a lockout path');
  assert.equal(exec('rm -rf ~', 'sunrise').tier, 'destructive', 'bare ~ is still the home root');
});

test('callers without a user keep the legacy placeholder behavior', () => {
  assert.equal(exec('rm -rf ~/data').tier, 'reversible');
  assert.equal(exec('echo broken > ~/.bashrc').tier, 'reversible');
});

test('readonly work under a root home stays readonly', () => {
  for (const command of ['ls ~', 'cat ~/notes.txt', 'grep x ~/app.log']) {
    assert.equal(exec(command, 'root').tier, 'readonly', `${command} must stay readonly`);
  }
});

test('the destructive prompt says when the session runs as root', () => {
  const zh = deviceDestructivePrompt({
    toolName: 'device_exec',
    tier: 'destructive',
    operand: 'rm -rf /root/data',
    reason: 'write to system path',
    remoteUser: 'root',
    locale: 'zh_CN.UTF-8',
  });
  assert.ok(zh.text.includes('root'), 'zh flat prompt notes the root session');
  assert.ok(
    zh.detail.some((line) => line.includes('root')),
    'zh detail notes the root session'
  );

  const en = deviceDestructivePrompt({
    toolName: 'device_exec',
    tier: 'destructive',
    operand: 'rm -rf /root/data',
    reason: 'write to system path',
    remoteUser: 'root',
    locale: 'C',
  });
  assert.ok(en.text.includes('as root'), 'en flat prompt notes the root session');
  assert.ok(
    en.detail.some((line) => line.includes('as root')),
    'en detail notes the root session'
  );
});

test('the destructive prompt stays silent about users that are not root', () => {
  const judged = deviceDestructivePrompt({
    toolName: 'device_exec',
    tier: 'destructive',
    operand: 'rm -rf /boot/env',
    reason: 'write to system path',
    remoteUser: 'sunrise',
    locale: 'C',
  });
  assert.ok(!judged.text.includes('as root'));
});
