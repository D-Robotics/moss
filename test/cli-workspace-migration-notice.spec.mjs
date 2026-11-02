import assert from 'node:assert/strict';
import test from 'node:test';
import { formatWorkspaceMigrationNotices } from '../dist/cli/workspace-migration-notice.js';
import { createTuiNoticeSource } from '../dist/cli/tui-notice-source.js';

test('fixed notices do not expose Windows-style paths or error strings', () => {
  const untrusted = {
    skippedPaths: ['C:\\Users\\example\\sk-private-token\\skills\\legacy'],
    cleanupWarnings: [{ path: 'D:\\projects\\private\\agent', code: 'opaque-error' }],
  };
  for (const zh of [false, true]) {
    const text = formatWorkspaceMigrationNotices(
      untrusted.skippedPaths.length > 0,
      untrusted.cleanupWarnings.length > 0,
      zh
    ).join('\n');
    assert.ok(!text.includes(untrusted.skippedPaths[0]));
    assert.ok(!text.includes(untrusted.cleanupWarnings[0].path));
    assert.ok(!text.includes(untrusted.cleanupWarnings[0].code));
    assert.match(text, /skill-candidates\//);
    assert.match(text, /\.moss\/skills\//);
    assert.doesNotMatch(text, /\\/);
  }
});

test('fullscreen startup notices replay once; other notices still buffer and stream', () => {
  const source = createTuiNoticeSource(['startup']);
  source.emit('buffered');
  const seen = [];
  const unsubscribe = source.subscribe((text) => seen.push(text), true);
  source.emit('live');
  unsubscribe();
  source.emit('after');
  source.subscribe((text) => seen.push(text), true);
  assert.deepEqual(seen, ['startup', 'buffered', 'live', 'after']);
});

test('inline startup does not replay a notice already printed before the TUI', () => {
  const source = createTuiNoticeSource(['startup']);
  source.emit('buffered');
  const seen = [];
  source.subscribe((text) => seen.push(text), false);
  assert.deepEqual(seen, ['buffered']);
});

test('fixed notices are absent when there is no skipped path or cleanup warning', () => {
  assert.deepEqual(formatWorkspaceMigrationNotices(false, false, false), []);
  assert.deepEqual(formatWorkspaceMigrationNotices(false, false, true), []);
});
