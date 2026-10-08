/**
 * `@` file mentions — typing `@` opens a filtered workspace-file menu and Tab
 * completes the path into the composer, matching the reference CLI's attach
 * flow. Pure functions (no ink, no fs at render time) so specs drive them.
 *
 * The index is a bounded, ignore-aware walk: a mention menu must open instantly,
 * so this never walks node_modules/.git/dist and never returns more than a few
 * thousand entries.
 */
import fs from 'node:fs';
import path from 'node:path';

import { clip, displayWidth, line, padEndTo, type TuiLine } from './text.js';

export interface MentionEntry {
  /** Workspace-relative path (POSIX separators). */
  path: string;
  /** Directories get a trailing slash and sort first. */
  directory: boolean;
}

export const MENTION_MAX_ROWS = 6;

const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.moss',
  '.next',
  '.cache',
  '.venv',
  '__pycache__',
]);

// A real repo has thousands of tracked files; the menu only renders a handful,
// but the index must be deep enough that a file search actually finds the file.
const DEFAULT_LIMIT = 6000;

/**
 * Bounded workspace walk. Directories first, then files, each alphabetically, so
 * `@src/` narrows predictably.
 */
export function workspaceFileIndex(root: string, limit = DEFAULT_LIMIT): MentionEntry[] {
  const dirs: MentionEntry[] = [];
  const files: MentionEntry[] = [];
  const walk = (absDir: string, prefix: string, depth: number): void => {
    if (dirs.length + files.length >= limit || depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (dirs.length + files.length >= limit) return;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') {
        if (IGNORED.has(entry.name)) continue;
      }
      if (IGNORED.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        dirs.push({ path: `${rel}/`, directory: true });
        walk(path.join(absDir, entry.name), rel, depth + 1);
      } else if (entry.isFile()) {
        files.push({ path: rel, directory: false });
      }
    }
  };
  walk(root, '', 0);
  // Shallow first: a bare `@` must offer the entries the user can see, not one
  // deep subtree that happens to sort first. Then directories, then files.
  const depth = (entry: MentionEntry) => entry.path.replace(/\/$/, '').split('/').length;
  const rank = (a: MentionEntry, b: MentionEntry) =>
    depth(a) - depth(b) ||
    Number(b.directory) - Number(a.directory) ||
    a.path.localeCompare(b.path);
  return [...dirs, ...files].sort(rank).slice(0, limit);
}

/** Same index as {@link workspaceFileIndex}, but each directory read yields. */
export async function buildWorkspaceIndexAsync(
  root: string,
  limit = DEFAULT_LIMIT
): Promise<MentionEntry[]> {
  const dirs: MentionEntry[] = [];
  const files: MentionEntry[] = [];
  const queue: Array<{ abs: string; prefix: string; depth: number }> = [
    { abs: root, prefix: '', depth: 0 },
  ];
  while (queue.length > 0 && dirs.length + files.length < limit) {
    const next = queue.shift();
    if (!next || next.depth > 8) continue;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(next.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (dirs.length + files.length >= limit) break;
      if (IGNORED.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const rel = next.prefix ? `${next.prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        dirs.push({ path: `${rel}/`, directory: true });
        queue.push({ abs: path.join(next.abs, entry.name), prefix: rel, depth: next.depth + 1 });
      } else if (entry.isFile()) {
        files.push({ path: rel, directory: false });
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const depth = (entry: MentionEntry) => entry.path.replace(/\/$/, '').split('/').length;
  return [...dirs, ...files]
    .sort(
      (a, b) =>
        depth(a) - depth(b) ||
        Number(b.directory) - Number(a.directory) ||
        a.path.localeCompare(b.path)
    )
    .slice(0, limit);
}

export interface MentionToken {
  /** Offset of the `@` in the value. */
  start: number;
  /** Offset just past the query. */
  end: number;
  query: string;
}

/**
 * The `@token` under the caret, or null. Only a word-boundary `@` opens the
 * menu (`foo@bar` and `@` after a path character do not), and only while the
 * token has no whitespace in it.
 */
export function mentionTokenAt(value: string, caret: number): MentionToken | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0) {
    const previous = value[at - 1] ?? '';
    if (!/\s/.test(previous)) return null;
  }
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, end: caret, query };
}

/** Rank entries for a query: prefix first, then substring, then subsequence. */
export function filterMentions(
  index: readonly MentionEntry[],
  query: string,
  limit = MENTION_MAX_ROWS
): MentionEntry[] {
  const needle = query.toLowerCase().replace(/^\.\//, '');
  if (!needle) return index.slice(0, limit);
  const scored: Array<{ entry: MentionEntry; tier: number; length: number }> = [];
  for (const entry of index) {
    const haystack = entry.path.toLowerCase();
    const base = haystack.replace(/\/$/, '').split('/').pop() ?? haystack;
    let tier: number;
    if (haystack.startsWith(needle) || base.startsWith(needle)) tier = 0;
    else if (haystack.includes(needle)) tier = 1;
    else if (isSubsequence(needle, haystack)) tier = 2;
    else continue;
    scored.push({ entry, tier, length: entry.path.length });
  }
  scored.sort(
    (a, b) => a.tier - b.tier || a.length - b.length || a.entry.path.localeCompare(b.entry.path)
  );
  return scored.slice(0, limit).map((item) => item.entry);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return index === needle.length;
}

/** Replace the active `@token` with the chosen path. */
export function completeMention(
  value: string,
  token: MentionToken,
  entry: MentionEntry
): { value: string; caret: number } {
  const insertion = `@${entry.path}${entry.directory ? '' : ' '}`;
  const next = `${value.slice(0, token.start)}${insertion}${value.slice(token.end)}`;
  return { value: next, caret: token.start + insertion.length };
}

/** Render rows for the mention menu. */
export function renderMentionMenu(
  entries: readonly MentionEntry[],
  options: { width: number; selected: number; query?: string }
): TuiLine[] {
  if (entries.length === 0) return [];
  const width = Math.max(4, options.width);
  const selected = Math.max(0, Math.min(options.selected, entries.length - 1));
  const labelWidth =
    Math.min(
      48,
      entries.reduce((widest, entry) => Math.max(widest, displayWidth(entry.path)), 0) + 2
    ) || 2;
  return entries.map((entry, index) => {
    const marker = index === selected ? '❯ ' : '  ';
    const kind = entry.directory ? 'dir' : 'file';
    const text = `${marker}${padEndTo(`@${entry.path}`, labelWidth)}${kind}`;
    return index === selected
      ? line(clip(text, width), { color: 'cyan', bold: true })
      : line(clip(text, width), { dim: true });
  });
}
