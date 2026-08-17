import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './workbench.css';

type RunStatus = 'created' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

interface PluginSnapshot {
  id: string;
  state: string;
  tools: string[];
  webContributions?: string[];
}

interface InstalledPlugin {
  id: string;
  version: string;
  enabled: boolean;
}

interface PluginInventory {
  installed: InstalledPlugin[];
  active: PluginSnapshot[];
  contributions: Array<{
    pluginId: string;
    id: string;
    slot: string;
    moduleUrl: string;
  }>;
}

interface RunSnapshot {
  id: string;
  sessionId: string;
  title: string;
  status: RunStatus;
  verification: string;
  evidenceCount: number;
  updatedAt: number;
}

interface SessionSummary {
  sessionId: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  runId?: string;
  runStatus?: RunStatus;
}

interface BootstrapResponse {
  tools: string[];
  plugins: PluginSnapshot[];
  taskRuns: RunSnapshot[];
  model: string;
}

type TimelineItem =
  | { id: string; kind: 'user' | 'assistant' | 'reasoning' | 'status'; text: string }
  | {
      id: string;
      kind: 'tool';
      name: string;
      state: 'running' | 'complete' | 'failed';
      input?: unknown;
      result?: unknown;
    };

interface StreamEvent {
  type: 'run' | 'text' | 'thought' | 'tool' | 'done' | 'error';
  delta?: string;
  state?: 'start' | 'end';
  toolCallId?: string;
  name?: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: string;
  run?: RunSnapshot;
}

const jsonRequest = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
};

const Icon = ({ name }: { name: 'plus' | 'search' | 'settings' | 'panel' | 'stop' }) => {
  const paths: Record<typeof name, string> = {
    plus: 'M12 5v14M5 12h14',
    search: 'm21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
    settings:
      'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-3.5.1-1.5 2-1.5-2-3.5-2.5 1a8 8 0 0 0-2.6-1.5L14 2h-4l-.4 3A8 8 0 0 0 7 6.5l-2.5-1-2 3.5 2 1.5-.1 3-2 1.5 2 3.5 2.6-1a8 8 0 0 0 2.6 1.5l.4 3h4l.4-3a8 8 0 0 0 2.6-1.5l2.5 1 2-3.5-2-1.5.1-1.5Z',
    panel: 'M4 5h16v14H4zM15 5v14',
    stop: 'M8 8h8v8H8z',
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d={paths[name]} />
    </svg>
  );
};

const EmptyConversation = ({ onPrompt }: { onPrompt(prompt: string): void }) => (
  <section className="empty-conversation">
    <div className="moss-glyph" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
    <p className="overline">MOSS WORKBENCH</p>
    <h1>What are we building?</h1>
    <p className="empty-copy">
      Give Moss a concrete outcome. The workbench keeps plans, tools, evidence, and deliverables in
      one continuous thread.
    </p>
    <div className="starter-grid">
      {[
        ['Inspect the repository', 'Find the highest-impact improvement and prove it.'],
        ['Review current changes', 'Check correctness, safety, and missing tests.'],
        ['Map the architecture', 'Explain boundaries and recommend the next move.'],
      ].map(([title, prompt]) => (
        <button key={title} className="starter-card" onClick={() => onPrompt(prompt)}>
          <span>{title}</span>
          <small>{prompt}</small>
        </button>
      ))}
    </div>
  </section>
);

const Timeline = ({
  items,
  onSelectTool,
  contributions,
}: {
  items: TimelineItem[];
  onSelectTool(item: Extract<TimelineItem, { kind: 'tool' }>): void;
  contributions: PluginInventory['contributions'];
}) => {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [items]);
  return (
    <section className="timeline" aria-live="polite" aria-relevant="additions text">
      {items.map((item) => {
        if (item.kind === 'tool') {
          return (
            <button
              className={`tool-row tool-${item.state}`}
              key={item.id}
              onClick={() => onSelectTool(item)}
            >
              <span className="tool-state" />
              <span className="tool-copy">
                <strong>{item.name}</strong>
                <small>{item.state === 'running' ? 'Running tool' : item.state}</small>
              </span>
              <span className="tool-arrow">›</span>
            </button>
          );
        }
        if (item.kind === 'reasoning') {
          return (
            <details className="reasoning-row" key={item.id}>
              <summary>Thought process</summary>
              <p>{item.text}</p>
            </details>
          );
        }
        return (
          <article className={`message message-${item.kind}`} key={item.id}>
            {item.kind !== 'status' && (
              <div className="message-author">{item.kind === 'user' ? 'You' : 'Moss'}</div>
            )}
            <div>{item.text || <span className="stream-caret" />}</div>
          </article>
        );
      })}
      <PluginSlot slot="conversation.message" contributions={contributions} />
      <PluginSlot slot="tool.inline" contributions={contributions} />
      <div ref={endRef} />
    </section>
  );
};

const PluginSlot = ({
  slot,
  contributions,
}: {
  slot: string;
  contributions: PluginInventory['contributions'];
}) => {
  const refs = useRef(new Map<string, HTMLDivElement>());
  const matching = useMemo(
    () => contributions.filter((contribution) => contribution.slot === slot),
    [contributions, slot]
  );
  useEffect(() => {
    const disposers: Array<() => void | Promise<void>> = [];
    let cancelled = false;
    for (const contribution of matching) {
      const contributionKey = `${contribution.pluginId}:${contribution.id}`;
      const host = refs.current.get(contributionKey);
      if (!host) continue;
      const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
      void import(/* @vite-ignore */ contribution.moduleUrl)
        .then(async (module: { default?: unknown; mount?: unknown }) => {
          if (cancelled) return;
          const candidate = module.default ?? module;
          const mount =
            candidate && typeof candidate === 'object' && 'mount' in candidate
              ? (candidate as { mount?: unknown }).mount
              : module.mount;
          if (typeof mount !== 'function') throw new Error('plugin Web module requires mount()');
          const dispose = await mount(root, {
            pluginId: contribution.pluginId,
            contributionId: contribution.id,
            slot: contribution.slot,
          });
          if (typeof dispose === 'function') {
            const ownedDispose = dispose as () => void | Promise<void>;
            if (cancelled) await ownedDispose();
            else disposers.push(ownedDispose);
          }
        })
        .catch(() => {
          if (!cancelled) root.textContent = 'Plugin UI failed to load.';
        });
    }
    return () => {
      cancelled = true;
      void (async () => {
        for (const dispose of disposers.reverse()) {
          try {
            await dispose();
          } catch {}
        }
      })();
    };
  }, [matching]);
  if (matching.length === 0) return null;
  return (
    <div className="plugin-slot" data-moss-slot={slot}>
      {matching.map((contribution) => (
        <div
          key={`${contribution.pluginId}:${contribution.id}`}
          ref={(node) => {
            const contributionKey = `${contribution.pluginId}:${contribution.id}`;
            if (node) refs.current.set(contributionKey, node);
            else refs.current.delete(contributionKey);
          }}
        />
      ))}
    </div>
  );
};

const Workbench = () => {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [prompt, setPrompt] = useState('');
  const [query, setQuery] = useState('');
  const [running, setRunning] = useState(false);
  const [online, setOnline] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'runtime' | 'models' | 'permissions' | 'plugins'>(
    'runtime'
  );
  const [pluginInventory, setPluginInventory] = useState<PluginInventory>({
    installed: [],
    active: [],
    contributions: [],
  });
  const [settingsNotice, setSettingsNotice] = useState('');
  const [selectedTool, setSelectedTool] = useState<Extract<TimelineItem, { kind: 'tool' }>>();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const controllerRef = useRef<AbortController | undefined>(undefined);

  const refresh = async () => {
    const [nextBootstrap, nextSessions, nextPlugins] = await Promise.all([
      jsonRequest<BootstrapResponse>('/api/bootstrap'),
      jsonRequest<{ sessions: SessionSummary[] }>('/api/sessions'),
      jsonRequest<PluginInventory>('/api/plugins'),
    ]);
    setBootstrap(nextBootstrap);
    setSessions(nextSessions.sessions);
    setPluginInventory(nextPlugins);
    setOnline(true);
  };

  useEffect(() => {
    void refresh().catch(() => setOnline(false));
    const onlineListener = () => void refresh().catch(() => setOnline(false));
    const offlineListener = () => setOnline(false);
    window.addEventListener('online', onlineListener);
    window.addEventListener('offline', offlineListener);
    return () => {
      window.removeEventListener('online', onlineListener);
      window.removeEventListener('offline', offlineListener);
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const filteredSessions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? sessions.filter((session) => session.title.toLowerCase().includes(normalized))
      : sessions;
  }, [query, sessions]);

  const createSession = async () => {
    const created = await jsonRequest<{ sessionId: string }>('/api/sessions', { method: 'POST' });
    setSessionId(created.sessionId);
    setItems([]);
    setSettingsOpen(false);
    setSelectedTool(undefined);
  };

  const openSession = async (session: SessionSummary) => {
    setSessionId(session.sessionId);
    setSettingsOpen(false);
    setSelectedTool(undefined);
    const history = await jsonRequest<{ items: TimelineItem[] }>(
      `/api/sessions/${encodeURIComponent(session.sessionId)}/messages`
    );
    setItems(history.items);
  };

  const appendText = (kind: 'assistant' | 'reasoning', delta: string) => {
    setItems((current) => {
      const last = current.at(-1);
      if (last?.kind === kind)
        return [...current.slice(0, -1), { ...last, text: last.text + delta }];
      return [...current, { id: crypto.randomUUID(), kind, text: delta }];
    });
  };

  const applyStreamEvent = (event: StreamEvent) => {
    if (event.type === 'text' && event.delta) appendText('assistant', event.delta);
    if (event.type === 'thought' && event.delta) appendText('reasoning', event.delta);
    if (event.type === 'tool' && event.toolCallId && event.name) {
      setItems((current) => {
        const existing = current.find(
          (item): item is Extract<TimelineItem, { kind: 'tool' }> =>
            item.kind === 'tool' && item.id === event.toolCallId
        );
        const next: Extract<TimelineItem, { kind: 'tool' }> = {
          id: event.toolCallId!,
          kind: 'tool',
          name: event.name!,
          state: event.state === 'end' ? (event.isError ? 'failed' : 'complete') : 'running',
          input: existing?.input ?? event.input,
          result: event.result,
        };
        return existing
          ? current.map((item) => (item.id === event.toolCallId ? next : item))
          : [...current, next];
      });
    }
    if (event.type === 'error')
      setItems((current) => [
        ...current,
        { id: crypto.randomUUID(), kind: 'status', text: event.message ?? 'Task failed' },
      ]);
  };

  const send = async () => {
    const text = prompt.trim();
    if (!text || running) return;
    let activeSession = sessionId;
    if (!activeSession) {
      const created = await jsonRequest<{ sessionId: string }>('/api/sessions', { method: 'POST' });
      activeSession = created.sessionId;
      setSessionId(activeSession);
    }
    setPrompt('');
    setItems((current) => [...current, { id: crypto.randomUUID(), kind: 'user', text }]);
    setRunning(true);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(activeSession)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: text }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) if (line) applyStreamEvent(JSON.parse(line) as StreamEvent);
      }
      await refresh();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setOnline(false);
        setItems((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            kind: 'status',
            text: 'Connection interrupted. Your run remains recorded.',
          },
        ]);
      }
    } finally {
      setRunning(false);
      controllerRef.current = undefined;
    }
  };

  const stop = async () => {
    controllerRef.current?.abort();
    if (sessionId)
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST' });
    setRunning(false);
  };

  const statusLabel = running ? 'Moss is working' : online ? 'Ready' : 'Reconnecting';

  const mutatePlugin = async (pluginId: string, action: 'enable' | 'disable' | 'remove') => {
    try {
      await jsonRequest(`/api/plugins/${encodeURIComponent(pluginId)}/${action}`, {
        method: 'POST',
      });
      setSettingsNotice('Saved. Restart Moss to apply the new plugin composition.');
      await refresh();
    } catch {
      setSettingsNotice('Plugin change failed. Check the runtime log and try again.');
    }
  };

  return (
    <main className={`app-frame ${detailsOpen ? '' : 'details-collapsed'}`}>
      <aside className="sidebar">
        <header className="brand-row">
          <div className="brand-mark">M</div>
          <div>
            <strong>Moss</strong>
            <span>Agent workspace</span>
          </div>
        </header>
        <button className="new-task" onClick={() => void createSession()}>
          <Icon name="plus" /> New task <kbd>⌘K</kbd>
        </button>
        <PluginSlot slot="navigation.primary" contributions={pluginInventory.contributions} />
        <label className="session-search">
          <Icon name="search" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tasks"
          />
        </label>
        <div className="section-label">Recent</div>
        <nav className="session-list" aria-label="Recent tasks">
          {filteredSessions.map((session) => (
            <button
              className={session.sessionId === sessionId ? 'active' : ''}
              key={session.sessionId}
              onClick={() => void openSession(session)}
            >
              <span>{session.title}</span>
              <small>{session.runStatus ?? `${session.messageCount} messages`}</small>
            </button>
          ))}
          {bootstrap && filteredSessions.length === 0 && (
            <p className="no-sessions">No matching tasks.</p>
          )}
        </nav>
        <footer className="sidebar-footer">
          <PluginSlot slot="navigation.footer" contributions={pluginInventory.contributions} />
          <button onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" /> Settings
          </button>
          <div className="runtime-state" role="status" aria-live="polite">
            <span className={online ? 'online' : 'offline'} />
            <div>
              <strong>Local runtime</strong>
              <small>{statusLabel}</small>
            </div>
          </div>
        </footer>
      </aside>

      <section className="conversation-column">
        <header className="conversation-header">
          <div>
            <p className="overline">LOCAL WORKSPACE</p>
            <h2>
              {settingsOpen
                ? 'Settings'
                : (sessions.find((session) => session.sessionId === sessionId)?.title ??
                  'New task')}
            </h2>
          </div>
          <div className="header-actions">
            <button className="model-pill">{bootstrap?.model ?? 'Connecting…'}</button>
            <button
              className="icon-button"
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
              aria-label="Toggle theme"
            >
              {theme === 'light' ? '◐' : '◑'}
            </button>
            <button
              className="icon-button"
              onClick={() => setDetailsOpen(!detailsOpen)}
              aria-label="Toggle details panel"
            >
              <Icon name="panel" />
            </button>
          </div>
          <PluginSlot slot="conversation.header" contributions={pluginInventory.contributions} />
        </header>

        {!online && (
          <div className="connection-banner" role="alert">
            Connection lost. Durable history remains safe while Moss reconnects.
          </div>
        )}

        {settingsOpen ? (
          <section className="settings-view">
            <div className="settings-tabs">
              {(['runtime', 'models', 'permissions', 'plugins'] as const).map((tab) => (
                <button
                  className={settingsTab === tab ? 'active' : ''}
                  key={tab}
                  onClick={() => setSettingsTab(tab)}
                >
                  {tab[0].toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
            <div className="settings-section">
              <PluginSlot slot="settings.section" contributions={pluginInventory.contributions} />
              {settingsTab === 'runtime' && (
                <>
                  <p className="overline">RUNTIME COMPOSITION</p>
                  <h3>Capabilities available to this workspace</h3>
                  <p>
                    Everything shown here comes from the live Moss runtime. Provider credentials
                    never leave the process.
                  </p>
                  <div className="inventory-grid">
                    <article>
                      <strong>{bootstrap?.tools.length ?? 0}</strong>
                      <span>Tools</span>
                    </article>
                    <article>
                      <strong>{bootstrap?.plugins.length ?? 0}</strong>
                      <span>Active plugins</span>
                    </article>
                    <article>
                      <strong>{sessions.length}</strong>
                      <span>Sessions</span>
                    </article>
                  </div>
                </>
              )}
              {settingsTab === 'models' && (
                <>
                  <p className="overline">MODEL</p>
                  <h3>{bootstrap?.model ?? 'Configured model'}</h3>
                  <p>Model selection and provider validation share the same runtime as the CLI.</p>
                  <article className="setting-row">
                    <div>
                      <strong>Provider credential</strong>
                      <small>
                        Configured values are write-only and never returned to this page.
                      </small>
                    </div>
                    <span className="configured-pill">Process-owned</span>
                  </article>
                </>
              )}
              {settingsTab === 'permissions' && (
                <>
                  <p className="overline">TRUST BOUNDARY</p>
                  <h3>Local runtime permissions</h3>
                  <p>
                    Tool actions continue to use the active CLI safety mode and approval policy.
                  </p>
                  <article className="setting-row">
                    <div>
                      <strong>Loopback-only Web host</strong>
                      <small>Cross-origin mutations are denied.</small>
                    </div>
                    <span className="configured-pill">Enforced</span>
                  </article>
                </>
              )}
              {settingsTab === 'plugins' && (
                <>
                  <p className="overline">TRUSTED PLUGINS</p>
                  <h3>Installed extensions</h3>
                  <p>
                    Add local or npm plugins with <code>moss plugins add</code>. Plugin JavaScript
                    is trusted code and is not sandboxed.
                  </p>
                  {settingsNotice && <div className="settings-notice">{settingsNotice}</div>}
                  {pluginInventory.installed.length === 0 && (
                    <div className="settings-empty">No plugins installed.</div>
                  )}
                  {pluginInventory.installed.map((plugin) => {
                    const active = pluginInventory.active.some(({ id }) => id === plugin.id);
                    return (
                      <article className="plugin-card" key={plugin.id}>
                        <div>
                          <strong>{plugin.id}</strong>
                          <small>
                            {plugin.version} ·{' '}
                            {active ? 'active' : plugin.enabled ? 'restart pending' : 'disabled'}
                          </small>
                        </div>
                        <div className="plugin-actions">
                          <button
                            onClick={() =>
                              void mutatePlugin(plugin.id, plugin.enabled ? 'disable' : 'enable')
                            }
                          >
                            {plugin.enabled ? 'Disable' : 'Enable'}
                          </button>
                          <button onClick={() => void mutatePlugin(plugin.id, 'remove')}>
                            Remove
                          </button>
                        </div>
                      </article>
                    );
                  })}
                  <PluginSlot
                    slot="settings.plugin"
                    contributions={pluginInventory.contributions}
                  />
                </>
              )}
            </div>
          </section>
        ) : items.length === 0 ? (
          <EmptyConversation onPrompt={setPrompt} />
        ) : (
          <Timeline
            items={items}
            contributions={pluginInventory.contributions}
            onSelectTool={(tool) => {
              setSelectedTool(tool);
              setDetailsOpen(true);
            }}
          />
        )}

        {!settingsOpen && (
          <section className="composer-shell">
            <div className="composer-status">
              <span className={running ? 'working-dot' : ''} />
              {statusLabel}
            </div>
            <div className="composer-card">
              <PluginSlot
                slot="conversation.composer"
                contributions={pluginInventory.contributions}
              />
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder="Ask Moss to plan, build, inspect, or verify…"
                rows={3}
              />
              <div className="composer-actions">
                <div>
                  <button className="composer-chip">Default</button>
                  <button className="composer-chip">@ Context</button>
                </div>
                {running ? (
                  <button className="stop-button" onClick={() => void stop()}>
                    <Icon name="stop" /> Stop
                  </button>
                ) : (
                  <button
                    className="send-button"
                    disabled={!prompt.trim()}
                    onClick={() => void send()}
                    aria-label="Send task"
                  >
                    ↑
                  </button>
                )}
              </div>
            </div>
          </section>
        )}
      </section>

      <aside className="details-panel">
        <header>
          <div>
            <p className="overline">TASK DETAILS</p>
            <h2>{selectedTool ? 'Tool call' : 'Runtime'}</h2>
          </div>
          <button onClick={() => setDetailsOpen(false)} aria-label="Close details">
            ×
          </button>
        </header>
        {selectedTool ? (
          <div className="detail-content">
            <PluginSlot slot="tool.details" contributions={pluginInventory.contributions} />
            <div className={`detail-status status-${selectedTool.state}`}>
              <span />
              {selectedTool.state}
            </div>
            <h3>{selectedTool.name}</h3>
            <label>Input</label>
            <pre>{JSON.stringify(selectedTool.input ?? {}, null, 2)}</pre>
            <label>Result</label>
            <pre>
              {typeof selectedTool.result === 'string'
                ? selectedTool.result
                : JSON.stringify(selectedTool.result ?? {}, null, 2)}
            </pre>
          </div>
        ) : (
          <div className="detail-content">
            <PluginSlot slot="conversation.details" contributions={pluginInventory.contributions} />
            <section>
              <label>Model</label>
              <strong>{bootstrap?.model ?? 'Connecting…'}</strong>
            </section>
            <section>
              <label>Available tools</label>
              <div className="tool-chips">
                {bootstrap?.tools.slice(0, 18).map((tool) => (
                  <span key={tool}>{tool}</span>
                ))}
              </div>
            </section>
            <section>
              <label>Trust boundary</label>
              <p>
                Local-first. Secrets remain in the Moss process and tool actions follow the active
                approval policy.
              </p>
            </section>
          </div>
        )}
      </aside>
    </main>
  );
};

const root = document.getElementById('moss-web-root');
if (!root) throw new Error('Moss Web root is missing');
createRoot(root).render(
  <StrictMode>
    <Workbench />
  </StrictMode>
);
