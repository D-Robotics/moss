import fs from 'node:fs/promises';
import path from 'node:path';
import type { PostToolUseHook } from './tool-hooks.js';
import { runProcess } from '../../utils/run-process.js';

const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch']);
const CHECK_TIMEOUT_MS = 5_000;

/** Extract workspace-relative file targets from the tool input shape. */
function editedPaths(toolName: string, input: Record<string, unknown>): string[] {
  const raw: unknown[] = [];
  if (toolName === 'apply_patch') {
    const patch = typeof input.patch === 'string' ? input.patch : '';
    for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
      raw.push(m[1]);
    }
  } else if (toolName === 'multi_edit' && Array.isArray(input.edits)) {
    for (const edit of input.edits as Array<Record<string, unknown>>) {
      if (typeof edit.file_path === 'string') raw.push(edit.file_path);
    }
    if (typeof input.file_path === 'string') raw.push(input.file_path);
  } else {
    for (const key of ['file_path', 'path']) {
      if (typeof input[key] === 'string') raw.push(input[key]);
    }
  }
  return [...new Set(raw.map((p) => String(p).trim()).filter(Boolean))];
}

async function checkOne(
  absPath: string,
  relPath: string,
  workspaceDir: string
): Promise<string | null> {
  const ext = path.extname(absPath).toLowerCase();
  try {
    if (ext === '.json') {
      const text = await fs.readFile(absPath, 'utf8');
      JSON.parse(text);
      return null;
    }
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      const result = await runProcess('node', {
        args: ['--check', absPath],
        cwd: workspaceDir,
        timeout: CHECK_TIMEOUT_MS,
      });
      if (result.exitCode === 0) return null;
      const firstLine = result.stderr.split('\n').find((l) => l.trim()) ?? 'syntax error';
      return `${relPath}: ${firstLine.trim().slice(0, 200)}`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `${relPath}: ${message.split('\n')[0]?.trim().slice(0, 200) ?? 'check failed'}`;
  }
  return null;
}

/**
 * Fast post-edit validation (C2): after a mutating file tool, JSON files get
 * a parse check and JS-family files get `node --check` (~100ms, no project
 * toolchain). Only failures are appended to the tool result so the model
 * learns immediately that an edit broke syntax — without spending a whole
 * verification turn. TypeScript and other extensions are skipped: there is
 * no fast single-file checker without the project toolchain; those stay
 * covered by code_diagnostics / run_tests.
 */
export function createEditSyntaxCheckHook(): PostToolUseHook {
  return {
    name: 'edit-syntax-check',
    priority: 10,
    async process({ tool, input, result, isError, ctx }) {
      if (isError || !MUTATING_TOOLS.has(tool.name)) return null;
      const relPaths = editedPaths(tool.name, input);
      if (relPaths.length === 0) return null;
      const failures: string[] = [];
      for (const relPath of relPaths.slice(0, 5)) {
        const abs = path.isAbsolute(relPath) ? relPath : path.join(ctx.workspaceDir, relPath);
        const failure = await checkOne(abs, relPath, ctx.workspaceDir);
        if (failure) failures.push(failure);
      }
      if (failures.length === 0) return null;
      return {
        result: `${result}\n[post-edit check] FAIL — ${failures.join(' | ')}`,
      };
    },
  };
}
