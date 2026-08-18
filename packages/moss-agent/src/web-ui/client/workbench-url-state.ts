import { useEffect } from 'react';

import { updateSessionPreference } from './workbench-preferences.js';
import type { SettingsSection, WorkbenchPreferences } from './workbench-types.js';

const SETTINGS = new Set<SettingsSection>([
  'general',
  'models',
  'permissions',
  'skills',
  'mcp',
  'plugins',
  'runtime',
]);
const DETAIL_TABS = new Set(['overview', 'plan', 'activity', 'evidence']);

export interface WorkbenchUrlInitialState {
  readonly preferences: WorkbenchPreferences;
  readonly executionId?: string;
}

export function readWorkbenchUrlState(base: WorkbenchPreferences): WorkbenchUrlInitialState {
  const params = new URLSearchParams(window.location.search);
  const workspaceId = params.get('workspace') ?? base.workspaceId;
  const sessionId = params.get('session') ?? base.sessionId;
  const settings = params.get('settings');
  let preferences: WorkbenchPreferences = {
    ...base,
    ...(workspaceId ? { workspaceId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(settings && SETTINGS.has(settings as SettingsSection)
      ? { settingsSection: settings as SettingsSection }
      : {}),
  };
  const details = params.get('details');
  const detailTab = params.get('detailTab');
  if (sessionId && (details || detailTab)) {
    preferences = updateSessionPreference(preferences, sessionId, {
      ...(details ? { detailsOpen: details === 'open' } : {}),
      ...(detailTab && DETAIL_TABS.has(detailTab) ? { selectedPanel: detailTab } : {}),
    });
  }
  return {
    preferences,
    executionId: params.get('case') ?? params.get('task') ?? undefined,
  };
}

export function writeWorkbenchUrlState(input: {
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly detailsOpen: boolean;
  readonly detailTab: string;
  readonly settings: SettingsSection;
}): void {
  const url = new URL(window.location.href);
  const set = (key: string, value?: string) => {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  };
  set('workspace', input.workspaceId);
  set('session', input.sessionId);
  set('case', input.executionId);
  set('task', input.executionId);
  set('details', input.detailsOpen ? 'open' : 'closed');
  set('detailTab', input.detailTab);
  set('settings', input.settings);
  window.history.replaceState(null, '', url);
}

export function useWorkbenchUrlSync(input: Parameters<typeof writeWorkbenchUrlState>[0]): void {
  useEffect(
    () => writeWorkbenchUrlState(input),
    [
      input.detailsOpen,
      input.detailTab,
      input.executionId,
      input.sessionId,
      input.settings,
      input.workspaceId,
    ]
  );
}
