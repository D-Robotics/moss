#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { promoteSkillCandidate } from '../dist/skill-learning/index.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-promoter-safety-'));
try {
  const preserved = path.join(
    workspace,
    '.moss',
    'skills',
    'operator-skill',
    'references',
    'keep.txt'
  );
  await fs.mkdir(path.dirname(preserved), { recursive: true });
  await fs.writeFile(preserved, 'operator-owned');

  const candidateDir = path.join(workspace, '.moss', 'skills', 'candidates', '!!!');
  await fs.mkdir(candidateDir, { recursive: true });
  await fs.writeFile(
    path.join(candidateDir, 'candidate.json'),
    JSON.stringify({
      candidateId: '!!!',
      sourceKind: 'conversation',
      createdAt: Date.now(),
      sourceSessionKey: 'safety-test',
      turnHash: 'turn',
      gate: 'strict',
      toolCalls: [{ name: 'read_file', input: {}, failed: false }],
      toolNames: ['read_file'],
      userMessage: 'read a file',
      assistantText: 'done',
      runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 1 },
    })
  );

  await assert.rejects(
    () => promoteSkillCandidate({ workspaceDir: workspace, candidateId: '!!!' }),
    /normalized skill ID is empty/
  );
  assert.equal(await fs.readFile(preserved, 'utf8'), 'operator-owned');
  await assert.rejects(() => fs.access(path.join(workspace, '.moss', 'skills', 'SKILL.md')));
} finally {
  await fs.rm(workspace, { recursive: true, force: true });
}

console.log('skill-promoter-safety: invalid normalized IDs cannot target the skills root');
