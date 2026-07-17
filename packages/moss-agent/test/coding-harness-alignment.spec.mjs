import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceMemory } from '../dist/memory/workspace-memory.js';
import { searchCodeTool, searchFilesTool, todoWriteTool, execTool } from '../dist/tools/builtin.js';

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

// ── search_code Grep parity: output_mode / glob ─────────────────────────────

test('search_code output_mode files_with_matches returns paths only', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src', 'a.ts'), 'export const ALPHA_MARKER = 1;\n');
  await fs.writeFile(path.join(dir, 'src', 'b.ts'), 'export const ALPHA_MARKER = 2;\n');
  await fs.writeFile(path.join(dir, 'readme.md'), 'ALPHA_MARKER is documented\n');

  const out = await searchCodeTool.execute(
    { pattern: 'ALPHA_MARKER', output_mode: 'files_with_matches' },
    ctx(dir)
  );
  assert.match(out, /Files with matches/);
  assert.match(out, /src\/a\.ts/);
  assert.match(out, /src\/b\.ts/);
  // Content mode markers must not appear
  assert.doesNotMatch(out, /:>/);
});

test('search_code output_mode count returns per-file counts', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'hits.ts'), 'FOO_COUNT\nFOO_COUNT\nbar\nFOO_COUNT\n');

  const out = await searchCodeTool.execute({ pattern: 'FOO_COUNT', output_mode: 'count' }, ctx(dir));
  assert.match(out, /Match counts|hits\.ts/);
  assert.match(out, /hits\.ts:\s*3/);
});

test('search_code glob filters files', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'keep.ts'), 'GLOB_ONLY_TOKEN\n');
  await fs.writeFile(path.join(dir, 'skip.md'), 'GLOB_ONLY_TOKEN\n');

  const out = await searchCodeTool.execute(
    { pattern: 'GLOB_ONLY_TOKEN', glob: '*.ts', output_mode: 'files_with_matches' },
    ctx(dir)
  );
  assert.match(out, /keep\.ts/);
  assert.doesNotMatch(out, /skip\.md/);
});

test('search_code head_limit caps matches (Claude Grep alias)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-hl-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Three files so files_with_matches can return more than head_limit without
  // depending on per-file max-count semantics.
  await fs.writeFile(path.join(dir, 'a.ts'), 'HEAD_LIMIT_TOKEN = 1\n');
  await fs.writeFile(path.join(dir, 'b.ts'), 'HEAD_LIMIT_TOKEN = 2\n');
  await fs.writeFile(path.join(dir, 'c.ts'), 'HEAD_LIMIT_TOKEN = 3\n');

  const out = await searchCodeTool.execute(
    {
      pattern: 'HEAD_LIMIT_TOKEN',
      output_mode: 'files_with_matches',
      head_limit: 2,
    },
    ctx(dir),
  );
  assert.match(out, /Files with matches \(2\)/);
  const paths = String(out)
    .split('\n')
    .filter((l) => /\.ts$/.test(l.trim()));
  assert.equal(paths.length, 2);
});

// ── search_files Glob parity ────────────────────────────────────────────────

test('search_files finds by glob and reports count', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-glob-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'pkg'));
  await fs.writeFile(path.join(dir, 'pkg', 'one.ts'), '1\n');
  await fs.writeFile(path.join(dir, 'pkg', 'two.ts'), '2\n');
  await fs.writeFile(path.join(dir, 'pkg', 'note.txt'), 'x\n');

  const out = await searchFilesTool.execute({ pattern: '*.ts' }, ctx(dir));
  assert.match(out, /Found \d+/);
  assert.match(out, /one\.ts/);
  assert.match(out, /two\.ts/);
  assert.doesNotMatch(out, /note\.txt/);
});

test('search_files head_limit caps paths (Claude Glob alias)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-glob-limit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (let i = 0; i < 5; i++) {
    await fs.writeFile(path.join(dir, `f${i}.ts`), `${i}\n`);
  }
  const out = await searchFilesTool.execute({ pattern: '*.ts', head_limit: 2 }, ctx(dir));
  assert.match(out, /Found 2\+|showing first 2/i);
  const paths = String(out)
    .split('\n')
    .filter((l) => /\.ts$/.test(l.trim()));
  assert.equal(paths.length, 2);
});

// ── exec.run_in_background ──────────────────────────────────────────────────

test('exec run_in_background returns a bg handle and is stoppable', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-exec-bg-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const { clearBackgroundRegistryForTests, execStopTool, execLogsTool } = await import(
    '../dist/tools/background-exec.js'
  );
  clearBackgroundRegistryForTests();
  t.after(() => clearBackgroundRegistryForTests());

  // Long sleep so settle window reports still-running.
  const out = await execTool.execute(
    { command: 'sleep 30', run_in_background: true, label: 'sleep-test' },
    ctx(dir)
  );
  assert.match(out, /bg_\d+/);
  const idMatch = out.match(/bg_\d+/);
  assert.ok(idMatch);
  const id = idMatch[0];

  const listed = await execLogsTool.execute({}, ctx(dir));
  assert.match(listed, new RegExp(id));

  const stopped = await execStopTool.execute({ id }, ctx(dir));
  assert.match(stopped, /Stopping|already|killed|exited/i);
});

// ── read_file FILE_UNCHANGED_STUB (Claude Code FileRead parity) ─────────────

test('read_file returns unchanged stub when re-reading same path without disk change', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-read-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const X = 1;\n');

  const { readFileTool } = await import('../dist/tools/builtin.js');
  const { globalToolStateManager, FILE_UNCHANGED_STUB } = await import(
    '../dist/tools/tool-helpers.js'
  );
  globalToolStateManager.clearFileState();

  const first = await readFileTool.execute({ path: 'a.ts' }, ctx(dir));
  assert.match(first, /export const X/);
  assert.doesNotMatch(first, /unchanged since last read/i);

  const second = await readFileTool.execute({ path: 'a.ts' }, ctx(dir));
  assert.equal(second, FILE_UNCHANGED_STUB);

  // Different range must re-read
  const ranged = await readFileTool.execute({ path: 'a.ts', offset: 1, limit: 1 }, ctx(dir));
  assert.match(ranged, /export const X|lines 1/);
  assert.notEqual(ranged, FILE_UNCHANGED_STUB);

  // After write, full re-read returns content again
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const X = 2;\n');
  // touch mtime separation on some FS (1ms resolution)
  await new Promise((r) => setTimeout(r, 20));
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const X = 2;\n');
  const afterWrite = await readFileTool.execute({ path: 'a.ts' }, ctx(dir));
  assert.match(afterWrite, /X = 2/);
});

test('board-mode connect prompt includes robotics skill + probe verification guidance', async () => {
  const src = await fs.readFile(
    new URL('../src/cli/device-connect.ts', import.meta.url),
    'utf8'
  );
  assert.match(src, /Robotics first/);
  assert.match(src, /skillhub_search/);
  assert.match(src, /load_skill/);
  assert.match(src, /never claim Connected\/Launched without evidence|真实探测/);
});

// ── list_directory depth (Codex list_dir parity) ────────────────────────────

test('list_directory depth=1 is flat; depth=2 includes nested paths', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ls-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src', 'a.ts'), '1\n');
  await fs.writeFile(path.join(dir, 'root.txt'), 'x\n');
  await fs.mkdir(path.join(dir, 'node_modules'));
  await fs.writeFile(path.join(dir, 'node_modules', 'pkg.js'), 'z\n');

  const { listDirectoryTool } = await import('../dist/tools/builtin.js');
  const flat = await listDirectoryTool.execute({ path: '.', depth: 1 }, ctx(dir));
  assert.match(flat, /src\//);
  assert.match(flat, /root\.txt/);
  assert.doesNotMatch(flat, /a\.ts/);
  assert.doesNotMatch(flat, /node_modules/);

  const deep = await listDirectoryTool.execute({ path: '.', depth: 2 }, ctx(dir));
  assert.match(deep, /src\/a\.ts|src\/a\.ts/);
  assert.match(deep, /a\.ts/);
  assert.doesNotMatch(deep, /pkg\.js/);
});

test('list_directory head_limit caps entries', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ls-limit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (let i = 0; i < 6; i++) {
    await fs.writeFile(path.join(dir, `f${i}.txt`), `${i}\n`);
  }
  const { listDirectoryTool } = await import('../dist/tools/builtin.js');
  const out = await listDirectoryTool.execute({ path: '.', head_limit: 2 }, ctx(dir));
  assert.match(out, /limit reached|Listed 2/i);
  const lines = String(out)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('Listed'));
  assert.ok(lines.length <= 2, `expected ≤2 entries, got ${lines.length}: ${lines.join(',')}`);
});
