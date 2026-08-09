#!/usr/bin/env node
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SoulPicker, WelcomePanel, deriveOnboardingState } from '../dist/cli/tui.js';

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
  })
);

const frame = rendered.lastFrame();
rendered.unmount();
assert.ok(frame.includes('Soul: workspace persona'), 'welcome shows the active Soul source');
assert.ok(frame.includes('/soul'), 'welcome points to the Soul management command');
assert.ok(
  !frame.includes('/tmp/project'),
  'compact welcome does not repeat the workspace already shown in the launch card'
);

const onboarding = render(
  React.createElement(WelcomePanel, {
    workspace: '/tmp/project',
    device: 'local',
    compact: true,
    onboardingHint: [
      'Quick tips for this session:',
      '',
      '💻 Local dev is ready now.',
      '🔌 Run /connect <board-ip> for board tools.',
      '📋 Run /init for project instructions.',
    ].join('\n'),
  })
);
const onboardingFrame = onboarding.lastFrame();
onboarding.unmount();
assert.ok(
  !onboardingFrame.includes('Tip: Quick tips'),
  'onboarding does not duplicate the Tip/Quick tips heading'
);
assert.ok(
  onboardingFrame.includes('💻 Local dev is ready now.'),
  'onboarding keeps actionable lines'
);

const returning = render(
  React.createElement(WelcomePanel, {
    workspace: '/tmp/new-project',
    device: 'local',
    compact: true,
    onboardingHint: '',
    soul: {
      id: 'default',
      identity: 'Moss',
      mode: 'replace',
      source: 'default',
    },
  })
);
const returningFrame = returning.lastFrame();
returning.unmount();
assert.ok(
  returningFrame.includes('PC Host Agent · no board target'),
  'returning welcome keeps one context line'
);
assert.ok(
  returningFrame.includes('Soul default · /soul'),
  'returning context line keeps Soul discoverable'
);
assert.ok(
  !returningFrame.includes('Local dev is ready'),
  'returning welcome omits repeated setup teaching'
);
assert.ok(!returningFrame.includes('Tip:'), 'returning welcome omits generic tips');
assert.equal(
  returningFrame.trim().split('\n').length,
  1,
  'returning welcome is a single compact line'
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-welcome-'));
const workspace = path.join(tempRoot, 'fresh-workspace');
const configDir = path.join(tempRoot, 'config');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, '.moss_onboarding_shown'), '');
const returningState = deriveOnboardingState({ workspace, configDir });
fs.rmSync(tempRoot, { recursive: true, force: true });
assert.equal(
  returningState.isFirstRun,
  false,
  'global Moss usage prevents first-run teaching in a new workspace'
);

const picker = render(
  React.createElement(SoulPicker, {
    state: {
      choices: [
        { code: 'DEFAULT', name: '默认 Moss', summary: '通用、专业', isDefault: true },
        { code: 'YYDS', name: '神人', summary: '主动破局' },
      ],
      selectedIndex: 1,
    },
    activeSoul: {
      id: 'skillhub-YYDS',
      identity: 'persona',
      source: 'workspace-file',
    },
  })
);
const pickerFrame = picker.lastFrame();
picker.unmount();
assert.ok(pickerFrame.includes('Soul / Persona'), 'picker has a clear title');
assert.ok(pickerFrame.includes('›  2. YYDS'), 'picker marks the selected persona');
assert.ok(pickerFrame.includes('[active]'), 'picker marks the active persona');
assert.ok(pickerFrame.includes('Esc close'), 'picker explains keyboard controls');

console.log('  [PASS] cli-soul-welcome: TUI renders active persona, picker, and entry command');
