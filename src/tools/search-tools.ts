import fs from 'node:fs/promises';
import path from 'node:path';
import micromatch from 'micromatch';
import { errorMessage } from '../errors.js';
import type { Tool } from '../core/tools/tool-types.js';
import { runProcess, ProcessError } from '../utils/run-process.js';
import { toolError, IS_WIN } from './tool-helpers.js';
import { resolveReadPath } from '../safety/read-scope.js';
import { redactEgress } from '../safety/tool-output-redact.js';

// ── ripgrep availability ────────────────────────────────────────────────────
// ripgrep is an order of magnitude faster than the JS walk fallback and
// respects .gitignore. We probe once per process and cache the result; when rg
// is unavailable (common on Windows without explicit install) we fall back to
// the in-process walk so search_code / search_files keep working everywhere.
let rgAvailability: boolean | null = null;

export async function isRgAvailable(): Promise<boolean> {
  if (rgAvailability !== null) return rgAvailability;
  try {
    await runProcess(IS_WIN ? 'where' : 'which', {
      args: ['rg'],
      timeout: 3000,
    });
    rgAvailability = true;
  } catch {
    rgAvailability = false;
  }
  return rgAvailability;
}

export type SearchCodeOutputMode = 'content' | 'files_with_matches' | 'count';

export interface GrepWithRgOptions {
  searchDir: string;
  pattern: string;
  extensions: string[] | null;
  /** rg --max-depth. Set for `/` and `$HOME` so a broad scan cannot walk forever. */
  maxDepth?: number;
  /** Optional rg --glob filter (e.g. `*.ts` or nested path globs). */
  glob?: string | null;
  /** Optional rg --type filter (e.g. "ts", "py"). */
  type?: string | null;
  limit: number;
  timeoutMs: number;
  displayRoot: string;
  caseSensitive: boolean;
  contextLines: number;
  outputMode: SearchCodeOutputMode;
  multiline?: boolean;
}

/**
 * Run the search via ripgrep. Shape depends on `outputMode`:
 * - content: `path:line:> match` / `path:line-| context` (matches grepWalk)
 * - files_with_matches: one relative path per line
 * - count: `path: N` per file
 *
 * Returns null when rg is unavailable or fails hard (caller falls back).
 * Empty array when there are no matches.
 */
export async function grepWithRg(opts: GrepWithRgOptions): Promise<string[] | null> {
  if (!(await isRgAvailable())) return null;

  const {
    searchDir,
    pattern,
    extensions,
    glob,
    type,
    maxDepth,
    limit,
    timeoutMs,
    displayRoot,
    caseSensitive,
    contextLines,
    outputMode,
    multiline,
  } = opts;

  const args: string[] = ['--color=never'];

  if (outputMode === 'files_with_matches') {
    args.push('--files-with-matches');
  } else if (outputMode === 'count') {
    args.push('--count');
  } else {
    args.push('--line-number', '--no-heading');
    // Cap matches per file so one hot file does not dominate the budget.
    args.push('--max-count', String(Math.max(1, Math.min(limit, 50))));
    if (contextLines > 0) {
      args.push('-C', String(contextLines));
    }
  }

  // Default case-sensitive for symbol-quality coding search (Claude Code / Codex
  // Grep defaults). Pass case_sensitive: false for case-insensitive recall.
  if (!caseSensitive) args.push('-i');
  if (multiline) args.push('-U', '--multiline-dotall');
  if (maxDepth !== undefined) args.push('--max-depth', String(maxDepth));

  if (type && /^[a-zA-Z0-9_+-]+$/.test(type)) {
    args.push('--type', type);
  }
  if (glob && glob.trim()) {
    args.push('--glob', glob.trim());
  }
  if (extensions) {
    for (const ext of extensions) {
      args.push('--glob', `*${ext.startsWith('.') ? ext : `.${ext}`}`);
    }
  }
  args.push(pattern, searchDir);

  let stdout = '';
  try {
    const result = await runProcess('rg', {
      args,
      cwd: searchDir,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    if (err instanceof ProcessError) {
      // exit code 1 = no matches — return empty, not an error.
      if (err.exitCode === 1) return [];
      // A bounded scan of / or $HOME hits unreadable directories (exit 2)
      // and may hit the time cap. Keep the lines rg already printed.
      if (maxDepth !== undefined && err.stdout.trim()) stdout = err.stdout;
      else return null;
    } else {
      return null;
    }
  }

  const out = stdout.trim();
  if (!out) return [];

  const lines = out.split('\n').filter((l) => l.trim() && l !== '--');

  if (outputMode === 'files_with_matches') {
    const results: string[] = [];
    for (const line of lines) {
      const abs = path.isAbsolute(line) ? line : path.resolve(searchDir, line);
      const relPath = path.relative(displayRoot, abs).split(path.sep).join('/');
      results.push(relPath);
      if (results.length >= limit) break;
    }
    return results;
  }

  if (outputMode === 'count') {
    const results: string[] = [];
    for (const line of lines) {
      // rg --count: path:count
      const m = line.match(/^(.*):(\d+)\s*$/);
      if (!m) continue;
      const abs = path.isAbsolute(m[1]) ? m[1] : path.resolve(searchDir, m[1]);
      const relPath = path.relative(displayRoot, abs).split(path.sep).join('/');
      results.push(`${relPath}: ${m[2]}`);
      if (results.length >= limit) break;
    }
    return results;
  }

  // content mode
  const results: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(.*?):(\d+)([:-])(.*)$/);
    if (!m) continue;
    const [, file, lineNo, sep, content] = m;
    const abs = path.isAbsolute(file) ? file : path.resolve(searchDir, file);
    const relPath = path.relative(displayRoot, abs).split(path.sep).join('/');
    const marker = sep === ':' ? ':>' : '-|';
    results.push(`${relPath}:${lineNo}${marker} ${content.slice(0, 200)}`);
    if (results.length >= limit * (contextLines > 0 ? contextLines * 2 + 1 : 1)) break;
  }
  return results;
}

/**
 * Find files via `rg --files` (respects .gitignore). Returns absolute paths
 * sorted by mtime descending (Claude Code Glob parity — recent files first).
 * Returns null when rg is unavailable.
 */
export async function filesWithRg(
  searchDir: string,
  pattern: string,
  limit: number,
  timeoutMs = 30_000,
  maxDepth?: number
): Promise<string[] | null> {
  if (!(await isRgAvailable())) return null;

  // rg --files lists all files; -g applies the glob. Patterns without a path
  // separator also match basename via a second glob on **/pattern.
  const args = ['--files', '--color=never'];
  const normalized = pattern.replace(/\\/g, '/').trim() || '*';
  args.push('--glob', normalized);
  if (!normalized.includes('/')) {
    // Also match the pattern anywhere under the tree (basename-style).
    args.push('--glob', `**/${normalized}`);
  }
  if (maxDepth !== undefined) args.push('--max-depth', String(maxDepth));
  args.push(searchDir);

  let stdout = '';
  try {
    const result = await runProcess('rg', {
      args,
      cwd: searchDir,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    if (err instanceof ProcessError) {
      if (err.exitCode === 1) return [];
      if (maxDepth !== undefined && err.stdout.trim()) stdout = err.stdout;
      else return null;
    } else {
      return null;
    }
  }

  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  // A depth-capped scan of / or $HOME can list far more paths than the result
  // cap. Stat only that prefix so the time bound is not spent sorting mtimes.
  const candidates = maxDepth !== undefined ? lines.slice(0, limit) : lines;

  // Resolve to absolute, stat for mtime, sort newest first, cap at limit.
  const withMtime: Array<{ abs: string; mtime: number }> = [];
  for (const line of candidates) {
    const abs = path.isAbsolute(line) ? line : path.resolve(searchDir, line);
    try {
      const st = await fs.stat(abs);
      if (st.isFile()) withMtime.push({ abs, mtime: st.mtimeMs });
    } catch {
      // skip vanished paths
    }
  }
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime.slice(0, limit).map((x) => x.abs);
}

export async function walkMatch(
  dir: string,
  pattern: string,
  limit: number,
  options: { maxDepth?: number; timeoutMs?: number } = {}
): Promise<string[]> {
  const results: string[] = [];
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const matchRelativePath = normalizedPattern.includes('/');
  const root = dir;
  const maxDepth = options.maxDepth;
  const deadline =
    options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : Number.POSITIVE_INFINITY;

  async function walk(d: string, depth: number) {
    if (results.length >= limit || Date.now() > deadline) return;
    if (maxDepth !== undefined && depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= limit || Date.now() > deadline) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        await walk(full, depth + 1);
      } else {
        const relPath = path.relative(root, full).split(path.sep).join('/');
        const target = matchRelativePath ? relPath : e.name;
        if (
          micromatch.isMatch(target, normalizedPattern, {
            dot: false,
            basename: false,
            nocase: true,
          })
        ) {
          results.push(full);
        }
      }
    }
  }

  await walk(dir, 0);

  // Sort by mtime descending (Claude Glob parity) when under a small limit
  // so walk fallback feels similar to the rg path.
  if (results.length <= 200) {
    const scored = await Promise.all(
      results.map(async (abs) => {
        try {
          const st = await fs.stat(abs);
          return { abs, mtime: st.mtimeMs };
        } catch {
          return { abs, mtime: 0 };
        }
      })
    );
    scored.sort((a, b) => b.mtime - a.mtime);
    return scored.map((s) => s.abs);
  }
  return results;
}

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '__pycache__',
  '.tox',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'dist',
  'build',
  'out',
  // moss-internal: session transcripts / memory / checkpoints contain the
  // exact strings agents search for (they log tool calls), creating a feedback
  // loop where search_code returns old session logs instead of source. rg
  // skips these via .gitignore; this keeps the JS-walk fallback (used when rg
  // is unavailable) at parity. .moss/skills discovery uses its own walker, so
  // search_code ignoring .moss does not break installed-skill lookup.
  '.moss',
  // Common generated/cache dirs — never source, and crowd out real results in
  // the JS-walk fallback (which does not parse .gitignore).
  'coverage',
  '.cache',
  '.turbo',
  '.parcel-cache',
]);

export function isSafeRegex(pattern: string): boolean {
  if (/(\([^)]*[+*]\)[+*])/.test(pattern)) return false;
  if (/(\([^)]*\|[^)]*\)[+*])/.test(pattern)) return false;
  if (pattern.length > 500) return false;
  return true;
}

function parseOutputMode(raw: unknown): SearchCodeOutputMode {
  const v = String(raw ?? 'content')
    .trim()
    .toLowerCase();
  if (v === 'files_with_matches' || v === 'files' || v === 'files-with-matches') {
    return 'files_with_matches';
  }
  if (v === 'count') return 'count';
  return 'content';
}

/** Caps for a recursive scan of `/` or `$HOME`. Reads stay allowed; they just stay bounded. */
export const BROAD_SEARCH_LIMITS = {
  filesystemRoot: { maxDepth: 2, timeoutMs: 8_000, maxResults: 40 },
  home: { maxDepth: 3, timeoutMs: 8_000, maxResults: 40 },
} as const;

export interface SearchBound {
  label: '/' | '$HOME';
  maxDepth: number;
  timeoutMs: number;
  maxResults: number;
  note: string;
}

export interface SearchLocation {
  dir: string;
  bound: SearchBound | null;
}

function boundNote(
  label: '/' | '$HOME',
  limits: { maxDepth: number; timeoutMs: number; maxResults: number }
): string {
  const seconds = Math.round(limits.timeoutMs / 1000);
  return (
    `Note: recursive search of ${label} is bounded ` +
    `(depth <= ${limits.maxDepth}, ${seconds}s, <= ${limits.maxResults} results). ` +
    'Narrow the path to the workspace for a full search.'
  );
}

/**
 * Default root is the workspace. Every path is searched. A recursive scan of
 * `/` or `$HOME` is depth-, time-, and result-capped; nothing is denied.
 */
export function resolveSearchLocation(raw: unknown, workspaceDir: string): SearchLocation {
  const dir = resolveReadPath(typeof raw === 'string' ? raw : '', workspaceDir);
  if (dir === path.parse(dir).root) {
    const limits = BROAD_SEARCH_LIMITS.filesystemRoot;
    return { dir, bound: { label: '/', ...limits, note: boundNote('/', limits) } };
  }
  if (dir === resolveReadPath('$HOME', workspaceDir)) {
    const limits = BROAD_SEARCH_LIMITS.home;
    return { dir, bound: { label: '$HOME', ...limits, note: boundNote('$HOME', limits) } };
  }
  return { dir, bound: null };
}

function withBoundNote(text: string, location: SearchLocation): string {
  if (!location.bound) return text;
  return `${text}\n${location.bound.note}`;
}

function presentSearch(text: string, location: SearchLocation): string {
  return redactEgress(withBoundNote(text, location));
}

export const searchFilesTool: Tool = {
  name: 'search_files',
  description:
    'Find files by glob pattern (Claude Code Glob parity). ' +
    'Prefer this over running `find`/`ls` through exec — it respects .gitignore when ripgrep is available, and returns paths sorted by modification time (newest first). ' +
    'Patterns: `*.ts`, `src/**/*.tsx`, `**/package.json`. The default root is the workspace; an explicit path outside it is still searched. A recursive search of `/` or `$HOME` is depth-, time-, and result-capped. For open-ended multi-round search, use create_subagent scope=explore.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern (e.g. "*.py", "src/**/*.ts", "**/SKILL.md")',
      },
      path: {
        type: 'string',
        description:
          'Directory to search. Defaults to the workspace root, not the filesystem root.',
      },
      maxResults: {
        type: 'number',
        description:
          'Max paths to return (default 100, max 500). Alias: head_limit (Claude Code Glob).',
      },
      head_limit: {
        type: 'number',
        description:
          'Alias for maxResults (Claude Code Glob head_limit). Cap on returned paths (newest first).',
      },
    },
    required: ['pattern'],
  },
  async execute(input, ctx) {
    try {
      const location = resolveSearchLocation(input.path, ctx.workspaceDir);
      const rawLimit = Number(input.head_limit ?? input.maxResults);
      const requested = Math.min(
        500,
        Math.max(1, Math.floor(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100))
      );
      const limit = location.bound ? Math.min(requested, location.bound.maxResults) : requested;
      const pattern = String(input.pattern ?? '*');
      const timeoutMs = location.bound?.timeoutMs ?? 30_000;
      const maxDepth = location.bound?.maxDepth;

      // Prefer rg --files: gitignore-aware and fast on monorepos.
      let absPaths = await filesWithRg(location.dir, pattern, limit, timeoutMs, maxDepth);
      if (absPaths === null) {
        absPaths = await walkMatch(location.dir, pattern, limit, {
          ...(maxDepth !== undefined ? { maxDepth, timeoutMs } : {}),
        });
      }

      const relative = absPaths.map((file) =>
        path.relative(ctx.workspaceDir, file).split(path.sep).join('/')
      );
      if (relative.length === 0) return presentSearch('No files found', location);
      const truncated = absPaths.length >= limit;
      const header = truncated
        ? `Found ${relative.length}+ files (showing first ${limit}, newest first):\n`
        : `Found ${relative.length} file(s) (newest first):\n`;
      return presentSearch(header + relative.join('\n'), location);
    } catch (err) {
      throw toolError('Error searching files', err);
    }
  },
};

export const searchCodeTool: Tool = {
  name: 'search_code',
  description:
    'Search for a regex or text pattern (Claude Code Grep parity, powered by ripgrep when available). ' +
    'The default root is the workspace. An explicit path outside it is still searched. A recursive search of `/` or `$HOME` is depth-, time-, and result-capped.\n' +
    'Prefer this over running `grep`/`rg` through exec.\n' +
    '- Default output_mode is "content" (matching lines with context).\n' +
    '- Use output_mode "files_with_matches" to get only file paths (cheaper for discovery).\n' +
    '- Use output_mode "count" for per-file match counts.\n' +
    '- Filter with glob (e.g. "*.ts") or type (rg --type, e.g. "ts", "py").\n' +
    '- Case-sensitive by default (good for symbol names); set case_sensitive: false for prose.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex or literal text to search for' },
      path: {
        type: 'string',
        description:
          'File or directory to search. Defaults to the workspace root, not the filesystem root. A search of / or $HOME is depth-, time-, and result-capped.',
      },
      fileTypes: {
        type: 'string',
        description:
          'Comma-separated extensions to include, e.g. ".ts,.js,.json" (legacy; prefer glob or type)',
      },
      glob: {
        type: 'string',
        description: 'Glob filter for files (rg --glob), e.g. "*.ts", "src/**/*.{ts,tsx}"',
      },
      type: {
        type: 'string',
        description: 'ripgrep file type (rg --type), e.g. "ts", "py", "rust", "go", "java"',
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description:
          'content = matching lines (default); files_with_matches = paths only; count = per-file counts',
      },
      maxResults: {
        type: 'number',
        description:
          'Max results to return (default 50, max 200). Alias: head_limit (Claude Code Grep).',
      },
      head_limit: {
        type: 'number',
        description:
          'Alias for maxResults (Claude Code Grep head_limit). Cap on returned matches/paths/counts.',
      },
      maxFileSize: {
        type: 'number',
        description: 'Skip files larger than this in bytes for JS fallback only (default 100KB)',
      },
      case_sensitive: {
        type: 'boolean',
        description:
          'Case-sensitive match (default true). Set false to ignore case — useful for prose, not for symbol names.',
      },
      context_lines: {
        type: 'number',
        description:
          'Lines of context before/after each match in content mode (default 1, max 3). Ignored for other modes.',
      },
      multiline: {
        type: 'boolean',
        description:
          'Enable multiline regex (rg -U --multiline-dotall). Default false. Patterns can span lines.',
      },
    },
    required: ['pattern'],
  },
  async execute(input, ctx) {
    // head_limit is the Claude Code Grep name; maxResults is the Moss name.
    const rawLimit = Number(input.head_limit ?? input.maxResults);
    const maxResults = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200);
    const maxFileSize = Number(input.maxFileSize) || 100 * 1024;
    const caseSensitive = input.case_sensitive !== false;
    const contextLines = Math.min(3, Math.max(0, Math.floor(Number(input.context_lines ?? 1))));
    const outputMode = parseOutputMode(input.output_mode);
    const multiline = input.multiline === true;
    const globFilter =
      typeof input.glob === 'string' && input.glob.trim() ? input.glob.trim() : null;
    const typeFilter =
      typeof input.type === 'string' && input.type.trim() ? input.type.trim() : null;
    const extensions = input.fileTypes
      ? String(input.fileTypes)
          .split(',')
          .map((e) => {
            const t = e.trim().toLowerCase();
            return t.startsWith('.') ? t : `.${t}`;
          })
          .filter(Boolean)
      : null;

    let regex: RegExp;
    try {
      if (!isSafeRegex(String(input.pattern))) {
        return redactEgress(
          'Error: pattern rejected as potentially unsafe (ReDoS risk). Use a simpler pattern.'
        );
      }
      regex = new RegExp(
        String(input.pattern),
        caseSensitive ? (multiline ? 'ms' : '') : multiline ? 'ims' : 'i'
      );
    } catch (err) {
      return redactEgress(`Invalid regex pattern: ${errorMessage(err)}`);
    }

    try {
      const location = resolveSearchLocation(input.path, ctx.workspaceDir);
      const patternStr = String(input.pattern);
      const cappedResults = location.bound
        ? Math.min(maxResults, location.bound.maxResults)
        : maxResults;
      const timeoutMs = location.bound?.timeoutMs ?? 30_000;
      const maxDepth = location.bound?.maxDepth;
      // Prefer ripgrep when available: respects .gitignore and is far
      // faster than the in-process walk on large repos.
      const rgResults = await grepWithRg({
        searchDir: location.dir,
        pattern: patternStr,
        extensions,
        glob: globFilter,
        type: typeFilter,
        limit: cappedResults,
        timeoutMs,
        displayRoot: ctx.workspaceDir,
        caseSensitive,
        contextLines: outputMode === 'content' ? contextLines : 0,
        outputMode,
        multiline,
        ...(maxDepth !== undefined ? { maxDepth } : {}),
      });

      let matches: string[];
      if (rgResults !== null) {
        matches = rgResults;
      } else {
        // JS fallback — limited output_mode support (content + files_with_matches + count)
        matches = await grepWalk(
          location.dir,
          regex,
          extensions,
          cappedResults,
          maxFileSize,
          timeoutMs,
          ctx.workspaceDir,
          {
            outputMode,
            contextLines: outputMode === 'content' ? contextLines : 0,
            glob: globFilter,
            ...(maxDepth !== undefined ? { maxDepth } : {}),
          }
        );
      }
      if (matches.length === 0) return presentSearch('No matches found', location);
      if (outputMode === 'files_with_matches') {
        return presentSearch(
          `Files with matches (${matches.length}):\n${matches.join('\n')}`,
          location
        );
      }
      if (outputMode === 'count') {
        return presentSearch(
          `Match counts (${matches.length} files):\n${matches.join('\n')}`,
          location
        );
      }
      return presentSearch(matches.join('\n'), location);
    } catch (err) {
      throw toolError('Error searching code', err);
    }
  },
};

export interface GrepWalkOptions {
  outputMode?: SearchCodeOutputMode;
  contextLines?: number;
  glob?: string | null;
  maxDepth?: number;
}

export async function grepWalk(
  dir: string,
  regex: RegExp,
  extensions: string[] | null,
  limit: number,
  maxFileSize: number,
  timeoutMs: number,
  displayRoot = dir,
  options: GrepWalkOptions = {}
): Promise<string[]> {
  const outputMode = options.outputMode ?? 'content';
  const contextLines = options.contextLines ?? 2;
  const globFilter = options.glob ?? null;
  const maxDepth = options.maxDepth;
  const results: string[] = [];
  const fileCounts = new Map<string, number>();
  const deadline = Date.now() + timeoutMs;

  async function walk(d: string, depth: number) {
    if (results.length >= limit || Date.now() > deadline) return;
    if (maxDepth !== undefined && depth > maxDepth) return;
    if (outputMode !== 'content' && fileCounts.size >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= limit || Date.now() > deadline) return;
      if (outputMode !== 'content' && fileCounts.size >= limit) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        if (extensions && !extensions.some((ext) => e.name.toLowerCase().endsWith(ext))) continue;
        const relPath = path.relative(displayRoot, full).split(path.sep).join('/');
        if (globFilter) {
          try {
            if (
              !micromatch.isMatch(relPath, globFilter, { dot: false, nocase: true }) &&
              !micromatch.isMatch(e.name, globFilter, { dot: false, nocase: true })
            ) {
              continue;
            }
          } catch {
            // invalid glob — skip filter
          }
        }
        try {
          const stat = await fs.stat(full);
          if (stat.size > maxFileSize) continue;
          const content = await fs.readFile(full, 'utf-8');
          const lines = content.split('\n');
          let fileMatchCount = 0;
          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (!regex.test(lines[i])) continue;
            fileMatchCount++;
            if (outputMode === 'content') {
              if (results.length >= limit) break;
              const ctxBefore = Math.max(0, i - contextLines);
              const ctxAfter = Math.min(lines.length - 1, i + contextLines);
              for (let j = ctxBefore; j <= ctxAfter; j++) {
                const marker = j === i ? ':>' : '-|';
                results.push(`${relPath}:${j + 1}${marker} ${lines[j].slice(0, 200)}`);
              }
              i = ctxAfter;
            }
          }
          // Multiline whole-file fallback when per-line scan found nothing.
          if (fileMatchCount === 0 && (regex.flags.includes('s') || regex.flags.includes('m'))) {
            regex.lastIndex = 0;
            if (regex.test(content)) {
              fileMatchCount = 1;
              if (outputMode === 'content' && results.length < limit) {
                results.push(`${relPath}:1:> [multiline match]`);
              }
            }
          }
          if (fileMatchCount > 0) {
            if (outputMode === 'files_with_matches') {
              if (!fileCounts.has(relPath)) {
                fileCounts.set(relPath, fileMatchCount);
                results.push(relPath);
              }
            } else if (outputMode === 'count') {
              if (!fileCounts.has(relPath)) {
                fileCounts.set(relPath, fileMatchCount);
                results.push(`${relPath}: ${fileMatchCount}`);
              }
            }
          }
        } catch {
          // unreadable file
        }
      }
    }
  }

  await walk(dir, 0);
  return results;
}

// Tool naming convention:
// - Function/const names use camelCase (e.g., editFileTool, webFetchTool)
// - tool.name fields use snake_case (e.g., 'edit_file', 'web_fetch')
// This convention is relied upon by tool classification logic (e.g., classifyTool in onboarding.ts)
// and capability pack registration. Maintain consistency when adding new tools.
