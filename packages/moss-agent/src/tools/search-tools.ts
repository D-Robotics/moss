import fs from 'node:fs/promises';
import path from 'node:path';
import micromatch from 'micromatch';
import { errorMessage } from '../errors.js';
import type { Tool } from '../core/tools/tool-types.js';
import { safePath, toolError } from './tool-helpers.js';

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
    'Prefer this over running `grep`/`rg` through exec when you need to locate code by content.',
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
    },
    required: ['pattern'],
  },
  async execute(input, ctx) {
    const maxResults = Math.min(Number(input.maxResults) || 50, 200);
    const maxFileSize = Number(input.maxFileSize) || 100 * 1024;
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
      regex = new RegExp(String(input.pattern), 'i');
    } catch (err) {
      return `Invalid regex pattern: ${errorMessage(err)}`;
    }

    try {
      const searchDir = await safePath(input.path || '.', ctx.workspaceDir);
      const matches = await grepWalk(
        searchDir,
        regex,
        extensions,
        maxResults,
        maxFileSize,
        30_000,
        ctx.workspaceDir
      );
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
