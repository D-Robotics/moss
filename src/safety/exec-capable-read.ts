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
}

/** Split into simple commands, keeping env assignments and wrappers. */
export function splitSimpleCommands(command: string): string[][] {
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
  const out: string[][] = [];
  for (const segment of segments) {
    const tokens: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
    out.push(tokens);
  }
  return out;
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
const GIT_EXEC_ARG = /^(?:--ext-diff$|--textconv$|--output(?:=|$)|--exec(?:=|$))/;
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
    const k = args.findIndex(
      (a, idx) => (a === '-c' || a === '--command') && (g === -1 || idx < g)
    );
    return k === -1 ? undefined : (args[k + 1] ?? '');
  }
  if (!SH_SHELLS.has(head)) return undefined;
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
]);

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
export function findExecCapableForms(
  command: string,
  inheritedEnv?: ReadonlySet<string>,
  depth = 0
): ExecCapableForm[] {
  if (!command.trim()) return [];
  if (depth > MAX_NEST) return [{ form: 'nested shell', operands: [], gitC: [], index: 0 }];
  const simples = splitSimpleCommands(command);
  const out: ExecCapableForm[] = [];
  // Env vars set by a previous simple command and still live.
  const liveEnv = new Set<string>(inheritedEnv ?? []);
  const nested = (text: string, env: ReadonlySet<string>, si: number) => {
    for (const f of findExecCapableForms(text, env, depth + 1)) out.push({ ...f, index: si });
  };
  for (const sub of commandSubstitutions(command)) nested(sub, liveEnv, 0);
  let stdinShell = false;

  for (let si = 0; si < simples.length; si += 1) {
    const words = simples[si]!;
    if (words.length === 0) continue;

    // pwsh `$env:X=…` / `Set-Item env:X …` / cmd `set X=…` as the head.
    const first = words[0] ?? '';
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
      for (const w of words) {
        const m = w.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/i);
        if (m && isExecEnvName(m[1]!)) liveEnv.add(m[1]!.toUpperCase());
      }
      continue;
    }
    if (head0 === 'set' && words[1] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[1]!)) {
      const name = words[1]!.split('=')[0]!;
      if (isExecEnvName(name)) liveEnv.add(name.toUpperCase());
      // cmd `set X=…&& git …` may share the segment; keep scanning.
    }

    let i = 0;
    // Leading `VAR=val` assignments for THIS simple command only.
    const localEnv = new Set<string>(liveEnv);
    while (i < words.length && ASSIGN.test(words[i]!)) {
      const name = ASSIGN.exec(words[i]!)![1]!;
      if (isExecEnvName(name)) localEnv.add(name.toUpperCase());
      i += 1;
    }
    // `env VAR=… cmd` / wrappers.
    let envSplit: string | undefined;
    while (i < words.length) {
      const h = headOf(words[i]);
      if (h === 'env') {
        i += 1;
        while (i < words.length && (words[i]!.startsWith('-') || ASSIGN.test(words[i]!))) {
          const w = words[i]!;
          if (ASSIGN.test(w)) {
            const name = ASSIGN.exec(w)![1]!;
            if (isExecEnvName(name)) localEnv.add(name.toUpperCase());
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
        i = skipWrapper(words, i + 1, spec, localEnv);
        continue;
      }
      break;
    }
    if (envSplit !== undefined) {
      nested(envSplit, localEnv, si);
      continue;
    }

    // `export` / `declare -x` / `typeset -x` / `readonly` as a statement:
    // the assignment lives for later commands. Also `export VAR=… cmd`.
    if (ENV_SETTERS.has(headOf(words[i]))) {
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

    // Shell / eval-like heads: scan their command string with this env.
    const inner = nestedCommandText(head, args);
    if (inner === null) {
      stdinShell = si > 0;
    } else if (inner !== undefined) {
      nested(inner, localEnv, si);
      continue;
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
    if (!TEXT_HEADS.has(head)) {
      for (let k = 0; k < args.length; k += 1) {
        if (!isGitWord(args[k])) continue;
        const rest = args.slice(k + 1);
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
      if (h === 'echo' || h === 'printf') nested(words.slice(1).join(' '), liveEnv, si);
    }
  }
  return out;
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
        /^(?:-O|--pre|--open-files-in-pager|--output|--exec|--compress-program)=/.test(a) ||
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
      continue;
    }
    sub = a.toLowerCase();
    for (const b of args.slice(i + 1)) {
      if (GIT_EXEC_ARG.test(b)) forms.push(`git ${b.split('=')[0]}`);
      if (sub === 'grep' && (GIT_GREP_EXEC_ARG.test(b) || /^-O./.test(b))) {
        forms.push('git grep -O');
      }
    }
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
