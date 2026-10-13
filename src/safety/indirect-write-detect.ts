/**
 * O101 layers 1–2: catch protected-path writes that O94's command-line
 * detector cannot see — inline interpreter code (`python -c`, `node -e`,
 * `bash -c`) and workspace script files invoked by the command.
 *
 * Best effort, not a sandbox. Script scan is read-only; paths are realpath'd
 * and must stay under the workspace. Test runners (`npm test`, `pytest`,
 * `node --test`, …) are never deep-scanned — layer 3 (post-run snapshot)
 * covers those. Scan failure → same as O94 uncertain: confirm only when the
 * command itself names a protected path.
 *
 * This module returns raw findings (path text + source location). Classification
 * lives in protected-paths.ts so there is no circular import.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_SCRIPT_BYTES = 256 * 1024;

/** Commands whose script trees we refuse to expand (rely on post-run). */
const SKIP_DEEP_SCAN =
  /(?:^|[\s;&|])(?:npm\s+(?:run\s+)?(?:test|t)\b|yarn\s+test\b|pnpm\s+test\b|npx\s+(?:vitest|jest|mocha)\b|node\s+--test\b|pytest\b|python(?:3(?:\.\d+)?)?\s+-m\s+pytest\b|vitest\b|jest\b|mocha\b|cargo\s+test\b|go\s+test\b)/i;

const INTERPRETER_INLINE: Record<string, string[]> = {
  node: ['-e', '--eval', '-p', '--print'],
  nodejs: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval'],
  deno: ['eval'],
  python: ['-c'],
  python3: ['-c'],
  python2: ['-c'],
  ruby: ['-e'],
  php: ['-r'],
  perl: ['-e', '-E'],
  lua: ['-e'],
};

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);
const SCRIPT_EXTS = new Set([
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.sh',
  '.bash',
  '.zsh',
  '.rb',
  '.pl',
  '.php',
  '.lua',
]);

const WRITE_API =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|rename|renameSync|truncate|truncateSync|write_text|write_bytes|shutil\.(?:copy|move|copyfile|copy2)|os\.(?:replace|remove|unlink|rename)|Path\([^)]*\)\.(?:write_text|write_bytes|open)|File\.write|file_put_contents|io\.open)\b|\bopen\s*\([^)]*['"][wax+]|\.write\s*\(|\bfs\.\w*[wW]rite|>>?\s*[^\s&|;]|tee\s+/;

/** Path-like tokens that look protected (literal form in source). */
const PROTECTED_LIT =
  /(?:~\/\.ssh|\$HOME\/\.ssh|\$\{HOME\}\/\.ssh|\.ssh\/|\/\.ssh(?:\/|$)|authorized_keys|id_rsa|id_ed25519|\.git\/(?:config|HEAD|hooks|refs)|(?:^|[\s'"`=(,[{])\.env(?:\.[\w.-]+)?(?:$|[\s'"`),;\]}])|\.envrc|\.bashrc|\.zshrc|\.profile(?:$|[\s'"`])|os\.path\.expanduser\s*\(\s*['"]~\/\.ssh)/i;

export interface IndirectWriteSource {
  kind: 'inline' | 'script';
  /** Script path relative to cwd, or `python -c` / `node -e` for inline. */
  script: string;
  line?: number;
  /** Offending line text (never contains file contents we wrote — only source). */
  detail?: string;
  /** O129: script realpath is outside the workspace (after resolving symlinks). */
  outsideWorkspace?: boolean;
}

export interface IndirectWriteFinding {
  /** Path text as it appears in the source (e.g. `~/.ssh/authorized_keys`). */
  raw: string;
  source: IndirectWriteSource;
  /** Scan could not fully decide (symlink to protected, unreadable + named). */
  uncertain?: boolean;
}

export type ScriptScanStatus =
  | 'ok'
  | 'skipped-runner'
  | 'outside-workspace'
  | 'unreadable'
  | 'too-large'
  | 'binary';

export interface ScriptScanResult {
  status: ScriptScanStatus;
  findings: IndirectWriteFinding[];
  scriptPath?: string;
}

function basenameCmd(word: string): string {
  return (
    word
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, '') ?? ''
  );
}

function tokenizeSimple(segment: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  return tokens;
}

function skipPrefixes(tokens: string[]): number {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i += 1;
  const prefixes = new Set(['sudo', 'doas', 'env', 'command', 'nohup', 'time', 'nice', 'stdbuf']);
  while (i < tokens.length && prefixes.has(basenameCmd(tokens[i]!))) {
    i += 1;
    while (i < tokens.length && (tokens[i]!.startsWith('-') || /^[A-Za-z_]\w*=/.test(tokens[i]!))) {
      const flag = tokens[i]!;
      i += 1;
      if (/^-[^-]*[uCg]$/.test(flag) || flag === '--user' || flag === '--group') i += 1;
    }
  }
  return i;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

function extractProtectedRaw(match: string): string {
  const m = match.match(
    /(~\/\.ssh(?:\/[\w.-]+)?|\.ssh\/[\w.-]+|\.git\/(?:config|HEAD|hooks\/[\w.-]+|refs(?:\/[\w./-]+)?)|\.env(?:\.[\w.-]+)?|\.envrc|\.bashrc|\.zshrc|\.profile)/i
  );
  return m?.[1] ?? match.trim().slice(0, 80);
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  let weird = 0;
  for (let i = 0; i < n; i += 1) {
    const b = buf[i]!;
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32 && b !== 9 && b !== 10 && b !== 13)) weird += 1;
  }
  return weird / Math.max(n, 1) > 0.3;
}

function realpathSafe(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}

function isUnder(child: string, parent: string): boolean {
  const c = path.resolve(child).replace(/\\/g, '/').toLowerCase();
  const p = path.resolve(parent).replace(/\\/g, '/').toLowerCase();
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

/**
 * Scan source text for a write API near a protected-path literal.
 * Returns findings with line numbers; never executes the source.
 */
export function scanSourceForProtectedWrites(
  source: string,
  displayName: string,
  kind: 'inline' | 'script'
): IndirectWriteFinding[] {
  if (!source || !WRITE_API.test(source)) return [];
  const findings: IndirectWriteFinding[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(PROTECTED_LIT.source, 'gi');
  while ((m = re.exec(source)) !== null) {
    const raw = extractProtectedRaw(m[0]!);
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const line = lineOf(source, m.index);
    const lineText = source.split('\n')[line - 1]?.trim().slice(0, 120) ?? '';
    findings.push({
      raw,
      source: {
        kind,
        script: displayName,
        line,
        detail: lineText.replace(/[\u0000-\u001f\u007f]/g, ''),
      },
    });
  }
  return findings;
}

/**
 * Read one workspace script (no execute) and look for protected-path writes.
 * `workspaceRoot` / `cwd` must be absolute.
 */
export function scanWorkspaceScript(
  scriptPath: string,
  cwd: string,
  workspaceRoot?: string
): ScriptScanResult {
  // O129: compare realpath to realpath. On macOS /var and /tmp are symlinks
  // (/private/var), so a lexical workspace never contained the realpath'd
  // script and the scan silently returned nothing.
  const lexCwd = path.resolve(cwd);
  const realCwd = realpathSafe(lexCwd) ?? lexCwd;
  cwd = realCwd;
  const abs = path.resolve(realCwd, scriptPath);
  const lexWorkspace = path.resolve(workspaceRoot ?? lexCwd);
  const workspace = realpathSafe(lexWorkspace) ?? lexWorkspace;
  const real = realpathSafe(abs) ?? abs;
  if (!isUnder(real, workspace) && !isUnder(real, lexWorkspace)) {
    // O129: never silent. An existing script outside the workspace is still
    // scanned read-only; any finding is uncertain (asks instead of passing).
    let findings: IndirectWriteFinding[] = [];
    try {
      const st = fs.statSync(real);
      if (st.isFile() && st.size <= MAX_SCRIPT_BYTES) {
        const buf = fs.readFileSync(real);
        if (!looksBinary(buf)) {
          findings = scanSourceForProtectedWrites(buf.toString('utf8'), real, 'script').map(
            (f) => ({ ...f, source: { ...f.source, outsideWorkspace: true }, uncertain: true })
          );
        }
      }
    } catch {
      /* unreadable: caller treats outside-workspace as scan failure */
    }
    return { status: 'outside-workspace', findings, scriptPath: real };
  }
  // Symlink whose target looks like a protected path → uncertain finding.
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(abs);
      if (PROTECTED_LIT.test(target) || /(?:^|\/)(?:\.ssh|\.git)(?:\/|$)/i.test(target)) {
        return {
          status: 'ok',
          scriptPath: real,
          findings: [
            {
              raw: target,
              source: {
                kind: 'script',
                script: scriptPath,
                line: 1,
                detail: `symlink → ${target}`,
              },
              uncertain: true,
            },
          ],
        };
      }
    }
  } catch {
    /* fall through to read */
  }
  let buf: Buffer;
  try {
    const st = fs.statSync(real);
    if (st.size > MAX_SCRIPT_BYTES) return { status: 'too-large', findings: [], scriptPath: real };
    buf = fs.readFileSync(real);
  } catch {
    return { status: 'unreadable', findings: [], scriptPath: real };
  }
  if (looksBinary(buf)) return { status: 'binary', findings: [], scriptPath: real };
  const text = buf.toString('utf8');
  const display = path.relative(cwd, real) || scriptPath;
  return {
    status: 'ok',
    scriptPath: real,
    findings: scanSourceForProtectedWrites(text, display.replace(/\\/g, '/'), 'script'),
  };
}

/** Collect script-file operands from a shell command (best effort). */
export function listInvokedScripts(command: string): string[] {
  const out: string[] = [];
  for (const segment of command.split(/(?:&&|\|\||[;|\n])/g)) {
    const tokens = tokenizeSimple(segment.trim());
    const i = skipPrefixes(tokens);
    if (i >= tokens.length) continue;
    const cmd = basenameCmd(tokens[i]!);
    const args = tokens.slice(i + 1);

    if (SHELLS.has(cmd)) {
      const cIdx = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
      if (cIdx >= 0) continue;
      const file = args.find((a) => !a.startsWith('-'));
      if (file) out.push(file);
      continue;
    }

    const inlineFlags =
      INTERPRETER_INLINE[cmd] ?? (/^python3\.\d+$/.test(cmd) ? ['-c'] : undefined);
    if (inlineFlags) {
      if (args.some((a) => inlineFlags.includes(a))) continue;
      if (args[0] === '-m') continue;
      const file = args.find(
        (a) => !a.startsWith('-') && SCRIPT_EXTS.has(path.extname(a).toLowerCase())
      );
      if (file) out.push(file);
      else {
        const any = args.find((a) => !a.startsWith('-') && !a.includes('='));
        if (any && /\.(py|js|mjs|cjs|ts|sh|bash|zsh|rb|pl)$/i.test(any)) out.push(any);
      }
      continue;
    }

    const head = tokens[i]!;
    if (
      SCRIPT_EXTS.has(path.extname(head).toLowerCase()) ||
      /^\.\/.*\.(sh|bash|zsh|py|js)$/i.test(head)
    ) {
      out.push(head);
    }
  }
  return out;
}

/** Collect inline interpreter scripts from the command. */
export function listInlineScripts(command: string): Array<{ lang: string; code: string }> {
  const out: Array<{ lang: string; code: string }> = [];
  for (const segment of command.split(/(?:&&|\|\||[;|\n])/g)) {
    const tokens = tokenizeSimple(segment.trim());
    const i = skipPrefixes(tokens);
    if (i >= tokens.length) continue;
    const cmd = basenameCmd(tokens[i]!);
    const args = tokens.slice(i + 1);

    if (SHELLS.has(cmd)) {
      const cIdx = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
      if (cIdx >= 0 && args[cIdx + 1] !== undefined) {
        out.push({ lang: cmd, code: args[cIdx + 1]! });
      }
      continue;
    }
    const inlineFlags =
      INTERPRETER_INLINE[cmd] ?? (/^python3\.\d+$/.test(cmd) ? ['-c'] : undefined);
    if (!inlineFlags) continue;
    const fIdx = args.findIndex((a) => inlineFlags.includes(a));
    if (fIdx >= 0 && args[fIdx + 1] !== undefined) {
      out.push({ lang: cmd, code: args[fIdx + 1]! });
    }
  }
  return out;
}

/**
 * Layer 1 + 2 entry: find protected-path writes in inline code and invoked
 * workspace scripts. Does not replace O97's command-line detector.
 */
export function findIndirectProtectedWrites(
  command: string,
  cwd: string,
  workspaceRoot?: string
): IndirectWriteFinding[] {
  if (!command.trim()) return [];
  const findings: IndirectWriteFinding[] = [];
  const seen = new Set<string>();
  const push = (f: IndirectWriteFinding) => {
    const key = `${f.raw.toLowerCase()}|${f.source.script}|${f.source.line ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };

  for (const { lang, code } of listInlineScripts(command)) {
    const label =
      lang === 'node' || lang === 'nodejs'
        ? 'node -e'
        : SHELLS.has(lang)
          ? `${lang} -c`
          : `${lang} -c`;
    for (const f of scanSourceForProtectedWrites(code, label, 'inline')) push(f);
  }

  if (SKIP_DEEP_SCAN.test(command)) return findings;

  let sawUnreadable = false;
  for (const script of listInvokedScripts(command)) {
    const result = scanWorkspaceScript(script, cwd, workspaceRoot);
    if (result.status === 'ok') {
      for (const f of result.findings) push(f);
    } else if (result.status === 'outside-workspace' && result.findings.length) {
      for (const f of result.findings) push(f);
    } else if (
      result.status === 'unreadable' ||
      result.status === 'too-large' ||
      result.status === 'binary' ||
      result.status === 'outside-workspace'
    ) {
      sawUnreadable = true;
    }
  }

  if (sawUnreadable && findings.length === 0) {
    const named = command.match(PROTECTED_LIT);
    if (named) {
      push({
        raw: extractProtectedRaw(named[0]!),
        source: {
          kind: 'script',
          script: '(unreadable)',
          detail: 'scan failed; command names protected path',
        },
        uncertain: true,
      });
    }
  }

  return findings;
}

export function shouldSkipDeepScan(command: string): boolean {
  return SKIP_DEEP_SCAN.test(command);
}

/** True when text looks like it names a protected path (for uncertain scan). */
export function textMentionsProtectedLiteral(text: string): boolean {
  return PROTECTED_LIT.test(text);
}
