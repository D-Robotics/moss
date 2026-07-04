#!/usr/bin/env node
/**
 * soul.md resolver — file-based persona discovery + merge.
 *
 * Verifies: (1) no soul file → default identity, source 'default'; (2) workspace
 * `.moss/soul.md` wins over global; (3) global `<configDir>/soul.md` used when no
 * workspace file; (4) frontmatter `id`/`mode` parsed; (5) non-default soul gets
 * the non-overridable model-honesty footer appended; (6) `prepend` mode keeps
 * the default identity and layers the soul on top.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSoul, resolveSoulIdentity } from '../dist/cli/soul.js';
import { buildMossCliIdentity } from '../dist/cli/identity.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-soul-test-'));
}

async function writeFile(dir, rel, content) {
  const p = path.join(dir, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf-8');
  return p;
}

// ─── 1. no soul file → default identity ─────────────────────────────────────
{
  const dir = await makeTempDir();
  const soul = resolveSoul({ workspaceDir: dir, configDir: dir, model: 'm-test' });
  assert.equal(soul.source, 'default', 'no soul file → default source');
  assert.equal(soul.id, 'moss-default');
  assert.ok(soul.identity.includes('You are Moss'), 'default identity present');
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 2. workspace soul wins over global ─────────────────────────────────────
{
  const ws = await makeTempDir();
  const cfg = await makeTempDir();
  await writeFile(ws, '.moss/soul.md', 'You are Studio, a board-focused agent.');
  await writeFile(cfg, 'soul.md', 'You are Global, never used.');
  const soul = resolveSoul({ workspaceDir: ws, configDir: cfg });
  assert.equal(soul.source, 'workspace-file', 'workspace soul takes precedence');
  assert.ok(soul.identity.includes('Studio'), 'workspace soul body used');
  assert.ok(!soul.identity.includes('Global'), 'global soul not used when workspace present');
  await fs.rm(ws, { recursive: true, force: true });
  await fs.rm(cfg, { recursive: true, force: true });
}

// ─── 3. global soul used when no workspace file ─────────────────────────────
{
  const ws = await makeTempDir();
  const cfg = await makeTempDir();
  await writeFile(cfg, 'soul.md', 'You are Global Agent.');
  const soul = resolveSoul({ workspaceDir: ws, configDir: cfg });
  assert.equal(soul.source, 'global-file');
  assert.ok(soul.identity.includes('Global Agent'));
  await fs.rm(ws, { recursive: true, force: true });
  await fs.rm(cfg, { recursive: true, force: true });
}

// ─── 4. frontmatter id/mode parsed ──────────────────────────────────────────
{
  const ws = await makeTempDir();
  await writeFile(ws, '.moss/soul.md', '---\nid: rdk-studio\nmode: prepend\n---\nYou are RDK Studio.');
  const soul = resolveSoul({ workspaceDir: ws });
  assert.equal(soul.id, 'rdk-studio', 'frontmatter id parsed');
  assert.equal(soul.mode, 'prepend', 'frontmatter mode parsed');
  assert.ok(soul.identity.startsWith('You are RDK Studio.'), 'body after frontmatter');
  await fs.rm(ws, { recursive: true, force: true });
}

// ─── 5. non-default soul gets the model-honesty footer ──────────────────────
{
  const ws = await makeTempDir();
  await writeFile(ws, '.moss/soul.md', 'You are Custom.');
  const identity = resolveSoulIdentity({ workspaceDir: ws, model: 'm-x', usingBundledDefault: true });
  assert.ok(identity.includes('You are Custom.'), 'soul body present');
  assert.ok(/non-overridable|不可覆盖/i.test(identity), 'model-honesty footer appended');
  assert.ok(identity.includes('current_model'), 'footer references current_model tool');
  await fs.rm(ws, { recursive: true, force: true });
}

// ─── 6. default soul has no separate footer (identity embeds it) ────────────
{
  const dir = await makeTempDir();
  const identity = resolveSoulIdentity({ workspaceDir: dir, configDir: dir, model: 'm' });
  const defaultIdentity = buildMossCliIdentity({ model: 'm' });
  assert.equal(identity, defaultIdentity, 'default soul → exactly the default identity (no double footer)');
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 7. prepend mode layers soul over default identity + footer ─────────────
{
  const ws = await makeTempDir();
  await writeFile(ws, '.moss/soul.md', '---\nmode: prepend\n---\nExtra persona layer.');
  const identity = resolveSoulIdentity({ workspaceDir: ws, model: 'm' });
  assert.ok(identity.includes('Extra persona layer.'), 'soul prepended');
  assert.ok(identity.includes('You are Moss'), 'default identity kept under prepend');
  assert.ok(/non-overridable|不可覆盖/i.test(identity), 'footer still appended');
  await fs.rm(ws, { recursive: true, force: true });
}

console.log('  [PASS] cli-soul: soul.md discovery, frontmatter, footer, prepend, default fallback');
