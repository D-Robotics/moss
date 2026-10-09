/**
 * Terminal colour themes for the shell (plan v3 P5).
 *
 * Rows name colours with the ink palette (`TuiColor`). The paint boundary
 * (`inkTextStyle`) passes every colour through `paintColor`, so one switch decides
 * the whole screen:
 *
 *   dark   the default: the ink palette as-is (designed for dark backgrounds)
 *   light  swaps the colours that vanish on a light background (yellow, white)
 *   mono   no colour at all (NO_COLOR, https://no-color.org); bold, italic and
 *          underline stay, because they carry meaning without colour
 *
 * Selection: `NO_COLOR` (any non-empty value) → mono; `MOSS_TUI_THEME` = dark |
 * light | mono wins over the detected background; otherwise `COLORFGBG` (set by
 * rxvt-family terminals as `fg;bg`) decides light vs dark, defaulting to dark.
 */
import type { TuiColor } from './text.js';

/**
 * Semantic colour names (plan v3 P5). Render code names a role, not a colour: the
 * table is the one place a role maps to the ink palette. A static spec keeps the
 * literals out of the render modules.
 */
export const TONE = {
  /** Interactive and structural accents: headings, tool marks, the active item. */
  accent: 'cyan',
  /** Secondary information: labels, folded hints, the resting chrome. */
  muted: 'gray',
  /** Waiting or slow: the spinner, a slow tool, a blocked task. */
  warn: 'yellow',
  /** Success: added lines, finished todos. */
  ok: 'green',
  /** Failure and removal: removed lines, errors. */
  err: 'red',
  /** The `!` shell prompt, accept-edits mode. */
  shell: 'magenta',
  /** Informational emphasis: the plan mode and links. */
  info: 'blue',
} as const satisfies Record<string, TuiColor>;

export type TuiThemeName = 'dark' | 'light' | 'mono';

export const THEME_NAMES: readonly TuiThemeName[] = ['dark', 'light', 'mono'];

/** Light-background remaps: colours that are unreadable on white. */
const LIGHT_REMAP: Partial<Record<TuiColor, TuiColor>> = {
  yellow: 'magenta',
  white: 'gray',
};

/** Background indexes (COLORFGBG) that are light in the 16-colour palette. */
const LIGHT_BACKGROUNDS = new Set(['7', '15']);

/** `NO_COLOR` outranks `/theme` and the background probe. */
export function themeLockedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NO_COLOR !== undefined && env.NO_COLOR !== '';
}

/**
 * OSC 11 reply body (`rgb:RRRR/GGGG/BBBB`) → light or dark. Undefined when the
 * payload is not a colour, so a garbled reply leaves the current theme alone.
 */
export function themeFromOsc11(body: string): 'light' | 'dark' | undefined {
  const match = /rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(body);
  if (!match) return undefined;
  const channel = (hex: string): number => {
    const value = Number.parseInt(hex, 16);
    const full = 16 ** hex.length - 1;
    return full > 0 ? value / full : 0;
  };
  const luminance =
    0.2126 * channel(match[1] ?? '0') +
    0.7152 * channel(match[2] ?? '0') +
    0.0722 * channel(match[3] ?? '0');
  return luminance >= 0.6 ? 'light' : 'dark';
}

export function detectTheme(env: NodeJS.ProcessEnv = process.env): TuiThemeName {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'mono';
  const explicit = (env.MOSS_TUI_THEME ?? '').trim().toLowerCase();
  if ((THEME_NAMES as readonly string[]).includes(explicit)) return explicit as TuiThemeName;
  const background = (env.COLORFGBG ?? '').split(';').pop()?.trim() ?? '';
  if (LIGHT_BACKGROUNDS.has(background)) return 'light';
  return 'dark';
}

let active: TuiThemeName = 'dark';

export function setTuiTheme(name: TuiThemeName): void {
  active = name;
}

export function currentTuiTheme(): TuiThemeName {
  return active;
}

/** The colour a row should be painted with under the active theme. */
export function paintColor(color: TuiColor | undefined): TuiColor | undefined {
  if (!color || active === 'mono') return undefined;
  if (active === 'light') return LIGHT_REMAP[color] ?? color;
  return color;
}
