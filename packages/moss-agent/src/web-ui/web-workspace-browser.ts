import fs from 'node:fs/promises';
import path from 'node:path';
import type http from 'node:http';

import { runProcess } from '../utils/run-process.js';

const EXCLUDED_NAMES = new Set(['.env', '.git', '.moss', 'node_modules']);
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_TEXT_BYTES = 256 * 1024;

function excluded(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]+/)
    .some((segment) => EXCLUDED_NAMES.has(segment) || segment.startsWith('.env.'));
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveContained(root: string, relativePath: string): Promise<string> {
  if (excluded(relativePath)) throw new Error('workspace path is excluded');
  const realRoot = await fs.realpath(root);
  const lexical = path.resolve(realRoot, relativePath || '.');
  if (!contained(realRoot, lexical)) throw new Error('workspace path escapes the configured root');
  const realCandidate = await fs.realpath(lexical);
  if (!contained(realRoot, realCandidate))
    throw new Error('workspace symlink escapes the configured root');
  return realCandidate;
}

/** List one bounded, read-only workspace directory for the local Web host. @internal */
export async function listWorkspaceDirectory(root: string, relativePath = '.') {
  const realRoot = await fs.realpath(root);
  const directory = await resolveContained(realRoot, relativePath);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return {
    path: path.relative(realRoot, directory).replaceAll(path.sep, '/') || '.',
    entries: entries
      .filter((entry) => !excluded(entry.name))
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .map((entry) => ({
        name: entry.name,
        path: path.relative(realRoot, path.join(directory, entry.name)).replaceAll(path.sep, '/'),
        kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }))
      .sort((left, right) =>
        left.kind === right.kind
          ? left.name.localeCompare(right.name)
          : left.kind.localeCompare(right.kind)
      ),
    truncated: entries.length > MAX_DIRECTORY_ENTRIES,
  };
}

/** Read a bounded UTF-8 workspace file without granting a browser write path. @internal */
export async function readWorkspaceFile(root: string, relativePath: string) {
  const realRoot = await fs.realpath(root);
  const file = await resolveContained(realRoot, relativePath);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('workspace path is not a file');
  if (stat.size > MAX_TEXT_BYTES) throw new Error('workspace file exceeds the preview limit');
  const body = await fs.readFile(file);
  if (body.includes(0)) throw new Error('binary workspace files cannot be previewed');
  return {
    path: path.relative(realRoot, file).replaceAll(path.sep, '/'),
    content: body.toString('utf8'),
    size: stat.size,
  };
}

/** Return status and diff-stat only; file bodies remain behind explicit preview requests. @internal */
export async function previewWorkspaceChanges(root: string) {
  const result = await runProcess('git', {
    args: ['status', '--short'],
    cwd: root,
    timeout: 5_000,
    maxBuffer: 200_000,
  });
  const diff = await runProcess('git', {
    args: ['diff', '--stat', '--', '.'],
    cwd: root,
    timeout: 5_000,
    maxBuffer: 200_000,
  });
  return { status: result.stdout, diffStat: diff.stdout };
}

/** Route the three read-only workspace endpoints. @internal */
export async function handleWorkspaceBrowserRequest(input: {
  readonly request: http.IncomingMessage;
  readonly response: http.ServerResponse;
  readonly url: URL;
  readonly root: string;
  readonly sendJson: (response: http.ServerResponse, status: number, body: unknown) => void;
}): Promise<boolean> {
  if (input.request.method !== 'GET' || !input.url.pathname.startsWith('/api/workspace/')) {
    return false;
  }
  if (input.url.pathname === '/api/workspace/tree') {
    input.sendJson(
      input.response,
      200,
      await listWorkspaceDirectory(input.root, input.url.searchParams.get('path') ?? '.')
    );
    return true;
  }
  if (input.url.pathname === '/api/workspace/file') {
    const relativePath = input.url.searchParams.get('path') ?? '';
    if (!relativePath) input.sendJson(input.response, 400, { error: 'path is required' });
    else input.sendJson(input.response, 200, await readWorkspaceFile(input.root, relativePath));
    return true;
  }
  if (input.url.pathname === '/api/workspace/changes') {
    input.sendJson(input.response, 200, await previewWorkspaceChanges(input.root));
    return true;
  }
  return false;
}
