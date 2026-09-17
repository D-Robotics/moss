#!/usr/bin/env node
/**
 * Logger — child level delegation + configureRootLogger in-place mutation.
 *
 * Bug these guard against: module-level `const log = getRootLogger().child(...)`
 * is evaluated at import time, BEFORE `configureRootLogger` runs. The old
 * `child()` snapshotted the parent's level at creation (default 'info') and
 * never saw the level `configureRootLogger` later set — so `log.info` calls
 * leaked to the user's terminal even with the default level set to 'warn'.
 *
 * The fix: `child()` delegates the level check to the parent's CURRENT level
 * (dynamic), and `configureRootLogger` mutates the existing root via setLevel
 * (instead of creating a new logger).
 */
import assert from 'node:assert/strict';

import { createLogger, getRootLogger, configureRootLogger } from '../dist/logger.js';

function captureSink() {
  const entries = [];
  const sink = (entry) => entries.push(entry);
  return { entries, sink };
}

// ─── 1. child() delegates level check to the parent (dynamic, not snapshotted) ─

{
  const { entries, sink } = captureSink();
  const parent = createLogger({ scope: 'p', level: 'info', sink });
  const child = parent.child('c');

  // Default level 'info' → child.info emits.
  child.info('one');
  assert.equal(entries.length, 1, 'child.info emits at parent level info');
  assert.equal(entries[0].scope, 'p:c', 'child scope is parent:child');
  assert.equal(entries[0].msg, 'one');

  // Lower the parent's level to 'warn' AFTER the child was created. The child
  // must respect the new level dynamically (not the snapshotted 'info').
  parent.setLevel('warn');
  child.info('two'); // should be suppressed
  child.warn('three'); // should emit
  assert.equal(
    entries.length,
    2,
    'child.info suppressed after parent setLevel warn; child.warn emits'
  );
  assert.equal(entries[1].msg, 'three');
  assert.equal(entries[1].level, 'warn');
}

// ─── 2. child.info at debug level emits; setLevel('error') suppresses warn ───

{
  const { entries, sink } = captureSink();
  const parent = createLogger({ scope: 'p', level: 'debug', sink });
  const child = parent.child('c');
  child.debug('d');
  child.info('i');
  child.warn('w');
  assert.equal(entries.length, 3, 'all levels emit at parent level debug');
  parent.setLevel('error');
  child.warn('w2'); // suppressed
  child.error('e'); // emits
  assert.equal(entries.length, 4, 'only error emits at parent level error');
  assert.equal(entries[3].msg, 'e');
}

// ─── 3. configureRootLogger mutates the existing root (children see the level) ─

{
  // Reset the root to a known state: create it first (simulating import-time
  // getRootLogger().child()), then configureRootLogger with a new level.
  configureRootLogger({ scope: 'moss-agent', level: 'info' });
  const root = getRootLogger();
  const child = root.child('agent:loop');
  // At this point level is 'info'. configureRootLogger to 'warn' (as the CLI
  // does at startup, AFTER module-level children are created).
  configureRootLogger({ scope: 'moss-agent', level: 'warn' });
  // The child must now respect 'warn' — info suppressed, warn emits.
  // (We can't easily capture the root's default sink, but we can assert the
  // child's effective level matches the configured 'warn'.)
  assert.equal(
    child.getLevel(),
    'warn',
    'child created before configureRootLogger sees the configured warn level (dynamic, not snapshotted info)'
  );
  assert.equal(root.getLevel(), 'warn', 'root level is warn after configureRootLogger');
}

console.error('logger: child level is dynamic + configureRootLogger mutates root in place ✓');
