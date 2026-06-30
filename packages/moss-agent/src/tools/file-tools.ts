import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '../core/tools/tool-types.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import {
  globalToolStateManager,
  safePath,
  toolError,
  withLineNumbers,
} from './tool-helpers.js';

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}








export function normalizeEditQuotes(s: string): string {
  return s.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"');
}

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read the contents of a file within the workspace. ' +
    'For large files, pass `offset` (1-based start line) and/or `limit` (line count) to page through it. ' +
    'Each line is prefixed with a right-aligned line number and a tab for reference — these prefixes are NOT part of the file; never copy them into edit_file / write_file / apply_patch content.',
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
      const content = await fs.readFile(filePath, 'utf-8');
      await globalToolStateManager.recordFileState(filePath);
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
      throw toolError('Error reading file', err);
    }
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Write content to a file within the workspace. Creates parent directories if needed.',
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
      const filePath = await safePath(input.path, ctx.workspaceDir);
      const stale = await globalToolStateManager.staleWriteError(filePath, String(input.path ?? ''));
      if (stale) return `Error: ${stale}`;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, input.content, 'utf-8');
      await globalToolStateManager.recordFileState(filePath);
      return `Successfully wrote ${input.content.length} chars to ${input.path}`;
    } catch (err) {
      throw toolError('Error writing file', err);
    }
  },
};

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Make a precise in-place edit by replacing an exact string in an existing file. ' +
    'Prefer this over write_file for modifying files — it changes only the matched text and leaves everything else untouched, which is safer and cheaper than rewriting the whole file.\n' +
    '- `old_string` must match the file EXACTLY, including whitespace and indentation, and must be UNIQUE. Include enough surrounding context to target a single location; if it matches more than once the edit is rejected unless `replace_all` is true.\n' +
    "- Never include read_file's line-number prefixes in `old_string` or `new_string`.\n" +
    '- Set `new_string` to "" to delete the matched text. To create a new file or replace an entire file, use write_file instead.',
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
      if (oldStr === '') {
        return 'Error: old_string is empty. Use write_file to create a new file or replace an entire file.';
      }
      if (oldStr === newStr) {
        return 'Error: old_string and new_string are identical — nothing to change.';
      }
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
      
      
      
      
      
      let needle = oldStr;
      let haystack = content;
      let fuzzy = false;
      let occurrences = countOccurrences(haystack, needle);
      if (occurrences === 0) {
        const normContent = normalizeEditQuotes(content);
        const normOld = normalizeEditQuotes(oldStr);
        if (
          (normContent !== content || normOld !== oldStr) &&
          countOccurrences(normContent, normOld) > 0
        ) {
          haystack = normContent;
          needle = normOld;
          occurrences = countOccurrences(haystack, needle);
          fuzzy = true;
        }
      }
      if (occurrences === 0) {
        return (
          `Error: old_string not found in ${displayPath}. ` +
          'The text must match the file exactly — including whitespace and indentation — and must not include ' +
          "read_file's line-number prefixes. Read the file and copy the target text verbatim."
        );
      }
      if (occurrences > 1 && !input.replace_all) {
        return (
          `Error: old_string is not unique in ${displayPath} (${occurrences} matches). ` +
          'Add more surrounding context to target a single location, or pass replace_all: true to replace every occurrence.'
        );
      }
      let updated = '';
      let pos = 0;
      for (;;) {
        const idx = haystack.indexOf(needle, pos);
        if (idx === -1) {
          updated += content.slice(pos);
          break;
        }
        updated += content.slice(pos, idx) + newStr;
        pos = idx + needle.length;
        if (!input.replace_all) {
          updated += content.slice(pos);
          break;
        }
      }
      await atomicWriteFile(filePath, updated);
      await globalToolStateManager.recordFileState(filePath);
      const label =
        input.replace_all && occurrences > 1 ? `${occurrences} occurrences` : '1 occurrence';
      const fuzzyNote = fuzzy ? '; matched after normalizing quote characters' : '';
      return `Edited ${displayPath} (replaced ${label}${fuzzyNote}).`;
    } catch (err) {
      throw toolError('Error editing file', err);
    }
  },
};

export const moveFileTool: Tool = {
  name: 'move_file',
  description:
    'Move or rename a file or directory within the workspace. ' +
    'Both paths are sandbox-checked; destination parent directories are created as needed.',
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
      const src = await safePath(input.source, ctx.workspaceDir);
      const dest = await safePath(input.destination, ctx.workspaceDir);
      try {
        await fs.access(src);
      } catch {
        return `Error: source does not exist: ${input.source}`;
      }
      if (!input.overwrite) {
        try {
          await fs.access(dest);
          return `Error: destination already exists: ${input.destination} (pass overwrite=true to replace)`;
        } catch {
          
        }
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
      return `Moved ${input.source} -> ${input.destination}`;
    } catch (err) {
      throw toolError('Error moving file', err);
    }
  },
};

export const listDirectoryTool: Tool = {
  name: 'list_directory',
  description: 'List files and directories within the workspace.',
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
    },
  },
  async execute(input, ctx) {
    try {
      const dirPath = await safePath(input.path || '.', ctx.workspaceDir);
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const lines = entries.map((e) => {
        const suffix = e.isDirectory() ? '/' : '';
        return `${e.name}${suffix}`;
      });
      return lines.join('\n') || '(empty directory)';
    } catch (err) {
      throw toolError('Error listing directory', err);
    }
  },
};


  'On Windows the local shell is cmd/PowerShell: Unix-only utilities (e.g. uname, grep without Git) are unavailable. ' +
  'Use PowerShell equivalents, read workspace files, or use device_* tools when SSH to a Linux board is configured.';

