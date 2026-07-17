import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '../core/tools/tool-types.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import {
  globalToolStateManager,
  findSimilarFileName,
  safePath,
  toolError,
  withLineNumbers,
  FILE_UNCHANGED_STUB,
} from './tool-helpers.js';

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

/** Strip read_file-style line-number prefixes the model often pastes back. */
export function stripLineNumberPrefixes(s: string): string {
  return s.replace(/^[ \t]*\d{1,6}\t/gm, '');
}

export function stripTrailingWhitespacePerLine(s: string): string {
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
}

export function normalizeEditQuotes(s: string): string {
  return s.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"');
}

/**
 * Compact unified-style preview for edit_file / multi_edit results so the
 * transcript always shows what changed (CC/Codex visibility), independent of
 * whether the UI expands tool inputRaw.
 * @internal exported for tests
 */
export function formatCompactEditPreview(
  oldString: string,
  newString: string,
  maxLines = 12,
): string {
  const oldLines = String(oldString ?? '').split('\n');
  const newLines = String(newString ?? '').split('\n');
  if (oldLines.length === 1 && newLines.length === 1 && oldLines[0] === newLines[0]) {
    return '';
  }
  const lines: string[] = ['--- change preview ---'];
  const half = Math.max(1, Math.ceil(maxLines / 2));
  for (const line of oldLines.slice(0, half)) {
    lines.push(`- ${line}`);
  }
  if (oldLines.length > half) {
    lines.push(`- \u2026 (${oldLines.length - half} more removed lines)`);
  }
  for (const line of newLines.slice(0, half)) {
    lines.push(`+ ${line}`);
  }
  if (newLines.length > half) {
    lines.push(`+ \u2026 (${newLines.length - half} more added lines)`);
  }
  return lines.join('\n');
}

/**
 * Find multi-line windows whose trailing-whitespace-stripped form equals the
 * stripped needle. Returns character offsets into the original content.
 */
export function findTrailingWsMatches(
  content: string,
  needle: string,
  allowMultiple: boolean
): Array<{ start: number; end: number }> {
  const contentLines = content.split('\n');
  const needleLines = stripTrailingWhitespacePerLine(needle).split('\n');
  if (needleLines.length === 0) return [];
  const matches: Array<{ start: number; end: number }> = [];

  const lineStarts: number[] = new Array(contentLines.length);
  let offset = 0;
  for (let i = 0; i < contentLines.length; i++) {
    lineStarts[i] = offset;
    offset += contentLines[i]!.length + (i < contentLines.length - 1 ? 1 : 0);
  }

  for (let i = 0; i <= contentLines.length - needleLines.length; i++) {
    let ok = true;
    for (let j = 0; j < needleLines.length; j++) {
      const fileLine = contentLines[i + j]!.replace(/[ \t]+$/g, '');
      if (fileLine !== needleLines[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const start = lineStarts[i]!;
    const last = i + needleLines.length - 1;
    const end = lineStarts[last]! + contentLines[last]!.length;
    matches.push({ start, end });
    if (!allowMultiple && matches.length > 1) return matches;
  }
  return matches;
}

/** Score lines for closest-match hints when old_string is missing. */
export function findClosestLineHints(content: string, needle: string, maxHints = 3): string[] {
  const probe = stripLineNumberPrefixes(needle)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length >= 4);
  if (!probe) return [];
  const lines = content.split('\n');
  const scored: Array<{ score: number; line: number; text: string }> = [];
  const probeLower = probe.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const textLine = lines[i] ?? '';
    const trimmed = textLine.trim();
    if (!trimmed) continue;
    let score = 0;
    if (trimmed === probe) score = 100;
    else if (trimmed.includes(probe) || probe.includes(trimmed)) score = 80;
    else if (trimmed.toLowerCase().includes(probeLower)) score = 60;
    else {
      const tokens = probeLower.split(/[^a-z0-9_$]+/i).filter((t) => t.length >= 4);
      const hit = tokens.filter((t) => trimmed.toLowerCase().includes(t)).length;
      if (hit === 0) continue;
      score = Math.min(50, hit * 15);
    }
    if (score > 0) scored.push({ score, line: i + 1, text: trimmed.slice(0, 160) });
  }
  scored.sort((a, b) => b.score - a.score || a.line - b.line);
  const out: string[] = [];
  const seen = new Set<number>();
  for (const s of scored) {
    if (seen.has(s.line)) continue;
    seen.add(s.line);
    out.push(`  L${s.line}: ${s.text}`);
    if (out.length >= maxHints) break;
  }
  return out;
}

function readRangeKey(input: { offset?: unknown; limit?: unknown }): string {
  const hasRange = input.offset !== undefined || input.limit !== undefined;
  if (!hasRange) return 'full';
  const start = Math.max(1, Math.floor(Number(input.offset) || 1));
  const limit =
    input.limit !== undefined ? Math.max(0, Math.floor(Number(input.limit))) : 'end';
  return `${start}:${limit}`;
}

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read the contents of a file within the workspace. ' +
    'For large files, pass `offset` (1-based start line) and/or `limit` (line count) to page through it. ' +
    'Each line is prefixed with a right-aligned line number and a tab for reference — these prefixes are NOT part of the file; never copy them into edit_file / write_file / apply_patch content. ' +
    'If you re-read the same path+range without the file changing on disk, the tool returns a short "unchanged" stub (Claude Code parity) so you reuse the earlier result instead of burning context.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root' },
      offset: {
        type: 'number',
        description: '1-based line number to start reading from (default: start of file)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read from `offset` (default: to end of file)',
      },
    },
    required: ['path'],
  },
  async execute(input, ctx) {
    try {
      const filePath = await safePath(input.path, ctx.workspaceDir);
      const rangeKey = readRangeKey(input);
      // Claude Code FileRead parity: skip re-dumping an unchanged window.
      if (await globalToolStateManager.unchangedSinceLastRead(filePath, rangeKey)) {
        return FILE_UNCHANGED_STUB;
      }
      const content = await fs.readFile(filePath, 'utf-8');
      await globalToolStateManager.recordFileState(filePath, rangeKey);
      const hasRange = input.offset !== undefined || input.limit !== undefined;
      if (hasRange) {
        const lines = content.split('\n');
        const start = Math.max(1, Math.floor(Number(input.offset) || 1));
        const count =
          input.limit !== undefined ? Math.max(0, Math.floor(Number(input.limit))) : lines.length;
        const slice = lines.slice(start - 1, start - 1 + count);
        const end = Math.min(lines.length, start - 1 + count);
        let body = slice.join('\n');
        let note = '';
        if (body.length > 100_000) {
          note = `\n\n[... truncated range, total ${body.length} chars]`;
          body = body.slice(0, 100_000);
        }
        return `[lines ${start}-${end} of ${lines.length}]\n${withLineNumbers(body, start)}${note}`;
      }
      if (content.length > 100_000) {
        return (
          withLineNumbers(content.slice(0, 100_000)) +
          `\n\n[... truncated, total ${content.length} chars — pass offset/limit to page through the rest]`
        );
      }
      return withLineNumbers(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || /ENOENT|no such file/i.test(String(err))) {
        const display = String(input.path ?? '');
        const similar = await findSimilarFileName(display, ctx.workspaceDir);
        const hint = similar ? ` Did you mean \`${similar}\`?` : '';
        return `Error: file not found: ${display}.${hint}`;
      }
      throw toolError('Error reading file', err);
    }
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Write content to a file within the workspace. Creates parent directories if needed. ' +
    'Prefer `edit_file` / `multi_edit` for modifying existing files. ' +
    'If the path already exists, you must `read_file` it at least once in this session first ' +
    '(Claude FileWrite discipline) so you do not clobber unread content.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(input, ctx) {
    try {
      const displayPath = String(input.path ?? '');
      const filePath = await safePath(displayPath, ctx.workspaceDir);
      const stale = await globalToolStateManager.staleWriteError(filePath, displayPath);
      if (stale) return `Error: ${stale}`;

      // Existing files: require prior read so full rewrites cannot bypass
      // surgical-edit thrash guards (Claude Code FileWrite parity).
      let existed = false;
      try {
        await fs.access(filePath);
        existed = true;
      } catch {
        existed = false;
      }
      if (existed) {
        const unread = globalToolStateManager.requirePriorReadError(filePath, displayPath);
        if (unread) {
          return (
            `Error: ${unread} ` +
            'For surgical changes prefer edit_file/multi_edit; use write_file only for intentional full rewrites after reading.'
          );
        }
      }

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, input.content, 'utf-8');
      await globalToolStateManager.recordFileState(filePath);
      const contentStr = String(input.content ?? '');
      const contentLines = contentStr.split('\n');
      const previewLines = contentLines.slice(0, 12).map((l) => `+ ${l}`);
      if (contentLines.length > 12) {
        previewLines.push(`+ … (${contentLines.length - 12} more lines)`);
      }
      const preview =
        contentStr.length > 0
          ? `\n--- write preview ---\n${previewLines.join('\n')}`
          : '';
      return `Successfully wrote ${contentStr.length} chars to ${displayPath}.${preview}`;
    } catch (err) {
      throw toolError('Error writing file', err);
    }
  },
};


export type PreciseEditMatchMode = 'exact' | 'quotes' | 'trailing-ws';

export interface PreciseEditRequest {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface PreciseEditSuccess {
  ok: true;
  content: string;
  occurrences: number;
  matchMode: PreciseEditMatchMode;
}

export interface PreciseEditFailure {
  ok: false;
  error: string;
}

/**
 * Core surgical-edit matcher shared by edit_file and multi_edit.
 * Handles line-number prefix stripping, quote normalization, and
 * trailing-whitespace-tolerant multi-line windows.
 */
export function applyPreciseEditToContent(
  content: string,
  request: PreciseEditRequest
): PreciseEditSuccess | PreciseEditFailure {
  let oldStr = String(request.oldString ?? '');
  let newStr = String(request.newString ?? '');
  if (oldStr === '') {
    return { ok: false, error: 'old_string is empty. Use write_file to create a new file or replace an entire file.' };
  }
  if (oldStr === newStr) {
    return { ok: false, error: 'old_string and new_string are identical — nothing to change.' };
  }

  const strippedOld = stripLineNumberPrefixes(oldStr);
  const strippedNew = stripLineNumberPrefixes(newStr);
  if (strippedOld !== oldStr || strippedNew !== newStr) {
    oldStr = strippedOld;
    newStr = strippedNew;
  }

  let matchMode: PreciseEditMatchMode = 'exact';
  let ranges: Array<{ start: number; end: number }> = [];

  const collectSubstringRanges = (haystack: string, needle: string): Array<{ start: number; end: number }> => {
    const out: Array<{ start: number; end: number }> = [];
    let pos = 0;
    for (;;) {
      const idx = haystack.indexOf(needle, pos);
      if (idx === -1) break;
      out.push({ start: idx, end: idx + needle.length });
      pos = idx + needle.length;
      if (!request.replaceAll) break;
    }
    return out;
  };

  ranges = collectSubstringRanges(content, oldStr);

  if (ranges.length === 0) {
    const normContent = normalizeEditQuotes(content);
    const normOld = normalizeEditQuotes(oldStr);
    if (normContent !== content || normOld !== oldStr) {
      const normRanges = collectSubstringRanges(normContent, normOld);
      if (normRanges.length > 0) {
        ranges = normRanges;
        matchMode = 'quotes';
      }
    }
  }

  if (ranges.length === 0) {
    const tw = findTrailingWsMatches(content, oldStr, Boolean(request.replaceAll));
    if (tw.length > 0) {
      ranges = tw;
      matchMode = 'trailing-ws';
    }
  }

  if (ranges.length === 0) {
    const hints = findClosestLineHints(content, oldStr);
    const hintBlock =
      hints.length > 0
        ? `\nClosest lines in the file (re-read and copy verbatim):\n${hints.join('\n')}`
        : '';
    return {
      ok: false,
      error:
        'old_string not found. The text must match exactly — including indentation — and must not include ' +
        "read_file's line-number prefixes.\n" +
        'Next step (required): call `read_file` on this path again, copy the exact current text into ' +
        '`old_string`, then retry `edit_file`. Do not retry the same old_string — the file contents ' +
        '(or your memory of them) no longer match.' +
        hintBlock,
    };
  }
  if (ranges.length > 1 && !request.replaceAll) {
    return {
      ok: false,
      error:
        `old_string is not unique (${ranges.length} matches). ` +
        'Add more surrounding context to target a single location, or pass replace_all: true.',
    };
  }

  const ordered = [...ranges].sort((a, b) => b.start - a.start);
  let updated = content;
  for (const r of ordered) {
    updated = updated.slice(0, r.start) + newStr + updated.slice(r.end);
  }
  return { ok: true, content: updated, occurrences: ranges.length, matchMode };
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Make a precise in-place edit by replacing an exact string in an existing file. ' +
    'Prefer this over write_file for modifying files — it changes only the matched text and leaves everything else untouched, which is safer and cheaper than rewriting the whole file.\n- You must call `read_file` on the target at least once in this session before editing (Claude Code FileEdit parity).\n' +
    '- `old_string` must match the file EXACTLY, including whitespace and indentation, and must be UNIQUE. Include enough surrounding context to target a single location; if it matches more than once the edit is rejected unless `replace_all` is true.\n' +
    "- Never include read_file's line-number prefixes in `old_string` or `new_string`.\n" +
    '- Set `new_string` to "" to delete the matched text. To create a new file or replace an entire file, use write_file instead. ' +
    'For several surgical edits in one step, prefer multi_edit.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace root' },
      old_string: {
        type: 'string',
        description: 'Exact text to replace — must be unique in the file unless replace_all is set',
      },
      new_string: {
        type: 'string',
        description: 'Replacement text (use "" to delete the matched text)',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace every occurrence instead of requiring a unique match (default false)',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(input, ctx) {
    try {
      const displayPath = String(input.path ?? '');
      const oldStr = String(input.old_string ?? '');
      const newStr = String(input.new_string ?? '');
      const filePath = await safePath(displayPath, ctx.workspaceDir);
      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return `Error: file does not exist: ${displayPath}. Use write_file to create it.`;
        }
        throw err;
      }
      const stale = await globalToolStateManager.staleWriteError(filePath, displayPath);
      if (stale) return `Error: ${stale}`;
      const unread = globalToolStateManager.requirePriorReadError(filePath, displayPath);
      if (unread) return `Error: ${unread}`;

      const result = applyPreciseEditToContent(content, {
        oldString: oldStr,
        newString: newStr,
        replaceAll: Boolean(input.replace_all),
      });
      if (!result.ok) {
        // Force re-read before the next edit attempt — prior-read credit is
        // no longer trustworthy once old_string failed to match.
        globalToolStateManager.invalidateFileState(filePath);
        const body = result.error.includes('old_string not found')
          ? result.error.replace('old_string not found.', `old_string not found in ${displayPath}.`)
          : result.error;
        return `Error: ${body}`;
      }

      await atomicWriteFile(filePath, result.content);
      await globalToolStateManager.recordFileState(filePath);
      const label =
        input.replace_all && result.occurrences > 1
          ? `${result.occurrences} occurrences`
          : '1 occurrence';
      const modeNote =
        result.matchMode === 'exact'
          ? ''
          : result.matchMode === 'quotes'
            ? '; matched after normalizing quote characters'
            : '; matched after ignoring trailing whitespace per line';
      // Embed a compact unified-ish preview so TUI/oneshot transcript always
      // shows what changed (even if UI collapse hides inputRaw-based diffs).
      const preview = formatCompactEditPreview(oldStr, newStr, 12);
      return (
        `Edited ${displayPath} (replaced ${label}${modeNote}; write complete — verify with tests instead of re-reading the file).` +
        (preview ? `\n${preview}` : '')
      );
    } catch (err) {
      throw toolError('Error editing file', err);
    }
  },
};

export const multiEditTool: Tool = {
  name: 'multi_edit',
  description:
    'Apply multiple precise in-place edits across one or more files in a single tool call. ' +
    'Prefer this over sequential edit_file when a task needs 2+ surgical replacements — one call keeps the turn budget low (Claude Code MultiEdit / Codex multi-hunk parity).\n' +
    '- Each edit uses the same matching rules as edit_file (exact unique match, optional replace_all, line-number prefix stripping, trailing-whitespace tolerance).\n' +
    '- Edits to the same file are applied in order; later edits see earlier replacements in that file.\n' +
    '- If any edit fails, no files are written (all-or-nothing).',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
  inputSchema: {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        description: 'Ordered list of surgical edits to apply',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to workspace root' },
            old_string: { type: 'string', description: 'Exact text to replace (must be unique unless replace_all)' },
            new_string: { type: 'string', description: 'Replacement text' },
            replace_all: {
              type: 'boolean',
              description: 'Replace every occurrence in this file (default false)',
            },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    required: ['edits'],
  },
  async execute(input, ctx) {
    try {
      const raw = Array.isArray(input.edits) ? input.edits : [];
      if (raw.length === 0) return 'Error: edits array is empty.';
      if (raw.length > 40) return 'Error: too many edits (max 40). Split into smaller multi_edit batches.';

      // Load each unique file once; apply edits in order into memory.
      type FileBuf = { displayPath: string; filePath: string; content: string; original: string };
      const buffers = new Map<string, FileBuf>();
      const summaries: string[] = [];

      for (let i = 0; i < raw.length; i++) {
        const item = raw[i] as Record<string, unknown>;
        const displayPath = String(item?.path ?? '');
        if (!displayPath) return `Error: edits[${i}].path is required.`;
        const oldStr = String(item?.old_string ?? '');
        const newStr = String(item?.new_string ?? '');
        const replaceAll = item?.replace_all === true;

        let buf = buffers.get(displayPath);
        if (!buf) {
          const filePath = await safePath(displayPath, ctx.workspaceDir);
          let content: string;
          try {
            content = await fs.readFile(filePath, 'utf-8');
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              return `Error: edits[${i}] file does not exist: ${displayPath}. Use write_file first.`;
            }
            throw err;
          }
          const stale = await globalToolStateManager.staleWriteError(filePath, displayPath);
          if (stale) return `Error: edits[${i}] ${stale}`;
          const unread = globalToolStateManager.requirePriorReadError(filePath, displayPath);
          if (unread) return `Error: edits[${i}] ${unread}`;
          buf = { displayPath, filePath, content, original: content };
          buffers.set(displayPath, buf);
        }

        const result = applyPreciseEditToContent(buf.content, {
          oldString: oldStr,
          newString: newStr,
          replaceAll,
        });
        if (!result.ok) {
          // Drop prior-read credit for every file already staged in this batch
          // so the model re-reads before retrying (all-or-nothing: nothing written).
          for (const b of buffers.values()) {
            globalToolStateManager.invalidateFileState(b.filePath);
          }
          globalToolStateManager.invalidateFileState(buf.filePath);
          const missExtra = /old_string not found/i.test(result.error)
            ? ''
            : '\nNext step: call `read_file` on this path and retry with exact current text.';
          return (
            `Error: edits[${i}] on ${displayPath}: ${result.error}${missExtra}\n` +
            'No files were written (all-or-nothing).'
          );
        }
        buf.content = result.content;
        const preview = formatCompactEditPreview(oldStr, newStr, 6);
        summaries.push(
          `  [${i + 1}] ${displayPath}: ${result.occurrences} replacement(s) [${result.matchMode}]` +
            (preview ? `\n${preview}` : ''),
        );
      }

      // Commit all files only after every edit succeeded.
      for (const buf of buffers.values()) {
        if (buf.content === buf.original) continue;
        await atomicWriteFile(buf.filePath, buf.content);
        await globalToolStateManager.recordFileState(buf.filePath);
      }

      return (
        `Applied ${raw.length} edit(s) across ${buffers.size} file(s) (all-or-nothing commit).\n` +
        summaries.join('\n') +
        '\nVerify with tests instead of re-reading every file.'
      );
    } catch (err) {
      throw toolError('Error applying multi_edit', err);
    }
  },
};

export const moveFileTool: Tool = {
  name: 'move_file',
  description:
    'Move or rename a file or directory within the workspace. ' +
    'Both paths are sandbox-checked; destination parent directories are created as needed. ' +
    'If overwriting an existing destination (`overwrite=true`), you must `read_file` that destination first so you do not destroy unread content.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Existing path relative to workspace root' },
      destination: { type: 'string', description: 'New path relative to workspace root' },
      overwrite: {
        type: 'boolean',
        description: 'Overwrite destination if it already exists (default false)',
      },
    },
    required: ['source', 'destination'],
  },
  async execute(input, ctx) {
    try {
      const srcDisplay = String(input.source ?? '');
      const destDisplay = String(input.destination ?? '');
      const src = await safePath(srcDisplay, ctx.workspaceDir);
      const dest = await safePath(destDisplay, ctx.workspaceDir);
      try {
        await fs.access(src);
      } catch {
        return `Error: source does not exist: ${srcDisplay}`;
      }
      let destExists = false;
      try {
        await fs.access(dest);
        destExists = true;
      } catch {
        destExists = false;
      }
      if (destExists && !input.overwrite) {
        return `Error: destination already exists: ${destDisplay} (pass overwrite=true to replace)`;
      }
      // Overwriting an existing destination requires prior read (same discipline
      // as write_file on existing files) so unread content is not destroyed.
      if (destExists && input.overwrite) {
        const unread = globalToolStateManager.requirePriorReadError(dest, destDisplay);
        if (unread) {
          return `Error: ${unread} Destination exists and overwrite=true — read it first or choose a new path.`;
        }
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
      // Destination is the surviving path; drop source read credit and stamp dest.
      globalToolStateManager.invalidateFileState(src);
      await globalToolStateManager.recordFileState(dest);
      return `Moved ${srcDisplay} -> ${destDisplay}`;
    } catch (err) {
      throw toolError('Error moving file', err);
    }
  },
};

const LIST_DIR_IGNORE = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '__pycache__',
  '.tox',
  '.venv',
  'venv',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
]);

/**
 * Codex-style depth-limited directory listing (BFS). Returns relative paths
 * from the listing root with `/` for directories and `@` for symlinks.
 */
export async function listDirEntries(
  rootAbs: string,
  depth: number,
  limit: number
): Promise<string[]> {
  const maxDepth = Math.max(1, Math.min(5, Math.floor(depth)));
  const maxEntries = Math.max(1, Math.min(500, Math.floor(limit)));
  type Item = { rel: string; depth: number; kind: 'dir' | 'file' | 'link' | 'other' };
  const items: Item[] = [];
  const queue: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: rootAbs, rel: '', depth: 0 },
  ];

  while (queue.length > 0 && items.length < maxEntries) {
    const cur = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(cur.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    // Sort children for stable output
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (items.length >= maxEntries) break;
      if (e.name === '.' || e.name === '..') continue;
      // Skip heavy/noise dirs at every level
      if (e.isDirectory() && LIST_DIR_IGNORE.has(e.name)) continue;
      const childRel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
      const childAbs = path.join(cur.abs, e.name);
      let kind: Item['kind'] = 'other';
      if (e.isSymbolicLink()) kind = 'link';
      else if (e.isDirectory()) kind = 'dir';
      else if (e.isFile()) kind = 'file';
      items.push({ rel: childRel, depth: cur.depth + 1, kind });
      if (kind === 'dir' && cur.depth + 1 < maxDepth) {
        queue.push({ abs: childAbs, rel: childRel, depth: cur.depth + 1 });
      }
    }
  }

  return items.map((it) => {
    const indent = '  '.repeat(Math.max(0, it.depth - 1));
    const mark = it.kind === 'dir' ? '/' : it.kind === 'link' ? '@' : '';
    return `${indent}${it.rel}${mark}`;
  });
}

export const listDirectoryTool: Tool = {
  name: 'list_directory',
  description:
    'List files and directories within the workspace (Codex list_dir parity: optional depth). ' +
    'Directories end with `/`, symlinks with `@`. Skips node_modules/.git/dist and similar noise. ' +
    'Default depth=1 (immediate children); set depth=2–3 for a shallow tree. Prefer search_files for name globs.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path relative to workspace root (default: root)',
      },
      depth: {
        type: 'number',
        description: 'Max directory depth to traverse (default 1, max 5). Use 2–3 for a shallow tree.',
      },
      limit: {
        type: 'number',
        description: 'Max entries to return (default 200, max 500).',
      },
    },
  },
  async execute(input, ctx) {
    try {
      const dirPath = await safePath(input.path || '.', ctx.workspaceDir);
      const depth = input.depth !== undefined ? Number(input.depth) : 1;
      const limit = input.limit !== undefined ? Number(input.limit) : 200;
      const lines = await listDirEntries(dirPath, depth, limit);
      if (lines.length === 0) return '(empty directory)';
      const truncated = lines.length >= Math.min(500, Math.max(1, Math.floor(limit || 200)));
      const header = truncated
        ? `Listed ${lines.length} entries (limit reached, depth=${Math.max(1, Math.min(5, Math.floor(depth || 1)))}):\n`
        : '';
      return header + lines.join('\n');
    } catch (err) {
      throw toolError('Error listing directory', err);
    }
  },
};


  'On Windows the local shell is cmd/PowerShell: Unix-only utilities (e.g. uname, grep without Git) are unavailable. ' +
  'Use PowerShell equivalents, read workspace files, or use device_* tools when SSH to a Linux board is configured.';
