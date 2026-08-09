import fs from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { Tool } from '../core/tools/tool-types.js';
import { applyUpdateHunk, extractAddContent, parsePatch } from '../utils/apply-patch-core.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { errorMessage } from '../errors.js';
import { globalToolStateManager, safePath } from './tool-helpers.js';

export interface PatchFileState {
  path: string;
  displayPath: string;
  originalExists: boolean;
  originalContent: string | null;
  nextContent?: string | null;
}

export function containsNul(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

export function decodePatchTarget(bytes: Uint8Array, displayPath: string): string {
  if (containsNul(bytes)) throw new Error(`refusing to patch binary-looking file: ${displayPath}`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`refusing to patch non-UTF-8 file: ${displayPath}`);
  }
}

export function dominantLineEnding(original: string): '\n' | '\r\n' | null {
  const crlf = original.match(/\r\n/g)?.length ?? 0;
  const loneLf = original.match(/(?<!\r)\n/g)?.length ?? 0;
  if (crlf > loneLf) return '\r\n';
  if (loneLf > crlf) return '\n';
  return null;
}

export function restoreDominantLineEndings(content: string, original: string): string {
  return dominantLineEnding(original) === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
}

export const applyPatchTool: Tool = {
  name: 'apply_patch',
  description:
    'Apply a structured patch within the workspace. Supports add, update, and delete hunks. ' +
    'All hunks are parsed and conflict-checked before files are touched; applied files are restored on execution failure. ' +
    'For update/delete of existing files you must `read_file` the path at least once in this session first (same discipline as edit_file).',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
  inputSchema: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description: 'Patch text using *** Begin Patch / *** End Patch format',
      },
    },
    required: ['patch'],
  },
  async execute(input, ctx) {
    const parsed = parsePatch(String(input.patch ?? ''));
    if (parsed.errors.length > 0) return `Patch rejected:\n${parsed.errors.join('\n')}`;
    if (parsed.hunks.length === 0) return 'Patch rejected: no hunks found.';

    const states = new Map<string, PatchFileState>();

    const loadState = async (displayPath: string, filePath: string): Promise<PatchFileState> => {
      const existing = states.get(filePath);
      if (existing) return existing;
      try {
        const bytes = await fs.readFile(filePath);
        const state: PatchFileState = {
          path: filePath,
          displayPath,
          originalExists: true,
          originalContent: decodePatchTarget(bytes, displayPath),
        };
        states.set(filePath, state);
        return state;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const state: PatchFileState = {
          path: filePath,
          displayPath,
          originalExists: false,
          originalContent: null,
        };
        states.set(filePath, state);
        return state;
      }
    };

    try {
      for (const hunk of parsed.hunks) {
        const filePath = await safePath(hunk.path, ctx.workspaceDir);
        const state = await loadState(hunk.path, filePath);

        if (hunk.type === 'add') {
          if (state.originalExists || state.nextContent !== undefined) {
            return `Patch rejected: add target already exists: ${hunk.path}`;
          }
          const content = extractAddContent(hunk);
          state.nextContent = content;
          continue;
        }

        if (hunk.type === 'delete') {
          if (!state.originalExists && state.nextContent === undefined) {
            return `Patch rejected: delete target does not exist: ${hunk.path}`;
          }
          if (!state.originalExists && state.nextContent !== undefined) {
            return `Patch rejected: cannot delete file added in same patch: ${hunk.path}`;
          }
          if (state.nextContent === null) {
            return `Patch rejected: file already deleted in same patch: ${hunk.path}`;
          }
          // Existing files: require prior read_file (Claude FileEdit parity).
          if (state.originalExists) {
            const unread = globalToolStateManager.requirePriorReadError(filePath, hunk.path);
            if (unread) {
              return `Patch rejected for ${hunk.path}: ${unread}`;
            }
            const stale = await globalToolStateManager.staleWriteError(filePath, hunk.path);
            if (stale) {
              return `Patch rejected for ${hunk.path}: ${stale}`;
            }
          }
          state.nextContent = null;
          continue;
        }

        const previous =
          state.nextContent !== undefined ? state.nextContent : state.originalContent;
        if (!state.originalExists && state.nextContent === undefined) {
          return `Patch rejected: update target does not exist: ${hunk.path}`;
        }
        if (previous === null)
          return `Patch rejected: cannot update deleted file in same patch: ${hunk.path}`;
        // Existing files (or files already staged in this patch as content): require
        // a prior read_file before the first update of an on-disk file.
        if (state.originalExists && state.nextContent === undefined) {
          const unread = globalToolStateManager.requirePriorReadError(filePath, hunk.path);
          if (unread) {
            return `Patch rejected for ${hunk.path}: ${unread}`;
          }
          // Concurrent mtime change since last full read (editor/linter/other tool).
          const stale = await globalToolStateManager.staleWriteError(filePath, hunk.path);
          if (stale) {
            return `Patch rejected for ${hunk.path}: ${stale}`;
          }
        }
        const normalizedPrevious = previous.replace(/\r\n/g, '\n');
        const updated = applyUpdateHunk(normalizedPrevious, hunk);
        if (updated.error) {
          globalToolStateManager.invalidateFileState(filePath);
          return (
            `Patch rejected for ${hunk.path}: ${updated.error}\n` +
            'Next step: call `read_file` on this path, rebuild the hunk from the exact current text, then retry. ' +
            'Do not resubmit the same failed patch body.'
          );
        }
        state.nextContent = restoreDominantLineEndings(updated.result, previous);
      }

      const changedStates = [...states.values()].filter((state) => state.nextContent !== undefined);
      const applied: PatchFileState[] = [];
      try {
        for (const state of changedStates) {
          const nextContent = state.nextContent;
          if (nextContent === undefined) continue;
          if (nextContent === null) {
            await fs.rm(state.path, { force: false });
          } else {
            await atomicWriteFile(state.path, nextContent);
          }
          applied.push(state);
        }
      } catch (err) {
        for (const state of applied.reverse()) {
          if (state.originalExists && state.originalContent !== null) {
            await atomicWriteFile(state.path, state.originalContent);
          } else {
            await fs.rm(state.path, { force: true });
          }
        }
        throw err;
      }

      // Record on-disk mtime for every file we wrote (add/update). This keeps
      // the stale-write detector (edit_file's staleWriteError) in sync so a
      // follow-up edit_file on a patched file does not falsely report
      // "modified since you last read it". Deleted files no longer exist, so
      // there is nothing to stat — recordFileState would no-op anyway.
      for (const state of applied) {
        if (state.nextContent !== null) {
          await globalToolStateManager.recordFileState(state.path);
        }
      }

      const summary = changedStates.map((state) => {
        if (!state.originalExists && state.nextContent !== null) {
          return `add ${state.displayPath}`;
        }
        if (state.originalExists && state.nextContent === null) {
          return `delete ${state.displayPath}`;
        }
        if (state.originalExists && state.nextContent !== undefined) {
          return `update ${state.displayPath}`;
        } else {
          return `change ${state.displayPath}`;
        }
      });

      // Embed a compact patch body so transcript/TUI always shows what changed
      // even when UI tool rows collapse inputRaw (parity with edit_file previews).
      const patchBody = String(input.patch ?? '');
      const previewLines = patchBody
        .split('\n')
        .filter((l) => {
          const t = l.trimEnd();
          return (
            t.startsWith('***') ||
            t.startsWith('@@') ||
            (t.startsWith('+') && !t.startsWith('+++')) ||
            (t.startsWith('-') && !t.startsWith('---'))
          );
        })
        .slice(0, 32);
      const preview =
        previewLines.length > 0
          ? `\n--- patch preview ---\n${previewLines.join('\n')}${
              patchBody.split('\n').length > previewLines.length
                ? `\n… (${patchBody.split('\n').length - previewLines.length} more lines)`
                : ''
            }`
          : '';

      return (
        `Patch applied:\n${summary.map((line) => `- ${line}`).join('\n')}` +
        `${preview}\n(write complete — verify with tests instead of re-reading patched files)`
      );
    } catch (err) {
      return `Error: Patch failed: ${errorMessage(err)}`;
    }
  },
};
