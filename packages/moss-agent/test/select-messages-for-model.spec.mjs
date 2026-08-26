#!/usr/bin/env node
import assert from 'node:assert/strict';
import { selectMessagesForModel } from '../dist/core/loop/agent-loop-context-prep.js';

const current = [{ role: 'user', content: 'full-history', timestamp: 1 }];
const pruned = [{ role: 'user', content: 'pruned-window', timestamp: 2 }];
const dropped = [{ role: 'user', content: 'old-snapshot', timestamp: 0 }];

assert.equal(
  selectMessagesForModel({
    pendingToolResultFollowUp: false,
    currentMessages: current,
    prunedMessages: pruned,
    droppedMessages: dropped,
    promptPruneCompactionSucceeded: false,
  })[0].content,
  'full-history',
  'before a compact attempt, do not silently drop history',
);

assert.equal(
  selectMessagesForModel({
    pendingToolResultFollowUp: false,
    currentMessages: current,
    prunedMessages: pruned,
    droppedMessages: dropped,
    promptPruneCompactionSucceeded: false,
    promptPruneCompactionAttempted: true,
  })[0].content,
  'pruned-window',
  'after compact timeout/fail, send the mechanically pruned window so the click loop can continue',
);

assert.equal(
  selectMessagesForModel({
    pendingToolResultFollowUp: false,
    currentMessages: current,
    prunedMessages: pruned,
    droppedMessages: dropped,
    promptPruneCompactionSucceeded: true,
    promptPruneCompactionAttempted: true,
  })[0].content,
  'pruned-window',
);

console.log('[PASS] failed prompt-prune compaction fail-softs to the pruned window');
