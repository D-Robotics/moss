// ────────────────────────────────────────────────────────────────────────────
// CLI Theme engine — JSON-driven semantic token system
// ────────────────────────────────────────────────────────────────────────────

export interface CliThemeTokens {
  accent: string; text: string; textSecondary: string; textMuted: string;
  textDim: string; inverseText: string; inactive: string; subtle: string;
  suggestion: string; user: string; tool: string; permission: string;
  success: string; error: string; warning: string; merged: string;
  promptBorder: string; planMode: string; autoAccept: string; bashBorder: string;
  ide: string; fastMode: string;
  diffAdded: string; diffRemoved: string; diffAddedDimmed: string; diffRemovedDimmed: string;
  diffAddedWord: string; diffRemovedWord: string;
  userMessageBackground: string; bashMessageBackgroundColor: string;
  memoryBackgroundColor: string; selectionBg: string;
  rateLimitFill: string; rateLimitEmpty: string;
  briefLabelYou: string; briefLabelAgent: string;
  accentShimmer: string; warningShimmer: string; permissionShimmer: string; toolShimmer: string;
  subagent1: string; subagent2: string; subagent3: string; subagent4: string;
  subagent5: string; subagent6: string; subagent7: string; subagent8: string;
  rainbowRed: string; rainbowOrange: string; rainbowYellow: string; rainbowGreen: string;
  rainbowCyan: string; rainbowBlue: string; rainbowViolet: string;
  primary: string; primarySoft: string; border: string;
}

export interface CliTheme {
  name: string;
  type: 'dark' | 'light' | 'daltonized';
  tokens: CliThemeTokens;
}

// opencode-aligned dark palette: warm-orange accent (#fab283), low-noise greys,
// purple/blue/cyan semantic accents and the opencode diff colors. Downstream brand
// orange/cyan still lives only in brand.ts/logo.ts for the startup logo.
export const AURORA_DARK_TOKENS: CliThemeTokens = {
  accent: '#fab283', text: '#eeeeee', textSecondary: '#c0c0c0',
  textMuted: '#808080', textDim: '#5c5c5c', inverseText: '#0a0a0a',
  inactive: '#808080', subtle: '#3c3c3c', suggestion: '#9d7cd8',
  user: '#5c9cf5', tool: '#fab283', permission: '#9d7cd8',
  success: '#7fd88f', error: '#e06c75', warning: '#f5a742', merged: '#9d7cd8',
  promptBorder: '#606060', planMode: '#56b6c2', autoAccept: '#9d7cd8',
  bashBorder: '#56b6c2', ide: '#5c9cf5', fastMode: '#f5a742',
  diffAdded: '#20303b', diffRemoved: '#37222c', diffAddedDimmed: '#1a2830',
  diffRemovedDimmed: '#2e1d25', diffAddedWord: '#4fd6be', diffRemovedWord: '#c53b53',
  userMessageBackground: '#1e1e1e', bashMessageBackgroundColor: '#141414',
  memoryBackgroundColor: '#1a2530', selectionBg: '#264f78',
  rateLimitFill: '#9d7cd8', rateLimitEmpty: '#323232',
  briefLabelYou: '#5c9cf5', briefLabelAgent: '#fab283',
  accentShimmer: '#ffc09f', warningShimmer: '#ffd28a',
  permissionShimmer: '#c5a9e8', toolShimmer: '#ffc09f',
  subagent1: '#dc2626', subagent2: '#2563eb', subagent3: '#16a34a', subagent4: '#ca8a04',
  subagent5: '#9333ea', subagent6: '#ea580c', subagent7: '#db2777', subagent8: '#0891b2',
  rainbowRed: '#e06c75', rainbowOrange: '#f5a742', rainbowYellow: '#e5c07b',
  rainbowGreen: '#7fd88f', rainbowCyan: '#56b6c2', rainbowBlue: '#5c9cf5', rainbowViolet: '#9d7cd8',
  primary: '#fab283', primarySoft: '#ffc09f', border: '#484848',
};

export const AURORA_DARK_THEME: CliTheme = {
  name: 'Aurora Dark',
  type: 'dark',
  tokens: AURORA_DARK_TOKENS,
};

// compact agent-aligned light palette, tuned for terminal cells rather than a web
// canvas. The muted/dim tokens stay dark enough for white or translucent macOS
// Terminal backgrounds, where SGR dim can otherwise become unreadable.
// opencode-aligned light palette (kept readable on white/translucent terminals).
// textMuted/textDim/promptBorder/permission are pinned by cli-tui-render.spec.
export const AURORA_LIGHT_TOKENS: CliThemeTokens = {
  accent: '#bd5d2a', text: '#1a1a1a', textSecondary: '#3a3a3a',
  textMuted: '#4b5563', textDim: '#6b7280', inverseText: '#ffffff',
  inactive: '#6b7280', subtle: '#9ca3af', suggestion: '#7c5cbf',
  user: '#3b7dd8', tool: '#bd5d2a', permission: '#5769f7',
  success: '#2f9d44', error: '#c53b53', warning: '#b5791f', merged: '#7c5cbf',
  promptBorder: '#767676', planMode: '#0e7490', autoAccept: '#7c5cbf',
  bashBorder: '#0e7490', ide: '#3b7dd8', fastMode: '#c2680c',
  diffAdded: '#cdeccd', diffRemoved: '#f5d0d8', diffAddedDimmed: '#dcebdc',
  diffRemovedDimmed: '#f2dfe3', diffAddedWord: '#2f9d44', diffRemovedWord: '#c53b53',
  userMessageBackground: '#2b2b2b', bashMessageBackgroundColor: '#f3f0f3',
  memoryBackgroundColor: '#e6f0f5', selectionBg: '#b4d5ff',
  rateLimitFill: '#5769f7', rateLimitEmpty: '#c7cbe8',
  briefLabelYou: '#3b7dd8', briefLabelAgent: '#bd5d2a',
  accentShimmer: '#d98a5a', warningShimmer: '#d0a955',
  permissionShimmer: '#8b7fd0', toolShimmer: '#d98a5a',
  subagent1: '#dc2626', subagent2: '#2563eb', subagent3: '#16a34a', subagent4: '#ca8a04',
  subagent5: '#9333ea', subagent6: '#ea580c', subagent7: '#db2777', subagent8: '#0891b2',
  rainbowRed: '#c53b53', rainbowOrange: '#c2680c', rainbowYellow: '#b5791f',
  rainbowGreen: '#2f9d44', rainbowCyan: '#0e7490', rainbowBlue: '#3b7dd8', rainbowViolet: '#7c5cbf',
  primary: '#bd5d2a', primarySoft: '#d98a5a', border: '#767676',
};

export const AURORA_LIGHT_THEME: CliTheme = {
  name: 'Aurora Light',
  type: 'light',
  tokens: AURORA_LIGHT_TOKENS,
};

// ── Nord Dark ──────────────────────────────────────────────────────────────
// Arctic, north-bluish clean palette. Popular in terminal communities for its
// low-contrast, eye-friendly tones.
export const NORD_DARK_TOKENS: CliThemeTokens = {
  accent: '#88c0d0', text: '#d8dee9', textSecondary: '#b0b9cb',
  textMuted: '#6f7d96', textDim: '#4c566a', inverseText: '#2e3440',
  inactive: '#6f7d96', subtle: '#3b4252', suggestion: '#b48ead',
  user: '#81a1c1', tool: '#88c0d0', permission: '#b48ead',
  success: '#a3be8c', error: '#bf616a', warning: '#ebcb8b', merged: '#b48ead',
  promptBorder: '#4c566a', planMode: '#8fbcbb', autoAccept: '#b48ead',
  bashBorder: '#8fbcbb', ide: '#81a1c1', fastMode: '#ebcb8b',
  diffAdded: '#2a3a2e', diffRemoved: '#3a2228', diffAddedDimmed: '#1e2e22',
  diffRemovedDimmed: '#2e1d22', diffAddedWord: '#a3be8c', diffRemovedWord: '#bf616a',
  userMessageBackground: '#212731', bashMessageBackgroundColor: '#1e232b',
  memoryBackgroundColor: '#1e2835', selectionBg: '#3e5068',
  rateLimitFill: '#b48ead', rateLimitEmpty: '#353c4b',
  briefLabelYou: '#81a1c1', briefLabelAgent: '#88c0d0',
  accentShimmer: '#a4d8e2', warningShimmer: '#f5dba0',
  permissionShimmer: '#c9a8d8', toolShimmer: '#a4d8e2',
  subagent1: '#bf616a', subagent2: '#5e81ac', subagent3: '#a3be8c', subagent4: '#ebcb8b',
  subagent5: '#b48ead', subagent6: '#d08770', subagent7: '#d06f8c', subagent8: '#8fbcbb',
  rainbowRed: '#bf616a', rainbowOrange: '#d08770', rainbowYellow: '#ebcb8b',
  rainbowGreen: '#a3be8c', rainbowCyan: '#88c0d0', rainbowBlue: '#81a1c1', rainbowViolet: '#b48ead',
  primary: '#88c0d0', primarySoft: '#a4d8e2', border: '#434c5e',
};

export const NORD_DARK_THEME: CliTheme = {
  name: 'Nord Dark',
  type: 'dark',
  tokens: NORD_DARK_TOKENS,
};

// ── Solarized Dark ─────────────────────────────────────────────────────────
// Ethan Schoonover's precision color scheme. Warm, low-contrast,
// carefully tuned for long reading sessions.
export const SOLARIZED_DARK_TOKENS: CliThemeTokens = {
  accent: '#268bd2', text: '#839496', textSecondary: '#657b83',
  textMuted: '#586e75', textDim: '#42535b', inverseText: '#002b36',
  inactive: '#586e75', subtle: '#073642', suggestion: '#6c71c4',
  user: '#268bd2', tool: '#2aa198', permission: '#6c71c4',
  success: '#859900', error: '#dc322f', warning: '#b58900', merged: '#6c71c4',
  promptBorder: '#586e75', planMode: '#2aa198', autoAccept: '#6c71c4',
  bashBorder: '#2aa198', ide: '#268bd2', fastMode: '#b58900',
  diffAdded: '#1e3620', diffRemoved: '#2e1a1c', diffAddedDimmed: '#172b18',
  diffRemovedDimmed: '#251518', diffAddedWord: '#859900', diffRemovedWord: '#dc322f',
  userMessageBackground: '#00212b', bashMessageBackgroundColor: '#001e26',
  memoryBackgroundColor: '#00212e', selectionBg: '#1a4560',
  rateLimitFill: '#6c71c4', rateLimitEmpty: '#1a3340',
  briefLabelYou: '#268bd2', briefLabelAgent: '#2aa198',
  accentShimmer: '#54a8e8', warningShimmer: '#d0a010',
  permissionShimmer: '#8e91d8', toolShimmer: '#48c0b8',
  subagent1: '#dc322f', subagent2: '#268bd2', subagent3: '#859900', subagent4: '#b58900',
  subagent5: '#6c71c4', subagent6: '#cb4b16', subagent7: '#d33682', subagent8: '#2aa198',
  rainbowRed: '#dc322f', rainbowOrange: '#cb4b16', rainbowYellow: '#b58900',
  rainbowGreen: '#859900', rainbowCyan: '#2aa198', rainbowBlue: '#268bd2', rainbowViolet: '#6c71c4',
  primary: '#268bd2', primarySoft: '#54a8e8', border: '#1a495c',
};

export const SOLARIZED_DARK_THEME: CliTheme = {
  name: 'Solarized Dark',
  type: 'dark',
  tokens: SOLARIZED_DARK_TOKENS,
};

export type CliThemeMode = 'dark' | 'light';

function forcedThemeMode(env: NodeJS.ProcessEnv): CliThemeMode | null {
  const raw = `${env.MOSS_TUI_THEME ?? env.MOSS_THEME ?? ''}`.trim().toLowerCase();
  if (!raw || raw === 'auto') return null;
  if (raw.startsWith('light')) return 'light';
  if (raw.startsWith('dark')) return 'dark';
  return null;
}

function modeFromColorFgBg(value: string | undefined): CliThemeMode | null {
  if (!value) return null;
  const last = value.split(/[;:]/).filter(Boolean).at(-1);
  const background = last === undefined ? Number.NaN : Number.parseInt(last, 10);
  if (!Number.isFinite(background)) return null;
  if (background === 7 || background >= 9) return 'light';
  if (background >= 0) return 'dark';
  return null;
}

function modeFromNamedEnvironment(env: NodeJS.ProcessEnv): CliThemeMode | null {
  const raw = [
    env.COLOR_SCHEME,
    env.OS_APPEARANCE,
    env.TERM_THEME,
    env.ITERM_PROFILE,
    env.TERMINAL_PROFILE,
  ].filter(Boolean).join(' ').toLowerCase();
  if (!raw) return null;
  if (/(light|day|paper|white|latte)/.test(raw)) return 'light';
  if (/(dark|night|black|pro|mocha)/.test(raw)) return 'dark';
  return null;
}

export function resolveTerminalThemeMode(env: NodeJS.ProcessEnv = process.env): CliThemeMode {
  return forcedThemeMode(env)
    ?? modeFromColorFgBg(env.COLORFGBG)
    ?? modeFromNamedEnvironment(env)
    ?? 'dark';
}

export function resolveThemeTokens(env: NodeJS.ProcessEnv = process.env): CliThemeTokens {
  return resolveTerminalThemeMode(env) === 'light' ? AURORA_LIGHT_TOKENS : AURORA_DARK_TOKENS;
}

// Active theme bag imported by tui.ts and the cli/components as `theme`.
// It is the full compact agent-aligned token set plus the
// `warn` alias that the legacy call sites use, so existing `theme.x` references
// keep working while gaining the new tokens (permission, planMode, autoAccept,
// subtle, diffAdded/diffRemoved/word, userMessageBackground, …).
const RESOLVED_TOKENS = resolveThemeTokens();

export const legacyTheme = {
  ...RESOLVED_TOKENS,
  warn: RESOLVED_TOKENS.warning,
  // Primary text uses the TERMINAL DEFAULT foreground (undefined) so it stays
  // readable on BOTH light and dark terminals.
  // Elements with a fixed dark background set an explicit light fg instead
  // (see the user-message echo in tui.ts).
  text: undefined as string | undefined,
};

const BUILTIN_THEMES: CliTheme[] = [
  AURORA_DARK_THEME,
  AURORA_LIGHT_THEME,
  NORD_DARK_THEME,
  SOLARIZED_DARK_THEME,
];

export function getBuiltinThemes(): CliTheme[] { return BUILTIN_THEMES; }
export function getDefaultTheme(): CliTheme { return AURORA_DARK_THEME; }

export function resolveThemeByName(name: string): CliTheme | null {
  const normalized = name.trim().toLowerCase();
  return BUILTIN_THEMES.find(
    (t) => t.name.toLowerCase() === normalized,
  ) ?? null;
}

export function listThemeNames(): string[] {
  return BUILTIN_THEMES.map((t) => t.name);
}

export function resolveTheme(base: CliTheme, overrides: Partial<CliThemeTokens>): CliTheme {
  return { ...base, tokens: { ...base.tokens, ...overrides } };
}

/**
 * Resolve theme tokens by name or from environment detection.
 * Supports `MOSS_TUI_THEME=aurora-dark|aurora-light|nord-dark|solarized-dark`.
 * Falls back to terminal auto-detection when the name is unknown.
 */
export function resolveThemeTokensByName(env: NodeJS.ProcessEnv = process.env): CliThemeTokens {
  const raw = `${env.MOSS_TUI_THEME ?? env.MOSS_THEME ?? ''}`.trim();
  if (raw && raw.toLowerCase() !== 'auto') {
    const theme = resolveThemeByName(raw);
    if (theme) return theme.tokens;
  }
  return resolveThemeTokens(env);
}
