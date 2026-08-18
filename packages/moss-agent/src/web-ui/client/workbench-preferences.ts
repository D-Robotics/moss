import type { SessionPreference, WorkbenchPreferences } from './workbench-types.js';

const STORAGE_KEY = 'moss-workbench-v2';
const fallback: WorkbenchPreferences = {
  mode: 'default',
  permissionPreset: 'balanced',
  settingsSection: 'general',
  sessions: {},
};
const sessionFallback: SessionPreference = {
  draft: '',
  scrollTop: 0,
  detailsOpen: true,
  selectedPanel: 'overview',
  delivery: 'queue',
};

export const loadPreferences = (): WorkbenchPreferences => {
  try {
    const value = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? 'null'
    ) as Partial<WorkbenchPreferences> | null;
    return value ? { ...fallback, ...value, sessions: value.sessions ?? {} } : fallback;
  } catch {
    return fallback;
  }
};

export const savePreferences = (value: WorkbenchPreferences): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
};

export const sessionPreference = (
  value: WorkbenchPreferences,
  sessionId?: string
): SessionPreference =>
  sessionId ? { ...sessionFallback, ...value.sessions[sessionId] } : sessionFallback;

export const updateSessionPreference = (
  value: WorkbenchPreferences,
  sessionId: string,
  patch: Partial<SessionPreference>
): WorkbenchPreferences => ({
  ...value,
  sessions: {
    ...value.sessions,
    [sessionId]: { ...sessionFallback, ...value.sessions[sessionId], ...patch },
  },
});
