/**
 * Wire protocol for one long-lived device shell (pure framing; the SSH I/O
 * lives in ssh-device-connection.ts).
 *
 * Every command is wrapped so the reader can tell where the command's output
 * ends and what it returned:
 *
 *   eval '<command>' 2>&1
 *   printf '\n<sentinel>%s\n' "$?"
 *
 * The sentinel never appears in program output by construction (random per
 * session), the exit code rides on the same line, and stdout/stderr are merged
 * because a shell channel has no separate stderr stream. The command goes
 * through `eval` (still the current shell, so `cd`/`export`/`source` persist)
 * because a non-interactive bash EXITS on a syntax error it parses from its
 * input — a single typo from the model would otherwise kill the session and
 * its environment; a syntax error inside `eval` only returns 2.
 */

/** Marker that must not occur in a command; we refuse such commands instead of guessing the frame. */
export function makeShellSentinel(): string {
  return `__MOSS_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}__`;
}

/**
 * Startup line for a fresh shell (opened WITHOUT a pty, so there is no echo,
 * no prompt and no readline to switch off): UTF-8, no pager, then READY.
 */
export function buildShellInit(): string {
  return [
    'unset PROMPT_COMMAND 2>/dev/null',
    'export PS1= PS2= PAGER=cat GIT_PAGER=cat LESS=FRX',
    'export TERM=dumb LANG=C.UTF-8 LC_ALL=C.UTF-8',
    // The caller sends this line through frameShellCommand, which appends the
    // sentinel frame; printing the sentinel here too would yield two frames.
    `printf 'READY\\n'`,
  ].join('; ');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Wrap one user command so its output and exit code are delimited. */
export function frameShellCommand(command: string, sentinel: string): string {
  return `eval ${shellQuote(command)} 2>&1; __rc=$?; printf '\\n${sentinel}%s\\n' "$__rc"`;
}

export interface ShellFrameResult {
  stdout: string;
  exitCode: number | null;
  /** Bytes after the sentinel line: the start of the next frame, if any. */
  rest: string;
}

/**
 * Pull the first complete frame out of a buffer. Returns null while the
 * sentinel line has not arrived yet.
 */
export function parseShellFrame(buffer: string, sentinel: string): ShellFrameResult | null {
  // The sentinel text may legitimately appear earlier in the stream (a command
  // that echoes `$PS1`-like state); only a `<sentinel><digits>` line ends a frame.
  let from = 0;
  for (;;) {
    const idx = buffer.indexOf(`\n${sentinel}`, from);
    if (idx < 0) return null;
    const lineEnd = buffer.indexOf('\n', idx + 1);
    if (lineEnd < 0) return null;
    const codeText = buffer.slice(idx + 1 + sentinel.length, lineEnd).trim();
    if (/^\d+$/.test(codeText)) {
      return {
        stdout: buffer.slice(0, idx).replace(/\r\n/g, '\n'),
        exitCode: Number(codeText),
        rest: buffer.slice(lineEnd + 1),
      };
    }
    from = idx + 1;
  }
}

/** Candidates in priority order: TROS humble first, then TROS, then any upstream ROS 2. */
export const ROS_SETUP_CANDIDATES = [
  '/opt/tros/humble/setup.bash',
  '/opt/tros/setup.bash',
  '/opt/ros/*/setup.bash',
] as const;

/**
 * Sources the first existing overlay inside the session shell (not a subshell)
 * so exports persist for later commands, and prints which one won. One line,
 * no `do;`/`done;` fragments that a `; `-join could turn into a syntax error.
 */
export function buildRosSourceCommand(extraSetupBash?: string): string {
  const candidates = [...(extraSetupBash ? [extraSetupBash] : []), ...ROS_SETUP_CANDIDATES];
  const quoted = candidates.map((c) => (c.includes('*') ? c : shellQuote(c))).join(' ');
  return (
    `for __m in ${quoted}; do ` +
    'if [ -f "$__m" ]; then . "$__m" && printf "ROS_ENV_SOURCED:%s\\n" "$__m" && break; fi; ' +
    'done; true'
  );
}

/** Extract the overlay path reported by {@link buildRosSourceCommand}, if any. */
export function parseSourcedRosSetup(stdout: string): string | null {
  const match = stdout.match(/ROS_ENV_SOURCED:(.+)/);
  return match ? match[1].trim() : null;
}
