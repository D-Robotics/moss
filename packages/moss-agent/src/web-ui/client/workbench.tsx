import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { api, ApiError, connectPluginComposition, connectRunEvents } from './api-client.js';
import { AppFrame, useMossLayout } from './app-frame.js';
import { ComponentGallery } from './component-gallery.js';
import { Composer, type ComposerAttachment } from './composer.js';
import { ConversationTimeline } from './conversation-timeline.js';
import { Button, Tooltip } from './design-system.js';
import { DetailsPanel } from './details-panel.js';
import { EmptyConversation } from './empty-conversation.js';
import { PluginSlot } from './plugin-slot.js';
import { SessionSidebar } from './session-sidebar.js';
import { SessionActionDialog, type PendingSessionAction } from './session-action-dialog.js';
import { SettingsCenter } from './settings-center.js';
import {
  loadPreferences,
  savePreferences,
  sessionPreference,
  updateSessionPreference,
} from './workbench-preferences.js';
import { readWorkbenchUrlState, useWorkbenchUrlSync } from './workbench-url-state.js';
import { consumeNdjsonStream } from './stream-response.js';
import type {
  BootstrapResponse,
  ExecutionView,
  Interaction,
  MentionInventory,
  PluginInventory,
  RunSnapshot,
  RuntimeMode,
  SessionSummary,
  StreamEvent,
  TimelineItem,
  WorkbenchPreferences,
  WorkspaceSummary,
} from './workbench-types.js';
import { WorkbenchIcon } from './workbench-icon.js';
import './workbench.css';
import './workbench-capabilities.css';

const emptyPlugins: PluginInventory = { installed: [], active: [], contributions: [] };
const emptyMentions: MentionInventory = { skills: [], experts: [], commands: [] };

const WorkbenchState = ({ kind, text }: { kind: 'loading' | 'error' | 'empty'; text: string }) => (
  <section className={`workbench-state state-${kind}`} aria-busy={kind === 'loading'} role="status">
    <span aria-hidden="true" />
    <strong>{kind === 'loading' ? 'Loading workspace' : 'Workspace unavailable'}</strong>
    <p>{text}</p>
    {kind === 'loading' && (
      <div className="workbench-skeleton" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
    )}
  </section>
);

const appendText = (
  items: TimelineItem[],
  kind: 'assistant' | 'reasoning',
  delta: string
): TimelineItem[] => {
  const last = items.at(-1);
  return last?.kind === kind
    ? [...items.slice(0, -1), { ...last, text: last.text + delta }]
    : [...items, { id: crypto.randomUUID(), kind, text: delta }];
};

const reduceEvent = (items: TimelineItem[], event: StreamEvent): TimelineItem[] => {
  if (event.type === 'text') return appendText(items, 'assistant', event.delta);
  if (event.type === 'thought') return appendText(items, 'reasoning', event.delta);
  if (event.type === 'tool') {
    const existing = items.find(
      (item): item is Extract<TimelineItem, { kind: 'tool' }> =>
        item.kind === 'tool' && item.id === event.toolCallId
    );
    const next: Extract<TimelineItem, { kind: 'tool' }> = {
      id: event.toolCallId,
      kind: 'tool',
      name: event.name,
      state: event.state === 'end' ? (event.isError ? 'failed' : 'complete') : 'running',
      input: existing?.input ?? event.input,
      result: event.result,
    };
    return existing
      ? items.map((item) => (item.id === event.toolCallId ? next : item))
      : [...items, next];
  }
  if (event.type === 'retry')
    return [
      ...items,
      { id: crypto.randomUUID(), kind: 'retry', attempt: event.attempt, text: event.error },
    ];
  if (event.type === 'compaction')
    return [
      ...items,
      {
        id: crypto.randomUUID(),
        kind: 'compaction',
        summaryChars: event.summaryChars,
        droppedMessages: event.droppedMessages,
        outline: event.checkpointOutline,
      },
    ];
  if (event.type === 'usage')
    return [
      ...items,
      {
        id: crypto.randomUUID(),
        kind: 'usage',
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        contextTokens: event.contextTokens,
      },
    ];
  if (event.type === 'context')
    return [
      ...items,
      {
        id: crypto.randomUUID(),
        kind: 'context',
        status: event.status,
        reason: event.reason,
        goal: event.goal,
        nextAction: event.nextAction,
      },
    ];
  if (event.type === 'interrupted')
    return [
      ...items,
      {
        id: crypto.randomUUID(),
        kind: 'status',
        state: 'interrupted',
        text: `Interrupted: ${event.reason}`,
      },
    ];
  if (event.type === 'done')
    return [
      ...items,
      {
        id: crypto.randomUUID(),
        kind: 'status',
        state: event.stopReason,
        text: `Completed · ${event.stopReason}`,
      },
    ];
  if (event.type === 'error')
    return [
      ...items,
      { id: crypto.randomUUID(), kind: 'status', state: 'error', text: event.message },
    ];
  return items;
};

const Workbench = () => {
  const layout = useMossLayout();
  const [initialUrlState] = useState(() => readWorkbenchUrlState(loadPreferences()));
  const [preferences, setPreferences] = useState<WorkbenchPreferences>(initialUrlState.preferences);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [surfaceError, setSurfaceError] = useState('');
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(preferences.sessionId);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [query, setQuery] = useState('');
  const [running, setRunning] = useState(false);
  const [online, setOnline] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [plugins, setPlugins] = useState<PluginInventory>(emptyPlugins);
  const [selectedTool, setSelectedTool] = useState<Extract<TimelineItem, { kind: 'tool' }>>();
  const [run, setRun] = useState<RunSnapshot>();
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [mentions, setMentions] = useState<MentionInventory>(emptyMentions);
  const [model, setModel] = useState('Connecting…');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [galleryOpen, setGalleryOpen] = useState(() => window.location.hash === '#gallery');
  const [activeExecutionId, setActiveExecutionId] = useState(initialUrlState.executionId);
  const [pendingSessionAction, setPendingSessionAction] = useState<PendingSessionAction>();
  const [sessionActionValue, setSessionActionValue] = useState('');
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const eventDisposeRef = useRef<(() => void) | undefined>(undefined);
  const activePreference = sessionPreference(preferences, sessionId ?? 'new');
  useWorkbenchUrlSync({
    workspaceId: preferences.workspaceId,
    sessionId,
    executionId: activeExecutionId,
    detailsOpen: activePreference.detailsOpen,
    detailTab: activePreference.selectedPanel,
    settings: preferences.settingsSection,
  });

  const updatePreferences = useCallback(
    (update: WorkbenchPreferences | ((current: WorkbenchPreferences) => WorkbenchPreferences)) => {
      setPreferences((current) => {
        const next = typeof update === 'function' ? update(current) : update;
        savePreferences(next);
        return next;
      });
    },
    []
  );
  const patchSessionPreference = (
    patch: Parameters<typeof updateSessionPreference>[2],
    targetSessionId = sessionId ?? 'new'
  ) => {
    updatePreferences((current) => updateSessionPreference(current, targetSessionId, patch));
  };
  const refresh = useCallback(async () => {
    const [nextBootstrap, nextWorkspaces, nextSessions, nextPlugins] = await Promise.all([
      api.bootstrap(),
      api.workspaces(),
      api.sessions(),
      api.plugins(),
    ]);
    setBootstrap(nextBootstrap);
    setModel(nextBootstrap.model);
    setWorkspaces(nextWorkspaces.workspaces);
    setSessions(nextSessions.sessions);
    setPlugins(nextPlugins);
    setOnline(true);
    void api
      .interactions()
      .then(({ interactions: next }) => setInteractions(next))
      .catch(() => {});
    void api
      .mentions()
      .then(setMentions)
      .catch(() => {});
    void api
      .runtimeMode()
      .then(({ mode }) => updatePreferences((current) => ({ ...current, mode })))
      .catch(() => {});
  }, [updatePreferences]);

  const attachActiveRun = useCallback(
    async (activeSessionId: string) => {
      eventDisposeRef.current?.();
      try {
        const active = await api.activeRun(activeSessionId);
        setRunning(true);
        const persisted = sessionPreference(loadPreferences(), activeSessionId);
        const after = persisted.runId === active.run.id ? (persisted.eventCursor ?? 0) : 0;
        eventDisposeRef.current = connectRunEvents(
          active.run.id,
          after,
          (event, cursor) => {
            const latest = loadPreferences();
            savePreferences(
              updateSessionPreference(latest, activeSessionId, {
                runId: active.run.id,
                eventCursor: cursor,
              })
            );
            setItems((current) => reduceEvent(current, event));
            if (
              event.type === 'run' ||
              event.type === 'interrupted' ||
              (event.type === 'done' && event.run)
            )
              setRun(event.run);
            if (event.type === 'done' || event.type === 'interrupted') {
              setRunning(false);
              void refresh();
            }
          },
          setOnline
        );
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) setOnline(false);
      }
    },
    [refresh]
  );

  useEffect(() => {
    void refresh()
      .then(async () => {
        if (sessionId) {
          const history = await api.messages(sessionId);
          setItems(history.items);
          await attachActiveRun(sessionId);
        }
      })
      .catch(() => {
        setOnline(false);
        setSurfaceError('Task history could not be loaded. The stored history may be damaged.');
      })
      .finally(() => setLoading(false));
    return () => {
      controllerRef.current?.abort();
      eventDisposeRef.current?.();
    };
  }, []);
  useEffect(
    () =>
      connectPluginComposition(() => {
        void api
          .plugins()
          .then(setPlugins)
          .catch(() => setOnline(false));
      }, setOnline),
    []
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const sync = () => setGalleryOpen(window.location.hash === '#gallery');
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  useEffect(() => {
    if (!query.trim()) {
      void api.sessions().then(({ sessions: next }) => setSessions(next));
      return;
    }
    const timer = window.setTimeout(
      () =>
        void api
          .search(query)
          .then(({ hits }) => setSessions(hits))
          .catch(() => {}),
      180
    );
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(
      () =>
        void api
          .interactions()
          .then(({ interactions: next }) => setInteractions(next))
          .catch(() => {}),
      1_000
    );
    return () => window.clearInterval(timer);
  }, [running]);

  const createSession = async () => {
    const created = await api.createSession(preferences.workspaceId);
    setSessionId(created.sessionId);
    updatePreferences((current) => ({ ...current, sessionId: created.sessionId }));
    setItems([]);
    setSettingsOpen(false);
    setSelectedTool(undefined);
    layout.closeDrawers();
    await refresh();
  };
  const openSession = async (session: SessionSummary) => {
    eventDisposeRef.current?.();
    setSessionId(session.sessionId);
    updatePreferences((current) => ({ ...current, sessionId: session.sessionId }));
    setSettingsOpen(false);
    setSelectedTool(undefined);
    layout.closeDrawers();
    if (sessionPreference(preferences, session.sessionId).detailsOpen) layout.openDetails();
    else layout.closeDetails();
    setSurfaceError('');
    try {
      const history = await api.messages(session.sessionId);
      setItems(history.items);
      await attachActiveRun(session.sessionId);
    } catch {
      setSurfaceError('This task history could not be read. It may be incomplete or damaged.');
    }
  };
  const sessionAction = async (
    action: 'rename' | 'export' | 'delete' | 'fork' | 'rewind',
    session: SessionSummary
  ) => {
    if (action === 'export') {
      const anchor = document.createElement('a');
      anchor.href = `/api/sessions/${encodeURIComponent(session.sessionId)}/export`;
      anchor.download = `${session.title}.md`;
      anchor.click();
      return;
    }
    if (action === 'rename') {
      setSessionActionValue(session.title);
      setPendingSessionAction({
        action,
        session,
        title: 'Rename task',
        description: 'Choose a concise title for this task.',
      });
      return;
    }
    if (action === 'delete') {
      setSessionActionValue('');
      setPendingSessionAction({
        action,
        session,
        title: 'Delete task',
        description: `Type the exact task id to delete “${session.title}”.`,
        expected: session.sessionId,
      });
      return;
    }
    if (action === 'fork') {
      const created = await api.fork(session.sessionId);
      await openSession(created.session);
    }
    if (action === 'rewind') {
      setSessionActionValue(String(Math.max(0, session.messageCount - 1)));
      setPendingSessionAction({
        action,
        session,
        title: 'Rewind task',
        description: 'Choose how many messages to retain in the non-destructive fork.',
      });
      return;
    }
    await refresh();
  };

  const confirmSessionAction = async () => {
    const pending = pendingSessionAction;
    if (!pending) return;
    try {
      if (pending.action === 'rename') {
        const title = sessionActionValue.trim();
        if (!title) return;
        await api.rename(pending.session.sessionId, title);
      } else if (pending.action === 'delete') {
        if (sessionActionValue !== pending.expected) return;
        await api.delete(pending.session.sessionId, sessionActionValue);
        if (sessionId === pending.session.sessionId) {
          setSessionId(undefined);
          setItems([]);
        }
      } else {
        const count = Number(sessionActionValue);
        if (!Number.isInteger(count) || count < 0) return;
        const created = await api.rewind(pending.session.sessionId, count);
        await openSession(created.session);
      }
      setPendingSessionAction(undefined);
      await refresh();
    } catch (error) {
      setSurfaceError(error instanceof Error ? error.message : String(error));
    }
  };

  const applyStreamEvent = (event: StreamEvent) => {
    setItems((current) => reduceEvent(current, event));
    if (event.type === 'run') {
      setRun(event.run);
      setSessions((current) =>
        current.map((session) =>
          session.sessionId === event.run.sessionId
            ? {
                ...session,
                title: event.run.title,
                runId: event.run.id,
                runStatus: event.run.status,
                updatedAt: event.run.updatedAt,
              }
            : session
        )
      );
    }
  };
  const send = async (text: string, attachments: ComposerAttachment[]) => {
    let activeSession = sessionId;
    if (!activeSession) {
      const created = await api.createSession(preferences.workspaceId);
      activeSession = created.sessionId;
      setSessionId(activeSession);
      updatePreferences((current) => ({ ...current, sessionId: activeSession }));
    }
    const failedAttachment = attachments.find((attachment) => !attachment.serverId);
    if (failedAttachment) {
      setItems((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          kind: 'status',
          state: 'error',
          text: `Attachment ${failedAttachment.name} is not ready.`,
        },
      ]);
      return;
    }
    patchSessionPreference({ draft: '' }, activeSession);
    setItems((current) => [...current, { id: crypto.randomUUID(), kind: 'user', text }]);
    setRunning(true);
    if (running) {
      await api.deliver(activeSession, text, activePreference.delivery);
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const response = await api.sendMessage(
        activeSession,
        text,
        attachments.map(({ serverId }) => serverId as string),
        controller.signal
      );
      await consumeNdjsonStream<StreamEvent>(response, applyStreamEvent);
      await refresh();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setOnline(false);
        setItems((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            kind: 'status',
            state: 'interrupted',
            text: 'Connection interrupted. Refresh will resume the durable run.',
          },
        ]);
        if (activeSession) await attachActiveRun(activeSession);
      }
    } finally {
      setRunning(false);
      controllerRef.current = undefined;
    }
  };
  const startDeliveryExecution = async (execution: ExecutionView) => {
    if (running) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    try {
      await consumeNdjsonStream<StreamEvent>(
        await api.runExecution(execution.graphId, controller.signal),
        applyStreamEvent
      );
      await refresh();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setSurfaceError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setRunning(false);
      controllerRef.current = undefined;
    }
  };
  const stop = async () => {
    controllerRef.current?.abort();
    if (sessionId) await api.cancelSession(sessionId);
    setRunning(false);
  };
  const mutatePlugin = async (id: string, action: 'enable' | 'disable' | 'remove') => {
    await api.mutatePlugin(id, action);
    await refresh();
  };
  const setMode = (mode: RuntimeMode) => {
    updatePreferences((current) => ({ ...current, mode }));
    void api.setRuntimeMode(mode).catch(() => {});
  };
  const resolveInteraction = async (answer: string) => {
    const interaction = interactions[0];
    if (!interaction) return;
    await api.resolveInteraction(interaction.id, answer);
    setInteractions(interactions.slice(1));
  };
  const runCommand = async (command: string) => {
    let activeSession = sessionId;
    if (!activeSession) {
      const created = await api.createSession(preferences.workspaceId);
      activeSession = created.sessionId;
      setSessionId(activeSession);
      updatePreferences((current) => ({ ...current, sessionId: activeSession }));
    }
    await api.command(activeSession, command);
    patchSessionPreference({ draft: '' }, activeSession);
    await refresh();
  };

  const filteredSessions = useMemo(() => sessions, [sessions]);
  if (galleryOpen)
    return (
      <ComponentGallery
        onExit={() => {
          window.location.hash = '';
        }}
      />
    );
  return (
    <AppFrame
      layout={layout}
      sidebar={
        <SessionSidebar
          workspaces={workspaces}
          workspaceId={preferences.workspaceId ?? workspaces.find(({ current }) => current)?.id}
          sessions={filteredSessions}
          activeId={sessionId}
          query={query}
          online={online}
          running={running}
          contributions={plugins.contributions}
          onWorkspace={(workspaceId) =>
            updatePreferences((current) => ({ ...current, workspaceId }))
          }
          onQuery={setQuery}
          onCreate={() => void createSession()}
          onOpen={(session) => void openSession(session)}
          onAction={(action, session) => void sessionAction(action, session)}
          onSettings={() => {
            setSettingsOpen(true);
            layout.closeDrawers();
          }}
          onGallery={() => {
            layout.closeDrawers();
            window.location.hash = 'gallery';
          }}
        />
      }
      conversation={
        <section className="conversation-column">
          <header className="conversation-header">
            <div>
              <p className="overline">
                {workspaces.find(({ id }) => id === preferences.workspaceId)?.name ??
                  'LOCAL WORKSPACE'}
              </p>
              <h2>
                {settingsOpen
                  ? 'Settings'
                  : (sessions.find((session) => session.sessionId === sessionId)?.title ??
                    'New task')}
              </h2>
            </div>
            <div className="header-actions">
              <Tooltip content="Toggle navigation panel">
                <Button
                  variant="ghost"
                  size="small"
                  className="icon-button"
                  onClick={layout.toggleSidebar}
                  aria-label="Toggle navigation panel"
                >
                  <WorkbenchIcon name="menu" />
                </Button>
              </Tooltip>
              <button className="model-pill" onClick={() => setSettingsOpen(true)}>
                {model}
              </button>
              <Tooltip content="Toggle color theme">
                <Button
                  variant="ghost"
                  size="small"
                  className="icon-button"
                  onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
                  aria-label="Toggle theme"
                >
                  {theme === 'light' ? '◐' : '◑'}
                </Button>
              </Tooltip>
              <Tooltip content="Toggle task details">
                <Button
                  variant="ghost"
                  size="small"
                  className="icon-button"
                  onClick={() => {
                    patchSessionPreference({ detailsOpen: !layout.detailsOpen });
                    layout.toggleDetails();
                  }}
                  aria-label="Toggle details panel"
                >
                  <WorkbenchIcon name="panel" />
                </Button>
              </Tooltip>
            </div>
            <PluginSlot
              slot="conversation.header"
              contributions={plugins.contributions}
              owner={{ kind: 'session', id: sessionId ?? 'new' }}
            />
          </header>
          {!online && (
            <div className="connection-banner" role="alert">
              Connection lost. Durable history remains safe while Moss reconnects.
            </div>
          )}
          {settingsOpen ? (
            <SettingsCenter
              initialSection={preferences.settingsSection}
              bootstrap={bootstrap}
              inventory={plugins}
              onSection={(settingsSection) =>
                updatePreferences((current) => ({ ...current, settingsSection }))
              }
              onPluginMutate={(id, action) => void mutatePlugin(id, action)}
              onPluginsChanged={() => void refresh()}
              onModelChanged={setModel}
            />
          ) : loading ? (
            <WorkbenchState kind="loading" text="Restoring sessions and runtime state…" />
          ) : surfaceError ? (
            <WorkbenchState kind="error" text={surfaceError} />
          ) : workspaces.length === 0 ? (
            <WorkbenchState kind="empty" text="No workspace is available for this runtime." />
          ) : items.length === 0 ? (
            <EmptyConversation onPrompt={(draft) => patchSessionPreference({ draft })} />
          ) : (
            <ConversationTimeline
              items={items}
              sessionId={sessionId}
              contributions={plugins.contributions}
              scrollTop={activePreference.scrollTop}
              onScroll={(scrollTop) => patchSessionPreference({ scrollTop })}
              onSelectTool={(tool) => {
                setSelectedTool(tool);
                patchSessionPreference({ detailsOpen: true });
                layout.openDetails();
              }}
              onRetry={() => {
                const last = [...items].reverse().find((item) => item.kind === 'user');
                if (last?.kind === 'user') void send(last.text, []);
              }}
              onCopy={(text) => void navigator.clipboard.writeText(text)}
              onFeedback={(value) => {
                window.dispatchEvent(new CustomEvent('moss:message-feedback', { detail: value }));
              }}
            />
          )}
          {!settingsOpen && (
            <Composer
              sessionId={sessionId}
              prompt={activePreference.draft}
              running={running}
              mode={preferences.mode}
              permissionPreset={preferences.permissionPreset}
              model={model}
              delivery={activePreference.delivery}
              interaction={interactions[0]}
              mentions={mentions}
              contributions={plugins.contributions}
              onPrompt={(draft) => patchSessionPreference({ draft })}
              onSend={(text, attachments) => void send(text, attachments)}
              onStop={() => void stop()}
              onMode={setMode}
              onPermissionPreset={(permissionPreset) => {
                updatePreferences((current) => ({ ...current, permissionPreset }));
                void api.setPermissionPreset(permissionPreset);
              }}
              onModel={() => setSettingsOpen(true)}
              onDelivery={(delivery) => patchSessionPreference({ delivery })}
              onResolve={(answer) => void resolveInteraction(answer)}
              onCancelInteraction={() => {
                const interaction = interactions[0];
                if (interaction)
                  void api
                    .cancelInteraction(interaction.id)
                    .then(() => setInteractions(interactions.slice(1)));
              }}
              onCommand={(command) => void runCommand(command)}
            />
          )}
          <SessionActionDialog
            pending={pendingSessionAction}
            value={sessionActionValue}
            onValue={setSessionActionValue}
            onClose={() => setPendingSessionAction(undefined)}
            onConfirm={() => void confirmSessionAction()}
          />
        </section>
      }
      details={
        <DetailsPanel
          sessionId={sessionId}
          run={run ?? bootstrap?.taskRuns.find((candidate) => candidate.sessionId === sessionId)}
          selectedTool={selectedTool}
          bootstrap={bootstrap}
          contributions={plugins.contributions}
          initialTab={activePreference.selectedPanel}
          preferredExecutionId={activeExecutionId}
          onExecution={setActiveExecutionId}
          onStartExecution={(execution) => void startDeliveryExecution(execution)}
          onTab={(selectedPanel) => patchSessionPreference({ selectedPanel })}
          onClose={() => {
            patchSessionPreference({ detailsOpen: false });
            layout.closeDetails();
          }}
        />
      }
    />
  );
};

const root = document.getElementById('moss-web-root');
if (!root) throw new Error('Moss Web root is missing');
createRoot(root).render(
  <StrictMode>
    <Workbench />
  </StrictMode>
);
