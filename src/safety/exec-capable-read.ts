/**
 * O152 (P1): command forms that look like a read but run an external program
 * the model chose, over files it did not name — `rg --pre rm … <root>`
 * deleted `.git/config`, `HEAD`, hooks and `.env` on main (QA RG1). These are
 * recognised statically and blocked BEFORE execution; never left to the
 * post-run L3 snapshot.
 *
 * Fixed list (PM r2 §6; the tests use exactly these):
 *   - `rg` / `ripgrep` `--pre <prog>` / `--pre=<prog>`;
 *   - git: ANY `-c` / `-ckey=val` / `--config-env` / `GIT_CONFIG_*`
 *     (COUNT / KEY_n / VALUE_n / PARAMETERS) except a small allowlist
 *     (`user.*`, `color.*`, `core.quotepath`, `i18n.*` — case-insensitive) so
 *     `git -c user.email=… commit` (o123 C1) still runs; `--ext-diff`,
 *     `--textconv`, `--output[=]`, `--exec[=]`, and for `grep` `-O` /
 *     `--open-files-in-pager`. (O151 root-exemption cancel for any `-c`
 *     remains in protected-paths.ts.)
 *   - environment variables that make a read run a program or point git at
 *     other metadata: GIT_EXTERNAL_DIFF, GIT_PAGER, PAGER, GIT_SSH_COMMAND,
 *     GIT_SSH, LESSOPEN, LESSCLOSE, GIT_DIR, GIT_CONFIG_COUNT,
 *     GIT_CONFIG_KEY_<n>, GIT_CONFIG_VALUE_<n>, GIT_CONFIG_PARAMETERS — set
 *     as `VAR=… cmd`, `env VAR=… cmd`, `export VAR=…; cmd` (and declare /
 *     typeset / set), pwsh `$env:VAR=…`, cmd `set VAR=…`;
 *   - `sort --compress-program[=]`;
 *   - `find -exec` / `-execdir` / `-ok` / `-okdir`.
 *
 * Known limitations (PM r6, accepted; L3 is the backstop): a program spawned
 * from python / perl / node (`subprocess`, `system`, `spawnSync`), or a
 * renamed / symlinked copy of git, cannot be recognised before it runs. The
 * post-run protected-path snapshot restores and the run exits 9 instead.
 *
 * Stricter only: nothing here makes a command pass that was blocked before.
 * Plain reads (`rg -n foo .`, `git diff`, `git log -3`, `git -C R status`,
 * `git show HEAD --stat`) carry none of these forms and are unaffected.
 */

/** Env vars whose value makes an otherwise read-only command run a program. */
export const EXEC_ENV_VARS: ReadonlySet<string> = new Set([
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'PAGER',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'LESSOPEN',
  'LESSCLOSE',
  'GIT_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
]);

/**
 * O152 r2 (QA §1): any `GIT_CONFIG` / `GIT_CONFIG_*` variable (GLOBAL,
 * SYSTEM, NOSYSTEM, COUNT, KEY_n, VALUE_n, PARAMETERS, …) points git at
 * config the model wrote — `GIT_CONFIG_GLOBAL=/tmp/evil.cfg git x` ran an
 * `alias.x=!script`. Treated as exec-capable for EVERY head (not only `git`),
 * because any program may spawn git with the inherited env (spec r3 C).
 */
export function isGitConfigEnvName(name: string): boolean {
  return /^GIT_CONFIG(?:_[A-Z0-9_]*)?$/.test(name.toUpperCase());
}

/**
 * `GIT_*` variables that are safe on a `git` command (identity, prompts,
 * locking). Every other `GIT_*` on a `git` head is exec-capable (fail-closed,
 * same shape as the `-c` allowlist): GIT_ASKPASS, GIT_EXEC_PATH, GIT_EDITOR,
 * GIT_TEMPLATE_DIR, GIT_TRACE=<file>, GIT_COMMON_DIR, …
 */
const GIT_ENV_ALLOWED: ReadonlySet<string> = new Set([
  'GIT_TERMINAL_PROMPT',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_OPTIONAL_LOCKS',
  'GIT_LITERAL_PATHSPECS',
  'GIT_GLOB_PATHSPECS',
  'GIT_NOGLOB_PATHSPECS',
  'GIT_ICASE_PATHSPECS',
  'GIT_FLUSH',
  'GIT_ADVICE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]);

export function isExecEnvName(name: string): boolean {
  const n = name.toUpperCase();
  if (EXEC_ENV_VARS.has(n) || isGitConfigEnvName(n)) return true;
  // SSH_ASKPASS is consulted by git when GIT_ASKPASS / core.askPass are unset.
  if (n === 'SSH_ASKPASS') return true;
  return n.startsWith('GIT_') && !GIT_ENV_ALLOWED.has(n);
}

export interface ExecCapableForm {
  /** Short label of the form, e.g. `rg --pre`, `git -c`, `GIT_EXTERNAL_DIFF=`. */
  form: string;
  /** Path operands of the simple command (unresolved; empty = reads cwd). */
  operands: string[];
  /** `git -C <dir>` values (unresolved). */
  gitC: string[];
  /** Index of the simple command in {@link splitSimpleCommands}. */
  index: number;
  /**
   * O152 r5 C: structural "uncertain" (obscured name, wrapper / unknown
   * prefix before git, env change then git, uncommon git global option).
   * Gated only inside a git repository.
   */
  uncertain?: boolean;
}

/** Split into simple commands, keeping env assignments and wrappers. */
export function splitSimpleCommands(command: string): string[][] {
  return splitRawSegments(command).map(tokenizeSegment);
}

/** Tokenize one raw segment into words (quotes removed). */
function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  return tokens;
}

/**
 * O152 r5 C: raw (still-quoted) segments, index-aligned with
 * {@link splitSimpleCommands}, so the command-name token can be checked for
 * quotes / `$` / escapes / globs before quote removal hides them.
 */
export function splitRawSegments(command: string): string[] {
  // Quote-aware split on `;` `&&` `||` `|` `&` newline and subshell
  // parens. A `VAR=value` word keeps `|` / `&` inside the value
  // (`LESSOPEN=|./p.sh`) so it is not treated as a pipeline operator.
  const segments: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;
  const pushSeg = () => {
    segments.push(cur);
    cur = '';
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (escaping) {
      cur += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaping = true;
      cur += ch;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    // Consume a full assignment word so `|` inside the value is literal.
    if (ch === '=' && /[A-Za-z0-9_]$/.test(cur)) {
      cur += ch;
      i += 1;
      while (i < command.length) {
        const c = command[i]!;
        // Keep `|` / `&` inside the value (LESSOPEN=|./p.sh). Stop on
        // shell control operators and whitespace.
        if (/\s/.test(c) || c === ';' || c === '(' || c === ')' || c === '\n') break;
        if (c === '&' && command[i + 1] === '&') break;
        if (c === '|' && command[i + 1] === '|') break;
        // Respect quotes inside the value.
        if (c === '"' || c === "'") {
          const q = c;
          cur += c;
          i += 1;
          while (i < command.length && command[i] !== q) {
            cur += command[i]!;
            i += 1;
          }
          if (i < command.length) {
            cur += command[i]!;
            i += 1;
          }
          continue;
        }
        cur += c;
        i += 1;
      }
      i -= 1;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '(' || ch === ')') {
      pushSeg();
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      pushSeg();
      i += 1;
      continue;
    }
    if (ch === '|' && command[i + 1] === '|') {
      pushSeg();
      i += 1;
      continue;
    }
    if (ch === '|' || ch === '&') {
      pushSeg();
      continue;
    }
    cur += ch;
  }
  pushSeg();
  return segments;
}

/** Raw words of a segment, quotes/escapes kept (`g"it"` stays one word). */
function rawWords(segment: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let esc = false;
  for (const ch of segment) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      cur += ch;
      esc = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Shell keywords that may precede the command name. */
const SHELL_KEYWORDS = new Set([
  '!',
  '{',
  '}',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  '[',
  '[[',
  ']]',
]);

/**
 * O152 r5 C1: a command name that is not a literal bare word — quotes,
 * `$`, backticks, escapes, globs (`g"it"`, `gi''t`, `$'git'`, `$G`, `\git`,
 * `g?t`). Such a name can resolve to `git` and is uncertain.
 */
function isObscuredName(raw: string): boolean {
  if (SHELL_KEYWORDS.has(raw)) return false;
  const a = analyzeWord(raw);
  if (a.dynamic) return true;
  // PM r6 B: a static quoted name (`"./node_modules/.bin/tsc"`,
  // `"C:\Program Files\nodejs\node.exe"`) is judged by its literal value;
  // a quoted spelling of git (`g"it"`, `gi''t`) stays uncertain.
  return a.quoted && headOf(a.literal) === 'git';
}

/**
 * Shell word analysis: `dynamic` when the word expands at run time (`$`,
 * backticks, an unquoted escape, glob or brace outside single/double quotes;
 * `$` / backtick also inside double quotes). `literal` is the word with
 * quotes removed.
 */
function analyzeWord(raw: string): {
  dynamic: boolean;
  quoted: boolean;
  literal: string;
  glob: boolean;
} {
  let quote: '"' | "'" | null = null;
  let dynamic = false;
  let quoted = false;
  let glob = false;
  let plus = false;
  let literal = '';
  for (let k = 0; k < raw.length; k += 1) {
    const ch = raw[k]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else literal += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '$' || ch === '`') dynamic = true;
      else literal += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      continue;
    }
    if (ch === '$' || ch === '`' || ch === '\\') {
      dynamic = true;
      continue;
    }
    if (/[*?[\]{}]/.test(ch)) {
      dynamic = true;
      glob = true;
    }
    // `('g'+'it')` (pwsh `&` expression) / `(git)` subshell: not a literal.
    if (ch === '(' || ch === ')') dynamic = true;
    if (ch === '+') plus = true;
    literal += ch;
  }
  // pwsh string concatenation `'g'+'it'`: computed, not a literal.
  if (quoted && plus) dynamic = true;
  return { dynamic, quoted, literal, glob };
}

/** Could this unquoted glob word's last path segment match `git` / `git.exe`? */
function globMayBeGit(literal: string): boolean {
  const last = literal.split(/[\\/]/).pop() ?? '';
  let re = '';
  for (const ch of last) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if (ch === '[') re += '[';
    else if (ch === ']') re += ']';
    else if (ch === '{' || ch === '}' || ch === ',') re += '.*';
    else re += ch.replace(/[.+^$()|\\]/g, '\\$&');
  }
  try {
    return (
      new RegExp(`^(?:${re})$`, 'i').test('git') || new RegExp(`^(?:${re})$`, 'i').test('git.exe')
    );
  } catch {
    return true;
  }
}

/** pwsh `$env:X = …` / `$x = …` / `[Type]::Member(…)`: not a command name. */
function isPwshStatementHead(words: readonly string[], j: number): boolean {
  const w = words[j] ?? '';
  if (/^\$\{?(?:env:)?[A-Za-z_][A-Za-z0-9_:]*\}?\s*[-+*/]?=/i.test(w)) return true;
  if (/^\$\{?(?:env:)?[A-Za-z_][A-Za-z0-9_:]*\}?$/i.test(w) && /^[-+*/]?=/.test(words[j + 1] ?? ''))
    return true;
  return /^\[[A-Za-z_][\w.]*\]::/.test(w);
}

/**
 * Raw command-name word of a segment: skip leading assignments, keywords,
 * `env …` and the known wrappers (only bare wrapper names are recognised, so
 * an obscured wrapper name stops here and is itself checked).
 */
function rawCommandName(
  segment: string
): { raw: string; pwsh: boolean; index: number; words: string[] } | undefined {
  const words = rawWords(segment);
  let j = 0;
  const env = new Set<string>();
  for (;;) {
    while (j < words.length && (SHELL_KEYWORDS.has(words[j]!) || ASSIGN.test(words[j]!))) j += 1;
    if (j >= words.length) return undefined;
    if (isPwshStatementHead(words, j)) return { raw: words[j]!, pwsh: true, index: j, words };
    const h = words[j]!;
    if (/^env$/.test(h)) {
      j += 1;
      while (j < words.length && (words[j]!.startsWith('-') || ASSIGN.test(words[j]!))) {
        j += /^-[uCPS]$/.test(words[j]!) ? 2 : 1;
      }
      continue;
    }
    const spec = WRAPPERS[h];
    if (spec) {
      j = skipWrapper(words, j + 1, spec, env);
      continue;
    }
    return { raw: h, pwsh: false, index: j, words };
  }
}

function headOf(word: string | undefined): string {
  return (
    (word ?? '')
      .replace(/^[`$(]+/, '')
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, '') ?? ''
  );
}

/**
 * O152 r2 (QA §1): wrappers that run the rest of the line as a command.
 * Each lists its short options that take a separate argument and how many
 * positional words come before the wrapped command (`timeout 10 git …`,
 * `taskset 0x1 git …`). `nice -n 5 git -c …` used to stop at `5`.
 */
interface WrapperSpec {
  argOpts?: readonly string[];
  positional?: number;
  /** `sudo VAR=… cmd` — assignments after the options apply to cmd. */
  assigns?: boolean;
}
const WRAPPERS: Readonly<Record<string, WrapperSpec>> = {
  sudo: {
    argOpts: ['-u', '-g', '-h', '-p', '-r', '-t', '-U', '-C', '-D', '-T', '-R'],
    assigns: true,
  },
  doas: { argOpts: ['-u', '-C'] },
  command: {},
  builtin: {},
  nohup: {},
  exec: { argOpts: ['-a'] },
  time: { argOpts: ['-f', '-o'] },
  nice: { argOpts: ['-n'] },
  ionice: { argOpts: ['-c', '-n'] },
  chrt: { positional: 1 },
  taskset: { positional: 1 },
  stdbuf: { argOpts: ['-i', '-o', '-e'] },
  timeout: { argOpts: ['-s', '-k'], positional: 1 },
  setsid: {},
  unbuffer: {},
  xargs: { argOpts: ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a'] },
};
/** Long options of the wrappers above that take a separate argument. */
const WRAPPER_LONG_ARG = new Set([
  '--user',
  '--group',
  '--signal',
  '--kill-after',
  '--adjustment',
  '--input',
  '--output',
  '--error',
  '--max-args',
  '--max-lines',
  '--max-procs',
  '--max-chars',
  '--delimiter',
  '--arg-file',
  '--eof',
  '--class',
  '--classdata',
]);
/** Shells whose `-c <string>` is itself a command line to scan. */
const SH_SHELLS = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'ksh',
  'mksh',
  'ash',
  'yash',
  'fish',
  'busybox',
]);
const PWSH_SHELLS = new Set(['pwsh', 'powershell']);
/** Names that set an environment variable for the rest of the command. */
const ENV_SETTERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly', 'set', 'setx']);
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=/;
/** Nesting cap for `sh -c 'bash -c "…"'`; deeper is reported (fail-closed). */
const MAX_NEST = 4;

/** git options that run an external program or write a file. */
// O169: --upload-pack / --receive-pack make git run the given command to
// speak the pack protocol (clone/fetch/push/ls-remote) — pure literal forms.
const GIT_EXEC_ARG =
  /^(?:--ext-diff$|--textconv$|--output(?:=|$)|--exec(?:=|$)|--upload-pack(?:=|$)|--receive-pack(?:=|$))/;
const GIT_GREP_EXEC_ARG = /^(?:-O|--open-files-in-pager(?:=|$))/;
const FIND_EXEC = /^-(?:exec|execdir|ok|okdir)$/i;
const SORT_COMPRESS = /^--compress-prog(?:ram)?(?:=|$)/i;
const RG_PRE = /^--pre(?:=|$)/;

/**
 * Bodies of `$( … )` and `` ` … ` `` outside single quotes. Double quotes do
 * not stop substitution, and the splitter keeps a double-quoted word whole,
 * so `echo "$(git -c … )"` must be pulled out and scanned on its own.
 */
function commandSubstitutions(command: string): string[] {
  const out: string[] = [];
  let single = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (ch === '\\' && !single) {
      i += 1;
      continue;
    }
    if (ch === "'") {
      // Inside "…" a single quote is literal; approximate: toggle only when
      // not inside a double-quoted run (cheap check on balance so far).
      const before = command.slice(0, i);
      const dq = (before.match(/(?<!\\)"/g) ?? []).length % 2 === 1;
      if (!dq) single = !single;
      continue;
    }
    if (single) continue;
    if (ch === '$' && command[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === '(') depth += 1;
        else if (command[j] === ')') depth -= 1;
        j += 1;
      }
      out.push(command.slice(i + 2, depth === 0 ? j - 1 : j));
      i = j - 1;
      continue;
    }
    if (ch === '`') {
      const j = command.indexOf('`', i + 1);
      out.push(command.slice(i + 1, j === -1 ? command.length : j));
      i = j === -1 ? command.length : j;
    }
  }
  return out.filter((s) => s.trim());
}

/** Skip a wrapper's options / positional words; returns the next index. */
function skipWrapper(
  words: readonly string[],
  i: number,
  spec: WrapperSpec,
  env: Set<string>
): number {
  const argOpts = new Set(spec.argOpts ?? []);
  while (i < words.length) {
    const w = words[i]!;
    if (w === '--') {
      i += 1;
      break;
    }
    if (!w.startsWith('-') || w === '-') break;
    if (w.startsWith('--')) {
      i += !w.includes('=') && WRAPPER_LONG_ARG.has(w) ? 2 : 1;
      continue;
    }
    i += w.length === 2 && argOpts.has(w) ? 2 : 1;
  }
  for (let p = 0; p < (spec.positional ?? 0) && i < words.length; p += 1) i += 1;
  if (spec.assigns) {
    while (i < words.length && ASSIGN.test(words[i]!)) {
      const name = ASSIGN.exec(words[i]!)![1]!;
      if (isExecEnvName(name)) env.add(name.toUpperCase());
      i += 1;
    }
  }
  return i;
}

/**
 * The command string a shell / eval-like head runs, or `undefined` when the
 * head is not one. `null` means "a shell that reads its script from stdin"
 * (`… | sh`), which the caller handles.
 */
function nestedCommandText(head: string, args: readonly string[]): string | null | undefined {
  if (head === 'eval') return args.join(' ');
  if (head === 'watch') {
    let i = 0;
    while (i < args.length && args[i]!.startsWith('-')) {
      i += /^-(?:n|d|g)$/.test(args[i]!) || /^--(?:interval|differences)$/.test(args[i]!) ? 2 : 1;
    }
    return args.slice(i).join(' ');
  }
  if (head === 'cmd') {
    const k = args.findIndex((a) => /^\/[ck]$/i.test(a));
    return k === -1 ? undefined : args.slice(k + 1).join(' ');
  }
  if (PWSH_SHELLS.has(head)) {
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i]!;
      if (/^-(?:e|ec|encodedcommand)$/i.test(a)) {
        try {
          return Buffer.from(args[i + 1] ?? '', 'base64').toString('utf16le');
        } catch {
          return 'git -c';
        }
      }
      if (/^-(?:c|command)$/i.test(a)) return args.slice(i + 1).join(' ');
    }
    return undefined;
  }
  if (head === 'su' || head === 'runuser' || head === 'flock' || head === 'script') {
    // Only a `-c` before the wrapped program counts (`flock f git -c …` is
    // git's `-c`, left to the backstop below).
    const g = args.findIndex((a) => isGitWord(a));
    // O152 r6 B1 (QA r6): `script -qc "…"`, `script -eqc "…"`, `su -lc "…"`,
    // `script --command="…"` — any short-option cluster containing `c`, or
    // `--command` / `--command=` / `--session-command[=]`.
    for (let k = 0; k < args.length && (g === -1 || k < g); k += 1) {
      const a = args[k]!;
      if (a === '--') break;
      const eq = a.match(/^--(?:session-)?command=([\s\S]*)$/);
      if (eq) return eq[1]!;
      if (a === '--command' || a === '--session-command') return args[k + 1] ?? '';
      if (/^-[A-Za-z]+$/.test(a) && a.includes('c')) return args[k + 1] ?? '';
    }
    return undefined;
  }
  if (head === 'trap') {
    // O152 r6 B2 (QA r6): `trap "<command>" SIG…` runs the string later in
    // this shell — scan it like eval. `trap -p` / `-l` / `trap - SIG` list
    // or reset only.
    let i = 0;
    if (args[i] === '--') i += 1;
    const a = args[i];
    if (a === undefined || /^-[pl]$/.test(a) || a === '-') return undefined;
    return a;
  }
  if (!SH_SHELLS.has(head)) return undefined;
  // O152 r5 N2: `bash <<< "git -c …"` runs the here-string; scan it. A
  // here-doc / `< file` feeds a script that is not on this line → stdin.
  const hs = args.findIndex((w) => w.startsWith('<<<'));
  if (hs !== -1) return args[hs]!.length > 3 ? args[hs]!.slice(3) : (args[hs + 1] ?? '');
  if (args.some((w) => /^\d*<(?!<<)/.test(w))) return null;
  let a = args;
  if (head === 'busybox') {
    if (!a[0] || !SH_SHELLS.has(headOf(a[0]))) return undefined;
    a = a.slice(1);
  }
  let hasC = false;
  let i = 0;
  for (; i < a.length; i += 1) {
    const w = a[i]!;
    if (w === '--') {
      i += 1;
      break;
    }
    if (/^[-+]o$/.test(w) || w === '-O' || w === '+O' || w === '--rcfile' || w === '--init-file') {
      i += 1;
      continue;
    }
    if (w === '--command') {
      hasC = true;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(w)) {
      if (w.includes('c')) hasC = true;
      continue;
    }
    if (/^(?:--|\+)/.test(w)) continue;
    break;
  }
  if (hasC) return a[i] ?? '';
  // No -c and no script operand (or `-s`): the shell reads stdin.
  return i >= a.length ? null : undefined;
}

/** True when a word is a `git` invocation name (`git`, `/usr/bin/git`, `git.exe`). */
function isGitWord(w: string | undefined): boolean {
  return headOf(w) === 'git';
}

/** A whole argument word that names git (`git`, `/usr/bin/git`, `git.exe`). */
function isGitArgWord(w: string | undefined): boolean {
  return !!w && /^(?:[^\s'"]*[\\/])?git(?:\.exe)?$/i.test(w);
}

/** Heads whose arguments are text, not commands (no `git` backstop for them). */
const TEXT_HEADS = new Set([
  'echo',
  'printf',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ripgrep',
  'ag',
  'man',
  'which',
  'type',
  'whereis',
  'git',
  'test',
  '[',
  '[[',
  // PM r6 B: known read-only commands — a `git` argument is a path/text
  // (`ls git`, `cd git && ls`), not a command position.
  'ls',
  'dir',
  'cd',
  'pushd',
  'popd',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'file',
  'du',
  'tree',
  'realpath',
  'readlink',
  'basename',
  'dirname',
  'pwd',
]);

/**
 * Heads that never run an argument as a program (PM r6 B, C2 "command
 * position"): a `$X` / glob / `git` argument to them is a path, not a
 * command. Deliberately excludes exec-capable tools (`tar
 * --to-command`, `rsync -e`, `sed e`, `xargs`, `find -exec`, …).
 */
const NON_EXEC_HEADS = new Set([
  'cp',
  'mv',
  'rm',
  'rmdir',
  'mkdir',
  'touch',
  'chmod',
  'chown',
  'ln',
  'curl',
  'wget',
  'tee',
]);

/** Function / alias definition (PM r6 A, rule C5). */
const DEF_RE =
  /(?:^|[\s;&|({])(?:function\s+[A-Za-z_][\w-]*|[A-Za-z_][\w-]*\s*\(\s*\)\s*[{(]|alias\s+[^\s=]+=|doskey\s+\S+=|(?:set|new)-alias\b|shopt\s+-s\s+expand_aliases|-O\s+expand_aliases)/i;
const GIT_TOKEN_RE = /(?:^|[^\w.-])git(?:\.exe)?(?![\w-])/i;

/** Does this text name git once quotes / escapes are removed (`g"it"`, `gi''t`)? */
function namesGit(text: string): boolean {
  return GIT_TOKEN_RE.test(text) || GIT_TOKEN_RE.test(text.replace(/['"\\]/g, ''));
}

/**
 * Walk the simple commands left-to-right. An `export VAR=…` / `declare -x`
 * / `set VAR=…` / `$env:VAR=` / `Set-Item env:` earlier in the command
 * "infects" every later simple command (the env is still set). Prefixed
 * `VAR=… cmd` and `env VAR=… cmd` infect only that simple command.
 *
 * O152 r2: wrappers are peeled with their option arguments (`nice -n 5`,
 * `timeout -s KILL 10`, `env -u X`, `sudo -u u VAR=…`), and the command
 * string of `sh`/`bash`/… `-c`, `eval`, `env -S`, `watch`, `cmd /c`,
 * `pwsh -c` / `-EncodedCommand`, `su -c`, `flock -c`, `$( … )` and
 * backticks is scanned again with the env inherited. A shell fed from a pipe
 * (`echo 'git -c …' | sh`) rescans the text of the `echo`/`printf` words.
 */
export interface FindExecCapableOptions {
  /** Inside `sh -c` / `eval` / `cmd /c` / `pwsh -c` / here-string (r5 C2). */
  wrapped?: boolean;
  /** An env-changing statement ran earlier on the line (r5 C3). */
  envChanged?: boolean;
  /** PATH was changed earlier on the line (r6 C4). */
  pathChanged?: boolean;
  /** The outer line names git somewhere (PM r7 O1 scope). */
  lineHasGit?: boolean;
  /**
   * Written back by a nested scan (eval / source / sh -c text): env changes
   * made inside it count for later commands on the outer line (r6 C3).
   */
  sink?: { envChanged: boolean; pathChanged: boolean; liveEnv: Set<string> };
}

export function findExecCapableForms(
  command: string,
  inheritedEnv?: ReadonlySet<string>,
  depth = 0,
  opts: FindExecCapableOptions = {}
): ExecCapableForm[] {
  if (!command.trim()) return [];
  if (depth > MAX_NEST) {
    return [{ form: 'nested shell', operands: [], gitC: [], index: 0, uncertain: true }];
  }
  const rawSegments = splitRawSegments(command);
  const simples = rawSegments.map(tokenizeSegment);
  const out: ExecCapableForm[] = [];
  // Env vars set by a previous simple command and still live.
  const liveEnv = new Set<string>(inheritedEnv ?? []);
  // O152 r5 C3: an env-changing statement (export, set -a, source, `.`,
  // pwsh `$env:X=`, cmd `set X=`, [Environment]::Set…) earlier on the line.
  let envChanged = opts.envChanged === true;
  // O152 r6 C4: PATH changed earlier on the line — any later command may
  // resolve to a planted binary.
  let pathChanged = opts.pathChanged === true;
  // PM r7 O1: the structural C rules only apply where git appears (or the
  // command name is dynamic). Quotes / escapes are removed first so
  // `G=gi''t` still counts.
  const lineHasGit = opts.lineHasGit === true || namesGit(command);
  const nested = (text: string, env: ReadonlySet<string>, si: number, wrapped: boolean) => {
    const sink = { envChanged: false, pathChanged: false, liveEnv: new Set<string>() };
    for (const f of findExecCapableForms(text, env, depth + 1, {
      wrapped: wrapped || opts.wrapped === true,
      envChanged,
      pathChanged,
      lineHasGit,
      sink,
    }))
      out.push({ ...f, index: si });
    // r6 C3: `eval 'export GIT_SSH_COMMAND=…'; git …` — the nested text's env
    // changes carry over (stricter for subshells too).
    if (sink.envChanged) envChanged = true;
    if (sink.pathChanged) pathChanged = true;
    for (const n of sink.liveEnv) liveEnv.add(n);
  };
  const uncertain = (form: string, si: number, operands: string[] = [], gitC: string[] = []) =>
    out.push({ form, operands, gitC, index: si, uncertain: true });
  const finish = (): ExecCapableForm[] => {
    if (opts.sink) {
      if (envChanged) opts.sink.envChanged = true;
      if (pathChanged) opts.sink.pathChanged = true;
      for (const n of liveEnv) opts.sink.liveEnv.add(n);
    }
    return out;
  };

  // O152 r6 C5: a function or alias defined on the line, with git after the
  // definition (in its body or at a call site), is uncertain.
  {
    const m = DEF_RE.exec(command);
    if (m && GIT_TOKEN_RE.test(command.slice(m.index))) {
      uncertain('function/alias then git', 0);
    }
  }
  // `$( … )` / backticks are not wrappers: `echo "$(git diff --quiet)"` (J13)
  // stays a plain git read.
  for (const sub of commandSubstitutions(command)) nested(sub, liveEnv, 0, false);
  let stdinShell = false;

  // O152 r5 N6/N8: pwsh env setters anywhere on the line (spaces allowed,
  // `$env:X = 'v'`), and [Environment]::SetEnvironmentVariable('X', …).
  for (const m of command.matchAll(/\$\{?env:([A-Za-z_][A-Za-z0-9_]*)\}?\s*[+]?=/gi)) {
    envChanged = true;
    if (m[1]!.toUpperCase() === 'PATH') pathChanged = true;
    if (isExecEnvName(m[1]!)) {
      liveEnv.add(m[1]!.toUpperCase());
      out.push({ form: `${m[1]!.toUpperCase()}=`, operands: [], gitC: [], index: 0 });
    }
  }
  for (const m of command.matchAll(
    /\[(?:System\.)?Environment\]::SetEnvironmentVariable\s*\(\s*['"]?([A-Za-z_][A-Za-z0-9_]*)/gi
  )) {
    envChanged = true;
    if (m[1]!.toUpperCase() === 'PATH') pathChanged = true;
    if (isExecEnvName(m[1]!)) {
      liveEnv.add(m[1]!.toUpperCase());
      out.push({ form: `${m[1]!.toUpperCase()}=`, operands: [], gitC: [], index: 0 });
    }
  }

  for (let si = 0; si < simples.length; si += 1) {
    const words = simples[si]!;
    if (words.length === 0) continue;

    // O152 r5 C1: the command name must be a literal bare word.
    const named = rawCommandName(rawSegments[si] ?? '');
    if (named && !named.pwsh && isObscuredName(named.raw)) {
      uncertain('non-literal command name', si);
      continue;
    }

    // pwsh `$env:X=…` / `Set-Item env:X …` / cmd `set X=…` as the head.
    const first = words[0] ?? '';
    if (named?.pwsh) {
      // Assignment / static call statement (handled by the line scan above).
      continue;
    }
    const pwshEnv = first.match(/^\$env:([A-Za-z_][A-Za-z0-9_]*)=/i);
    if (pwshEnv && isExecEnvName(pwshEnv[1]!)) {
      liveEnv.add(pwshEnv[1]!.toUpperCase());
      continue;
    }
    const head0 = headOf(first);
    if (
      (head0 === 'set-item' || head0 === 'si') &&
      words.some((w) => /^env:/i.test(w) || /^-?[pP]ath$/i.test(w))
    ) {
      envChanged = true;
      if (words.some((w) => /^env:path$/i.test(w) || /^-?[pP]ath$/.test(w))) pathChanged = true;
      for (const w of words) {
        const m = w.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/i);
        if (m && isExecEnvName(m[1]!)) liveEnv.add(m[1]!.toUpperCase());
      }
      continue;
    }
    if (head0 === 'set' && words[1] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[1]!)) {
      envChanged = true;
      const name = words[1]!.split('=')[0]!;
      if (name.toUpperCase() === 'PATH') pathChanged = true;
      if (isExecEnvName(name)) liveEnv.add(name.toUpperCase());
      // cmd `set X=…&& git …` may share the segment; keep scanning.
    }

    let i = 0;
    // `if git …`, `! git …`, `{ git …; }`: the keyword is not the command.
    while (i < words.length && SHELL_KEYWORDS.has(words[i]!) && !/^\[\[?$/.test(words[i]!)) i += 1;
    // Leading `VAR=val` assignments for THIS simple command only.
    const localEnv = new Set<string>(liveEnv);
    let localPath = false;
    while (i < words.length && ASSIGN.test(words[i]!)) {
      const name = ASSIGN.exec(words[i]!)![1]!;
      if (isExecEnvName(name)) localEnv.add(name.toUpperCase());
      if (name.toUpperCase() === 'PATH') localPath = true;
      i += 1;
    }
    // Bare `VAR=…` statement (no command): PATH / exec-capable vars are
    // exported already or by `set -a` — counts as an env change (r5 C3).
    if (i >= words.length && i > 0) {
      // r6 C3: any assignment inside eval / nested text is an env change.
      if (opts.wrapped) envChanged = true;
      for (const w of words) {
        const name = ASSIGN.exec(w)?.[1];
        if (name && name.toUpperCase() === 'PATH') pathChanged = true;
        if (name && (isExecEnvName(name) || name.toUpperCase() === 'PATH')) {
          envChanged = true;
          liveEnv.add(name.toUpperCase());
        }
      }
      continue;
    }
    // `env VAR=… cmd` / wrappers.
    let envSplit: string | undefined;
    let peeled = false;
    let lookupOnly = false;
    while (i < words.length) {
      const h = headOf(words[i]);
      if (h === 'command' && /^-[vV]$/.test(words[i + 1] ?? '')) {
        lookupOnly = true;
        break;
      }
      if (h === 'env') {
        peeled = true;
        i += 1;
        while (i < words.length && (words[i]!.startsWith('-') || ASSIGN.test(words[i]!))) {
          const w = words[i]!;
          if (ASSIGN.test(w)) {
            const name = ASSIGN.exec(w)![1]!;
            if (isExecEnvName(name)) localEnv.add(name.toUpperCase());
            if (name.toUpperCase() === 'PATH') localPath = true;
            i += 1;
            continue;
          }
          if (w === '--') {
            i += 1;
            break;
          }
          // -u NAME / -C DIR / -P PATH take a value; -S STRING is a command line.
          if (w === '-S' || w === '--split-string') {
            envSplit = words[i + 1] ?? '';
            i = words.length;
            break;
          }
          if (/^-S./.test(w) || w.startsWith('--split-string=')) {
            envSplit = w.startsWith('-S') ? w.slice(2) : w.slice('--split-string='.length);
            i = words.length;
            break;
          }
          i += /^-[uCP]$/.test(w) || w === '--unset' || w === '--chdir' ? 2 : 1;
        }
        continue;
      }
      const spec = WRAPPERS[h];
      if (spec) {
        peeled = true;
        i = skipWrapper(words, i + 1, spec, localEnv);
        continue;
      }
      break;
    }
    if (lookupOnly) continue;
    if (envSplit !== undefined) {
      nested(envSplit, localEnv, si, true);
      continue;
    }

    // `export` / `declare -x` / `typeset -x` / `readonly` as a statement:
    // the assignment lives for later commands. Also `export VAR=… cmd`.
    const setterHead = headOf(words[i]);
    if (setterHead === 'source' || setterHead === '.' || setterHead === 'alias') {
      envChanged = true;
      continue;
    }
    if (ENV_SETTERS.has(setterHead)) {
      // `set` only changes the env with -a / -o allexport or an assignment.
      if (
        setterHead !== 'set' ||
        words
          .slice(i + 1)
          .some((w) => /^-[A-Za-z]*a/.test(w) || w === 'allexport' || ASSIGN.test(w))
      )
        envChanged = true;
      i += 1;
      // skip flags (-x, -g, …); `set` alone with no assign is a shell option
      // change and is not an env infection (handled by O151 F10 cancel).
      while (i < words.length && words[i]!.startsWith('-') && !ASSIGN.test(words[i]!)) i += 1;
      while (
        i < words.length &&
        (ASSIGN.test(words[i]!) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(words[i]!))
      ) {
        const tok = words[i]!;
        const name = ASSIGN.test(tok) ? ASSIGN.exec(tok)![1]! : tok;
        if (name.toUpperCase() === 'PATH') pathChanged = true;
        if (isExecEnvName(name)) {
          liveEnv.add(name.toUpperCase());
          localEnv.add(name.toUpperCase());
        }
        i += 1;
        // `export VAR value` (no `=`) — skip the value.
        if (
          !ASSIGN.test(tok) &&
          i < words.length &&
          !ASSIGN.test(words[i]!) &&
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(words[i]!)
        )
          break;
      }
      // Pure setter statement: next simple command inherits liveEnv.
      // `export VAR=… cmd …` falls through with the remaining words.
    }

    // Spec r3 C: a GIT_CONFIG_* assignment anywhere in this simple command
    // (prefix, env, export, sudo, or a later word) is exec-capable whatever
    // the head is — any child may spawn git with it.
    const gitCfgWord = words.find((w) => {
      const m = ASSIGN.exec(w) ?? w.match(/^\$env:([A-Za-z_][A-Za-z0-9_]*)=/i);
      return !!m && isGitConfigEnvName(m[1]!);
    });
    const gitCfgLive = [...localEnv].find((n) => isGitConfigEnvName(n));
    if (gitCfgWord || gitCfgLive) {
      const name = gitCfgLive ?? ASSIGN.exec(gitCfgWord!)?.[1] ?? 'GIT_CONFIG';
      const h = headOf(words[i]);
      const a = words.slice(i + 1);
      out.push({
        form: `${name.toUpperCase()}=`,
        operands: pathOperands(h, a),
        gitC: gitCValues(h, a),
        index: si,
      });
    }

    if (i >= words.length) continue;
    const head = headOf(words[i]);
    const args = words.slice(i + 1);

    // O152 r6 C4: `PATH=<dir>:$PATH git status`, `export PATH=…; x` — the
    // command may resolve to a planted binary.
    // PM r7 O1: only for a segment that runs / names git.
    if ((pathChanged || localPath) && namesGit(rawSegments[si] ?? ''))
      uncertain('PATH change before command', si);

    // Shell / eval-like heads: scan their command string with this env.
    const inner = nestedCommandText(head, args);
    if (inner === null) {
      // A shell reading its script from stdin / a here-doc / a redirect:
      // the command text is not on this line (r5 C1/C2) — uncertain.
      stdinShell = si > 0;
      // `echo '…' | sh` is rescanned below (as wrapped); any other source
      // (`curl … | sh`, here-doc, `< file`) is not visible here.
      const prevHead = si > 0 ? headOf(simples[si - 1]?.[0]) : '';
      const viaRedirect = args.some((w) => /^\d*</.test(w));
      if (viaRedirect || (prevHead !== 'echo' && prevHead !== 'printf')) {
        uncertain('shell reads stdin', si);
      }
    } else if (inner !== undefined) {
      nested(inner, localEnv, si, true);
      continue;
    }

    // O152 r5 C2/C3: git run through a wrapper / nested shell, or after an
    // env-changing statement on the same line.
    if (head === 'git') {
      if (peeled || opts.wrapped)
        uncertain('wrapper before git', si, pathOperands(head, args), gitCValues(head, args));
      if (envChanged)
        uncertain('env change before git', si, pathOperands(head, args), gitCValues(head, args));
    }

    // Carry localEnv into detection of this command.
    for (const name of localEnv) {
      // GIT_* (other than the GIT_CONFIG family, reported above) only
      // matters on git; PAGER / LESSOPEN on the pager-capable readers.
      const gitOnly = name.startsWith('GIT_') && !EXEC_ENV_VARS.has(name);
      const applies = gitOnly
        ? head === 'git'
        : head === 'git' ||
          head === 'rg' ||
          head === 'ripgrep' ||
          head === 'less' ||
          head === 'more' ||
          head === 'sort' ||
          head === 'find' ||
          head === 'grep' ||
          head === 'egrep' ||
          head === 'fgrep';
      if (applies) {
        // Report once per simple command that is affected.
        out.push({
          form: `${name}=`,
          operands: pathOperands(head, args),
          gitC: gitCValues(head, args),
          index: si,
        });
        break;
      }
    }
    // Even if env infected already reported, keep scanning for other forms
    // on the same command (a second hit is fine; the caller dedupes by form).

    if (head === 'rg' || head === 'ripgrep') {
      if (args.some((a) => RG_PRE.test(a))) {
        out.push({ form: 'rg --pre', operands: pathOperands(head, args), gitC: [], index: si });
      }
      continue;
    }
    if (head === 'sort') {
      if (args.some((a) => SORT_COMPRESS.test(a))) {
        out.push({
          form: 'sort --compress-program',
          operands: pathOperands(head, args),
          gitC: [],
          index: si,
        });
      }
      continue;
    }
    if (head === 'find') {
      if (args.some((a) => FIND_EXEC.test(a))) {
        out.push({ form: 'find -exec', operands: pathOperands(head, args), gitC: [], index: si });
      }
      continue;
    }
    if (head === 'git') {
      const forms = gitExecForms(args);
      for (const form of forms) {
        out.push({
          form,
          operands: pathOperands(head, args),
          gitC: gitCValues(head, args),
          index: si,
        });
      }
      continue;
    }
    // Backstop for wrappers not in the table (`flock f git -c …`,
    // `chronic git -c …`): a later `git` word followed by a blocked `-c` /
    // `--config-env` / exec option is still reported (fail-closed).
    if (!TEXT_HEADS.has(head) && !NON_EXEC_HEADS.has(head)) {
      // O152 r6 (QA r5 C1/C2): after an unknown prefix, an argument that is
      // not a literal word — an expansion (`$G`, `$(…)`, backticks) or a glob
      // that could match git (`/usr/bin/gi?`) — may be git: uncertain.
      if (named && !named.pwsh) {
        const dyn = named.words.slice(named.index + 1).find((w) => {
          const a = analyzeWord(w);
          if (!a.dynamic) return false;
          if (/[$`]/.test(w.replace(/'[^']*'/g, ''))) return true;
          // An unquoted escape only matters when it spells git (`g\\it`);
          // a Windows path (`C:\\tools\\x.js`, pwsh) is not an expansion.
          if (/\\/.test(w.replace(/'[^']*'|"[^"]*"/g, ''))) return isGitArgWord(a.literal);
          return a.glob && globMayBeGit(a.literal);
        });
        // PM r7 O1: only when git appears on the line (`G=git; setpriv $G`);
        // `npm run $S`, `ps -p $$`, `node x.js "$PWD"` do not run git.
        // A glob that can match git (`/usr/bin/gi?`) may become git itself.
        const gitGlob = named.words.slice(named.index + 1).some((w) => {
          const a = analyzeWord(w);
          return a.glob && globMayBeGit(a.literal);
        });
        if (dyn !== undefined && (lineHasGit || gitGlob))
          uncertain('dynamic argument after unknown prefix', si);
      }
      for (let k = 0; k < args.length; k += 1) {
        if (!isGitArgWord(args[k])) continue;
        const rest = args.slice(k + 1);
        // O152 r5 C2/N4: an unknown prefix (`flock f git`, `setpriv git`)
        // before git is uncertain whatever git's options / env are.
        uncertain(
          'unknown prefix before git',
          si,
          pathOperands('git', rest),
          gitCValues('git', rest)
        );
        for (const form of gitExecForms(rest)) {
          out.push({
            form,
            operands: pathOperands('git', rest),
            gitC: gitCValues('git', rest),
            index: si,
          });
        }
        break;
      }
    }
  }

  // `echo 'git -c …' | sh`: the shell runs text another word produced.
  if (stdinShell) {
    for (let si = 0; si < simples.length; si += 1) {
      const words = simples[si]!;
      const h = headOf(words[0]);
      if (h === 'echo' || h === 'printf') nested(words.slice(1).join(' '), liveEnv, si, true);
    }
  }
  return finish();
}

function gitCValues(head: string, args: readonly string[]): string[] {
  if (head !== 'git') return [];
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-C') {
      if (args[i + 1]) out.push(args[i + 1]!);
      i += 1;
    }
  }
  return out;
}

/** Non-option path-looking operands (best-effort; empty = cwd). */
function pathOperands(head: string, args: readonly string[]): string[] {
  const skipNext = new Set([
    '-C',
    '-c',
    '--config-env',
    '-e',
    '-f',
    '-g',
    '-m',
    '-O',
    '--pre',
    '--regexp',
    '--file',
    '--glob',
    '--type',
    '--type-add',
    '--type-clear',
    '--max-count',
    '--max-filesize',
    '--max-depth',
    '--threads',
    '--color',
    '--compress-program',
    '--open-files-in-pager',
    '--output',
    '--exec',
    '--exec-path',
    '--upload-pack',
    '--receive-pack',
    '--git-dir',
    '--work-tree',
    '--namespace',
  ]);
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-')) {
      if (
        skipNext.has(a) ||
        /^(?:-O|--pre|--open-files-in-pager|--output|--exec|--compress-program|--upload-pack|--receive-pack)=/.test(
          a
        ) ||
        /^-c./.test(a) ||
        /^--config-env=/.test(a)
      ) {
        if (skipNext.has(a) && !a.includes('=')) i += 1;
      }
      continue;
    }
    // git subcommand itself is not a path.
    if (head === 'git' && i === firstNonOpt(args)) continue;
    out.push(a);
  }
  return out;
}

function firstNonOpt(args: readonly string[]): number {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-C' || args[i] === '-c' || args[i] === '--config-env') {
      i += 1;
      continue;
    }
    if (args[i]!.startsWith('-')) continue;
    return i;
  }
  return -1;
}

/**
 * O152 r1 F1 (QA): allowlist for `-c` / `--config-env`. Every other key is
 * treated as exec-capable (credential.helper=!…, core.askPass, include.path,
 * filter.*.*, …). Fail-closed: empty / unparsable key is NOT allowed.
 */
export function gitCKeyAllowed(kv: string): boolean {
  const key = (kv.split('=')[0] ?? '').trim().toLowerCase();
  if (!key) return false;
  if (key.startsWith('user.')) return true;
  if (key.startsWith('color.')) return true;
  if (key.startsWith('i18n.')) return true;
  if (key === 'core.quotepath') return true;
  return false;
}

/** True when this `-c` / `--config-env` value must be pre-blocked. */
function gitCIsBlocked(kv: string): boolean {
  return !gitCKeyAllowed(kv);
}

/** git global options that are common and run nothing (r5 C4). */
const GIT_COMMON_GLOBALS: ReadonlySet<string> = new Set([
  '--no-pager',
  '-P',
  '--version',
  '-v',
  '--help',
  '-h',
  '--no-optional-locks',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-replace-objects',
  '--html-path',
  '--man-path',
  '--info-path',
]);

function gitExecForms(args: readonly string[]): string[] {
  const forms: string[] = [];
  let sub = '';
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '-c' || a === '--config-env') {
      const kv = args[i + 1] ?? '';
      if (gitCIsBlocked(kv)) forms.push('git -c');
      i += 1;
      continue;
    }
    if (/^-c./.test(a)) {
      if (gitCIsBlocked(a.slice(2))) forms.push('git -c');
      continue;
    }
    if (/^--config-env=/.test(a)) {
      if (gitCIsBlocked(a.slice('--config-env='.length))) forms.push('git -c');
      continue;
    }
    if (a === '-C') {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) {
      if (GIT_EXEC_ARG.test(a)) forms.push(`git ${a.split('=')[0]}`);
      // O152 r5 B/N5: `--exec-path[=dir]` picks where git finds subcommands.
      else if (/^--exec-path(?:=|$)/.test(a)) forms.push('git --exec-path');
      // O152 r5 C4: any other uncommon global option is uncertain
      // (`--git-dir`, `--work-tree`, `--namespace`, `-p`/`--paginate`, …).
      else if (!GIT_COMMON_GLOBALS.has(a)) forms.push('git uncommon global option');
      continue;
    }
    sub = a.toLowerCase();
    const rest = args.slice(i + 1);
    for (let k = 0; k < rest.length; k += 1) {
      const b = rest[k]!;
      if (b === '--') break;
      if (GIT_EXEC_ARG.test(b)) forms.push(`git ${b.split('=')[0]}`);
      if (sub === 'grep' && (GIT_GREP_EXEC_ARG.test(b) || /^-O./.test(b))) {
        forms.push('git grep -O');
      }
      // O169: clone's `-u` is `--upload-pack` (split `-u cmd` or glued `-ucmd`).
      // Only clone: `git push -u origin main` is --set-upstream (benign).
      if (sub === 'clone' && /^-u/.test(b)) forms.push('git clone -u');
      // O152 r5 B/N7: `git difftool -x <cmd>` / `--extcmd[=]<cmd>`.
      if (
        (sub === 'difftool' || sub === 'mergetool') &&
        (/^-x/.test(b) || /^--extcmd(?:=|$)/.test(b))
      ) {
        forms.push(`git ${sub} --extcmd`);
      }
      // Stricter: subcommands whose option runs a program.
      if (sub === 'rebase' && /^-x/.test(b)) forms.push('git rebase --exec');
    }
    if (sub === 'bisect' && rest[0] === 'run') forms.push('git bisect run');
    if (sub === 'submodule' && rest.includes('foreach')) forms.push('git submodule foreach');
    if (sub === 'filter-branch') forms.push('git filter-branch');
    break;
  }
  return [...new Set(forms)];
}

/**
 * True when the command contains any of the forms above. Used by the
 * approval layer's `isReadonlyExecCommand` so a `rg --pre …` alone is never
 * classified as a readonly side-effect (which would skip the protected-path
 * gate entirely).
 */
export function commandHasExecCapableRead(command: string): boolean {
  return findExecCapableForms(command).length > 0;
}
