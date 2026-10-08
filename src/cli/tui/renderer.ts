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
  if (probe.inScreen || env.STY) return { mode: 'inline', reason: 'GNU screen' };
  if (probe.inTmux || env.TMUX) {
    const mouse = (probe.tmuxMouse ?? 'off').trim().toLowerCase();
    if (mouse !== 'on') return { mode: 'inline', reason: 'tmux mouse is off' };
  }
  return { mode: 'fullscreen', reason: 'default' };
}

export const MOUSE_TRACKING_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1004h';
export const MOUSE_TRACKING_OFF = '\x1b[?1004l\x1b[?1006l\x1b[?1002l\x1b[?1000l';

/** OSC 52 clipboard write. The caller also falls back to pbcopy on macOS. */
export function osc52(text: string): string {
  const payload = Buffer.from(text, 'utf8').toString('base64');
  return `\x1b]52;c;${payload}\x07`;
}
