#!/usr/bin/env node
/**
 * O90: a hook whose `timeoutMs` exceeds Node's timer ceiling (2^31 - 1 =
 * 2147483647 ms) used to overflow the timer and fire at ~1ms, so the hook was
 * reported as timed out immediately. The effective timeout must be clamped to
 * 2147483647 ms instead, and the clamp warning printed once per hook (in the
 * UI language: English or Chinese, following src/cli/hooks.ts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createConfiguredHookCallbacks } from '../dist/cli/hooks.js';
import { clearUiLanguage } from '../dist/cli/cli-locale.js';
import { installUiLanguage } from '../dist/utils/ui-language.js';

const IS_WIN = process.platform === 'win32';
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o90-'));
}

function useLang(language) {
  clearUiLanguage();
  installUiLanguage({ language, source: 'flag', setting: 'auto' });
}

/** Capture process.stderr while the async fn runs. */
async function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stderr.write = (chunk, ...rest) => {
    out += String(chunk);
    return true;
  };
  try {
    const value = await fn();
    return { value, stderr: out };
  } finally {
    process.stderr.write = orig;
  }
}

for (const lang of ['en', 'zh']) {
  test(`[${lang}] timeoutMs 1e12 is clamped, not an instant timeout; warning once`, async () => {
    useLang(lang);
    const dir = tmp();
    const marker = path.join(dir, 'ran.txt');
    // Sleep ~0.2s then write the marker. Without the clamp the overflowed
    // ~1ms timer kills the hook before the marker appears; with the clamp the
    // hook runs to completion well under the 2147483647ms ceiling.
    const command = IS_WIN
      ? `ping -n 2 127.0.0.1 >NUL & type nul > "${marker}"`
      : `sleep 0.2 && touch ${JSON.stringify(marker)}`;

    const hooks = createConfiguredHookCallbacks(
      { SessionStart: [{ command, timeoutMs: 1e12 }] },
      { workspaceDir: dir }
    );

    const { stderr } = await captureStderr(async () => {
      await hooks.runSessionStart();
      await hooks.runSessionStart();
      await hooks.runSessionStart();
    });

    // The hook was not treated as timed out: it completed and wrote its marker.
    assert.equal(fs.existsSync(marker), true, 'hook ran to completion (not a timeout)');
    assert.doesNotMatch(
      stderr,
      /\[hook timed out|timed out after|超时（|exited 124/,
      'no timeout reported'
    );

    // The clamp warning is emitted, and exactly once despite three runs.
    const warnedRe =
      lang === 'zh'
        ? new RegExp(`已限制为 ${MAX_TIMER_DELAY_MS} 毫秒`, 'g')
        : new RegExp(`clamped to ${MAX_TIMER_DELAY_MS}ms`, 'g');
    const matches = stderr.match(warnedRe) ?? [];
    assert.equal(matches.length, 1, `clamp warning emitted exactly once (got ${matches.length})`);

    if (lang === 'zh') {
      assert.match(stderr, /钩子/, 'zh calls the hook 「钩子」');
      assert.doesNotMatch(stderr, /timeoutMs|clamped|warning/, 'zh adds no English words');
    }
  });
}
