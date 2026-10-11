/**
 * Best-effort static detection of files a shell command may write.
 *
 * Used by the loop guard (O97) to stop a model from rewriting a file through
 * `exec` after the edit tools refused it; meant to be reused by O94.
 *
 * Contract:
 * - `targets`: absolute paths the command writes in a way we can see
 *   (redirects, `tee`, `cp`/`mv`/`install`/`rsync`/`ln` destinations,
 *   `dd of=`, `sed -i`, `perl -i`, `awk -i inplace`, `truncate`,
 *   `git checkout|restore`, nested `sh -c`/`bash -c`/`eval`, and quoted
 *   path literals inside `node -e`/`python -c`/... scripts that call a write
 *   API).
 * - `uncertain`: the command may write files we cannot see statically
 *   (inline interpreter code, running a script file, `git apply`/`patch`,
 *   `$(...)`/backticks, unbalanced quotes).
 * - `mentions`: absolute form of every path-like word in the command,
 *   including words inside quoted scripts. Callers combine it with
 *   `uncertain` (e.g. block when uncertain AND a protected file is named).
 *
 * Not detected (documented limits): writes performed by a script file whose
 * text is not in the command (`python fix.py`), paths assembled at runtime
 * (string concatenation, env vars, base64), and anything outside POSIX-like
 * shell syntax.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ShellWriteDetection {
  targets: string[];
  uncertain: boolean;
  mentions: string[];
}

type Token = { kind: 'word'; text: string } | { kind: 'op'; text: string };

const SEPARATORS = new Set([';', '&&', '||', '|', '|&', '&', '\n', '(', ')']);
const REDIRECT_WRITE = /^(?:\d*>>?|\d*>\||&>>?)$/;

/** Remove heredoc bodies (`<<EOF ... EOF`); keep the `<<WORD` operator. */
function stripHeredocBodies(command: string): string {
  const lines = command.split('\n');
  const out: string[] = [];
  let pending: string[] = [];
  for (const line of lines) {
    if (pending.length > 0) {
      const want = pending[0]!;
      if (line.replace(/^\t+/, '').trim() === want) pending = pending.slice(1);
      continue;
    }
    out.push(line);
    const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) pending.push(m[2]!);
  }
  return out.join('\n');
}

function tokenize(command: string): { tokens: Token[]; balanced: boolean } {
  const tokens: Token[] = [];
  let i = 0;
  let word = '';
  let inWord = false;
  const flush = () => {
    if (inWord) tokens.push({ kind: 'word', text: word });
    word = '';
    inWord = false;
  };
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return { tokens, balanced: false };
      word += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = '';
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) {
          buf += command[j + 1];
          j += 2;
          continue;
        }
        buf += command[j];
        j++;
      }
      if (j >= command.length) return { tokens, balanced: false };
      word += buf;
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') word += command[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t') {
      flush();
      i++;
      continue;
    }
    if (c === '\n' || c === ';' || c === '(' || c === ')') {
      flush();
      tokens.push({ kind: 'op', text: c });
      i++;
      continue;
    }
    if (c === '|' || c === '&') {
      // `&>` / `&>>` redirect
      if (c === '&' && command[i + 1] === '>') {
        flush();
        const op = command[i + 2] === '>' ? '&>>' : '&>';
        tokens.push({ kind: 'op', text: op });
        i += op.length;
        continue;
      }
      flush();
      const two = command.slice(i, i + 2);
      const op = two === '&&' || two === '||' || two === '|&' ? two : c;
      tokens.push({ kind: 'op', text: op });
      i += op.length;
      continue;
    }
    if (c === '>' || c === '<') {
      // fd prefix like 2> stays attached to the operator
      let fd = '';
      if (inWord && /^\d+$/.test(word)) {
        fd = word;
        word = '';
        inWord = false;
      } else flush();
      let op = c;
      let j = i + 1;
      if (c === '>' && (command[j] === '>' || command[j] === '|')) op += command[j++];
      else if (c === '<' && command[j] === '<') {
        op += command[j++];
        if (command[j] === '<' || command[j] === '-') op += command[j++];
      }
      if (command[j] === '&') {
        // fd duplication: 2>&1, <&3 — not a file write
        j++;
        while (j < command.length && /[0-9-]/.test(command[j]!)) j++;
        i = j;
        continue;
      }
      tokens.push({ kind: 'op', text: fd + op });
      i = j;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  flush();
  return { tokens, balanced: true };
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveWord(word: string, cwd: string): string | null {
  const w = word.trim();
  if (!w || w.startsWith('-') || w.startsWith('/dev/')) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return null;
  return path.resolve(cwd, expandHome(w));
}

const INTERPRETERS: Record<string, string[]> = {
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
const PREFIX_COMMANDS = new Set([
  'sudo',
  'env',
  'command',
  'nohup',
  'time',
  'exec',
  'nice',
  'stdbuf',
]);
const WRITE_API =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|rename|renameSync|truncate|truncateSync|write_text|write_bytes|shutil\.(?:copy|move)|os\.replace|File\.write|file_put_contents|io\.open)\b|\bopen\s*\([^)]*['"][wax+]|\.write\s*\(|\bfs\.\w*[wW]rite/;

function scriptWords(script: string): string[] {
  return script.split(/[\s"'`;|&<>(),=:{}[\]+]+/).filter(Boolean);
}

function nonOptionArgs(args: string[], takesValue: Set<string> = new Set()): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      if (takesValue.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

interface Acc {
  targets: Set<string>;
  mentions: Set<string>;
  uncertain: boolean;
  depth: number;
}

function analyzeSimple(words: string[], cwd: string, acc: Acc): void {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
  while (i < words.length && PREFIX_COMMANDS.has(path.basename(words[i]!))) {
    i++;
    while (i < words.length && (words[i]!.startsWith('-') || /^[A-Za-z_]\w*=/.test(words[i]!))) i++;
  }
  if (i >= words.length) return;
  const cmd = path.basename(words[i]!);
  const args = words.slice(i + 1);
  const add = (w: string | undefined) => {
    if (w === undefined) return;
    const r = resolveWord(w, cwd);
    if (r) acc.targets.add(r);
  };

  if (SHELLS.has(cmd)) {
    const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (ci >= 0 && args[ci + 1] !== undefined) {
      analyzeInto(args[ci + 1]!, cwd, acc);
      return;
    }
    if (nonOptionArgs(args).length > 0) acc.uncertain = true; // runs a script file
    return;
  }
  if (cmd === 'eval') {
    analyzeInto(args.join(' '), cwd, acc);
    return;
  }
  if (cmd === 'xargs' || cmd === 'find' || cmd === 'parallel') {
    // Runs another command over computed paths.
    if (cmd !== 'find' || args.some((a) => /^-(?:exec|execdir|ok|delete|fprint)/.test(a))) {
      acc.uncertain = true;
    }
    return;
  }
  const interp = INTERPRETERS[cmd] ?? (/^python3\.\d+$/.test(cmd) ? ['-c'] : undefined);
  if (cmd === 'perl' && args.some((a) => /^-[a-zA-Z]*i/.test(a))) {
    // perl -i / -pi -e 's///' FILES
    const files = nonOptionArgs(args, new Set(['-e', '-E', '-M', '-I']));
    files.forEach(add);
    return;
  }
  if (interp) {
    acc.uncertain = true;
    const idx = args.findIndex((a) => interp.includes(a));
    const script = idx >= 0 ? (args[idx + 1] ?? '') : '';
    if (script && WRITE_API.test(script)) {
      for (const lit of script.matchAll(/(['"`])((?:(?!\1).)+)\1/g)) add(lit[2]);
    }
    return;
  }
  switch (cmd) {
    case 'tee':
      nonOptionArgs(args).forEach(add);
      return;
    case 'cp':
    case 'mv':
    case 'install':
    case 'rsync':
    case 'ln': {
      const tIdx = args.findIndex((a) => a === '-t' || a.startsWith('--target-directory'));
      let dest: string | undefined;
      let srcs: string[];
      const rest = nonOptionArgs(
        args,
        new Set(['-t', '-m', '--mode', '-o', '-g', '-S', '-e', '--rsh', '--suffix'])
      );
      if (tIdx >= 0) {
        dest = args[tIdx].includes('=') ? args[tIdx].split('=')[1] : args[tIdx + 1];
        srcs = rest;
      } else {
        dest = rest[rest.length - 1];
        srcs = rest.slice(0, -1);
      }
      if (cmd === 'install' && args.includes('-d')) {
        rest.forEach(add);
        return;
      }
      if (dest === undefined) return;
      add(dest);
      for (const s of srcs) add(path.join(dest, path.basename(s)));
      if (cmd === 'mv') srcs.forEach(add); // the source path changes too
      return;
    }
    case 'dd':
      for (const a of args) if (a.startsWith('of=')) add(a.slice(3));
      return;
    case 'sed':
    case 'gsed':
      if (args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
        nonOptionArgs(args, new Set(['-e', '-f', '--expression', '--file'])).forEach(add);
      }
      return;
    case 'awk':
    case 'gawk': {
      const inplace =
        args.includes('--inplace') ||
        args.some((a, k) => (a === '-i' || a === '--include') && args[k + 1] === 'inplace') ||
        args.includes('-iinplace');
      if (inplace) {
        const files = nonOptionArgs(args, new Set(['-i', '--include', '-f', '-v', '-F']));
        files.slice(args.includes('-f') ? 0 : 1).forEach(add); // skip the program text
      }
      return;
    }
    case 'truncate':
      nonOptionArgs(args, new Set(['-s', '--size', '-r', '--reference'])).forEach(add);
      return;
    case 'touch':
    case 'rm':
    case 'unlink':
    case 'shred':
      nonOptionArgs(args).forEach(add);
      return;
    case 'git': {
      const sub = args.find((a) => !a.startsWith('-'));
      if (sub === 'checkout' || sub === 'restore') {
        const after = args.slice(args.indexOf(sub) + 1);
        const dd = after.indexOf('--');
        (dd >= 0 ? after.slice(dd + 1) : nonOptionArgs(after)).forEach(add);
      } else if (sub === 'apply' || sub === 'am' || sub === 'stash' || sub === 'reset') {
        acc.uncertain = true;
      }
      return;
    }
    case 'patch':
      acc.uncertain = true;
      return;
    default:
      // `./fix.sh`, `npx some-codemod` ... may write anything.
      if (cmd.endsWith('.sh') || cmd.endsWith('.py') || cmd.endsWith('.js') || cmd === 'npx') {
        acc.uncertain = true;
      }
  }
}

function analyzeInto(command: string, startCwd: string, acc: Acc): void {
  let cwd = startCwd;
  if (acc.depth > 4) {
    acc.uncertain = true;
    return;
  }
  acc.depth++;
  if (/\$\(|`/.test(command)) acc.uncertain = true;
  for (const w of scriptWords(command)) {
    const r = resolveWord(w, cwd);
    if (r) acc.mentions.add(r);
  }
  const { tokens, balanced } = tokenize(stripHeredocBodies(command));
  if (!balanced) acc.uncertain = true;
  let words: string[] = [];
  const flushSimple = () => {
    // Track `cd DIR && ...` so later relative paths resolve correctly.
    if (words[0] === 'cd' || words[0] === 'pushd') {
      const dest = words[1];
      if (dest === undefined || dest === '~') cwd = os.homedir();
      else if (dest !== '-') cwd = path.resolve(cwd, expandHome(dest));
    } else if (words.length) analyzeSimple(words, cwd, acc);
    words = [];
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind === 'word') {
      words.push(t.text);
      const r = resolveWord(t.text, cwd);
      if (r) acc.mentions.add(r);
      continue;
    }
    if (SEPARATORS.has(t.text)) {
      flushSimple();
      continue;
    }
    const next = tokens[k + 1];
    if (REDIRECT_WRITE.test(t.text) && next?.kind === 'word') {
      const r = resolveWord(next.text, cwd);
      if (r) acc.targets.add(r);
      k++;
      continue;
    }
    if (/^\d*<+-?$/.test(t.text) && next?.kind === 'word') k++; // input redirect / heredoc tag
  }
  flushSimple();
  acc.depth--;
}

/** Analyze `command` run in `cwd`. Paths come back absolute (not canonicalized). */
export function detectShellWriteTargets(command: string, cwd: string): ShellWriteDetection {
  const acc: Acc = { targets: new Set(), mentions: new Set(), uncertain: false, depth: 0 };
  if (command && command.trim()) analyzeInto(command, cwd, acc);
  return { targets: [...acc.targets], uncertain: acc.uncertain, mentions: [...acc.mentions] };
}

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Comparison key for a path: realpath (follows symlinks, so a link to a
 * locked file compares equal to it), walking up to the nearest existing
 * parent for paths that do not exist yet; lower-cased on win32/darwin.
 */
export function canonicalPath(p: string, caseInsensitive = CASE_INSENSITIVE): string {
  let abs = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      abs = path.join(fs.realpathSync.native(abs), ...tail.reverse());
      break;
    } catch {
      const parent = path.dirname(abs);
      if (parent === abs) {
        abs = path.join(abs, ...tail.reverse());
        break;
      }
      tail.push(path.basename(abs));
      abs = parent;
    }
  }
  return caseInsensitive ? abs.toLowerCase() : abs;
}

/**
 * The protected path this command would write, or null. Blocks when a
 * visible write target is protected, or when the command is `uncertain` and
 * names a protected file anywhere in its text (e.g. `python -c "...a.ts..."`).
 * `protectedPaths` must already be `canonicalPath` keys. Matching is
 * case-insensitive on win32/darwin (both sides fold), but the returned path
 * is the case-preserving canonical form of the command's own target, so
 * callers can display it or relativise it against a real-case workspace dir.
 */
export function findProtectedWrite(
  command: string,
  cwd: string,
  protectedPaths: Iterable<string>
): string | null {
  const locked = new Set(protectedPaths);
  if (locked.size === 0) return null;
  const d = detectShellWriteTargets(command, cwd);
  for (const t of d.targets) {
    const key = canonicalPath(t);
    if (locked.has(key)) return canonicalPath(t, false);
  }
  if (d.uncertain) {
    for (const m of d.mentions) {
      const key = canonicalPath(m);
      if (locked.has(key)) return canonicalPath(m, false);
    }
  }
  return null;
}
