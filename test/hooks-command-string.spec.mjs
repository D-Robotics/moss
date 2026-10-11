#!/usr/bin/env node
/**
 * O89: a Moss-format hook whose `command` is not a string (object, array,
 * number, boolean, null) must fail at config load/parse time with a readable
 * "command must be a string" error that names the config file — never at run
 * time as `Command: [object Object]`.
 *
 * Red-green: removing the `assertHookCommandsAreStrings` call in
 * src/cli/config.ts makes every illegal-type assertion below fail while the
 * legal string controls stay green.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliConfigFileError, loadConfigFile } from '../dist/cli/config.js';
import { createConfiguredHookCallbacks } from '../dist/cli/hooks.js';
import { clearUiLanguage } from '../dist/cli/cli-locale.js';
import { installUiLanguage } from '../dist/utils/ui-language.js';

function useLang(language) {
  clearUiLanguage();
  installUiLanguage({ language, source: 'flag', setting: 'auto' });
}

/** Write a config.json carrying `hooks` and return its path. */
function writeHooksConfig(hooks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o89-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({ hooks }, null, 2)}\n`);
  return configPath;
}

/** Capture process.stderr while `fn` runs. */
async function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stderr.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    return { value: await fn(), stderr: out };
  } finally {
    process.stderr.write = orig;
  }
}

const ILLEGAL = [
  { label: 'object', value: { x: 1 } },
  { label: 'array', value: ['echo', 'hi'] },
  { label: 'number', value: 42 },
  { label: 'boolean', value: true },
  { label: 'null', value: null },
];

for (const lang of ['en', 'zh']) {
  // Spec requires at least two illegal variants; cover all five in both UI
  // languages so en and zh each produce a correct illegal-config message.
  for (const bad of ILLEGAL) {
    test(`[${lang}] ${bad.label} command fails at load: must-be-a-string + config path, no [object Object]`, () => {
      useLang(lang);
      const configPath = writeHooksConfig({ PreToolUse: [{ command: bad.value }] });
      let caught;
      try {
        loadConfigFile(configPath);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, 'loadConfigFile must reject a non-string hook command');
      assert.ok(caught instanceof CliConfigFileError, 'error is a CliConfigFileError');
      assert.equal(caught.configPath, configPath);
      // The exact one-liner cli-main shows: `[moss] ${err.message}`.
      const shown = `[moss] ${caught.message}`;
      assert.ok(shown.includes(configPath), `message names the config file: ${shown}`);
      assert.doesNotMatch(shown, /\[object Object\]/);
      // Event name + entry index point at the broken hook.
      assert.match(shown, /PreToolUse\[0\]/);
      if (lang === 'zh') {
        assert.match(shown, /必须是字符串/);
        assert.match(shown, /钩子/);
        // zh copy keeps only whitelisted English tokens: the key `command`,
        // the config path, and the event name.
        assert.doesNotMatch(shown, /Invalid moss config|must be a string|\bhook\b/i);
      } else {
        assert.match(shown, /command must be a string/);
      }
    });
  }
}

test('illegal command in a second event entry is rejected too (index reported)', () => {
  useLang('en');
  const configPath = writeHooksConfig({
    Stop: [{ command: 'echo fine' }, { command: { nested: true } }],
  });
  assert.throws(
    () => loadConfigFile(configPath),
    (err) => {
      assert.ok(err instanceof CliConfigFileError);
      assert.match(err.message, /hooks\.Stop\[1\]\.command must be a string/);
      assert.ok(err.message.includes(configPath));
      return true;
    }
  );
});

test('missing command keeps existing load behavior (no [object Object] invented)', () => {
  useLang('en');
  const configPath = writeHooksConfig({ PreToolUse: [{ timeoutMs: 1000 }] });
  const config = loadConfigFile(configPath); // must not throw: unchanged behavior
  assert.equal(config.hooks.PreToolUse.length, 1);
});

test('legal string command still loads and runs under existing rules', async () => {
  useLang('en');
  const configPath = writeHooksConfig({ Stop: [{ command: 'echo o89-ok' }] });
  const config = loadConfigFile(configPath);
  assert.equal(config.hooks.Stop[0].command, 'echo o89-ok');
  const cbs = createConfiguredHookCallbacks(config.hooks, {
    workspaceDir: path.dirname(configPath),
  });
  const { value, stderr } = await captureStderr(() => cbs.runStop({ stopReason: 'end_turn' }));
  assert.equal(value.blocked, false);
  assert.doesNotMatch(stderr, /\[object Object\]/);
  assert.doesNotMatch(stderr, /\[hooks\]/, 'a clean exit-0 hook prints no failure notice');
});
