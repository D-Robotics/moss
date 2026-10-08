import fs from 'node:fs';

/**
 * Which terminal renderer a TTY session uses.
 *
 * Fullscreen (alternate screen + mouse) is the default. Inline is the
 * primary-screen fallback when the terminal cannot host it, or when the user
 * asks for it.
 */
export type TuiRendererMode = 'inline' | 'fullscreen';

export interface RendererProbe {
  env?: Record<string, string | undefined>;
  rows?: number;
  /** Terminal width; below MIN_FULLSCREEN_COLUMNS the fullscreen frame cannot hold its chrome. */
  columns?: number;
  term?: string;
  /** `tmux show -gv mouse` result; undefined when not inside tmux. */
  tmuxMouse?: string | undefined;
  inTmux?: boolean;
  inScreen?: boolean;
}

export interface RendererChoice {
  mode: TuiRendererMode;
  reason: string;
}

/** Below this width the fullscreen chrome (rules, hint, status) cannot stay on one row each. */
export const MIN_FULLSCREEN_COLUMNS = 40;

export function selectTuiRenderer(probe: RendererProbe = {}): RendererChoice {
  const env = probe.env ?? {};
  const explicit = (env.MOSS_TUI_RENDERER ?? '').trim().toLowerCase();
  if (explicit === 'inline') return { mode: 'inline', reason: 'MOSS_TUI_RENDERER=inline' };
  if (explicit === 'fullscreen')
    return { mode: 'fullscreen', reason: 'MOSS_TUI_RENDERER=fullscreen' };
  const configured = (env.MOSS_TUI_RENDERER_CONFIG ?? '').trim().toLowerCase();
  if (configured === 'inline') return { mode: 'inline', reason: 'config tui.renderer=inline' };
  if (configured === 'fullscreen')
    return { mode: 'fullscreen', reason: 'config tui.renderer=fullscreen' };
  const term = (probe.term ?? env.TERM ?? '').toLowerCase();
  if (term === 'dumb' || term === '')
    return { mode: 'inline', reason: 'TERM cannot host a fullscreen UI' };
  const rows = probe.rows ?? 24;
  if (rows < 10) return { mode: 'inline', reason: 'terminal is shorter than 10 rows' };
  const columns = probe.columns ?? 80;
  if (columns < MIN_FULLSCREEN_COLUMNS) {
    return {
      mode: 'inline',
      reason: `terminal is narrower than ${MIN_FULLSCREEN_COLUMNS} columns`,
    };
  }
  if (probe.inScreen || env.STY) return { mode: 'inline', reason: 'GNU screen' };
  if (probe.inTmux || env.TMUX) {
    const mouse = (probe.tmuxMouse ?? 'off').trim().toLowerCase();
    if (mouse !== 'on') return { mode: 'inline', reason: 'tmux mouse is off' };
  }
  return { mode: 'fullscreen', reason: 'default' };
}

export const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1004h';
export const MOUSE_TRACKING_OFF =
  '\x1b[?1004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1003l\x1b[?1015l';

/**
 * Modes that must not survive the process. Mouse tracking in particular is
 * not tied to the alternate screen: if it is still on when the shell prompt
 * returns, a click is delivered as an SGR report (`0;84;44M`) and echoed.
 * Autowrap (`?7`) is turned off for the session and has to come back too.
 * Written with `writeSync` because ink drops `useStdout().write` once
 * unmount has set `isUnmounted`.
 */
export const TERMINAL_RESTORE = MOUSE_TRACKING_OFF + '\x1b[?7h\x1b[?25h\x1b[?2004l';

export function restoreTerminalModes(target: { fd?: number; isTTY?: boolean } | number = 1): void {
  const fd = typeof target === 'number' ? target : target.fd;
  const tty = typeof target === 'number' ? true : target.isTTY === true;
  if (!tty || typeof fd !== 'number') return;
  try {
    fs.writeSync(fd, TERMINAL_RESTORE);
  } catch {
    // The fd is already closed during a hard shutdown.
  }
}

let restoreInstalled = false;

/** Idempotent. The `exit` hook covers signals that skip the React cleanup. */
export function installTerminalRestore(): void {
  if (restoreInstalled) return;
  restoreInstalled = true;
  process.on('exit', () => {
    restoreTerminalModes(process.stdout);
  });
}

/** OSC 52 clipboard write. The caller also falls back to pbcopy on macOS. */
export function osc52(text: string): string {
  const payload = Buffer.from(text, 'utf8').toString('base64');
  return `\x1b]52;c;${payload}\x07`;
}
