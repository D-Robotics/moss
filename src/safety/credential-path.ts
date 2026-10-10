/**
 * Credential-file detection for strict redaction. The file name decides.
 * A parent directory named `credentials` does not, and source / documentation
 * extensions never do (`env-credentials.ts`, `docs/credentials.md`).
 */
import path from 'node:path';
import { resolveReadPath } from './read-scope.js';

export const CREDENTIAL_WITHHELD = 'Moss credential values withheld.\n';

/** One list. `isCredentialLikePath` and search globs both use it. */
const KEY_FILENAMES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'] as const;

const CREDENTIAL_BASENAMES = new Set<string>([
  '.netrc',
  '_netrc',
  '.pgpass',
  'credentials',
  ...KEY_FILENAMES,
]);

/**
 * Source and documentation suffixes. Checked on the file name only, before
 * any `credential` substring, so `env-credentials.ts` stays ordinary text.
 */
const SOURCE_OR_DOC_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.go',
  '.py',
  '.pyi',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.dart',
  '.lua',
  '.pl',
  '.pm',
  '.r',
  '.jl',
  '.vue',
  '.svelte',
  '.md',
  '.markdown',
  '.rst',
  '.txt',
  '.adoc',
  '.asciidoc',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
]);

const GLOB_CREDENTIAL = new RegExp(
  `(^|[\\\\/])\\.env(\\b|$)|credentials|${KEY_FILENAMES.join('|')}|\\.netrc|\\.pgpass`,
  'i'
);

function fileName(filePath: string): string {
  return path.posix.basename(filePath.replace(/\\/g, '/')).toLowerCase();
}

function hasSourceOrDocExtension(base: string): boolean {
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return SOURCE_OR_DOC_EXTENSIONS.has(base.slice(dot));
}

/** `.env`, `.env.local`, `service.credentials`, `.netrc`, `id_ed25519`, `.pgpass`. */
export function isCredentialLikePath(filePath: string): boolean {
  const base = fileName(filePath);
  if (!base || hasSourceOrDocExtension(base)) return false;
  if (base === '.env' || base.startsWith('.env.') || base.startsWith('.env_')) return true;
  if (CREDENTIAL_BASENAMES.has(base)) return true;
  if (base.startsWith('credentials.') || base.endsWith('.credentials')) return true;
  return base.includes('credential');
}

/**
 * A shell word that names a credential file. The bare search term
 * `credentials` (`grep -rn credentials src`) does not. Parent directories
 * do not: only the final path segment is judged.
 */
function commandTokenIsCredentialFile(token: string): boolean {
  const normalized = token.replace(/\\/g, '/').replace(/[:=,]+$/, '');
  if (!normalized || normalized.startsWith('-')) return false;
  const base = normalized.split('/').pop() ?? normalized;
  if (!isCredentialLikePath(base)) return false;
  if (normalized.includes('/')) return true;
  if (base.startsWith('.') || base.includes('.')) return true;
  return base !== 'credentials';
}

function commandTargetsCredentialFile(command: string): boolean {
  return command.split(/[\s"'`;|&<>()]+/).some(commandTokenIsCredentialFile);
}

function globTargetsCredentialFile(glob: string): boolean {
  return GLOB_CREDENTIAL.test(glob);
}

/** True when this tool result is the contents of a credential-like file. */
export function targetsCredentialFile(toolName: string, input: Record<string, unknown>): boolean {
  const target = typeof input.path === 'string' ? input.path : '';
  const glob = typeof input.glob === 'string' ? input.glob : '';
  if (toolName === 'read_file' || toolName === 'search_code') {
    if (target && isCredentialLikePath(target)) return true;
    return glob !== '' && globTargetsCredentialFile(glob);
  }
  if (toolName === 'exec' || toolName === 'exec_background') {
    const command = typeof input.command === 'string' ? input.command : '';
    return command !== '' && commandTargetsCredentialFile(command);
  }
  return false;
}

export function isRawApiKeyFile(resolved: string): boolean {
  return path.basename(resolved) === '.apikey-key';
}

function credentialPathCandidate(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const indexed = /^(.+?):\d+(?::|>|\s)/.exec(trimmed);
  const head = (indexed?.[1] ?? '').trim();
  if (!head || head.length > 512 || /\s/.test(head)) return undefined;
  if (!head.includes('.moss') && !head.includes('.config') && !head.includes('.apikey-key')) {
    return undefined;
  }
  return head;
}

/** Drop search/grep lines that name the raw `.apikey-key` file. Config stays. */
export function scrubRawApiKeyLines(
  text: string,
  workspaceDir: string,
  env: NodeJS.ProcessEnv
): string {
  let dropped = false;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const candidate = credentialPathCandidate(line);
    if (candidate) {
      try {
        if (isRawApiKeyFile(resolveReadPath(candidate, workspaceDir, env))) {
          dropped = true;
          continue;
        }
      } catch {
        // A colon-prefixed line that is not a path stays visible.
      }
    }
    kept.push(line);
  }
  if (!dropped) return text;
  const body = kept.join('\n').replace(/\n+$/, '');
  return body ? `${body}\n${CREDENTIAL_WITHHELD}` : CREDENTIAL_WITHHELD;
}

const GREP_HIT = /^(.+?):(\d+):(.*)$/;

/** `path:line:body` when the file name is credential-like. The body may contain colons. */
export function credentialGrepHit(
  line: string
): { path: string; lineNo: string; body: string } | undefined {
  const match = GREP_HIT.exec(line);
  if (!match?.[1] || match[2] === undefined || match[3] === undefined) return undefined;
  if (match[1].length > 512 || /\s/.test(match[1])) return undefined;
  if (!isCredentialLikePath(match[1])) return undefined;
  return { path: match[1], lineNo: match[2], body: match[3] };
}
