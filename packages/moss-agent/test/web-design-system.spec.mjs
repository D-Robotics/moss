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
  assert.match(
    styles,
    /width:\s*min\(88vw,\s*20\.5rem\)/,
    'mobile drawers keep a subpixel-safe 328px upper bound'
  );
  assert.match(styles, /prefers-reduced-motion/);
});

test('workbench start surface exposes actionable prompts and honest composer controls', async () => {
  const [styles, script] = await Promise.all([
    readFile(new URL('workbench.css', clientRoot), 'utf8'),
    readFile(new URL('workbench.js', clientRoot), 'utf8'),
  ]);

  assert.match(script, /Start with an outcome/);
  assert.match(script, /Describe the result, constraints, and how Moss should prove it/);
  assert.match(script, /Add a skill mention/);
  assert.match(script, /Add a slash command/);
  assert.match(script, /Enter to send/);
  assert.match(styles, /\.starter-list/);
  assert.match(styles, /\.composer-select-label/);
  assert.match(styles, /\.execution-card\s*{[^}]*display:\s*grid/s);
  assert.match(styles, /\.details-panel\s*{[^}]*overflow-x:\s*hidden/s);
  assert.match(
    styles,
    /data-sidebar-collapsed[^}]*\.workspace-picker[^}]*\.no-sessions[^}]*display:\s*none/s
  );
  assert.doesNotMatch(script, />@ Skills</);
});
