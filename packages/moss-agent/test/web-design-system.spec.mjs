#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const clientRoot = new URL('../dist/web-ui/client/', import.meta.url);

test('bundled workbench exposes the complete Moss design system and layout contract', async () => {
  const [styles, script] = await Promise.all([
    readFile(new URL('workbench.css', clientRoot), 'utf8'),
    readFile(new URL('workbench.js', clientRoot), 'utf8'),
  ]);

  for (const token of [
    '--moss-font-family-body',
    '--moss-font-family-code',
    '--moss-font-size-1',
    '--moss-line-height-body',
    '--moss-space-10',
    '--moss-radius-round',
    '--moss-shadow-dialog',
    '--moss-z-dialog',
    '--moss-state-success',
    '--moss-state-interrupted',
  ]) {
    assert.match(styles, new RegExp(`${token}:`), `missing design token ${token}`);
  }

  for (const primitive of [
    'button',
    'input',
    'tabs',
    'dialog',
    'toast',
    'tooltip',
    'card',
    'disclosure',
    'code',
    'diff',
    'terminal',
  ]) {
    assert.match(
      script,
      new RegExp(`data-moss-ui.{0,20}${primitive}`),
      `missing ${primitive} primitive`
    );
  }

  assert.match(script, /data-moss-component-gallery/);
  assert.match(script, /moss-layout-v1/);
  assert.match(script, /data-resize-handle/);
  assert.match(script, /aria-orientation/);
  assert.match(styles, /\.moss-skip-link/);
  assert.match(styles, /\[data-mobile-drawer/);
  assert.match(styles, /prefers-reduced-motion/);
});
