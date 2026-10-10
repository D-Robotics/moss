#!/usr/bin/env node
/** uninstall prints paths, asks on a TTY, and refuses HOME, /, and cwd. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configDirDeletionRefusal, runUninstall } from '../dist/cli/uninstall.js';

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const home = temp('moss-un-home-');
const configDir = path.join(temp('moss-un-cfg-'), 'moss');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'config.json'), '{"model":"x"}\n');

const lines = [];
const asked = [];
const deleted = await runUninstall({
  env: { HOME: home, MOSS_CONFIG_DIR: configDir },
  cwd: temp('moss-un-cwd-'),
  isTTY: true,
  ask: async (prompt) => {
    asked.push(prompt);
    return 'y';
  },
  log: (line) => lines.push(line),
});
const text = lines.join('\n');
assert.equal(deleted.deletedConfig, true);
assert.match(text, /npm uninstall -g /);
assert.match(text, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(text, /config\.json|Config directory/);
assert.equal(fs.existsSync(configDir), false);
assert.ok(asked[0]?.includes(configDir));
assert.match(text, /Deleted config/);

{
  const kept = [];
  const result = await runUninstall({
    env: { HOME: home, MOSS_CONFIG_DIR: configDir },
    cwd: temp('moss-un-cwd2-'),
    isTTY: false,
    log: (line) => kept.push(line),
  });
  assert.equal(result.deletedConfig, false);
  assert.match(kept.join('\n'), /not present|Kept config/);
}

{
  const refused = [];
  const result = await runUninstall({
    env: { HOME: home, MOSS_CONFIG_DIR: home },
    cwd: temp('moss-un-cwd3-'),
    isTTY: true,
    ask: async () => 'y',
    log: (line) => refused.push(line),
  });
  assert.equal(result.deletedConfig, false);
  assert.match(refused.join('\n'), /home directory/);
  assert.equal(fs.existsSync(home), true);
}

{
  const root = path.parse(process.cwd()).root;
  assert.match(
    configDirDeletionRefusal(root, { HOME: home }, 'linux', temp('moss-un-cwd4-')) ?? '',
    /root/
  );
  const cwd = temp('moss-un-cwd5-');
  assert.match(
    configDirDeletionRefusal(cwd, { HOME: home }, 'linux', cwd) ?? '',
    /current directory/
  );
}

console.log('[PASS] uninstall command');
