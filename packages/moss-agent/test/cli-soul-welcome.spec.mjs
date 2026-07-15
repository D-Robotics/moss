#!/usr/bin/env node
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { SoulPicker, WelcomePanel } from '../dist/cli/tui.js';

const rendered = render(
  React.createElement(WelcomePanel, {
    workspace: '/tmp/project',
    device: 'local',
    compact: true,
    tip: 'Ask Moss to inspect the repository.',
    soul: {
      id: 'project-persona',
      identity: 'A project-specific engineering partner.',
      mode: 'replace',
      source: 'workspace-file',
    },
  }),
);

const frame = rendered.lastFrame();
rendered.unmount();
assert.ok(frame.includes('Soul: workspace persona'), 'welcome shows the active Soul source');
assert.ok(frame.includes('/soul'), 'welcome points to the Soul management command');

const picker = render(
  React.createElement(SoulPicker, {
    state: {
      choices: [
        { code: 'DEFAULT', name: '默认 Moss', summary: '通用、专业', isDefault: true },
        { code: 'YYDS', name: '神人', summary: '主动破局' },
      ],
      selectedIndex: 1,
    },
  }),
);
const pickerFrame = picker.lastFrame();
picker.unmount();
assert.ok(pickerFrame.includes('Select Soul / persona'), 'picker has a clear title');
assert.ok(pickerFrame.includes('›  2. YYDS'), 'picker marks the selected persona');
assert.ok(pickerFrame.includes('Esc cancel'), 'picker explains keyboard controls');

console.log('  [PASS] cli-soul-welcome: TUI renders active persona, picker, and entry command');
