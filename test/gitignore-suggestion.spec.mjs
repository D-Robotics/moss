#!/usr/bin/env node
/** Generated .gitignore suggestion keeps session logs out of git. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GITIGNORE_SUGGESTION,
  gitignoreCoversMoss,
  gitignoreNoticeForWorkspace,
} from '../dist/cli/gitignore-suggestion.js';

assert.match(GITIGNORE_SUGGESTION, /\.moss\//);
assert.match(GITIGNORE_SUGGESTION, /!\.moss\/skills\//);
assert.equal(gitignoreCoversMoss('.moss/\n'), true);
assert.equal(gitignoreCoversMoss('.moss\n'), true);
assert.equal(gitignoreCoversMoss('.moss/*\n!.moss/skills/\n'), true);
assert.equal(gitignoreCoversMoss('node_modules/\n'), false);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-gitignore-'));
assert.equal(gitignoreNoticeForWorkspace(dir, 'en_US.UTF-8'), undefined, 'not a git checkout');
fs.mkdirSync(path.join(dir, '.git'));
const notice = gitignoreNoticeForWorkspace(dir, 'en_US.UTF-8');
assert.match(notice ?? '', /\.moss\//);
const zh = gitignoreNoticeForWorkspace(dir, 'zh_CN.UTF-8');
assert.match(zh ?? '', /会话日志/);
fs.writeFileSync(path.join(dir, '.gitignore'), '.moss/*\n!.moss/skills/\n');
assert.equal(gitignoreNoticeForWorkspace(dir, 'en_US.UTF-8'), undefined);

console.log('[PASS] gitignore-suggestion');
