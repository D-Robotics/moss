/**
 * Shell write-target static extraction (v0.9 W1 sandbox close-out).
 *
 * File tools confine writes to the workspace via assertSandboxPath; shell
 * commands historically were not path-confined at all — `printf x > /abs/path`
 * wrote anywhere the OS user could. This module statically extracts the
 * write targets of a shell command line (redirections, tee/dd/cp/mv/install/
 * rsync destinations, mkdir/rm/sed -i/truncate operands, one level of
 * process substitution) so the exec tools can apply the SAME root
 * confinement the file tools already enforce.
 *
 * Honest scope: this is shell-level static analysis. Writes mediated by an
 * interpreter (`python -c "open('/x','w')"`) are not statically extractable
 * and remain governed by the approval layer (mutating exec requires
 * approval outside autonomous profiles). Env-var indirection is expanded
 * from the ambient environment for detection (over-approximation is safe:
 * a false block is a nuisance, a false escape is a bug).
 */
import { assertSandboxPath } from './sandbox-paths.js';

const ALLOWED_SPECIAL_TARGETS = [/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/i];

function isAllowedSpecial(target: string): boolean {
  return ALLOWED_SPECIAL_TARGETS.some((re) => re.test(target));
}

function expandVars(token: string): string {
  return token
    .replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '')
    .replace(/\$(\w+)/g, (_, key) => process.env[key] ?? '');
}

function stripQuotes(token: string): string {
  const trimmed = token.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Split a command line into segments on shell separators (kept naive on purpose). */
function segments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||[;|\n])/g)
    .flatMap((seg) => seg.split(/\s(?=>\()/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokensOf(segment: string): string[] {
  // Split on whitespace but keep quoted runs together.
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(segment))) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

function redirectionTargets(segment: string): string[] {
  const out: string[] = [];
  // >, >>, 2>, 2>>, &>, &>>, <> followed by a (possibly quoted) path token.
  const re = /(?:^|[\s;|&(])(?:\d)?>{1,2}|&>>?|<>(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) {
    const rest = segment.slice(m.index + m[0].length).trimStart();
    if (!rest) continue;
    const tokenMatch = rest.match(/^"(?:[^"]*)"|^'(?:[^']*)'|^\S+/);
    if (!tokenMatch) continue;
    const token = stripQuotes(tokenMatch[0]);
    // Descriptor duplication (>&1, >>&2) and &-closures are not file writes.
    if (token.startsWith('&') || token === '') continue;
    out.push(token);
  }
  return out;
}

function operandTargets(segment: string): string[] {
  const tokens = tokensOf(segment);
  if (tokens.length === 0) return [];
  const head = tokens[0]!.split(/[\\/]/).pop()!;
  const args = tokens.slice(1);
  const nonFlags = args.filter((t) => !t.startsWith('-'));
  const last = nonFlags[nonFlags.length - 1];

  switch (head) {
    case 'tee':
      // every non-flag operand is a write target
      return nonFlags;
    case 'dd': {
      const ofArg = args.find((t) => t.startsWith('of='));
      return ofArg ? [ofArg.slice(3).replace(/^["']|["']$/g, '')] : [];
    }
    case 'cp':
    case 'mv':
    case 'install':
    case 'rsync':
    case 'ln': {
      if (!last) return [];
      // scp-style remote targets are out of scope, but a Windows drive letter
      // (C:\ or c:/) is a local absolute path and must stay in scope — treating
      // it as remote let shell writes escape the sandbox on Windows.
      const remoteish = last.includes(':') && !/^[A-Za-z]:[\\/]/.test(last);
      if (remoteish && head !== 'ln') return []; // remote-ish target (scp style) — out of scope
      return [last];
    }
    case 'mkdir':
    case 'rm':
    case 'rmdir':
    case 'unlink':
      return nonFlags;
    case 'truncate': {
      // `truncate -s SIZE file...` — the -s value is not a path; `-s0` attaches it.
      const files: string[] = [];
      let skipNext = false;
      for (const t of args) {
        if (skipNext) {
          skipNext = false;
          continue;
        }
        if (/^-[a-zA-Z]*s$/.test(t)) {
          skipNext = true;
          continue;
        }
        if (!t.startsWith('-')) files.push(t);
      }
      return files;
    }
    case 'sed':
      return args.some((t) => /^-[a-zA-Z]*i[a-zA-Z]*$/.test(t)) ? nonFlags : [];
    default:
      return [];
  }
}

/** Extract raw write-target tokens from a shell command line. */
export function extractShellWriteTargets(command: string): string[] {
  const out = new Set<string>();
  const visit = (cmd: string, depth: number): void => {
    for (const segment of segments(cmd)) {
      for (const target of [...redirectionTargets(segment), ...operandTargets(segment)]) {
        if (target) out.add(target);
      }
      // one level of process substitution: >(...inner command...)
      for (const ps of segment.matchAll(/>\(([^()]*)\)/g)) {
        if (depth < 1) visit(ps[1]!, depth + 1);
      }
    }
  };
  visit(command, 0);
  return [...out];
}

/**
 * Assert every statically-extractable write target stays within the given
 * roots (same containment the file tools enforce, including the symlink and
 * realpath defenses). Throws MossError on the first escape.
 */
export async function assertShellWritesWithinRoots(
  command: string,
  params: { cwd: string; roots: string[]; extraRoots?: string[] }
): Promise<void> {
  const targets = extractShellWriteTargets(command);
  for (const raw of targets) {
    const expanded = expandVars(stripQuotes(raw));
    if (!expanded || isAllowedSpecial(expanded)) continue;
    const primary = params.roots[0];
    if (!primary) continue;
    await assertSandboxPath({
      filePath: expanded,
      cwd: params.cwd,
      root: primary,
      ...(params.roots.length > 1 ? { extraRoots: params.roots.slice(1) } : {}),
    });
  }
}

/** First escaping write target, or null — non-throwing probe for tests. */
export async function findShellWriteEscape(
  command: string,
  params: { cwd: string; roots: string[]; extraRoots?: string[] }
): Promise<string | null> {
  try {
    await assertShellWritesWithinRoots(command, params);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const match = message.match(
      /(?:escapes workspace[^:]*|sandbox after realpath resolution):\s*(.+)$/
    );
    return match ? match[1]!.trim() : message;
  }
}
