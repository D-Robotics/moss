#!/usr/bin/env node
/**
 * MemoryManager — read/write lifecycle.
 * Tests add → getById → update → delete, content deduplication via hash,
 * and scope/topic/pinned attribute persistence.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../dist/memory/index.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-memory-test-'));
}

// ─── 1. Add → getById → delete lifecycle ────────────────────────────────────

{
  const dir = await makeTempDir();
  const mm = new MemoryManager(dir);
  await mm.load();

  const id = await mm.add('RDK X5 board IP is 192.168.1.10', 'memory');
  assert.ok(id, 'add returns an id');
  assert.ok(id.startsWith('mem_'), 'id has mem_ prefix');

  const entry = await mm.getById(id);
  assert.ok(entry, 'getById finds the entry');
  assert.equal(entry.content, 'RDK X5 board IP is 192.168.1.10');
  assert.equal(entry.source, 'memory');

  const deleted = await mm.delete(id);
  assert.equal(deleted, true, 'delete returns true');

  const after = await mm.getById(id);
  assert.equal(after, null, 'entry gone after delete');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 2. Content deduplication — same content updates, not duplicates ─────────

{
  const dir = await makeTempDir();
  const mm = new MemoryManager(dir);
  await mm.load();

  const content = 'User prefers concise responses with code examples';
  const id1 = await mm.add(content);
  const id2 = await mm.add(content);

  assert.equal(id1, id2, 'same content → same id (dedup by hash)');

  const all = await mm.getAll();
  assert.equal(all.length, 1, 'no duplicate entries');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 3. Update patches fields correctly ──────────────────────────────────────

{
  const dir = await makeTempDir();
  const mm = new MemoryManager(dir);
  await mm.load();

  const id = await mm.add('Original content here', 'memory', undefined, {
    scope: 'workspace',
    topic: 'setup',
  });

  const updated = await mm.update(id, {
    content: 'Updated content with new info',
    pinned: true,
    topic: 'deploy',
  });
  assert.equal(updated, true, 'update returns true on success');

  const entry = await mm.getById(id);
  assert.equal(entry.content, 'Updated content with new info', 'content updated');
  assert.equal(entry.pinned, true, 'pinned flag set');
  assert.equal(entry.topic, 'deploy', 'topic updated');

  // Update non-existent id
  const ghost = await mm.update('mem_nonexistent', { pinned: true });
  assert.equal(ghost, false, 'update returns false for missing id');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 4. Scope filtering and pinned ordering ─────────────────────────────────

{
  const dir = await makeTempDir();
  const mm = new MemoryManager(dir);
  await mm.load();

  await mm.add('Workspace fact one', 'memory', undefined, { scope: 'workspace' });
  await mm.add('User preference: dark theme', 'memory', undefined, { scope: 'user' });
  await mm.add('Pinned workspace note', 'memory', undefined, {
    scope: 'workspace',
    pinned: true,
  });

  const workspaceEntries = await mm.listByScope('workspace');
  assert.equal(workspaceEntries.length, 2, 'two workspace entries');
  assert.equal(workspaceEntries[0].pinned, true, 'pinned entry sorts first');

  const userEntries = await mm.listByScope('user');
  assert.equal(userEntries.length, 1, 'one user entry');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 5. Persistence across instances ────────────────────────────────────────

{
  const dir = await makeTempDir();
  const mm1 = new MemoryManager(dir);
  await mm1.load();
  const id = await mm1.add('Persistent fact stored to disk', 'memory');

  // New instance, same directory — should load from index.json
  const mm2 = new MemoryManager(dir);
  await mm2.load();
  const entry = await mm2.getById(id);
  assert.ok(entry, 'entry survives across MemoryManager instances');
  assert.equal(entry.content, 'Persistent fact stored to disk');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 6. add/update enforce secret validation at the write boundary ──────────
{
  const dir = await makeTempDir();
  const mm = new MemoryManager(dir);
  await mm.load();

  // add() must reject secret-shaped content even when the caller skips
  // upstream validation (defense-in-depth at the write boundary).
  await assert.rejects(
    () => mm.add('cached credential: api_key=sk_live_abcdef1234567890xyz123', 'memory'),
    /memory add rejected/,
    'add() rejects secret-shaped content at the write boundary'
  );

  // a normal fact still passes
  const id = await mm.add('a normal workspace fact', 'memory');
  assert.ok(id, 'normal content still accepted after a rejected add');

  // update() must reject patching a secret into an existing entry
  await assert.rejects(
    () => mm.update(id, { content: 'db password=secret12345' }),
    /memory update rejected/,
    'update() rejects secret-shaped patch content'
  );

  // the entry's content is unchanged after the rejected update
  const entry = await mm.getById(id);
  assert.equal(entry.content, 'a normal workspace fact', 'rejected update did not mutate content');

  await fs.rm(dir, { recursive: true, force: true });
}

console.log('✓ memory-manager.spec.mjs — all assertions passed');
