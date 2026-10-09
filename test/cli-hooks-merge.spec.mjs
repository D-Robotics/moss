#!/usr/bin/env node
/**
 * Project `.moss/config.json` hooks merge every event, not only
 * PreToolUse / PostToolUse / SessionStart.
 */
import assert from 'node:assert/strict';
import { mergeConfigFiles, mergeHooksConfig } from '../dist/cli/config.js';

const events = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'PermissionRequest',
  'SessionStart',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
  'Notification',
];

{
  const project = {
    hooks: Object.fromEntries(events.map((event) => [event, [{ command: `project-${event}` }]])),
  };
  const user = { hooks: { PreToolUse: [{ command: 'user-pre' }] } };
  const merged = mergeConfigFiles(project, user);
  for (const event of events) {
    assert.ok(merged.hooks?.[event]?.length, `${event} from the project config is kept`);
  }
  assert.deepEqual(
    merged.hooks.PreToolUse.map((hook) => hook.command),
    ['project-PreToolUse', 'user-pre'],
    'project hooks run before user hooks'
  );
  assert.equal(merged.hooks.Stop[0].command, 'project-Stop');
  assert.equal(merged.hooks.SessionEnd[0].command, 'project-SessionEnd');
  assert.equal(merged.hooks.Notification[0].command, 'project-Notification');
}

{
  const merged = mergeHooksConfig(undefined, {
    Stop: [{ command: 'only-stop' }],
    PreCompact: [{ command: 'compact' }],
  });
  assert.deepEqual(Object.keys(merged).sort(), ['PreCompact', 'Stop']);
}

{
  assert.equal(mergeHooksConfig(undefined, undefined), undefined);
}

console.log('[PASS] cli-hooks-merge');
