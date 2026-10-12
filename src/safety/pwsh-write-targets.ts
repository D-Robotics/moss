/**
 * O130: write targets the POSIX detector (shell-write-detect.ts) does not
 * model: PowerShell write cmdlets and aliases, `[IO.File]::Write*`, pwsh /
 * cmd env forms (`$env:X`, `${env:X}`, `%X%`) and every redirection form
 * (`>`, `>>`, `2>`, `*>`, `&>`). Stricter only.
 *
 * Scope (PM 10-12 13:07): only WRITE TARGETS are looked at. A `$` in an
 * argument or a read is never reported.
 *  - A target whose variables all resolve from the current process env is
 *    expanded and compared against protected paths.
 *  - A target with an unknown variable, a variable assigned earlier on the same
 *    command line (QA: never trust the current env for it), or a command
 *    substitution is UNRESOLVABLE and reported so the caller blocks it.
 *  - After `cd <unresolvable>` a relative write target is unresolvable too.
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

/** Words of one simple command; redirect operators become their own words. No backslash escapes (pwsh / cmd paths). */
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
 * statically (unknown / reassigned variable, command substitution).
 */
function expand(word: Word, ctx: Ctx, assigned: Set<string>): string | null {
  let w = word.text;
  if (word.quoted === 'single') return w; // literal in pwsh and POSIX
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

const VALUE_FLAGS = new Set([
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
  '-t', // cp/mv -t handled separately
  '-m',
  '--mode',
  '-s',
  '-o',
  '-g',
]);
const PATH_FLAGS = new Set(['-path', '-literalpath', '-filepath', '-filename', '-pspath', '-lp']);
const DEST_FLAGS = new Set(['-destination', '-target', '--target-directory', '-t']);

type Kind = 'first' | 'all' | 'dest' | 'newitem';
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
};

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

  const kind = WRITERS[cmd];
  if (!kind) return out;
  const positional: Word[] = [];
  let pathFlag: Word | undefined;
  let destFlag: Word | undefined;
  let nameFlag: Word | undefined;
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
      if (PATH_FLAGS.has(flag)) pathFlag = take();
      else if (DEST_FLAGS.has(flag) && kind === 'dest') destFlag = take();
      else if (flag === '-name' && kind === 'newitem') nameFlag = take();
      else if (VALUE_FLAGS.has(flag) || flag === '-name' || flag === '-destination') {
        if (inline === undefined) k++;
      }
      continue;
    }
    positional.push(a);
  }
  const add = (w: Word | undefined) => {
    if (w) out.push(w);
  };
  switch (kind) {
    case 'first':
      add(pathFlag ?? positional[0]);
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
        const src = pathFlag ? positional : positional.slice(0, -1);
        const dest = pathFlag ? positional[0] : positional[positional.length - 1];
        if (positional.length >= (pathFlag ? 1 : 2)) {
          add(dest);
          if (dest && dest.quoted !== 'single') {
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

export function findPwshWriteTargets(command: string, ctx: Ctx): PwshWriteTargets {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  if (!command || !command.trim()) return { resolved, unresolved };
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
    for (const t of targetWords(ws)) {
      if (!t.text || NULL_TARGETS.test(t.text)) continue;
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
  return { resolved, unresolved };
}
