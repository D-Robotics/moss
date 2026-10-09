#!/usr/bin/env node
/**
 * Ordinary chat does not request a task contract. /goal and explicit task
 * flows do.
 */
import assert from 'node:assert/strict';

import { messageRequestsTaskContract } from '../dist/cli/task-flow.js';

assert.equal(messageRequestsTaskContract('what is the board status?'), false);
assert.equal(messageRequestsTaskContract('how do I read the temperature?'), false);
assert.equal(messageRequestsTaskContract('/goal camera stays at 30 fps'), true);
assert.equal(messageRequestsTaskContract('/task status'), true);
assert.equal(messageRequestsTaskContract('please call task_define'), true);
assert.equal(messageRequestsTaskContract('请创建任务并验收'), true);
assert.equal(messageRequestsTaskContract('定义任务：推流 30fps'), true);
assert.equal(messageRequestsTaskContract('补上任务契约'), true);

console.log('[PASS] task flow');
