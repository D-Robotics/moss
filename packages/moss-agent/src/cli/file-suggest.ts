import fs from 'node:fs';
import path from 'node:path';

export interface FileSuggestion {
  rel: string;

  abs: string;
  kind: 'file' | 'dir';
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.moss',
  'dist',
  'build',
  '.cache',
  '.next',
  'coverage',
  '.DS_Store',
]);

const DEFAULT_LIMIT = 8;
const MAX_SCAN_ENTRIES = 4000;

function fuzzyRank(candidate: string, query: string): [number, number, number] | null {
  if (query.length === 0) return [1, 0, 0];
  if (candidate === query) return [0, 0, 0];
  if (candidate.startsWith(query)) return [1, query.length, 0];
  let ci = 0;
  let first = -1;
  let last = -1;
  for (let qi = 0; qi < query.length; qi += 1) {
    const ch = query[qi]!;
    let found = -1;
    while (ci < candidate.length) {
      if (candidate[ci] === ch) {
        found = ci;
        ci += 1;
        break;
      }
      ci += 1;
    }
    if (found === -1) return null;
    if (first === -1) first = found;
    last = found;
  }
  return [2, last - first, first];
}

function splitPartial(partial: string): { dir: string; frag: string } {
  const norm = partial.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  if (slash === -1) return { dir: '', frag: norm };
  return { dir: norm.slice(0, slash + 1), frag: norm.slice(slash + 1) };
}

export function suggestWorkspaceFiles(
  partial: string,
  workspace: string,
  options: { limit?: number } = {}
): FileSuggestion[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const { dir, frag } = splitPartial(partial);

  const scanAbs = path.resolve(workspace, dir);
  const rootAbs = path.resolve(workspace);
  if (scanAbs !== rootAbs && !scanAbs.startsWith(rootAbs + path.sep)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scanAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.length > MAX_SCAN_ENTRIES) entries = entries.slice(0, MAX_SCAN_ENTRIES);

  const fragLower = frag.toLowerCase();
  const ranked: Array<{
    suggestion: FileSuggestion;
    rank: [number, number, number];
    name: string;
  }> = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.') && !fragLower.startsWith('.')) continue;
    const isDir = entry.isDirectory();
    if (isDir && SKIP_DIRS.has(name)) continue;
    if (!isDir && !entry.isFile()) continue;
    const rank = fuzzyRank(name.toLowerCase(), fragLower);
    if (!rank) continue;
    const relRaw = path.posix.join(dir.replace(/\\/g, '/'), name);
    const rel = isDir ? `${relRaw}/` : relRaw;
    const abs = path.join(scanAbs, name);
    ranked.push({ suggestion: { rel, abs, kind: isDir ? 'dir' : 'file' }, rank, name });
  }

  ranked.sort(
    (a, b) =>
      a.rank[0] - b.rank[0] ||
      a.rank[1] - b.rank[1] ||
      a.rank[2] - b.rank[2] ||
      (a.suggestion.kind === b.suggestion.kind ? 0 : a.suggestion.kind === 'dir' ? -1 : 1) ||
      a.name.localeCompare(b.name)
  );

  return ranked.slice(0, limit).map((entry) => entry.suggestion);
}

export function detectAtReference(
  value: string,
  cursor: number
): { partial: string; start: number } | null {
  const before = value.slice(0, cursor);

  const match = /(?:^|\s)@(\S*)$/.exec(before);
  if (!match) return null;
  const partial = match[1] ?? '';
  const start = cursor - partial.length - 1;
  return { partial, start };
}

export function parseAtReferences(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|\s)@(\S+)/g;
  for (const match of text.matchAll(re)) {
    const raw = (match[1] ?? '').replace(/\/+$/, '');
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}
