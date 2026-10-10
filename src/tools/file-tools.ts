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
  FILE_UNCHANGED_TRUNCATED_STUB,
} from './tool-helpers.js';
import { wouldTruncateToolOutput } from '../context/tool-output-truncate.js';
import {
  redactedPlaceholderEditError,
  redactedPlaceholderWriteError,
} from '../safety/tool-output-redact.js';
import { resolveReadPath } from '../safety/read-scope.js';

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
  maxLines = 12
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
  const limit = input.limit !== undefined ? Math.max(0, Math.floor(Number(input.limit))) : 'end';
  return `${start}:${limit}`;
}

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a workspace file. Page large files with offset (1-based line) and limit. ' +
    'Each line is prefixed with a line number and a tab that are NOT file content — do not copy them into edits. ' +
    'An unchanged re-read returns a short stub. Paths outside the workspace are still read; secret-like values are removed.',
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
      const filePath = resolveReadPath(String(input.path ?? ''), ctx.workspaceDir);
      const rangeKey = readRangeKey(input);
      // Claude Code FileRead parity: skip re-dumping an unchanged window — but
      // only when the earlier body actually survived the output budget.
      const reuse = await globalToolStateManager.readReuseState(filePath, rangeKey);
      if (reuse === 'fresh') return FILE_UNCHANGED_STUB;
      if (reuse === 'truncated') return FILE_UNCHANGED_TRUNCATED_STUB;
      const content = await fs.readFile(filePath, 'utf-8');
      const hasRange = input.offset !== undefined || input.limit !== undefined;
      const result = (() => {
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
      })();
      // The secret-sanitizer post hook redacts the result that reaches the model.
      // Record the tool's own body so an unchanged re-read still short-circuits.
      await globalToolStateManager.recordFileState(
        filePath,
        rangeKey,
        wouldTruncateToolOutput('read', result)
      );
      return result;
    } catch (err) {
      if (
        (err as NodeJS.ErrnoException).code === 'ENOENT' ||
        /ENOENT|no such file/i.test(String(err))
      ) {
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
    'Create or overwrite a workspace file (parent directories are created). Prefer edit_file or multi_edit for existing files. If the path exists, read_file it once this session first.',
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

      const contentStrEarly = String(input.content ?? '');
      let originalBody: string | null = null;
      if (existed) {
        originalBody = await fs.readFile(filePath, 'utf-8');
      }
      const redactedWrite = redactedPlaceholderWriteError(originalBody, contentStrEarly);
      if (redactedWrite) return `Error: ${redactedWrite}`;

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contentStrEarly, 'utf-8');
      await globalToolStateManager.recordFileState(filePath);
      const contentLines = contentStrEarly.split('\n');
      const previewLines = contentLines.slice(0, 12).map((l) => `+ ${l}`);
      if (contentLines.length > 12) {
        previewLines.push(`+ … (${contentLines.length - 12} more lines)`);
      }
      const preview =
        contentStrEarly.length > 0 ? `\n--- write preview ---\n${previewLines.join('\n')}` : '';
      return `Successfully wrote ${contentStrEarly.length} chars to ${displayPath}.${preview}`;
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
    return {
      ok: false,
      error: 'old_string is empty. Use write_file to create a new file or replace an entire file.',
    };
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

  const collectSubstringRanges = (
    haystack: string,
    needle: string
  ): Array<{ start: number; end: number }> => {
    const out: Array<{ start: number; end: number }> = [];
    let pos = 0;
    for (;;) {
      const idx = haystack.indexOf(needle, pos);
      if (idx === -1) break;
      out.push({ start: idx, end: idx + needle.length });
      pos = idx + needle.length;
      // One hit is not enough to know the match is unique. Stop at two so the
      // not-unique error fires instead of silently editing the first match.
      if (!request.replaceAll && out.length >= 2) break;
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

  // No hit on the original bytes. Match an LF view (so `\n` in old_string
  // finds `\r\n` in the file) and splice only that original span.
  if (ranges.length === 0 && (content.includes('\r\n') || oldStr.includes('\r\n'))) {
    const view = projectCrLf(content);
    const oldLf = oldStr.replace(/\r\n/g, '\n');
    if (view.lf !== content || oldLf !== oldStr) {
      let lfRanges = collectSubstringRanges(view.lf, oldLf);
      let lfMode: PreciseEditMatchMode = 'exact';
      if (lfRanges.length === 0) {
        const normContent = normalizeEditQuotes(view.lf);
        const normOld = normalizeEditQuotes(oldLf);
        if (normContent !== view.lf || normOld !== oldLf) {
          const normRanges = collectSubstringRanges(normContent, normOld);
          if (normRanges.length > 0) {
            lfRanges = normRanges;
            lfMode = 'quotes';
          }
        }
      }
      if (lfRanges.length === 0) {
        const tw = findTrailingWsMatches(view.lf, oldLf, Boolean(request.replaceAll));
        if (tw.length > 0) {
          lfRanges = tw;
          lfMode = 'trailing-ws';
        }
      }
      if (lfRanges.length > 0) {
        ranges = lfRanges.map((range) =>
          originalRange(view.starts, content.length, range.start, range.end)
        );
        matchMode = lfMode;
      }
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
    const inserted = withSpanEnding(newStr, replacementEnding(content, r.start, r.end));
    updated = updated.slice(0, r.start) + inserted + updated.slice(r.end);
  }
  return { ok: true, content: updated, occurrences: ranges.length, matchMode };
}

/** Map `\r\n` to one `\n`. `starts[i]` is the original offset where `lf[i]` begins. */
function projectCrLf(content: string): { lf: string; starts: number[] } {
  const starts: number[] = [];
  let lf = '';
  for (let i = 0; i < content.length; i += 1) {
    starts.push(i);
    if (content[i] === '\r' && content[i + 1] === '\n') {
      lf += '\n';
      i += 1;
    } else {
      lf += content[i] ?? '';
    }
  }
  return { lf, starts };
}

function originalRange(
  starts: number[],
  contentLength: number,
  start: number,
  end: number
): { start: number; end: number } {
  return {
    start: starts[start] ?? contentLength,
    end: end >= starts.length ? contentLength : (starts[end] ?? contentLength),
  };
}

function lineEndingForSpan(span: string): '\n' | '\r\n' | null {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < span.length; i += 1) {
    if (span[i] === '\r' && span[i + 1] === '\n') {
      crlf += 1;
      i += 1;
    } else if (span[i] === '\n') {
      lf += 1;
    }
  }
  if (crlf === 0 && lf === 0) return null;
  return crlf >= lf ? '\r\n' : '\n';
}

/** EOL of the line that contains `index` (the break after that line, if any). */
function lineEndingOfLine(content: string, index: number): '\n' | '\r\n' | null {
  let lineStart = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (content[i] === '\n') {
      lineStart = i + 1;
      break;
    }
  }
  for (let i = lineStart; i < content.length; i += 1) {
    if (content[i] === '\r' && content[i + 1] === '\n') return '\r\n';
    if (content[i] === '\n') return '\n';
  }
  return null;
}

/**
 * Ending the replacement must use. Majority inside the matched span when the
 * span itself contains newlines; otherwise the ending of the line it sits on.
 */
function replacementEnding(content: string, start: number, end: number): '\n' | '\r\n' | null {
  return lineEndingForSpan(content.slice(start, end)) ?? lineEndingOfLine(content, start);
}

function withSpanEnding(text: string, ending: '\n' | '\r\n' | null): string {
  if (ending === '\r\n') return text.replace(/\r?\n/g, '\r\n');
  if (ending === '\n') return text.replace(/\r\n/g, '\n');
  return text;
}

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Replace one exact unique string in an existing file. read_file it first. ' +
    'old_string must match whitespace exactly and be unique unless replace_all. Do not include read_file line-number prefixes. ' +
    'Empty new_string deletes the match. Use write_file for new files and multi_edit for several replacements.',
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
      const redactedWrite = redactedPlaceholderEditError(oldStr, newStr);
      if (redactedWrite) return `Error: ${redactedWrite}`;

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
    'Apply several edit_file replacements in one call (same match rules, in order, all-or-nothing). Prefer this for 2+ edits.',
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
            old_string: {
              type: 'string',
              description: 'Exact text to replace (must be unique unless replace_all)',
            },
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
      if (raw.length > 40)
        return 'Error: too many edits (max 40). Split into smaller multi_edit batches.';

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
        const redactedEdit = redactedPlaceholderEditError(oldStr, newStr);
        if (redactedEdit) {
          return (
            `Error: edits[${i}] on ${displayPath}: ${redactedEdit}\n` +
            'No files were written (all-or-nothing).'
          );
        }
        buf.content = result.content;
        const preview = formatCompactEditPreview(oldStr, newStr, 6);
        summaries.push(
          `  [${i + 1}] ${displayPath}: ${result.occurrences} replacement(s) [${result.matchMode}]` +
            (preview ? `\n${preview}` : '')
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
    'Move or rename a workspace path. overwrite=true requires a prior read_file of an existing destination.',
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
      // Explicit move preview so transcripts show the rename without expanding input.
      return (
        `Moved ${srcDisplay} -> ${destDisplay}\n` +
        `--- move preview ---\n` +
        `- ${srcDisplay}\n` +
        `+ ${destDisplay}` +
        (input.overwrite ? '\n(overwrite)' : '')
      );
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
    'List a directory (depth default 1, max 5). Directories end with /, symlinks with @. Skips node_modules, .git, and dist. Prefer search_files for globs. A path outside the workspace is still listed.',
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
        description:
          'Max directory depth to traverse (default 1, max 5). Use 2–3 for a shallow tree.',
      },
      limit: {
        type: 'number',
        description: 'Max entries to return (default 200, max 500). Alias: head_limit.',
      },
      head_limit: {
        type: 'number',
        description: 'Alias for limit (Claude Code list_dir style cap on returned entries).',
      },
    },
  },
  async execute(input, ctx) {
    try {
      const depth = input.depth !== undefined ? Number(input.depth) : 1;
      const dirPath = resolveReadPath(String(input.path || '.'), ctx.workspaceDir);
      const rawLimit = Number(input.head_limit ?? input.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 200;
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
