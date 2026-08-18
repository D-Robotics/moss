#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('published Web subpath exposes stable slots and design tokens', async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')
  );
  assert.ok(manifest.exports['./web']);

  const web = await import('../dist/web-ui/index.js');
  assert.ok(web.MOSS_WEB_SLOTS.includes('conversation.message'));
  assert.ok(web.MOSS_WEB_SLOTS.includes('settings.plugin'));
  assert.ok(web.MOSS_WEB_THEME_TOKENS.includes('--moss-color-surface'));
  assert.ok(web.MOSS_WEB_THEME_TOKENS.includes('--moss-radius-panel'));

  const source = await fs.readFile(new URL('../src/web-ui/index.ts', import.meta.url), 'utf8');
  assert.match(source, /MossWebPluginMountContext/);
  assert.match(source, /MossWebPluginModule/);
});
