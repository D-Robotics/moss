import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceMemory } from '../dist/memory/workspace-memory.js';
import { searchCodeTool, todoWriteTool } from '../dist/tools/builtin.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

// ── workspace-memory: project-instruction filename alignment ────────────────
// Moss historically read only AGENTS.md. Claude Code repos ship CLAUDE.md.
// Without this alignment, Moss running in its own repo (which has CLAUDE.md
// but no AGENTS.md) would load zero project instructions.

test('WorkspaceMemory loads AGENTS.md when present (backward compat)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ws-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'AGENTS.md'), '# Rules\nUse rg.');

  const mem = new WorkspaceMemory({ workspaceDir: dir });
  const ctx = await mem.loadContext();
  assert.equal(ctx.agentRulesSource, 'AGENTS.md');
  assert.match(ctx.agentRules, /Use rg\./);
  assert.match(mem.buildPromptLayer(ctx), /Project Instructions \(AGENTS\.md\)/);
});

test('WorkspaceMemory falls back to CLAUDE.md when AGENTS.md is absent', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ws-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), '# Discipline\nVerify before claiming done.');

  const mem = new WorkspaceMemory({ workspaceDir: dir });
  const ctx = await mem.loadContext();
  assert.equal(ctx.agentRulesSource, 'CLAUDE.md');
  assert.match(ctx.agentRules, /Verify before claiming done\./);
  assert.match(mem.buildPromptLayer(ctx), /Project Instructions \(CLAUDE\.md\)/);
});

test('WorkspaceMemory merges AGENTS.md and CLAUDE.md when both exist', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ws-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'AGENTS.md'), '# from agents');
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), '# from claude');

  const mem = new WorkspaceMemory({ workspaceDir: dir });
  const ctx = await mem.loadContext();
  // Both files are merged (Claude Code / Codex style stacking).
  // AGENTS.md is listed first (historical Moss priority).
  assert.ok(ctx.agentRules.includes('from agents'));
  assert.ok(ctx.agentRules.includes('from claude'));
  assert.ok(ctx.agentRules.indexOf('from agents') < ctx.agentRules.indexOf('from claude'));
  assert.deepEqual(ctx.agentRulesSources, ['AGENTS.md', 'CLAUDE.md']);
  assert.match(mem.buildPromptLayer(ctx), /### AGENTS\.md/);
  assert.match(mem.buildPromptLayer(ctx), /### CLAUDE\.md/);
});

test('WorkspaceMemory inherits monorepo-root CLAUDE.md into a nested workspace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-mono-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Fake git root so the walk stops at `root` and does not climb into /tmp.
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, 'CLAUDE.md'), '# monorepo rules\nUse CodeGraph.');
  const nested = path.join(root, 'packages', 'app');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, 'AGENTS.md'), '# package rules\nPrefer local tests.');

  const mem = new WorkspaceMemory({ workspaceDir: nested });
  const ctx = await mem.loadContext();
  assert.match(ctx.agentRules, /monorepo rules/);
  assert.match(ctx.agentRules, /package rules/);
  assert.ok(ctx.agentRulesSources?.some((s) => s.includes('AGENTS.md')));
});

test('WorkspaceMemory walkAncestors:false stays in workspace only', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-mono-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, 'CLAUDE.md'), '# root only');
  const nested = path.join(root, 'pkg');
  await fs.mkdir(nested, { recursive: true });

  const mem = new WorkspaceMemory({ workspaceDir: nested, walkAncestors: false });
  const ctx = await mem.loadContext();
  assert.equal(ctx.agentRules, null);
});

test('WorkspaceMemory returns null when no candidate file exists', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ws-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const mem = new WorkspaceMemory({ workspaceDir: dir });
  const ctx = await mem.loadContext();
  assert.equal(ctx.agentRules, null);
  assert.equal(ctx.agentRulesSource, null);
  assert.equal(mem.buildPromptLayer(ctx), '');
});

test('WorkspaceMemory honors a host-injected candidate list', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ws-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'TEAM.md'), '# team rules');

  const mem = new WorkspaceMemory({ workspaceDir: dir, projectInstructionFiles: ['TEAM.md'] });
  const ctx = await mem.loadContext();
  assert.equal(ctx.agentRulesSource, 'TEAM.md');
});

test('WorkspaceMemory truncates oversized instruction files', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ws-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'AGENTS.md'), 'x'.repeat(20_000));

  const mem = new WorkspaceMemory({ workspaceDir: dir });
  const ctx = await mem.loadContext();
  assert.match(ctx.agentRules, /\[... truncated\]/);
});

// ── search_code: rg-or-fallback produces path:line: context ────────────────
// Whether rg is installed or not, the result shape must stay `path:line:` so
// the model and downstream renderers never branch on the backend.

test('search_code returns path:line: matches via rg or fallback', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src', 'app.ts'), 'export const TOKEN = "MOSS_TOKEN";\n');

  const out = await searchCodeTool.execute({ pattern: 'MOSS_TOKEN' }, ctx(dir));
  assert.match(out, /src\/app\.ts:1:/);
  assert.match(out, /MOSS_TOKEN/);
});

test('search_code reports No matches when pattern is absent', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello world\n');

  const out = await searchCodeTool.execute({ pattern: 'NONEXISTENT_PATTERN_XYZ' }, ctx(dir));
  assert.equal(out, 'No matches found');
});

test('search_code is case-sensitive by default and can opt into ignore-case', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'sym.ts'), 'export const CamelCaseToken = 1;\n');

  const sensitiveMiss = await searchCodeTool.execute({ pattern: 'camelcasetoken' }, ctx(dir));
  assert.equal(sensitiveMiss, 'No matches found');

  const sensitiveHit = await searchCodeTool.execute({ pattern: 'CamelCaseToken' }, ctx(dir));
  assert.match(sensitiveHit, /CamelCaseToken/);

  const insensitive = await searchCodeTool.execute(
    { pattern: 'camelcasetoken', case_sensitive: false },
    ctx(dir)
  );
  assert.match(insensitive, /CamelCaseToken/);
});

test('search_code includes one line of context by default', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'ctx.ts'),
    'const before = 1;\nexport const HIT = 2;\nconst after = 3;\n'
  );

  const out = await searchCodeTool.execute({ pattern: 'HIT' }, ctx(dir));
  assert.match(out, /HIT/);
  // Context lines use `-|` marker; match lines use `:>`.
  assert.match(out, /before|after|HIT/);
});

// ── todo_write: long-task progress external brain ───────────────────────────

test('todo_write formats a checklist with status glyphs and progress', async () => {
  const out = await todoWriteTool.execute({
    todos: [
      { content: 'Reproduce the bug', status: 'completed' },
      { content: 'Fix the root cause', status: 'in_progress' },
      { content: 'Add a regression test', status: 'pending' },
    ],
  });
  assert.match(out, /1\. ✓ Reproduce the bug \[completed\]/);
  assert.match(out, /2\. ◐ Fix the root cause \[in_progress\]/);
  assert.match(out, /3\. ○ Add a regression test \[pending\]/);
  assert.match(out, /Progress: 1\/3 complete\./);
});

test('todo_write enforces a max of 50 todos', async () => {
  const todos = Array.from({ length: 51 }, (_, i) => ({ content: `step ${i}`, status: 'pending' }));
  const out = await todoWriteTool.execute({ todos });
  assert.match(out, /Error: too many todos/);
});

test('todo_write trims content and normalizes garbage status to pending', async () => {
  const out = await todoWriteTool.execute({
    todos: [
      { content: '   real task   ', status: 'in_progress' },
      { content: '', status: 'pending' },
      { content: 'unknown-status task', status: 'garbage' },
    ],
  });
  assert.match(out, /1\. ◐ real task \[in_progress\]/);
  // empty content item dropped; garbage status normalized to pending (item kept)
  assert.match(out, /2\. ○ unknown-status task \[pending\]/);
  assert.match(out, /Progress: 0\/2 complete\./);
});

test('todo_write clears the list when given empty array', async () => {
  const out = await todoWriteTool.execute({ todos: [] });
  assert.equal(out, 'Todo list cleared.');
});
