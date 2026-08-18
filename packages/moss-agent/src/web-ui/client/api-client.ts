import type {
  BootstrapResponse,
  GoalSnapshot,
  ExecutionGraphSnapshot,
  ExecutionView,
  Interaction,
  JobSnapshot,
  MentionInventory,
  PluginInventory,
  PluginConfigResponse,
  RuntimeInventory,
  RuntimeMode,
  SessionSummary,
  SettingsSection,
  SettingsSnapshot,
  StreamEvent,
  TimelineItem,
  TodoSnapshot,
  WorkspaceSummary,
  WorkflowSnapshot,
} from './workbench-types.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

let csrfToken = '';

export const jsonRequest = async <T>(url: string, options?: RequestInit): Promise<T> => {
  const method = options?.method?.toUpperCase() ?? 'GET';
  const headers = new Headers(options?.headers);
  if (method !== 'GET' && method !== 'HEAD') {
    if (!csrfToken) throw new ApiError(403, 'Moss Web security token is not ready');
    headers.set('x-moss-csrf', csrfToken);
  }
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, body.error ?? `HTTP ${response.status}`);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
};

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const sid = (id: string) => encodeURIComponent(id);

const authorizedStreamRequest = async (url: string, signal?: AbortSignal): Promise<Response> => {
  if (!csrfToken) throw new ApiError(403, 'Moss Web security token is not ready');
  return fetch(url, {
    method: 'POST',
    headers: { 'x-moss-csrf': csrfToken },
    signal,
  });
};

export const api = {
  bootstrap: async () => {
    const response = await jsonRequest<BootstrapResponse>('/api/bootstrap');
    csrfToken = response.csrfToken;
    return response;
  },
  uploadAttachment: (filename: string, mimeType: string, contentBase64: string) =>
    jsonRequest<{
      attachment: {
        id: string;
        filename: string;
        mimeType: string;
        kind: 'text' | 'image';
        size: number;
        downloadUrl: string;
      };
    }>('/api/attachments', json('POST', { filename, mimeType, contentBase64 })),
  deleteAttachment: (id: string) => jsonRequest(`/api/attachments/${sid(id)}`, json('DELETE')),
  createArtifact: (workspaceRelativePath: string) =>
    jsonRequest<{ attachment: { id: string; filename: string; downloadUrl: string } }>(
      '/api/artifacts',
      json('POST', { workspaceRelativePath })
    ),
  plugins: () => jsonRequest<PluginInventory>('/api/plugins'),
  addPlugin: (source: string) =>
    jsonRequest<{ plugin: { id: string }; generation: number }>(
      '/api/plugins/add',
      json('POST', { source })
    ),
  doctorPlugins: () =>
    jsonRequest<{
      results: Array<{
        id?: string;
        pluginId?: string;
        status?: string;
        ok?: boolean;
        message?: string;
      }>;
      generation: number;
    }>('/api/plugins/doctor', json('POST')),
  pluginConfig: (id: string) => jsonRequest<PluginConfigResponse>(`/api/plugins/${sid(id)}/config`),
  savePluginConfig: (id: string, values: Record<string, unknown>) =>
    jsonRequest<PluginConfigResponse>(`/api/plugins/${sid(id)}/config`, json('PUT', { values })),
  putPluginSecret: (id: string, name: string, value: string) =>
    jsonRequest<PluginConfigResponse>(
      `/api/plugins/${sid(id)}/config/secrets/${sid(name)}`,
      json('PUT', { value })
    ),
  deletePluginSecret: (id: string, name: string) =>
    jsonRequest<PluginConfigResponse>(
      `/api/plugins/${sid(id)}/config/secrets/${sid(name)}`,
      json('DELETE')
    ),
  workspaces: () => jsonRequest<{ workspaces: WorkspaceSummary[] }>('/api/workspaces'),
  workspaceTree: (relativePath = '.') =>
    jsonRequest<{
      path: string;
      entries: Array<{ name: string; path: string; kind: 'directory' | 'file' | 'other' }>;
      truncated: boolean;
    }>(`/api/workspace/tree?path=${encodeURIComponent(relativePath)}`),
  workspaceFile: (relativePath: string) =>
    jsonRequest<{ path: string; content: string; size: number }>(
      `/api/workspace/file?path=${encodeURIComponent(relativePath)}`
    ),
  workspaceChanges: () =>
    jsonRequest<{ status: string; diffStat: string }>('/api/workspace/changes'),
  sessions: () => jsonRequest<{ sessions: SessionSummary[] }>('/api/sessions'),
  search: (query: string) =>
    jsonRequest<{ hits: SessionSummary[] }>(`/api/sessions/search?q=${encodeURIComponent(query)}`),
  messages: (id: string) =>
    jsonRequest<{ items: TimelineItem[] }>(`/api/sessions/${sid(id)}/messages`),
  createSession: (workspaceId = 'current') =>
    jsonRequest<{ sessionId: string }>('/api/sessions', json('POST', { workspaceId })),
  rename: (id: string, title: string) =>
    jsonRequest(`/api/sessions/${sid(id)}`, json('PATCH', { title })),
  delete: (id: string, confirmation: string) =>
    jsonRequest(`/api/sessions/${sid(id)}`, json('DELETE', { confirmation })),
  fork: (id: string) =>
    jsonRequest<{ session: SessionSummary }>(`/api/sessions/${sid(id)}/fork`, json('POST')),
  rewind: (id: string, messageCount: number) =>
    jsonRequest<{ session: SessionSummary }>(
      `/api/sessions/${sid(id)}/rewind`,
      json('POST', { messageCount })
    ),
  activeRun: (id: string) =>
    jsonRequest<{ run: { id: string }; cursor: number; eventsUrl: string }>(
      `/api/sessions/${sid(id)}/active-run`
    ),
  interactions: () => jsonRequest<{ interactions: Interaction[] }>('/api/interactions'),
  resolveInteraction: (id: string, answer: string) =>
    jsonRequest(`/api/interactions/${sid(id)}/resolve`, json('POST', { answer })),
  cancelInteraction: (id: string) =>
    jsonRequest(`/api/interactions/${sid(id)}/cancel`, json('POST')),
  runtimeMode: () => jsonRequest<{ mode: RuntimeMode }>('/api/runtime/mode'),
  setRuntimeMode: (mode: RuntimeMode) =>
    jsonRequest<{ mode: RuntimeMode }>('/api/runtime/mode', json('PUT', { mode })),
  setPermissionPreset: (profile: 'cautious' | 'balanced' | 'autonomous') =>
    jsonRequest('/api/runtime/permission-preset', json('PUT', { profile })),
  runtimeInventory: () => jsonRequest<RuntimeInventory>('/api/runtime/inventory'),
  mentions: () => jsonRequest<MentionInventory>('/api/runtime/mentions'),
  inbox: (id: string) => jsonRequest<{ items?: unknown[] }>(`/api/sessions/${sid(id)}/inbox`),
  deliver: (id: string, prompt: string, delivery: 'queue' | 'steer') =>
    jsonRequest(`/api/sessions/${sid(id)}/inbox`, json('POST', { prompt, delivery })),
  steer: (id: string, prompt: string) =>
    jsonRequest(`/api/sessions/${sid(id)}/steer`, json('POST', { prompt })),
  goal: (id: string) => jsonRequest<{ goal: GoalSnapshot }>(`/api/sessions/${sid(id)}/goal`),
  updateGoal: (id: string, body: Record<string, unknown>) =>
    jsonRequest<{ goal: GoalSnapshot }>(`/api/sessions/${sid(id)}/goal`, json('PUT', body)),
  todos: (id: string) => jsonRequest<{ todos: TodoSnapshot[] }>(`/api/sessions/${sid(id)}/todos`),
  command: (id: string, command: string) =>
    jsonRequest(`/api/sessions/${sid(id)}/commands`, json('POST', { command })),
  jobs: () => jsonRequest<{ jobs: JobSnapshot[] }>('/api/jobs'),
  tasks: () => jsonRequest<{ tasks: ExecutionGraphSnapshot[] }>('/api/tasks'),
  executions: (sessionId?: string) =>
    jsonRequest<{ executions: ExecutionView[] }>(
      `/api/executions${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`
    ),
  execution: (id: string) =>
    jsonRequest<{ execution: ExecutionView }>(`/api/executions/${sid(id)}`),
  executeAction: (id: string, expectedRevision: number, action: Record<string, unknown>) =>
    jsonRequest<{ execution: ExecutionView }>(
      `/api/executions/${sid(id)}/actions`,
      json('POST', { expectedRevision, action })
    ),
  runExecution: (id: string, signal?: AbortSignal) =>
    authorizedStreamRequest(`/api/executions/${sid(id)}/run`, signal),
  task: (id: string) => jsonRequest<{ task: ExecutionGraphSnapshot }>(`/api/tasks/${sid(id)}`),
  controlTask: (id: string, action: 'resume' | 'retry' | 'stop', nodeId?: string) =>
    jsonRequest<{ task: ExecutionGraphSnapshot }>(
      `/api/tasks/${sid(id)}/${action}`,
      json('POST', nodeId ? { nodeId } : {})
    ),
  stopJob: (id: string) => jsonRequest(`/api/jobs/${sid(id)}/stop`, json('POST')),
  workflows: () => jsonRequest<{ workflows: WorkflowSnapshot[] }>('/api/workflows'),
  runWorkflow: (id: string, sessionId: string, args = '') =>
    jsonRequest(`/api/workflows/${sid(id)}/run`, json('POST', { sessionId, args })),
  trajectory: (runId: string) => jsonRequest<unknown>(`/api/runs/${sid(runId)}/trajectory`),
  verdict: (runId: string) => jsonRequest<unknown>(`/api/runs/${sid(runId)}/verdict`),
  settings: (section: SettingsSection) => jsonRequest<SettingsSnapshot>(`/api/settings/${section}`),
  validateSettings: (section: SettingsSection, values: Record<string, unknown>) =>
    jsonRequest<{ valid: boolean; errors?: Record<string, string> }>(
      `/api/settings/${section}/validate`,
      json('POST', { values })
    ),
  saveSettings: (section: SettingsSection, values: Record<string, unknown>) =>
    jsonRequest(`/api/settings/${section}`, json('PUT', { values })),
  models: () =>
    jsonRequest<{
      choices?: Array<{ id?: string; model?: string; displayName?: string }>;
      models?: string[];
    }>('/api/settings/models/catalog'),
  selectModel: (model: string) =>
    jsonRequest('/api/settings/models/selection', json('PUT', { model })),
  setApiKey: (value: string) =>
    jsonRequest('/api/settings/credentials/apiKey', json('PUT', { value })),
  deleteApiKey: () => jsonRequest('/api/settings/credentials/apiKey', json('DELETE')),
  cancelSession: (id: string) => jsonRequest(`/api/sessions/${sid(id)}/cancel`, json('POST')),
  mutatePlugin: (id: string, action: 'enable' | 'disable' | 'remove') =>
    jsonRequest(`/api/plugins/${sid(id)}/${action}`, json('POST')),
  sendMessage: (id: string, prompt: string, attachmentIds: string[], signal: AbortSignal) => {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (!csrfToken) throw new ApiError(403, 'Moss Web security token is not ready');
    headers.set('x-moss-csrf', csrfToken);
    return fetch(`/api/sessions/${sid(id)}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt, attachmentIds }),
      signal,
    });
  },
};

export const connectRunEvents = (
  runId: string,
  after: number,
  onEvent: (event: StreamEvent, cursor: number) => void,
  onState: (connected: boolean) => void
): (() => void) => {
  let cursor = after;
  let source: EventSource | undefined;
  let stopped = false;
  let retryTimer: number | undefined;
  const connect = () => {
    if (stopped) return;
    source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?after=${cursor}`);
    source.onopen = () => onState(true);
    const handleMessage = (message: MessageEvent<string>) => {
      const record = JSON.parse(message.data) as { seq: number; event: StreamEvent };
      const lastEventId = Number(message.lastEventId);
      cursor = Number.isSafeInteger(lastEventId) && lastEventId > 0 ? lastEventId : record.seq;
      onEvent(record.event, cursor);
      if (record.event.type === 'done' || record.event.type === 'interrupted') {
        stopped = true;
        source?.close();
      }
    };
    for (const type of [
      'run',
      'text',
      'thought',
      'tool',
      'retry',
      'compaction',
      'usage',
      'context',
      'interrupted',
      'done',
    ])
      source.addEventListener(type, handleMessage as EventListener);
    source.addEventListener('error', (event) => {
      if (event instanceof MessageEvent && typeof event.data === 'string' && event.data) {
        handleMessage(event);
        return;
      }
      if (stopped) return;
      onState(false);
      source?.close();
      retryTimer = window.setTimeout(connect, 850);
    });
  };
  connect();
  return () => {
    stopped = true;
    if (retryTimer) window.clearTimeout(retryTimer);
    source?.close();
  };
};

export const connectPluginComposition = (
  onComposition: () => void,
  onState: (connected: boolean) => void
): (() => void) => {
  const source = new EventSource('/api/plugins/events');
  source.onopen = () => onState(true);
  source.addEventListener('composition', () => onComposition());
  source.onerror = () => onState(false);
  return () => source.close();
};
