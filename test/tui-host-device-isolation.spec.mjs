#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isolatedCliEnv } from './helpers/isolated-cli-env.mjs';

const env = isolatedCliEnv({
  inherited: {
    PATH: process.env.PATH,
    HOME: '/host/home',
    XDG_CONFIG_HOME: '/host/xdg',
    APPDATA: '/host/appdata',
    MOSS_CONFIG_DIR: '/host/moss',
    MOSS_CONFIG_FILE: '/host/config.json',
    MOSS_CONFIG_PATH: '/host/legacy-config.json',
    MOSS_DEVICE_HOST: 'example.invalid',
    MOSS_DEVICE_PASSWORD: 'must-not-cross',
    MOSS_DEVICE_FUTURE_OPTION: 'must-not-cross',
  },
});
const result = spawnSync(
  process.execPath,
  [
    '-e',
    'console.log(JSON.stringify({env:process.env,device:Object.keys(process.env).filter(k=>k.startsWith("MOSS_DEVICE_"))}))',
  ],
  { encoding: 'utf8', env }
);
assert.equal(result.status, 0, result.stderr);
const child = JSON.parse(result.stdout);

assert.deepEqual(child.device, [], 'all current and future MOSS_DEVICE_* keys are stripped');
assert.equal(child.env.MOSS_NO_RDK_DOCS, '1', 'built-in rdk-docs is disabled in CLI/TUI probes');
assert.ok(
  child.env.XDG_CONFIG_HOME.startsWith(child.env.HOME),
  'XDG config is rooted in the temporary HOME'
);
assert.ok(
  child.env.MOSS_CONFIG_DIR.startsWith(child.env.HOME),
  'Moss config is rooted in temporary HOME'
);
assert.equal(child.env.MOSS_CONFIG_FILE, undefined);
assert.equal(child.env.MOSS_CONFIG_PATH, undefined);
console.log('[PASS] TUI/CLI subprocesses isolate host device and user config');
