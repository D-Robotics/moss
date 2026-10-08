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

export type TuiThemeName = 'dark' | 'light' | 'mono';

export const THEME_NAMES: readonly TuiThemeName[] = ['dark', 'light', 'mono'];

/** Light-background remaps: colours that are unreadable on white. */
const LIGHT_REMAP: Partial<Record<TuiColor, TuiColor>> = {
  yellow: 'magenta',
  white: 'gray',
};

/** Background indexes (COLORFGBG) that are light in the 16-colour palette. */
const LIGHT_BACKGROUNDS = new Set(['7', '15']);

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
