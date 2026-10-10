#!/usr/bin/env node
/**
 * uninstall lists the files it will delete, and refuses HOME, ancestors of
 * HOME or cwd, and directories that are not a Moss config directory.
 */
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
const configFile = path.join(configDir, 'config.json');
assert.match(text, new RegExp(configFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(text, /Will delete:/);
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

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-un-anc-'));
  const cwd = path.join(root, 'skills');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(root, 'config.json'), '{}\n');
  fs.writeFileSync(path.join(cwd, 'SKILL.md'), '# skill\n');
  const lines = [];
  const result = await runUninstall({
    env: { HOME: home, MOSS_CONFIG_DIR: root, LANG: 'C' },
    cwd,
    isTTY: true,
    ask: async () => 'y',
    log: (line) => lines.push(line),
  });
  assert.equal(result.deletedConfig, false);
  assert.match(lines.join('\n'), /parent of the current directory/);
  assert.equal(fs.readFileSync(path.join(cwd, 'SKILL.md'), 'utf8'), '# skill\n');
  assert.equal(fs.existsSync(path.join(root, 'config.json')), true);
}

{
  const grand = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-un-home-anc-'));
  const nestedHome = path.join(grand, 'home');
  fs.mkdirSync(nestedHome);
  fs.writeFileSync(path.join(grand, 'config.json'), '{}\n');
  const lines = [];
  const result = await runUninstall({
    env: { HOME: nestedHome, MOSS_CONFIG_DIR: grand, LANG: 'C' },
    cwd: temp('moss-un-cwd6-'),
    isTTY: true,
    ask: async () => 'y',
    log: (line) => lines.push(line),
  });
  assert.equal(result.deletedConfig, false);
  assert.match(lines.join('\n'), /parent of the home directory/);
  assert.equal(fs.existsSync(nestedHome), true);
  assert.equal(fs.existsSync(path.join(grand, 'config.json')), true);
}

{
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-un-xdg-'));
  fs.writeFileSync(path.join(xdg, 'config.json'), '{}\n');
  fs.mkdirSync(path.join(xdg, 'firefox'));
  fs.writeFileSync(path.join(xdg, 'firefox', 'prefs.js'), 'keep\n');
  const lines = [];
  const result = await runUninstall({
    env: { HOME: home, MOSS_CONFIG_DIR: xdg, LANG: 'C' },
    cwd: temp('moss-un-cwd7-'),
    isTTY: true,
    ask: async () => 'y',
    log: (line) => lines.push(line),
  });
  assert.equal(result.deletedConfig, false);
  assert.match(lines.join('\n'), /not a Moss config directory/);
  assert.match(lines.join('\n'), /firefox/);
  assert.equal(fs.readFileSync(path.join(xdg, 'firefox', 'prefs.js'), 'utf8'), 'keep\n');
  assert.equal(fs.existsSync(path.join(xdg, 'config.json')), true);
}

{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-un-empty-'));
  const lines = [];
  const result = await runUninstall({
    env: { HOME: home, MOSS_CONFIG_DIR: empty, LANG: 'C' },
    cwd: temp('moss-un-cwd8-'),
    isTTY: true,
    ask: async () => 'y',
    log: (line) => lines.push(line),
  });
  assert.equal(result.deletedConfig, false);
  assert.match(lines.join('\n'), /no Moss config files/);
  assert.equal(fs.existsSync(empty), true);
}

{
  const lines = [];
  const result = await runUninstall({
    env: { HOME: home, MOSS_CONFIG_DIR: home, LANG: 'zh_CN.UTF-8' },
    cwd: temp('moss-un-cwd9-'),
    isTTY: true,
    ask: async () => 'y',
    log: (line) => lines.push(line),
  });
  assert.equal(result.deletedConfig, false);
  assert.match(lines.join('\n'), /主目录/);
  assert.equal(fs.existsSync(home), true);
}

console.log('[PASS] uninstall command');
