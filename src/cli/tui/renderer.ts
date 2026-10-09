import fs from 'node:fs';

import { runProcessSync } from '../../utils/run-process.js';

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

function tmuxShow(args: string[], env: Record<string, string>): string {
  const result = runProcessSync('tmux', args, {
    encoding: 'utf8',
    timeout: 1_000,
    env,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return '';
  return String(result.stdout ?? '')
    .trim()
    .toLowerCase();
}

/**
 * Effective tmux mouse option, or `undefined` when this process is not inside
 * tmux. A session value wins over the global one (`set -g mouse on` leaves the
 * session option empty). A failed probe is `off`: fullscreen mouse tracking
 * inside tmux without the mouse option eats clicks, so the safe fallback is
 * the inline renderer.
 */
export function readTmuxMouse(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.TMUX) return undefined;
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') childEnv[key] = value;
  }
  const session = tmuxShow(['show', '-v', 'mouse'], childEnv);
  if (session) return session;
  return tmuxShow(['show', '-gv', 'mouse'], childEnv) || 'off';
}

/**
 * Ink `auto` asks the terminal `CSI ? u` and, until that probe ends, copies
 * stdin into a side buffer it later unshifts. A keystroke in that window is
 * delivered twice — `测` becomes `测测`, so the hardware cursor (and an IME
 * candidate window sitting on it) lands a cell too far. Force-enable skips
 * the probe. Terminals that do not speak the protocol ignore `CSI > flags u`.
 */
export const TUI_KITTY_KEYBOARD = { mode: 'enabled' as const };

// 1003 (any-event) reports motion without a button: the scroll bar appears on hover.
export const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1004h';
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
/**
 * Mouse, wrap, cursor, and bracketed paste. Leaving the alternate screen
 * (`?1049l`) is fullscreen-only: inline never entered it, and sending the
 * leave sequence from the primary screen is not how a leftover frame is erased.
 */
export const TERMINAL_RESTORE = MOUSE_TRACKING_OFF + '\x1b[?7h\x1b[?25h\x1b[?2004l';

/** Last dynamic frame (composer and rules), not the committed transcript above it. */
export interface DrawnFrame {
  rows: number;
  /** 0-based hardware-cursor row inside the frame. `rows` means the line just below it. */
  cursorRow: number;
}

let lastDrawnFrame: DrawnFrame | undefined;
let restoreMode: 'inline' | 'fullscreen' = 'inline';

/** Remember which renderer is on screen so a signal exit leaves the right buffer. */
export function setTerminalRestoreMode(mode: 'inline' | 'fullscreen'): void {
  restoreMode = mode;
}

/** The inline shell records the frame it just painted so exit can erase that frame only. */
export function rememberDrawnFrame(frame: DrawnFrame | undefined): void {
  lastDrawnFrame = frame;
}

/**
 * Move to column 0 of the first row of the frame, then erase downward.
 * The committed answer sits above the frame, so it stays.
 */
export function eraseDrawnFrame(frame: DrawnFrame): string {
  const rows = Math.max(0, Math.floor(frame.rows));
  if (rows <= 0) return '';
  const up = Math.min(Math.max(0, Math.floor(frame.cursorRow)), rows);
  return `${up > 0 ? `\x1b[${up}A` : ''}\x1b[G\x1b[J`;
}

/** Mode restores shared by exit and the process hook. Alternate-screen exit is fullscreen only. */
export function terminalRestoreSequence(mode: 'inline' | 'fullscreen'): string {
  return mode === 'fullscreen' ? `${TERMINAL_RESTORE}\x1b[?1049l` : TERMINAL_RESTORE;
}

/**
 * What to write once when the shell exits.
 * Inline erases only the last dynamic frame (not the answer above it), then
 * prints one continue hint. Fullscreen leaves the alternate screen and does
 * not clear the primary buffer.
 */
export function tuiExitSequence(mode: 'inline' | 'fullscreen', frame?: DrawnFrame): string {
  if (mode === 'inline') {
    const drawn = frame ?? lastDrawnFrame;
    const erase = drawn ? eraseDrawnFrame(drawn) : '';
    return `${terminalRestoreSequence('inline')}${erase}moss --continue\n`;
  }
  return terminalRestoreSequence('fullscreen');
}

let terminalExitDone = false;

/** Write the exit sequence at most once. The process `exit` hook skips if this ran. */
export function writeTuiExitSequence(
  mode: 'inline' | 'fullscreen',
  target: { fd?: number; isTTY?: boolean } | number = 1
): void {
  if (terminalExitDone) return;
  const fd = typeof target === 'number' ? target : target.fd;
  const tty = typeof target === 'number' ? true : target.isTTY === true;
  if (!tty || typeof fd !== 'number') return;
  terminalExitDone = true;
  try {
    fs.writeSync(fd, tuiExitSequence(mode));
  } catch {
    // The fd is already closed during a hard shutdown.
  }
}

export function restoreTerminalModes(target: { fd?: number; isTTY?: boolean } | number = 1): void {
  const fd = typeof target === 'number' ? target : target.fd;
  const tty = typeof target === 'number' ? true : target.isTTY === true;
  if (!tty || typeof fd !== 'number') return;
  try {
    fs.writeSync(fd, terminalRestoreSequence(restoreMode));
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
    if (terminalExitDone) return;
    restoreTerminalModes(process.stdout);
  });
}

/** OSC 52 clipboard write. The caller also falls back to pbcopy on macOS. */
export function osc52(text: string): string {
  const payload = Buffer.from(text, 'utf8').toString('base64');
  return `\x1b]52;c;${payload}\x07`;
}
