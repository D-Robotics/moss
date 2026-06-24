#!/usr/bin/env node
/**
 * `moss migrate` moves legacy dmoss runtime dirs into .moss and rewrites legacy
 * <dmoss_*> session checkpoint tags to <moss_*> so paused goals resume.
 *
 * Run after `npm run build -w @rdk-moss/agent`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrateCommand } from '../dist/cli/migrate-command.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-migrate-'));
const origWrite = process.stdout.write.bind(process.stdout);
function captureRun(workspace, env) {
  const out = [];
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  try {
    runMigrateCommand(workspace, env);
  } finally {
    process.stdout.write = origWrite;
  }
  return out.join('');
}

try {
  const xdg = path.join(tmp, 'xdg');
  fs.mkdirSync(path.join(xdg, 'dmoss'), { recursive: true });
  const workspace = path.join(tmp, 'ws');
  const legacySessions = path.join(workspace, '.dmoss-runtime', 'sessions');
  fs.mkdirSync(legacySessions, { recursive: true });
  fs.writeFileSync(
    path.join(legacySessions, 's1.jsonl'),
    '{"role":"user","content":"<dmoss_goal_checkpoint version=\\"1\\">{}</dmoss_goal_checkpoint>"}\n',
  );

  captureRun(workspace, { XDG_CONFIG_HOME: xdg });

  // 1. session moved into .moss/sessions with checkpoint tags rewritten
  const moved = path.join(workspace, '.moss', 'sessions', 's1.jsonl');
  assert.ok(fs.existsSync(moved), 'session moved into .moss/sessions');
  const content = fs.readFileSync(moved, 'utf8');
  assert.ok(content.includes('<moss_goal_checkpoint'), 'legacy tag rewritten to <moss_*>');
  assert.ok(content.includes('</moss_goal_checkpoint>'), 'closing tag rewritten');
  assert.ok(!content.includes('dmoss_'), 'no legacy dmoss_ tags remain');
  assert.equal(fs.existsSync(path.join(workspace, '.dmoss-runtime')), false, 'legacy .dmoss-runtime removed');

  // 2. global config dir relocated
  assert.ok(fs.existsSync(path.join(xdg, 'moss')), 'legacy ~/.config/dmoss relocated to moss');
  assert.equal(fs.existsSync(path.join(xdg, 'dmoss')), false, 'legacy ~/.config/dmoss removed');

  // 3. idempotent
  const second = captureRun(workspace, { XDG_CONFIG_HOME: xdg });
  assert.match(second, /Nothing to migrate/, 'second run is idempotent');

  console.log('[PASS] moss migrate moves legacy dirs + rewrites <dmoss_*> checkpoint tags');
} finally {
  process.stdout.write = origWrite;
  fs.rmSync(tmp, { recursive: true, force: true });
}
