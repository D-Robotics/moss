#!/usr/bin/env node
import assert from 'node:assert/strict';
import { renderPermissionsPanel } from '../dist/cli/tui/permissions-panel.js';
import { renderHistoryRule } from '../dist/cli/tui/history-search.js';

const lines = renderPermissionsPanel({
  width: 72,
  mode: 'full',
  cursor: 0,
  rules: [
    { level: 'deny', spec: 'read_file(./.env)', source: 'session', session: true },
    { level: 'allow', spec: 'exec(npm run *)', source: 'user', session: false },
  ],
}).map((entry) => entry.text);

assert.ok(
  lines.some((text) => text.includes('full')),
  'the panel shows the mode'
);
assert.ok(
  lines.some((text) => text.includes('read_file(./.env)')),
  'session rules are listed'
);
assert.ok(lines[2]?.includes('❯'), 'the cursor marks the selected rule');
assert.ok(
  lines.some((text) => text.includes('/permissions add')),
  'adding a rule stays a command'
);

const rule = renderHistoryRule(2, 7, 40).text;
assert.ok(rule.includes('History 2/7'), rule);
assert.ok(rule.startsWith('───'), rule);
