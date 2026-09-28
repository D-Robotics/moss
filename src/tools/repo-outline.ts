import fs from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '../core/tools/tool-types.js';
import { safePath, toolError } from './tool-helpers.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.moss',
  '.cache',
  '__pycache__',
]);

const DEFAULT_MAX_ENTRIES = 300;
const HARD_MAX_ENTRIES = 800;
const MAX_OUTPUT_CHARS = 14_000;

interface OutlineEntry {
  relPath: string;
  depth: number;
  isDir: boolean;
  bytes: number;
}

async function walk(
  absRoot: string,
  relRoot: string,
  depth: number,
  maxEntries: number,
  includeHidden: boolean,
  out: OutlineEntry[],
  stats: { dirs: number; files: number; skippedDirs: number }
): Promise<void> {
  if (out.length >= maxEntries) return;
  let entries;
  try {
    entries = await fs.readdir(absRoot, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) =>
    a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1
  );
  for (const entry of entries) {
    if (out.length >= maxEntries) return;
    if (!includeHidden && entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        stats.skippedDirs += 1;
        continue;
      }
      const rel = relRoot ? `${relRoot}/${entry.name}` : entry.name;
      out.push({ relPath: rel, depth, isDir: true, bytes: 0 });
      stats.dirs += 1;
      await walk(
        path.join(absRoot, entry.name),
        rel,
        depth + 1,
        maxEntries,
        includeHidden,
        out,
        stats
      );
    } else if (entry.isFile()) {
      const rel = relRoot ? `${relRoot}/${entry.name}` : entry.name;
      let bytes = 0;
      try {
        bytes = (await fs.stat(path.join(absRoot, entry.name))).size;
      } catch {
        bytes = 0;
      }
      out.push({ relPath: rel, depth, isDir: false, bytes });
      stats.files += 1;
    }
  }
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

export const repoOutlineTool: Tool = {
  name: 'repo_outline',
  description:
    'One-shot file-level outline of the workspace tree (paths + sizes) — a cheap context amplifier: ' +
    'call this instead of many list_directory/search round-trips when you need to understand repo structure first. ' +
    'Skips node_modules/.git/dist/build/coverage/.moss and hidden dirs by default.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Root directory relative to workspace (default: workspace root)',
      },
      max_entries: {
        type: 'number',
        description: `Max tree entries to return (default ${DEFAULT_MAX_ENTRIES}, max ${HARD_MAX_ENTRIES})`,
      },
      include_hidden: {
        type: 'boolean',
        description: 'Include dotfiles/dot-dirs (default false)',
      },
    },
  },
  async execute(input, ctx) {
    try {
      const rootRel = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '.';
      const absRoot = await safePath(rootRel, ctx.workspaceDir);
      const requested = Number(input.max_entries);
      const maxEntries =
        Number.isFinite(requested) && requested > 0
          ? Math.min(HARD_MAX_ENTRIES, Math.floor(requested))
          : DEFAULT_MAX_ENTRIES;
      const includeHidden = input.include_hidden === true;

      const out: OutlineEntry[] = [];
      const stats = { dirs: 0, files: 0, skippedDirs: 0 };
      await walk(absRoot, '', 0, maxEntries, includeHidden, out, stats);

      if (out.length === 0) return '(empty outline: no visible entries under the given path)';

      const lines: string[] = [];
      let totalChars = 0;
      let shown = 0;
      for (const entry of out) {
        const indent = '  '.repeat(entry.depth);
        const label = entry.isDir
          ? `${entry.relPath.split('/').pop()}/`
          : `${entry.relPath.split('/').pop()}  ${humanBytes(entry.bytes)}`;
        const line = `${indent}${label}`;
        if (totalChars + line.length > MAX_OUTPUT_CHARS || shown >= maxEntries) break;
        lines.push(line);
        totalChars += line.length + 1;
        shown += 1;
      }

      const header =
        `Repo outline (${shown} entries shown · ${stats.dirs} dirs / ${stats.files} files · ` +
        `${stats.skippedDirs} noise dirs skipped · root: ${rootRel})\n`;
      const truncationNote =
        shown < out.length || out.length >= maxEntries
          ? `\n(truncated at ${shown} entries — narrow with path= or raise max_entries)`
          : '';
      return header + lines.join('\n') + truncationNote;
    } catch (err) {
      throw toolError('Error building repo outline', err);
    }
  },
};
