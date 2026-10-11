#!/usr/bin/env node
/**
 * O57 first-install copy (roadmap §11/§12/§16, copy-audit 1.2–1.7).
 */
import assert from 'node:assert/strict';

import {
  PROVIDER_KEY_URLS,
  SETUP_PROVIDERS,
  initialFirstRunView,
  renderFirstRunLines,
} from '../dist/cli/first-run.js';
import {
  classifyTrustKey,
  folderTrustPrompt,
  untrustedFolderLine,
} from '../dist/cli/workspace-trust.js';

// §11.1/§11.5: fresh HOME → provider list first, cursor not on D-Robotics.
{
  const view = initialFirstRunView({ HOME: '/nonexistent-o57' });
  assert.equal(view.step, 'provider', 'first screen is provider choice, not key input');
  assert.notEqual(
    SETUP_PROVIDERS[view.cursor].id,
    'd-robotics',
    'cursor does not start on D-Robotics'
  );
  const dr = SETUP_PROVIDERS.find((p) => p.id === 'd-robotics');
  assert.match(dr.en, /internal/i);
  assert.match(dr.zh, /内部用户/);
  assert.doesNotMatch(
    SETUP_PROVIDERS.find((p) => p.id === 'deepseek').en,
    /unverified/,
    '§12 DeepSeek verified'
  );
  for (const id of ['qwen', 'openai', 'anthropic']) {
    assert.match(
      SETUP_PROVIDERS.find((p) => p.id === id).en,
      /unverified/,
      `${id} marked unverified`
    );
  }
}

// key URLs: placeholders only, never invented.
assert.deepEqual(Object.keys(PROVIDER_KEY_URLS), [], 'no unverified key URLs shipped');

// key screen names the provider, gives the way out; zh says "API key", not 密钥.
{
  const en = renderFirstRunLines(
    { step: 'key', provider: 'deepseek', offers: [], cursor: 0, keyDots: 3 },
    'C'
  ).join('\n');
  assert.match(en, /DeepSeek API key \(paste it; shown as dots\)/);
  assert.match(en, /No key yet\?/);
  assert.match(en, /Esc: choose another provider/);
  const zh = renderFirstRunLines(
    { step: 'key', provider: 'deepseek', offers: [], cursor: 0, keyDots: 3 },
    'zh_CN.UTF-8'
  ).join('\n');
  assert.match(zh, /DeepSeek API key（粘贴即可/);
  assert.doesNotMatch(zh, /密钥/);
}

// error screen: no "press 1"; s saves.
{
  const en = renderFirstRunLines(
    {
      step: 'error',
      offers: [],
      cursor: 0,
      failStep: 'key',
      pending: { type: 'probe', provider: 'deepseek', baseUrl: 'https://x' },
    },
    'C'
  ).join('\n');
  assert.match(en, /Enter: try again/);
  assert.match(en, /s: save without testing/);
  assert.doesNotMatch(en, /press 1/);
}

// trust screen: says what Moss will do, y/n only; "1"/Enter do not answer (double-1).
{
  const en = folderTrustPrompt({ folderKey: '/tmp/p', home: false, root: false, zh: false });
  assert.match(en, /read and edit files and run commands/);
  assert.match(en, /^\s+y\s+Trust and continue$/m);
  assert.doesNotMatch(en, /gateway, proxy, TLS/);
  assert.doesNotMatch(en, /^\s+1\s/m);
  const zh = folderTrustPrompt({ folderKey: '/tmp/p', home: false, root: false, zh: true });
  assert.match(zh, /读写文件、运行命令/);
  assert.equal(classifyTrustKey('1'), undefined, '"1" does not trust');
  assert.equal(classifyTrustKey('11'), undefined, 'double "1" does not trust');
  assert.equal(classifyTrustKey('\r'), undefined, 'bare Enter does not trust');
  assert.equal(classifyTrustKey('y'), 'yes');
  assert.equal(classifyTrustKey('n'), 'no');
  assert.equal(classifyTrustKey('\u0003'), 'no');
}

// untrusted line: silent when nothing was skipped; "folder" wording.
assert.equal(untrustedFolderLine([], false), '');
assert.match(
  untrustedFolderLine(['.moss/devices.json'], false),
  /This folder isn't trusted.*\.moss\/devices\.json/
);
assert.match(untrustedFolderLine(['.moss/devices.json'], true), /此文件夹未信任/);

console.log('o57-first-install-copy: ok');
