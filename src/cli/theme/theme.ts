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

export const AURORA_DARK_TOKENS: CliThemeTokens = {
  accent: '#d4622a',
  text: '#d4d4d4',
  textSecondary: '#b0b0b0',
  textMuted: '#9a9a9a', // was #888888 — bumped for readability
  textDim: '#808080', // was #666666 — bumped for readability on dark bg
  inverseText: '#ffffff',
  inactive: '#888888', // was #777777
  subtle: '#666666', // was #555555
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
