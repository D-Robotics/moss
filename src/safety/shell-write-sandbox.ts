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
 * approval outside autonomous profiles). The same is true of opaque
 * PowerShell (`iex`, `Start-Process`, `[IO.File]::WriteAllText`,
 * `-EncodedCommand`, nested `pwsh -c`): they are not parsed as in-workspace
 * writes; `shellCommandHasOpaqueWrite` forces them off the readonly fast
 * path so they need confirmation. Env-var indirection, including PowerShell
 * `$env:NAME`, is expanded from the ambient environment for detection
 * (over-approximation is safe: a false block is a nuisance, a false escape
 * is a bug).
 */
import { assertSandboxPath } from './sandbox-paths.js';

const ALLOWED_SPECIAL_TARGETS = [/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/i];

function isAllowedSpecial(target: string): boolean {
  return ALLOWED_SPECIAL_TARGETS.some((re) => re.test(target));
}

function expandVars(token: string): string {
  // `$env:NAME` before `$NAME`, or `$env` is eaten and the path looks relative.
  return token
    .replace(/\$\{env:(\w+)\}/gi, (_, key: string) => process.env[key] ?? '')
    .replace(/\$env:(\w+)/gi, (_, key: string) => process.env[key] ?? '')
    .replace(/\$\{(\w+)\}/g, (_, key: string) => process.env[key] ?? '')
    .replace(/\$(\w+)/g, (_, key: string) => process.env[key] ?? '');
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
  // >, >>, 2>, 10>, *>, &>, &>>, <> followed by a (possibly quoted) path token.
  const re = /(?:^|[\s;|&(])(?:\d+|\*)?>{1,2}|&>>?|<>(?=\s|$)/g;
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

const PATH_FLAGS = new Set(['path', 'literalpath', 'filepath']);
const DEST_FLAGS = new Set(['destination', 'destinationpath']);

interface WriteVerb {
  positional: 'all' | 'last' | 'none';
  flags: ReadonlySet<string>;
  /** scp-style `host:path` destinations are out of scope (drive letters are not). */
  remote?: boolean;
}

const WRITE_VERBS: Readonly<Record<string, WriteVerb>> = {
  tee: { positional: 'all', flags: new Set(['filepath']) },
  'tee-object': { positional: 'none', flags: new Set(['filepath']) },
  cp: { positional: 'last', flags: DEST_FLAGS, remote: true },
  mv: { positional: 'last', flags: DEST_FLAGS, remote: true },
  install: { positional: 'last', flags: DEST_FLAGS, remote: true },
  rsync: { positional: 'last', flags: DEST_FLAGS, remote: true },
  ln: { positional: 'last', flags: DEST_FLAGS, remote: true },
  mkdir: { positional: 'all', flags: PATH_FLAGS },
  rm: { positional: 'all', flags: PATH_FLAGS },
  rmdir: { positional: 'all', flags: PATH_FLAGS },
  unlink: { positional: 'all', flags: PATH_FLAGS },
  del: { positional: 'all', flags: PATH_FLAGS },
  erase: { positional: 'all', flags: PATH_FLAGS },
  rd: { positional: 'all', flags: PATH_FLAGS },
  'remove-item': { positional: 'all', flags: PATH_FLAGS },
  ri: { positional: 'all', flags: PATH_FLAGS },
  'set-content': { positional: 'all', flags: PATH_FLAGS },
  sc: { positional: 'all', flags: PATH_FLAGS },
  'add-content': { positional: 'all', flags: PATH_FLAGS },
  ac: { positional: 'all', flags: PATH_FLAGS },
  'clear-content': { positional: 'all', flags: PATH_FLAGS },
  clc: { positional: 'all', flags: PATH_FLAGS },
  'out-file': { positional: 'all', flags: PATH_FLAGS },
  'new-item': { positional: 'all', flags: PATH_FLAGS },
  ni: { positional: 'all', flags: PATH_FLAGS },
  md: { positional: 'all', flags: PATH_FLAGS },
  'set-item': { positional: 'all', flags: PATH_FLAGS },
  si: { positional: 'all', flags: PATH_FLAGS },
  'copy-item': { positional: 'last', flags: DEST_FLAGS },
  copy: { positional: 'last', flags: DEST_FLAGS },
  cpi: { positional: 'last', flags: DEST_FLAGS },
  'move-item': { positional: 'last', flags: DEST_FLAGS },
  move: { positional: 'last', flags: DEST_FLAGS },
  mi: { positional: 'last', flags: DEST_FLAGS },
  'rename-item': { positional: 'last', flags: new Set(['newname', 'destination']) },
  ren: { positional: 'last', flags: new Set(['newname', 'destination']) },
  rename: { positional: 'last', flags: new Set(['newname', 'destination']) },
  rni: { positional: 'last', flags: new Set(['newname', 'destination']) },
  'export-csv': { positional: 'last', flags: PATH_FLAGS },
  'invoke-webrequest': { positional: 'none', flags: new Set(['outfile']) },
  iwr: { positional: 'none', flags: new Set(['outfile']) },
  curl: { positional: 'none', flags: new Set(['outfile']) },
  wget: { positional: 'none', flags: new Set(['outfile']) },
  'expand-archive': { positional: 'last', flags: new Set(['destinationpath']) },
};

function commandHead(token: string): string {
  return token
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '');
}

/** cmd single-letter switches (`/Y`, `/Q`). A path like `/tmp` is not one of these. */
function isOptionToken(token: string): boolean {
  return token.startsWith('-') || /^\/[a-zA-Z]$/.test(token);
}

function positionalOperands(args: string[]): string[] {
  return args.filter((token) => !isOptionToken(token));
}

function flagWriteTargets(args: string[], names: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (!token.startsWith('-') || token.startsWith('--')) continue;
    const body = token.slice(1);
    const colon = body.indexOf(':');
    if (colon !== -1) {
      const name = body.slice(0, colon).toLowerCase();
      const value = stripQuotes(body.slice(colon + 1));
      if (names.has(name) && value) out.push(value);
      continue;
    }
    if (names.has(body.toLowerCase())) {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        out.push(stripQuotes(next));
        i += 1;
      }
    }
  }
  return out;
}

function isRemoteScpTarget(target: string): boolean {
  // A Windows drive letter (C:\ or c:/) is a local absolute path.
  return target.includes(':') && !/^[A-Za-z]:[\\/]/.test(target);
}

function operandTargets(segment: string): string[] {
  const tokens = tokensOf(segment);
  if (tokens.length === 0) return [];
  const head = commandHead(tokens[0]!);
  const args = tokens.slice(1);
  const operands = positionalOperands(args);
  const last = operands[operands.length - 1];

  if (head === 'dd') {
    const ofArg = args.find((t) => t.startsWith('of='));
    return ofArg ? [ofArg.slice(3).replace(/^["']|["']$/g, '')] : [];
  }
  if (head === 'truncate') {
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
      if (!isOptionToken(t)) files.push(t);
    }
    return files;
  }
  if (head === 'sed') {
    return args.some((t) => /^-[a-zA-Z]*i[a-zA-Z]*$/.test(t)) ? operands : [];
  }

  const verb = WRITE_VERBS[head];
  if (!verb) return [];
  const named = flagWriteTargets(args, verb.flags);
  if (verb.positional === 'none') return named;
  if (verb.positional === 'all') return [...named, ...operands];
  if (!last && named.length === 0) return [];
  if (verb.remote && last && isRemoteScpTarget(last) && head !== 'ln') return named;
  return last ? [...named, last] : named;
}

const OPAQUE_WRITE_HEADS = new Set(['iex', 'invoke-expression', 'start-process']);

/**
 * Indirect writes that static extraction must not treat as "no write".
 * Same policy as `python -c`: the approval layer confirms them.
 */
export function shellCommandHasOpaqueWrite(command: string): boolean {
  if (/\[(?:system\.)?io\.file\]::/i.test(command)) return true;
  if (/(?:^|[\s;|&])-encodedcommand\b/i.test(command)) return true;
  for (const segment of segments(command)) {
    const tokens = tokensOf(segment);
    if (tokens.length === 0) continue;
    const head = commandHead(tokens[0]!);
    if (OPAQUE_WRITE_HEADS.has(head)) return true;
    if (head !== 'pwsh' && head !== 'powershell') continue;
    const nested = tokens.slice(1).some((token) => {
      const flag = token.toLowerCase();
      return (
        flag === '-c' ||
        flag === '-command' ||
        flag === '-encodedcommand' ||
        flag.startsWith('-c:') ||
        flag.startsWith('-command:') ||
        flag.startsWith('-encodedcommand:')
      );
    });
    if (nested) return true;
  }
  return false;
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
