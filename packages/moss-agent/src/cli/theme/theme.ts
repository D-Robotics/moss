



export interface CliThemeTokens {
  accent: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  textDim: string;
  inverseText: string;
  inactive: string;
  subtle: string;
  suggestion: string;
  user: string;
  tool: string;
  permission: string;
  success: string;
  error: string;
  warning: string;
  merged: string;
  promptBorder: string;
  promptBackground: string;
  planMode: string;
  autoAccept: string;
  bashBorder: string;
  ide: string;
  fastMode: string;
  diffAdded: string;
  diffRemoved: string;
  diffAddedDimmed: string;
  diffRemovedDimmed: string;
  diffAddedWord: string;
  diffRemovedWord: string;
  userMessageBackground: string;
  bashMessageBackgroundColor: string;
  memoryBackgroundColor: string;
  selectionBg: string;
  rateLimitFill: string;
  rateLimitEmpty: string;
  briefLabelYou: string;
  briefLabelAgent: string;
  accentShimmer: string;
  warningShimmer: string;
  permissionShimmer: string;
  toolShimmer: string;
  subagent1: string;
  subagent2: string;
  subagent3: string;
  subagent4: string;
  subagent5: string;
  subagent6: string;
  subagent7: string;
  subagent8: string;
  rainbowRed: string;
  rainbowOrange: string;
  rainbowYellow: string;
  rainbowGreen: string;
  rainbowCyan: string;
  rainbowBlue: string;
  rainbowViolet: string;
  primary: string;
  primarySoft: string;
  border: string;
}

export interface CliTheme {
  name: string;
  type: 'dark' | 'light' | 'daltonized';
  tokens: CliThemeTokens;
}








export const AURORA_DARK_TOKENS: CliThemeTokens = {
  accent: '#d4622a',
  text: '#d4d4d4',
  textSecondary: '#b0b0b0',
  textMuted: '#888888',
  textDim: '#666666',
  inverseText: '#ffffff',
  inactive: '#777777',
  subtle: '#555555',
  suggestion: '#7c5cbf',
  user: '#3b7dd8',
  tool: '#d4622a',
  permission: '#7c5cbf',
  success: '#2f9d44',
  error: '#c53b53',
  warning: '#b5791f',
  merged: '#7c5cbf',
  promptBorder: '#888888',
  promptBackground: '#1c1c28',
  planMode: '#0e7490',
  autoAccept: '#7c5cbf',
  bashBorder: '#0e7490',
  ide: '#3b7dd8',
  fastMode: '#c2680c',
  diffAdded: '#cdeccd',
  diffRemoved: '#f5d0d8',
  diffAddedDimmed: '#dcebdc',
  diffRemovedDimmed: '#f2dfe3',
  diffAddedWord: '#2f9d44',
  diffRemovedWord: '#c53b53',
  userMessageBackground: '#f0f0f0',
  bashMessageBackgroundColor: '#e8e8e8',
  memoryBackgroundColor: '#e6f0f5',
  selectionBg: '#b4d5ff',
  rateLimitFill: '#7c5cbf',
  rateLimitEmpty: '#cccccc',
  briefLabelYou: '#3b7dd8',
  briefLabelAgent: '#d4622a',
  accentShimmer: '#e87a3a',
  warningShimmer: '#d0a010',
  permissionShimmer: '#9d8bd0',
  toolShimmer: '#e87a3a',
  subagent1: '#dc2626',
  subagent2: '#2563eb',
  subagent3: '#16a34a',
  subagent4: '#ca8a04',
  subagent5: '#9333ea',
  subagent6: '#ea580c',
  subagent7: '#db2777',
  subagent8: '#0891b2',
  rainbowRed: '#c53b53',
  rainbowOrange: '#c2680c',
  rainbowYellow: '#b5791f',
  rainbowGreen: '#2f9d44',
  rainbowCyan: '#0e7490',
  rainbowBlue: '#3b7dd8',
  rainbowViolet: '#7c5cbf',
  primary: '#d4622a',
  primarySoft: '#e87a3a',
  border: '#aaaaaa',
};

export const AURORA_DARK_THEME: CliTheme = {
  name: 'Aurora Dark',
  type: 'dark',
  tokens: AURORA_DARK_TOKENS,
};






export const AURORA_LIGHT_TOKENS: CliThemeTokens = {
  accent: '#bd5d2a',
  text: '#0a0a0a',
  textSecondary: '#3a3a3a',
  textMuted: '#4b5563',
  textDim: '#6b7280',
  inverseText: '#ffffff',
  inactive: '#6b7280',
  subtle: '#9ca3af',
  suggestion: '#7c5cbf',
  user: '#3b7dd8',
  tool: '#bd5d2a',
  permission: '#5769f7',
  success: '#2f9d44',
  error: '#c53b53',
  warning: '#b5791f',
  merged: '#7c5cbf',
  promptBorder: '#767676',
  promptBackground: '#f5f5f4',
  planMode: '#0e7490',
  autoAccept: '#7c5cbf',
  bashBorder: '#0e7490',
  ide: '#3b7dd8',
  fastMode: '#c2680c',
  diffAdded: '#cdeccd',
  diffRemoved: '#f5d0d8',
  diffAddedDimmed: '#dcebdc',
  diffRemovedDimmed: '#f2dfe3',
  diffAddedWord: '#2f9d44',
  diffRemovedWord: '#c53b53',
  userMessageBackground: '#2b2b2b',
  bashMessageBackgroundColor: '#f3f0f3',
  memoryBackgroundColor: '#e6f0f5',
  selectionBg: '#b4d5ff',
  rateLimitFill: '#5769f7',
  rateLimitEmpty: '#c7cbe8',
  briefLabelYou: '#3b7dd8',
  briefLabelAgent: '#bd5d2a',
  accentShimmer: '#d98a5a',
  warningShimmer: '#d0a955',
  permissionShimmer: '#8b7fd0',
  toolShimmer: '#d98a5a',
  subagent1: '#dc2626',
  subagent2: '#2563eb',
  subagent3: '#16a34a',
  subagent4: '#ca8a04',
  subagent5: '#9333ea',
  subagent6: '#ea580c',
  subagent7: '#db2777',
  subagent8: '#0891b2',
  rainbowRed: '#c53b53',
  rainbowOrange: '#c2680c',
  rainbowYellow: '#b5791f',
  rainbowGreen: '#2f9d44',
  rainbowCyan: '#0e7490',
  rainbowBlue: '#3b7dd8',
  rainbowViolet: '#7c5cbf',
  primary: '#bd5d2a',
  primarySoft: '#d98a5a',
  border: '#767676',
};

export const AURORA_LIGHT_THEME: CliTheme = {
  name: 'Aurora Light',
  type: 'light',
  tokens: AURORA_LIGHT_TOKENS,
};




export const NORD_DARK_TOKENS: CliThemeTokens = {
  accent: '#88c0d0',
  text: '#d8dee9',
  textSecondary: '#b0b9cb',
  textMuted: '#6f7d96',
  textDim: '#4c566a',
  inverseText: '#2e3440',
  inactive: '#6f7d96',
  subtle: '#3b4252',
  suggestion: '#b48ead',
  user: '#81a1c1',
  tool: '#88c0d0',
  permission: '#b48ead',
  success: '#a3be8c',
  error: '#bf616a',
  warning: '#ebcb8b',
  merged: '#b48ead',
  promptBorder: '#4c566a',
  promptBackground: '#242b36',
  planMode: '#8fbcbb',
  autoAccept: '#b48ead',
  bashBorder: '#8fbcbb',
  ide: '#81a1c1',
  fastMode: '#ebcb8b',
  diffAdded: '#2a3a2e',
  diffRemoved: '#3a2228',
  diffAddedDimmed: '#1e2e22',
  diffRemovedDimmed: '#2e1d22',
  diffAddedWord: '#a3be8c',
  diffRemovedWord: '#bf616a',
  userMessageBackground: '#212731',
  bashMessageBackgroundColor: '#1e232b',
  memoryBackgroundColor: '#1e2835',
  selectionBg: '#3e5068',
  rateLimitFill: '#b48ead',
  rateLimitEmpty: '#353c4b',
  briefLabelYou: '#81a1c1',
  briefLabelAgent: '#88c0d0',
  accentShimmer: '#a4d8e2',
  warningShimmer: '#f5dba0',
  permissionShimmer: '#c9a8d8',
  toolShimmer: '#a4d8e2',
  subagent1: '#bf616a',
  subagent2: '#5e81ac',
  subagent3: '#a3be8c',
  subagent4: '#ebcb8b',
  subagent5: '#b48ead',
  subagent6: '#d08770',
  subagent7: '#d06f8c',
  subagent8: '#8fbcbb',
  rainbowRed: '#bf616a',
  rainbowOrange: '#d08770',
  rainbowYellow: '#ebcb8b',
  rainbowGreen: '#a3be8c',
  rainbowCyan: '#88c0d0',
  rainbowBlue: '#81a1c1',
  rainbowViolet: '#b48ead',
  primary: '#88c0d0',
  primarySoft: '#a4d8e2',
  border: '#434c5e',
};

export const NORD_DARK_THEME: CliTheme = {
  name: 'Nord Dark',
  type: 'dark',
  tokens: NORD_DARK_TOKENS,
};




export const SOLARIZED_DARK_TOKENS: CliThemeTokens = {
  accent: '#268bd2',
  text: '#839496',
  textSecondary: '#657b83',
  textMuted: '#586e75',
  textDim: '#42535b',
  inverseText: '#002b36',
  inactive: '#586e75',
  subtle: '#073642',
  suggestion: '#6c71c4',
  user: '#268bd2',
  tool: '#2aa198',
  permission: '#6c71c4',
  success: '#859900',
  error: '#dc322f',
  warning: '#b58900',
  merged: '#6c71c4',
  promptBorder: '#586e75',
  promptBackground: '#0a2e38',
  planMode: '#2aa198',
  autoAccept: '#6c71c4',
  bashBorder: '#2aa198',
  ide: '#268bd2',
  fastMode: '#b58900',
  diffAdded: '#1e3620',
  diffRemoved: '#2e1a1c',
  diffAddedDimmed: '#172b18',
  diffRemovedDimmed: '#251518',
  diffAddedWord: '#859900',
  diffRemovedWord: '#dc322f',
  userMessageBackground: '#00212b',
  bashMessageBackgroundColor: '#001e26',
  memoryBackgroundColor: '#00212e',
  selectionBg: '#1a4560',
  rateLimitFill: '#6c71c4',
  rateLimitEmpty: '#1a3340',
  briefLabelYou: '#268bd2',
  briefLabelAgent: '#2aa198',
  accentShimmer: '#54a8e8',
  warningShimmer: '#d0a010',
  permissionShimmer: '#8e91d8',
  toolShimmer: '#48c0b8',
  subagent1: '#dc322f',
  subagent2: '#268bd2',
  subagent3: '#859900',
  subagent4: '#b58900',
  subagent5: '#6c71c4',
  subagent6: '#cb4b16',
  subagent7: '#d33682',
  subagent8: '#2aa198',
  rainbowRed: '#dc322f',
  rainbowOrange: '#cb4b16',
  rainbowYellow: '#b58900',
  rainbowGreen: '#859900',
  rainbowCyan: '#2aa198',
  rainbowBlue: '#268bd2',
  rainbowViolet: '#6c71c4',
  primary: '#268bd2',
  primarySoft: '#54a8e8',
  border: '#1a495c',
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
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!raw) return null;
  if (/(light|day|paper|white|latte)/.test(raw)) return 'light';
  if (/(dark|night|black|pro|mocha)/.test(raw)) return 'dark';
  return null;
}

export function resolveTerminalThemeMode(env: NodeJS.ProcessEnv = process.env): CliThemeMode {
  return (
    forcedThemeMode(env) ??
    modeFromColorFgBg(env.COLORFGBG) ??
    modeFromNamedEnvironment(env) ??
    'dark'
  );
}

export function resolveThemeTokens(env: NodeJS.ProcessEnv = process.env): CliThemeTokens {
  return resolveTerminalThemeMode(env) === 'light' ? AURORA_LIGHT_TOKENS : AURORA_DARK_TOKENS;
}





export function resolveForcedThemeMode(env: NodeJS.ProcessEnv = process.env): CliThemeMode | null {
  return forcedThemeMode(env);
}






const RESOLVED_TOKENS = resolveThemeTokens();

export const legacyTheme = {
  ...RESOLVED_TOKENS,
  warn: RESOLVED_TOKENS.warning,
  // `text` is correctly resolved from RESOLVED_TOKENS above — do NOT override
  // it with a hardcoded value. The old '#2a2a2a' was a near-invisible dark gray
  // that slipped in as dead code in the common path (always overwritten by
  // applyTerminalThemeMode) but became a latent bug in the forced-theme path
  // where applyTerminalThemeMode is skipped.
};










export function applyTerminalThemeMode(mode: CliThemeMode): void {
  const tokens = mode === 'light' ? AURORA_LIGHT_TOKENS : AURORA_DARK_TOKENS;
  Object.assign(legacyTheme, tokens, { warn: tokens.warning });
}

const BUILTIN_THEMES: CliTheme[] = [
  AURORA_DARK_THEME,
  AURORA_LIGHT_THEME,
  NORD_DARK_THEME,
  SOLARIZED_DARK_THEME,
];

export function getBuiltinThemes(): CliTheme[] {
  return BUILTIN_THEMES;
}
export function getDefaultTheme(): CliTheme {
  return AURORA_DARK_THEME;
}

export function resolveThemeByName(name: string): CliTheme | null {
  const normalized = name.trim().toLowerCase();
  return BUILTIN_THEMES.find((t) => t.name.toLowerCase() === normalized) ?? null;
}

export function listThemeNames(): string[] {
  return BUILTIN_THEMES.map((t) => t.name);
}

export function resolveTheme(base: CliTheme, overrides: Partial<CliThemeTokens>): CliTheme {
  return { ...base, tokens: { ...base.tokens, ...overrides } };
}






export function resolveThemeTokensByName(env: NodeJS.ProcessEnv = process.env): CliThemeTokens {
  const raw = `${env.MOSS_TUI_THEME ?? env.MOSS_THEME ?? ''}`.trim();
  if (raw && raw.toLowerCase() !== 'auto') {
    const theme = resolveThemeByName(raw);
    if (theme) return theme.tokens;
  }
  return resolveThemeTokens(env);
}
