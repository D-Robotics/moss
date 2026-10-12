/**
 * O130: write targets the POSIX detector (shell-write-detect.ts) does not
 * model: PowerShell write cmdlets and aliases, `[IO.File]::Write*`, pwsh /
 * cmd env forms (`$env:X`, `${env:X}`, `%X%`) and every redirection form
 * (`>`, `>>`, `2>`, `*>`, `&>`). Stricter only.
 *
 * Scope (PM 10-12 13:07 / QA BLOCK 10-12 14:08): only WRITE TARGETS are
 * looked at. A `$` in an argument or a read is never reported.
 *  - A target whose variables all resolve from the current process env is
 *    expanded and compared against protected paths.
 *  - A target with an unknown variable, a variable assigned earlier on the same
 *    command line (QA: never trust the current env for it), a parenthesized
 *    expression, or a command substitution is UNRESOLVABLE and reported so the
 *    caller blocks it.
 *  - After `cd <unresolvable>` a relative write target is unresolvable too.
 *  - Parameter names match by PowerShell unique-prefix against the full-name
 *    lists (so `-En`/`-Va`/`-Enc` consume values and do not steal the path).
 *  - One level of nested execution (`& {}` / `. {}` / `pwsh -c` / `iex`) is
 *    re-scanned with the SAME rules; `-EncodedCommand` always blocks.
 */
import * as path from 'node:path';

export interface PwshWriteTargets {
  /** Absolute (or ~-relative) write targets after env expansion. */
  resolved: string[];
  /** Write targets as written, which cannot be resolved statically. */
  unresolved: string[];
}

interface Ctx {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

/** Split into simple commands on ; && || | & newlines, quote-aware. */
function segments(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if (c === ';' || c === '\n' || c === '|') {
      out.push(cur);
      cur = '';
      continue;
    }
    if (c === '&') {
      // keep `2>&1` / `&>` / `>&` inside the segment
      const prev = cur.trimEnd().slice(-1);
      if (prev === '>' || command[i + 1] === '>') {
        cur += c;
        continue;
      }
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

interface Word {
  text: string; // quotes removed
  quoted: 'single' | 'double' | null;
}

/**
 * Words of one simple command; redirect operators become their own words.
 * Balanced `(...)` is kept as a single word (parenthesized expression target).
 * No backslash escapes (pwsh / cmd paths).
 */
function words(seg: string): Word[] {
  const out: Word[] = [];
  let cur = '';
  let has = false;
  let quoted: Word['quoted'] = null;
  let q: string | null = null;
  const flush = () => {
    if (has) out.push({ text: cur, quoted });
    cur = '';
    has = false;
    quoted = null;
  };
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (q) {
      if (c === q) q = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      has = true;
      quoted = quoted ?? (c === "'" ? 'single' : 'double');
      continue;
    }
    if (c === '(' && !has) {
      // parenthesized expression: keep balanced parens (and nested quotes) as one word
      let depth = 1;
      let j = i + 1;
      let pq: string | null = null;
      let body = '(';
      while (j < seg.length && depth > 0) {
        const ch = seg[j]!;
        body += ch;
        if (pq) {
          if (ch === pq) pq = null;
        } else if (ch === '"' || ch === "'") {
          pq = ch;
        } else if (ch === '(') depth++;
        else if (ch === ')') depth--;
        j++;
      }
      out.push({ text: body, quoted: null });
      i = j - 1;
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    if (c === '>') {
      // operator: optional fd / * / & prefix already in cur when it is just that
      let op = '';
      if (/^(?:\d|\*|&)$/.test(cur) && quoted === null) {
        op = cur;
        cur = '';
        has = false;
      } else flush();
      op += '>';
      if (seg[i + 1] === '>') {
        op += '>';
        i++;
      }
      if (seg[i + 1] === '|') i++;
      out.push({ text: op, quoted: null });
      if (seg[i + 1] === '&') {
        // >&2 / 2>&1: fd duplication, not a file
        let j = i + 2;
        while (j < seg.length && /\d|-/.test(seg[j]!)) j++;
        out.push({ text: '&fd', quoted: null });
        i = j - 1;
      }
      continue;
    }
    cur += c;
    has = true;
  }
  flush();
  return out;
}

const ASSIGN_RES = [
  /\$env:([A-Za-z_]\w*)\s*\+?=/gi,
  /\$\{env:([A-Za-z_]\w*)\}\s*\+?=/gi,
  /(?:^|[\s;&|(])\$([A-Za-z_]\w*)\s*\+?=/g, // pwsh $p = ...
  /(?:^|[\s;&|(])(?:export\s+|set\s+|setx\s+|local\s+|declare\s+(?:-\w+\s+)*|readonly\s+)?([A-Za-z_]\w*)=/gi,
  /\b(?:Set-Item|si|New-Item|ni)\s+(?:-Path\s+)?['"]?env:([A-Za-z_]\w*)/gi,
  /\b(?:Set-Variable|sv|New-Variable|nv)\s+(?:-Name\s+)?['"]?([A-Za-z_]\w*)/gi,
  /\bsetx\s+([A-Za-z_]\w*)\s/gi,
  /\b(?:read|for|foreach)\s+(?:-\w+\s+)*\$?([A-Za-z_]\w*)/gi,
  /\[(?:System\.)?Environment\]::SetEnvironmentVariable\(\s*['"]([A-Za-z_]\w*)/gi,
];

/** Variable names assigned anywhere on this command line (lower-cased). */
function assignedVars(command: string): Set<string> {
  const out = new Set<string>();
  for (const re of ASSIGN_RES) for (const m of command.matchAll(re)) out.add(m[1]!.toLowerCase());
  return out;
}

const NULL_TARGETS = /^(?:\$null|nul|\/dev\/(?:null|stdout|stderr|tty)|&fd|-)$/i;

/**
 * Expand a write-target word. Returns null when it cannot be resolved
 * statically (unknown / reassigned variable, command substitution,
 * parenthesized expression).
 */
function expand(word: Word, ctx: Ctx, assigned: Set<string>): string | null {
  let w = word.text;
  if (word.quoted === 'single') return w; // literal in pwsh and POSIX
  // Parenthesized expression / concat / subexpression → unresolvable (block).
  if (/^\s*\(|\)/.test(w) || /\+|Join-Path/i.test(w)) return null;
  if (/\$\(|`|@\(|\$\[|<\(|\$\{[^}]*[^\w:}]/.test(w)) return null;
  const lookup = (name: string): string | null => {
    const lower = name.toLowerCase();
    if (assigned.has(lower)) return null;
    if (lower === 'home') return ctx.home;
    if (lower === 'pwd') return ctx.cwd;
    const key = Object.keys(ctx.env).find((k) => k.toLowerCase() === lower);
    const v = key === undefined ? undefined : ctx.env[key];
    return v === undefined || v === '' ? null : v;
  };
  let bad = false;
  const sub = (_m: string, name: string) => {
    const v = lookup(name);
    if (v === null) bad = true;
    return v ?? '';
  };
  w = w
    .replace(/\$\{env:([A-Za-z_]\w*)\}/gi, sub)
    .replace(/\$env:([A-Za-z_]\w*)/gi, sub)
    .replace(/%([A-Za-z_]\w*)%/g, sub)
    .replace(/\$\{([A-Za-z_]\w*)\}/g, sub)
    .replace(/\$([A-Za-z_]\w*)/g, sub);
  if (bad || /\$/.test(w)) return null;
  return w;
}

const VALUE_FLAGS = [
  '-value',
  '-encoding',
  '-itemtype',
  '-type',
  '-inputobject',
  '-width',
  '-filter',
  '-include',
  '-exclude',
  '-credential',
  '-stream',
  '-delimiter',
  '-variable',
  '-m',
  '--mode',
  '-s',
  '-g',
  '-uri',
  '-url',
  '-method',
  '-headers',
  '-body',
  '-contenttype',
  '-userdata',
  '-transferencoding',
  '-argumentlist',
  '-args',
];
const PATH_FLAGS = ['-path', '-literalpath', '-filepath', '-pspath', '-lp', '-outfile', '-newname'];
const DEST_FLAGS = ['-destination', '-target', '--target-directory', '-t'];

/** PowerShell unique-prefix match against a list of full flag names. */
function matchFlagPrefix(flag: string, names: readonly string[]): string | undefined {
  const lower = flag.toLowerCase();
  if (names.includes(lower)) return lower;
  const hits = names.filter((n) => n.startsWith(lower));
  return hits.length === 1 ? hits[0] : undefined;
}

/** True when flag is a (possibly abbreviated) value-taking switch we should skip. */
function isValueFlag(flag: string): boolean {
  if (matchFlagPrefix(flag, VALUE_FLAGS)) return true;
  // Ambiguous abbreviation that still prefixes at least one value flag (e.g. -E
  // → Encoding/Exclude): consume the next token so it cannot steal the path slot.
  const lower = flag.toLowerCase();
  return VALUE_FLAGS.some((n) => n.startsWith(lower) && lower.length >= 2);
}

type Kind = 'first' | 'all' | 'dest' | 'newitem' | 'outfile' | 'curl';
const WRITERS: Record<string, Kind> = {
  'set-content': 'first',
  sc: 'first',
  'add-content': 'first',
  ac: 'first',
  'clear-content': 'first',
  clc: 'first',
  'out-file': 'first',
  'tee-object': 'first',
  tee: 'all',
  'new-item': 'newitem',
  ni: 'newitem',
  mkdir: 'all',
  md: 'all',
  'copy-item': 'dest',
  cpi: 'dest',
  copy: 'dest',
  cp: 'dest',
  'move-item': 'dest',
  mi: 'dest',
  move: 'dest',
  mv: 'dest',
  'rename-item': 'dest',
  rni: 'dest',
  ren: 'dest',
  install: 'dest',
  'remove-item': 'all',
  ri: 'all',
  del: 'all',
  erase: 'all',
  rm: 'all',
  rd: 'all',
  rmdir: 'all',
  touch: 'all',
  truncate: 'all',
  // O130 QA BLOCK: additional writers
  'set-item': 'first',
  si: 'first',
  'export-clixml': 'first',
  'export-csv': 'first',
  'invoke-webrequest': 'outfile',
  iwr: 'outfile',
  'invoke-restmethod': 'outfile',
  irm: 'outfile',
  curl: 'curl',
  wget: 'curl',
  xcopy: 'dest',
  robocopy: 'dest',
};

/** Paths passed to New-Object IO.StreamWriter(...) / [IO.StreamWriter]::new(...). */
function extractStreamWriterPaths(raw: string): Word[] {
  const out: Word[] = [];
  const pushArg = (a: string) => {
    let s = a.trim();
    if (!s) return;
    let quoted: Word['quoted'] = null;
    if (/^'.*'$/.test(s)) {
      quoted = 'single';
      s = s.slice(1, -1);
    } else if (/^".*"$/.test(s)) {
      quoted = 'double';
      s = s.slice(1, -1);
    }
    // ArgumentList "path, other" → first arg only
    const comma = s.search(/,(?=(?:[^']*'[^']*')*[^']*$)(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    if (comma > 0) s = s.slice(0, comma).trim();
    out.push({ text: s, quoted });
  };
  for (const m of raw.matchAll(
    /New-Object\s+(?:-TypeName\s+)?['"]?(?:System\.)?IO\.StreamWriter['"]?\s*\(\s*((?:'[^']*'|"[^"]*"|[^,)])+)/gi
  )) {
    pushArg(m[1]!);
  }
  for (const m of raw.matchAll(
    /New-Object\s+(?:-TypeName\s+)?['"]?(?:System\.)?IO\.StreamWriter['"]?\s+-ArgumentList\s+((?:'[^']*'|"[^"]*"|[^\s;|&]+))/gi
  )) {
    pushArg(m[1]!);
  }
  for (const m of raw.matchAll(
    /\[(?:System\.)?IO\.StreamWriter\]::new\s*\(\s*((?:'[^']*'|"[^"]*"|[^,)])+)/gi
  )) {
    pushArg(m[1]!);
  }
  return out;
}

/** Raw write-target words of one simple command (after the command word). */
function targetWords(ws: Word[]): Word[] {
  const out: Word[] = [];
  const plain: Word[] = [];
  for (let k = 0; k < ws.length; k++) {
    const t = ws[k]!;
    if (t.quoted === null && /^(?:\d|\*|&)?>>?$/.test(t.text)) {
      const nx = ws[k + 1];
      if (nx) out.push(nx);
      k++;
      continue;
    }
    plain.push(t);
  }
  // skip leading VAR=val prefixes and wrappers
  let i = 0;
  while (i < plain.length && plain[i]!.quoted === null && /^[A-Za-z_]\w*=/.test(plain[i]!.text))
    i++;
  while (
    i < plain.length &&
    /^(?:sudo|env|command|nohup|time|exec|nice|&|\.)$/i.test(plain[i]!.text)
  )
    i++;
  const head = plain[i];
  if (!head) return out;
  const cmd = head.text
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '');
  const args = plain.slice(i + 1);

  // [IO.File]::WriteAllText(path, …) / [System.IO.File]::AppendAllLines(…)
  const joined = plain
    .map((p) => (p.quoted === 'single' ? `'${p.text}'` : p.quoted ? `"${p.text}"` : p.text))
    .join(' ');
  for (const m of joined.matchAll(
    /\[(?:System\.)?IO\.(?:File|StreamWriter)\]::(?:Write\w*|Append\w*|Create\w*|Open\w*|Copy|Move|Replace|Delete|new)\s*\(\s*((?:'[^']*'|"[^"]*"|[^,()'"]|\([^()]*\))+)/gi
  )) {
    let a = m[1]!.trim();
    let quoted: Word['quoted'] = null;
    if (/^'.*'$/.test(a)) quoted = 'single';
    else if (/^".*"$/.test(a)) quoted = 'double';
    if (quoted) a = a.slice(1, -1);
    out.push({ text: a, quoted });
  }

  // New-Object / [IO.StreamWriter]::new ctor paths are extracted from the raw
  // segment in scanCommand (quotes survive there; joined words strip them).

  const kind = WRITERS[cmd];
  if (!kind) return out;
  const positional: Word[] = [];
  let pathFlag: Word | undefined;
  let destFlag: Word | undefined;
  let nameFlag: Word | undefined;
  let outfileFlag: Word | undefined;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if ((a.quoted === null && /^--?[A-Za-z]/.test(a.text)) || /^-[A-Za-z]+:./.test(a.text)) {
      const [flag, inline] =
        a.text.includes(':') && a.text.startsWith('-') && !a.text.startsWith('--')
          ? [
              a.text.slice(0, a.text.indexOf(':')).toLowerCase(),
              a.text.slice(a.text.indexOf(':') + 1),
            ]
          : a.text.includes('=') && a.text.startsWith('--')
            ? [
                a.text.slice(0, a.text.indexOf('=')).toLowerCase(),
                a.text.slice(a.text.indexOf('=') + 1),
              ]
            : [a.text.toLowerCase(), undefined];
      const take = (): Word | undefined =>
        inline !== undefined && inline !== '' ? { text: inline, quoted: null } : args[++k];

      // curl -o path / --output path; -O / --remote-name → unresolvable
      if (kind === 'curl' && (flag === '-o' || flag === '--output')) {
        pathFlag = take();
        continue;
      }
      if (kind === 'curl' && (a.text === '-O' || flag === '--remote-name')) {
        out.push({ text: '-O', quoted: null });
        continue;
      }

      const pathMatch = matchFlagPrefix(flag, PATH_FLAGS);
      const destMatch = matchFlagPrefix(flag, DEST_FLAGS);
      const nameMatch = matchFlagPrefix(flag, ['-name']);

      if (pathMatch === '-outfile' || (kind === 'outfile' && pathMatch)) {
        outfileFlag = take();
        continue;
      }
      if (pathMatch && pathMatch !== '-outfile') {
        if (pathMatch === '-newname' && kind === 'dest') destFlag = take();
        else pathFlag = take();
        continue;
      }
      if (destMatch && (kind === 'dest' || kind === 'first')) {
        destFlag = take();
        continue;
      }
      if (nameMatch && kind === 'newitem') {
        nameFlag = take();
        continue;
      }
      if (isValueFlag(flag) || flag === '-name' || flag === '-destination') {
        if (inline === undefined) k++;
        continue;
      }
      // Unknown flag: do not consume; positional path stays intact.
      continue;
    }
    positional.push(a);
  }
  const add = (w: Word | undefined) => {
    if (w) out.push(w);
  };
  switch (kind) {
    case 'first':
      add(pathFlag ?? destFlag ?? positional[0]);
      break;
    case 'outfile':
      add(outfileFlag ?? pathFlag);
      break;
    case 'curl':
      add(pathFlag);
      // -O already pushed as unresolved marker above
      break;
    case 'all':
      if (pathFlag) add(pathFlag);
      positional.forEach(add);
      break;
    case 'newitem': {
      const base = pathFlag ?? positional[0];
      if (base && nameFlag)
        add({
          text: `${base.text}/${nameFlag.text}`,
          quoted: base.quoted === 'single' && nameFlag.quoted === 'single' ? 'single' : 'double',
        });
      else add(base ?? nameFlag);
      break;
    }
    case 'dest': {
      if (
        pathFlag &&
        (cmd.startsWith('move') ||
          cmd === 'mi' ||
          cmd === 'mv' ||
          cmd.startsWith('ren') ||
          cmd === 'rni')
      )
        add(pathFlag);
      if (destFlag) add(destFlag);
      else {
        // xcopy/robocopy: source dest (dest is 2nd positional); others last positional
        const isCopyish = cmd === 'xcopy' || cmd === 'robocopy' || cmd === 'cp' || cmd === 'copy';
        const src = pathFlag
          ? positional
          : isCopyish
            ? positional.slice(0, 1)
            : positional.slice(0, -1);
        const dest = pathFlag
          ? positional[0]
          : isCopyish
            ? positional[1]
            : positional[positional.length - 1];
        const need = pathFlag ? 1 : isCopyish ? 2 : 2;
        if (positional.length >= need) {
          add(dest);
          if (dest && dest.quoted !== 'single' && !isCopyish) {
            for (const s of src) {
              const b = s.text.split(/[\\/]/).pop();
              if (b && !/\$|\*/.test(b)) add({ text: `${dest.text}/${b}`, quoted: dest.quoted });
            }
          }
        }
        if (cmd === 'mv' || cmd === 'move' || cmd === 'move-item' || cmd === 'mi') src.forEach(add);
      }
      break;
    }
  }
  return out;
}

function isAbsoluteAny(p: string): boolean {
  return (
    path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('~') || p.startsWith('\\\\')
  );
}

/**
 * Extract one-level nested command strings for recursive scanning.
 * Covers `& {…}` / `. {…}` / `iex '…'` / `Invoke-Expression "…"` /
 * `pwsh -c "…"` / `powershell -Command '…'` / `cmd /c "…"`.
 * `-EncodedCommand` is handled separately (always block).
 */
function extractNestedCommands(command: string): string[] {
  const out: string[] = [];

  // & { body } / . { body } — brace depth, quote-aware
  for (const m of command.matchAll(/(?:^|[\s;|&])(?:&|\.)\s*\{/g)) {
    const start = m.index! + m[0].length;
    let depth = 1;
    let q: string | null = null;
    let i = start;
    for (; i < command.length && depth > 0; i++) {
      const c = command[i]!;
      if (q) {
        if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'") {
        q = c;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    if (depth === 0) out.push(command.slice(start, i - 1));
  }

  // iex / Invoke-Expression: string literal → recurse; anything else → mark opaque
  for (const m of command.matchAll(
    /(?:^|[\s;|&])(?:iex|Invoke-Expression)\b\s*(?:-Command\s+)?/gi
  )) {
    const rest = command.slice(m.index! + m[0].length).trimStart();
    const lit = rest.match(/^(['"])([\s\S]*?)\1/);
    if (lit) out.push(lit[2]!);
    else out.push('__iex_opaque__'); // variable / subexpression — unresolvable
  }

  // pwsh/powershell -c/-Command string (not EncodedCommand). Quote-aware so
  // a `;` inside the -c body is not treated as a segment break.
  for (const m of command.matchAll(/(?:^|[\s;|&])(?:pwsh|powershell)(?:\.exe)?\b/gi)) {
    let i = m.index! + m[0].length;
    // skip to end of this invocation (quote-aware, stop at unquoted ;|& or newline)
    let q: string | null = null;
    const start = i;
    while (i < command.length) {
      const c = command[i]!;
      if (q) {
        if (c === q) q = null;
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        q = c;
        i++;
        continue;
      }
      if (c === ';' || c === '\n' || c === '|' || (c === '&' && command[i + 1] !== '&')) break;
      i++;
    }
    const args = command.slice(start, i);
    if (argsHasEncodedCommandFlag(args)) continue; // handled elsewhere
    // Find -c / -Command value (prefix match: -c, -com, -command)
    const flagRe = /(?:^|\s)(-c(?:ommand)?)(?:\s+|:)/gi;
    let fm: RegExpExecArray | null;
    let body: string | null = null;
    while ((fm = flagRe.exec(args)) !== null) {
      // fm[1] is like '-c' or '-Command'; strip leading dashes for prefix check
      const name = fm[1]!.toLowerCase().replace(/^-+/, '');
      // unique-prefix: -c matches -Command; -enc is separate and already skipped
      if (name !== 'c' && name !== 'command' && !'command'.startsWith(name)) continue;
      const after = args.slice(fm.index + fm[0].length);
      const lit = after.match(/^(['"])([\s\S]*)\1\s*$/);
      if (lit) {
        body = lit[2]!;
        break;
      }
      // unquoted single token
      const tok = after.match(/^(\S+)/);
      if (tok) {
        body = tok[1]!;
        break;
      }
    }
    if (body) out.push(body);
  }

  // cmd /c "body" / cmd /c body
  for (const m of command.matchAll(
    /(?:^|[\s;|&])cmd(?:\.exe)?\s+(?:\/[CcKk]\s+)(['"])([\s\S]*?)\1/gi
  )) {
    out.push(m[2]!);
  }

  return out.filter((s) => s.trim().length > 0);
}

/**
 * PowerShell host `-EncodedCommand` unique-prefix / alias match (VALUE_FLAGS style).
 * Matches any unique prefix of EncodedCommand (`-e`, `-en`, `-enc`, `-EncodedC`, …)
 * plus the documented short alias `-ec`. Fail-closed on host invocations: an
 * ambiguous `-e` (also a prefix of `-ExecutionPolicy`) still blocks.
 */
function isEncodedCommandFlag(flag: string): boolean {
  const lower = flag.toLowerCase();
  if (lower === '-ec') return true; // documented pwsh/powershell alias
  if (lower === '-encodedcommand') return true;
  // Unique-prefix of -EncodedCommand (length >= 2 so `-e` counts; `-ex` does not
  // match because EncodedCommand diverges at the 3rd character).
  return lower.length >= 2 && '-encodedcommand'.startsWith(lower);
}

/** True when `args` (the token stream after pwsh/powershell) has -EncodedCommand. */
function argsHasEncodedCommandFlag(args: string): boolean {
  const flagRe = /(?:^|\s)(-[A-Za-z][\w-]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = flagRe.exec(args)) !== null) {
    if (isEncodedCommandFlag(m[1]!)) return true;
  }
  return false;
}

/** True when the command line uses -EncodedCommand (always block). */
function hasEncodedCommand(command: string): boolean {
  // pwsh/powershell … <EncodedCommand unique-prefix or -ec>
  for (const m of command.matchAll(/(?:^|[\s;|&])(?:pwsh|powershell)(?:\.exe)?\b([^;\n|&]*)/gi)) {
    if (argsHasEncodedCommandFlag(m[1]!)) return true;
  }
  // Bare -EncodedCommand full name (kept for non-host forms / legacy callers)
  return /(?:^|[\s;|&])-EncodedCommand\b/i.test(command);
}

function scanCommand(command: string, ctx: Ctx, depth: number): PwshWriteTargets {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  if (!command || !command.trim()) return { resolved, unresolved };

  if (hasEncodedCommand(command)) {
    unresolved.push('-EncodedCommand');
  }

  const assigned = assignedVars(command);
  let cwd: string | null = ctx.cwd;
  for (const seg of segments(command)) {
    const ws = words(seg);
    const head = ws[0]?.text.toLowerCase();
    if (head && ['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'].includes(head)) {
      const args = ws
        .slice(1)
        .filter((w) => !(w.quoted === null && /^-/.test(w.text) && !/^-$/.test(w.text)));
      const dest = args[0];
      if (!dest || dest.text === '~') cwd = ctx.home;
      else if (dest.text === '-') cwd = null;
      else {
        const e = expand(dest, ctx, assigned);
        if (e === null) cwd = null;
        else {
          const n = e.replace(/\\/g, '/');
          const abs = n.startsWith('~') ? ctx.home + n.slice(1) : n;
          cwd = isAbsoluteAny(abs) ? abs : cwd === null ? null : path.resolve(cwd, abs);
        }
      }
      continue;
    }
    const targets = [...targetWords(ws), ...extractStreamWriterPaths(seg)];
    for (const t of targets) {
      if (!t.text || NULL_TARGETS.test(t.text)) continue;
      // curl -O marker
      if (t.text === '-O' || t.text === '--remote-name') {
        unresolved.push(t.text);
        continue;
      }
      const e = expand(t, ctx, assigned);
      if (e === null) {
        unresolved.push(t.text);
        continue;
      }
      const n = e.replace(/\\/g, '/');
      if (isAbsoluteAny(n)) resolved.push(n);
      else if (cwd === null) unresolved.push(t.text);
      else resolved.push(path.resolve(cwd, n));
    }
  }

  // One-level nested execution: apply the SAME rules (abbreviations, parens,
  // same-line assignments) to the inner string. Deeper nesting → O148.
  if (depth < 1) {
    for (const inner of extractNestedCommands(command)) {
      if (inner === '__iex_opaque__') {
        unresolved.push('Invoke-Expression');
        continue;
      }
      // Inner assigned-vars are computed from the inner string itself, so
      // same-line assignments inside the nested body are respected.
      const nested = scanCommand(inner, ctx, depth + 1);
      resolved.push(...nested.resolved);
      unresolved.push(...nested.unresolved);
    }
  }

  return { resolved, unresolved };
}

export function findPwshWriteTargets(command: string, ctx: Ctx): PwshWriteTargets {
  return scanCommand(command, ctx, 0);
}
