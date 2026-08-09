/**
 * Source-parity harness tests — behaviors derived from Claude Code / Codex / Grok
 * under /Users/d-robotics/Desktop/reference.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { WorkspaceMemory, HIERARCHICAL_AGENTS_POLICY } from '../dist/memory/workspace-memory.js';
import { editFileTool, readFileTool, multiEditTool } from '../dist/tools/file-tools.js';
import { globalToolStateManager } from '../dist/tools/tool-helpers.js';
import { askUserQuestionTool } from '../dist/tools/ask-user-question.js';
import { builtinTools } from '../dist/tools/builtin.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

test('Codex hierarchical path: root + nested AGENTS.md both load when cwd is nested', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-hier-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# root rules\nUse pnpm.');
  const nested = path.join(root, 'packages', 'app');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, 'CLAUDE.md'), '# package rules\nPrefer local tests.');

  // workspace = monorepo root, cwd = nested package (Codex root→cwd walk)
  const mem = new WorkspaceMemory({ workspaceDir: root, cwd: nested });
  const c = await mem.loadContext();
  assert.match(c.agentRules, /root rules/);
  assert.match(c.agentRules, /package rules/);
  assert.match(c.agentRules, /Hierarchical project instructions|deeper path overrides/i);
  assert.ok(
    c.agentRules.includes(HIERARCHICAL_AGENTS_POLICY.split('\n')[0]) ||
      /deeper path/i.test(c.agentRules)
  );
});

test('Codex AGENTS.override.md preferred over AGENTS.md in same dir', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ov-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'AGENTS.md'), '# base agents');
  await fs.writeFile(path.join(dir, 'AGENTS.override.md'), '# override agents');

  const mem = new WorkspaceMemory({ workspaceDir: dir, walkAncestors: false });
  const c = await mem.loadContext();
  assert.match(c.agentRules, /override agents/);
  // AGENTS.md should be skipped when override exists
  assert.ok(!c.agentRules.includes('# base agents'));
});

test('Claude read-before-edit: edit_file fails without prior read_file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-rbe-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  globalToolStateManager.clearFileState();
  await fs.writeFile(path.join(dir, 'x.ts'), 'const a = 1;\n');

  const blocked = await editFileTool.execute(
    { path: 'x.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
    ctx(dir)
  );
  assert.match(blocked, /read_file.*before editing/i);

  await readFileTool.execute({ path: 'x.ts' }, ctx(dir));
  const ok = await editFileTool.execute(
    { path: 'x.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
    ctx(dir)
  );
  assert.match(ok, /Edited x\.ts/);
});

test('Claude findSimilarFile: read_file suggests sibling on missing path', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-sim-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Use a genuinely different basename (not case-only) so APFS case-insensitive
  // volumes still treat it as a missing path.
  await fs.writeFile(path.join(dir, 'auth-service.ts'), 'export {}\n');

  const out = await readFileTool.execute({ path: 'authService.ts' }, ctx(dir));
  assert.match(out, /file not found/i);
  assert.match(out, /Did you mean/);
  assert.match(out, /auth-service\.ts/i);
});

test('Grok/Claude ask_user_question is registered and fails closed without interactive asker', async () => {
  assert.ok(builtinTools.some((t) => t.name === 'ask_user_question'));
  const out = await askUserQuestionTool.execute(
    {
      questions: [
        {
          question: 'Which approach?',
          options: [{ label: 'A (Recommended)' }, { label: 'B' }],
        },
      ],
    },
    ctx(process.cwd())
  );
  assert.match(out, /non-interactive|unavailable|best judgment/i);
});

test('multi_edit also requires prior read (Claude FileEdit discipline)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-me-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  globalToolStateManager.clearFileState();
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const A = 1;\n');

  const blocked = await multiEditTool.execute(
    {
      edits: [
        { path: 'a.ts', old_string: 'export const A = 1;', new_string: 'export const A = 2;' },
      ],
    },
    ctx(dir)
  );
  assert.match(blocked, /read_file|before editing/i);
});
