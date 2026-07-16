import fs from 'node:fs/promises';
import path from 'node:path';
import micromatch from 'micromatch';
import { errorMessage } from '../errors.js';
import type { Tool } from '../core/tools/tool-types.js';
import { runProcess, ProcessError } from '../utils/run-process.js';
import { safePath, toolError, IS_WIN } from './tool-helpers.js';

// ── ripgrep availability ────────────────────────────────────────────────────
// ripgrep is an order of magnitude faster than the JS walk fallback and
// respects .gitignore. We probe once per process and cache the result; when rg
// is unavailable (common on Windows without explicit install) we fall back to
// the in-process grepWalk so search_code keeps working everywhere.
let rgAvailability: boolean | null = null;

async function isRgAvailable(): Promise<boolean> {
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

/**
 * Run the search via ripgrep. Returns matches in the same `path:line: context`
 * shape as grepWalk so downstream rendering is identical. rg exits 1 when there
 * are no matches (not an error); other non-zero exits are real failures.
 */
async function grepWithRg(
  searchDir: string,
  pattern: string,
  extensions: string[] | null,
  limit: number,
  timeoutMs: number,
  displayRoot: string,
  caseSensitive: boolean,
  contextLines: number
): Promise<string[] | null> {
  if (!(await isRgAvailable())) return null;

  const args = [
    '--line-number',
    '--no-heading',
    '--color=never',
    '--max-count',
    String(limit),
  ];
  // Default case-sensitive for symbol-quality coding search (Claude Code / Codex
  // Grep defaults). Pass case_sensitive: false for case-insensitive recall.
  if (!caseSensitive) args.push('-i');
  if (contextLines > 0) {
    args.push('-C', String(contextLines));
  }
  if (extensions) {
    for (const ext of extensions) {
      args.push('--glob', `*${ext}`);
    }
  }
  args.push(pattern, searchDir);

  let result;
  try {
    result = await runProcess('rg', {
      args,
      cwd: searchDir,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    if (err instanceof ProcessError) {
      // exit code 1 = no matches — return empty, not an error.
      if (err.exitCode === 1) return [];
      // exit code 2 = real error (invalid regex, io error, etc.)
      return null;
    }
    return null;
  }

  const out = result.stdout.trim();
  if (!out) return [];

  const lines = out.split('\n');
  // rg output: match `path:line:content`, context `path:line-content` (with -C).
  // Normalize both to `path:line:> content` / `path:line-| content`.
  const results: string[] = [];
  for (const line of lines) {
    if (!line.trim() || line === '--') continue;
    const m = line.match(/^(.*?):(\d+)([:-])(.*)$/);
    if (!m) continue;
    const [, file, lineNo, sep, content] = m;
    const relPath = path.relative(displayRoot, path.resolve(searchDir, file)).split(path.sep).join('/');
    const marker = sep === ':' ? ':>' : '-|';
    results.push(`${relPath}:${lineNo}${marker} ${content.slice(0, 200)}`);
    if (results.length >= limit * (contextLines > 0 ? contextLines * 2 + 1 : 1)) break;
  }
  return results;
}

export async function walkMatch(dir: string, pattern: string, limit: number): Promise<string[]> {
  const results: string[] = [];
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const matchRelativePath = normalizedPattern.includes('/');
  const root = dir;

  async function walk(d: string) {
    if (results.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= limit) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        await walk(full);
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

  await walk(dir);
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
]);


export function isSafeRegex(pattern: string): boolean {
  
  if (/(\([^)]*[+*]\)[+*])/.test(pattern)) return false;
  
  if (/(\([^)]*\|[^)]*\)[+*])/.test(pattern)) return false;
  
  if (pattern.length > 500) return false;
  return true;
}


export const searchFilesTool: Tool = {
  name: 'search_files',
  description:
    'Find files by glob pattern within the workspace. Prefer this over running `find`/`ls` through exec — ' +
    'it is sandbox-checked and returns clean paths.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "*.py", "src*.ts")' },
      path: {
        type: 'string',
        description: 'Directory to search in relative to workspace (default: root)',
      },
    },
    required: ['pattern'],
  },
  async execute(input, ctx) {
    try {
      const searchDir = await safePath(input.path || '.', ctx.workspaceDir);
      const results = await walkMatch(searchDir, input.pattern, 100);
      const relative = results
        .map((file) => path.relative(ctx.workspaceDir, file).split(path.sep).join('/'))
        .sort((a, b) => a.localeCompare(b));
      return relative.length > 0 ? relative.join('\n') : 'No files found';
    } catch (err) {
      throw toolError('Error searching files', err);
    }
  },
};

export const searchCodeTool: Tool = {
  name: 'search_code',
  description:
    'Search for a regex or text pattern within files in the workspace. Returns matching file paths and line excerpts. ' +
    'Prefer this over running `grep`/`rg` through exec when you need to locate code by content. ' +
    'Case-sensitive by default (good for symbol names); set case_sensitive: false for case-insensitive search.',
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
        description: 'Subdirectory to search within (defaults to workspace root)',
      },
      fileTypes: {
        type: 'string',
        description: 'Comma-separated extensions to include, e.g. ".ts,.js,.json"',
      },
      maxResults: {
        type: 'number',
        description: 'Max matching lines to return (default 50, max 200)',
      },
      maxFileSize: {
        type: 'number',
        description: 'Skip files larger than this in bytes (default 100KB)',
      },
      case_sensitive: {
        type: 'boolean',
        description:
          'Case-sensitive match (default true). Set false to ignore case — useful for prose, not for symbol names.',
      },
      context_lines: {
        type: 'number',
        description:
          'Lines of context before/after each match (default 1, max 3). Helps place the match without a follow-up read.',
      },
    },
    required: ['pattern'],
  },
  async execute(input, ctx) {
    const maxResults = Math.min(Number(input.maxResults) || 50, 200);
    const maxFileSize = Number(input.maxFileSize) || 100 * 1024;
    const caseSensitive = input.case_sensitive !== false;
    const contextLines = Math.min(3, Math.max(0, Math.floor(Number(input.context_lines ?? 1))));
    const extensions = input.fileTypes
      ? String(input.fileTypes)
          .split(',')
          .map((e) => e.trim().toLowerCase())
      : null;

    let regex: RegExp;
    try {
      if (!isSafeRegex(String(input.pattern))) {
        return 'Error: pattern rejected as potentially unsafe (ReDoS risk). Use a simpler pattern.';
      }
      regex = new RegExp(String(input.pattern), caseSensitive ? '' : 'i');
    } catch (err) {
      return `Invalid regex pattern: ${errorMessage(err)}`;
    }

    try {
      const searchDir = await safePath(input.path || '.', ctx.workspaceDir);
      const patternStr = String(input.pattern);
      // Prefer ripgrep when available: it respects .gitignore and is far
      // faster than the in-process walk on large repos. Falls back to grepWalk
      // transparently when rg is not on PATH (e.g. minimal Windows installs).
      const rgResults = await grepWithRg(
        searchDir,
        patternStr,
        extensions,
        maxResults,
        30_000,
        ctx.workspaceDir,
        caseSensitive,
        contextLines
      );
      let matches: string[];
      if (rgResults !== null) {
        matches = rgResults;
      } else {
        matches = await grepWalk(
          searchDir,
          regex,
          extensions,
          maxResults,
          maxFileSize,
          30_000,
          ctx.workspaceDir
        );
      }
      if (matches.length === 0) return 'No matches found';
      return matches.join('\n');
    } catch (err) {
      throw toolError('Error searching code', err);
    }
  },
};


export async function grepWalk(
  dir: string,
  regex: RegExp,
  extensions: string[] | null,
  limit: number,
  maxFileSize: number,
  timeoutMs: number,
  displayRoot = dir
): Promise<string[]> {
  const results: string[] = [];
  const deadline = Date.now() + timeoutMs;

  async function walk(d: string) {
    if (results.length >= limit || Date.now() > deadline) return;
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
        await walk(full);
      } else if (e.isFile()) {
        if (extensions && !extensions.some((ext) => e.name.toLowerCase().endsWith(ext))) continue;
        try {
          const stat = await fs.stat(full);
          if (stat.size > maxFileSize) continue;
          const content = await fs.readFile(full, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= limit) break;
            if (regex.test(lines[i])) {
              const relPath = path.relative(displayRoot, full).split(path.sep).join('/');
              const ctxBefore = Math.max(0, i - 2);
              const ctxAfter = Math.min(lines.length - 1, i + 2);
              const block: string[] = [];
              for (let j = ctxBefore; j <= ctxAfter; j++) {
                const marker = j === i ? '>' : ' ';
                block.push(`${relPath}:${j + 1}:${marker} ${lines[j].slice(0, 200)}`);
              }
              results.push(block.join('\n'));
              i = ctxAfter;
            }
          }
        } catch {
          
        }
      }
    }
  }

  await walk(dir);
  return results;
}




// Tool naming convention:
// - Function/const names use camelCase (e.g., editFileTool, webFetchTool)
// - tool.name fields use snake_case (e.g., 'edit_file', 'web_fetch')
// This convention is relied upon by tool classification logic (e.g., classifyTool in onboarding.ts)
// and capability pack registration. Maintain consistency when adding new tools.
