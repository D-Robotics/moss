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

export function isExecEnvName(name: string): boolean {
  const n = name.toUpperCase();
  return EXEC_ENV_VARS.has(n) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(n);
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
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, '') ?? ''
  );
}

const WRAPPER = /^(?:sudo|doas|command|nohup|exec|time|nice|stdbuf)$/i;
/** Names that set an environment variable for the rest of the command. */
const ENV_SETTERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly', 'set', 'setx']);
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** git options that run an external program or write a file. */
const GIT_EXEC_ARG = /^(?:--ext-diff$|--textconv$|--output(?:=|$)|--exec(?:=|$))/;
const GIT_GREP_EXEC_ARG = /^(?:-O|--open-files-in-pager(?:=|$))/;
const FIND_EXEC = /^-(?:exec|execdir|ok|okdir)$/i;
const SORT_COMPRESS = /^--compress-prog(?:ram)?(?:=|$)/i;
const RG_PRE = /^--pre(?:=|$)/;

/**
 * Walk the simple commands left-to-right. An `export VAR=…` / `declare -x`
 * / `set VAR=…` / `$env:VAR=` / `Set-Item env:` earlier in the command
 * "infects" every later simple command (the env is still set). Prefixed
 * `VAR=… cmd` and `env VAR=… cmd` infect only that simple command.
 */
export function findExecCapableForms(command: string): ExecCapableForm[] {
  if (!command.trim()) return [];
  const simples = splitSimpleCommands(command);
  const out: ExecCapableForm[] = [];
  // Env vars set by a previous simple command and still live.
  const liveEnv = new Set<string>();

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
    while (i < words.length) {
      const h = headOf(words[i]);
      if (h === 'env') {
        i += 1;
        while (i < words.length && (words[i]!.startsWith('-') || ASSIGN.test(words[i]!))) {
          if (ASSIGN.test(words[i]!)) {
            const name = ASSIGN.exec(words[i]!)![1]!;
            if (isExecEnvName(name)) localEnv.add(name.toUpperCase());
          }
          i += 1;
        }
        continue;
      }
      if (WRAPPER.test(words[i]!)) {
        i += 1;
        while (i < words.length && words[i]!.startsWith('-')) i += 1;
        continue;
      }
      break;
    }

    // `export` / `declare -x` / `typeset -x` / `readonly` as a statement:
    // the assignment lives for later commands. Also `export VAR=… cmd`.
    if (ENV_SETTERS.has(headOf(words[i]))) {
      const setter = headOf(words[i]);
      i += 1;
      // skip flags (-x, -g, …); `set` alone with no assign is a shell option
      // change and is not an env infection (handled by O151 F10 cancel).
      while (i < words.length && words[i]!.startsWith('-') && !ASSIGN.test(words[i]!)) i += 1;
      let infected = false;
      while (
        i < words.length &&
        (ASSIGN.test(words[i]!) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(words[i]!))
      ) {
        const tok = words[i]!;
        const name = ASSIGN.test(tok) ? ASSIGN.exec(tok)![1]! : tok;
        if (isExecEnvName(name)) {
          liveEnv.add(name.toUpperCase());
          localEnv.add(name.toUpperCase());
          infected = true;
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
      if (i >= words.length) {
        // Pure setter statement; next simple command inherits liveEnv.
        if (infected && setter !== 'set') {
          /* liveEnv already updated */
        }
        continue;
      }
      // `export VAR=… cmd …` — fall through with the remaining words as the cmd.
    }

    if (i >= words.length) continue;
    const head = headOf(words[i]);
    const args = words.slice(i + 1);

    // Carry localEnv into detection of this command.
    for (const name of localEnv) {
      // Report once per simple command that is affected.
      if (
        head === 'git' ||
        head === 'rg' ||
        head === 'ripgrep' ||
        head === 'less' ||
        head === 'more' ||
        head === 'sort' ||
        head === 'find' ||
        head === 'grep' ||
        head === 'egrep' ||
        head === 'fgrep'
      ) {
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
