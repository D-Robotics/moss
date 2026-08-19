import { useState } from 'react';
import { Button, Input } from './design-system.js';
import { PluginSlot } from './plugin-slot.js';
import type { SessionSummary, WebContribution, WorkspaceSummary } from './workbench-types.js';

const Glyph = ({ children }: { children: string }) => (
  <span aria-hidden="true" className="text-glyph">
    {children}
  </span>
);

export const WorkspacePicker = ({
  workspaces,
  value,
  onChange,
}: {
  workspaces: WorkspaceSummary[];
  value?: string;
  onChange(id: string): void;
}) => (
  <label className="workspace-picker">
    <span>Workspace</span>
    <select
      name="workspace"
      autoComplete="off"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {workspaces.map((workspace) => (
        <option key={workspace.id} value={workspace.id}>
          {workspace.name}
        </option>
      ))}
    </select>
  </label>
);

export const SessionSidebar = ({
  workspaces,
  workspaceId,
  sessions,
  activeId,
  query,
  online,
  running,
  creatingSession,
  contributions,
  onWorkspace,
  onQuery,
  onCreate,
  onOpen,
  onAction,
  onSettings,
  onGallery,
}: {
  workspaces: WorkspaceSummary[];
  workspaceId?: string;
  sessions: SessionSummary[];
  activeId?: string;
  query: string;
  online: boolean;
  running: boolean;
  creatingSession: boolean;
  contributions: WebContribution[];
  onWorkspace(id: string): void;
  onQuery(value: string): void;
  onCreate(): void;
  onOpen(session: SessionSummary): void;
  onAction(
    action: 'rename' | 'export' | 'delete' | 'fork' | 'rewind',
    session: SessionSummary
  ): void;
  onSettings(): void;
  onGallery(): void;
}) => {
  const [menuId, setMenuId] = useState<string>();
  return (
    <aside className="sidebar">
      <header className="brand-row">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <strong>Moss</strong>
          <span>Local agent workspace</span>
        </div>
      </header>
      <WorkspacePicker workspaces={workspaces} value={workspaceId} onChange={onWorkspace} />
      <Button
        className="new-task"
        icon={<Glyph>＋</Glyph>}
        onClick={onCreate}
        disabled={creatingSession}
        aria-busy={creatingSession}
      >
        <span className="new-task-label">{creatingSession ? 'Creating…' : 'New task'}</span>
        <kbd>⌘K</kbd>
      </Button>
      <PluginSlot
        slot="navigation.primary"
        contributions={contributions}
        owner={{ kind: 'workspace', id: workspaceId ?? 'current' }}
      />
      <Input
        className="session-search"
        label="Search tasks"
        labelHidden
        name="session-search"
        autoComplete="off"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        placeholder="Search tasks…"
      />
      <div className="section-label">Recent tasks</div>
      <nav className="session-list" aria-label="Recent tasks">
        {sessions.map((session) => (
          <div
            className={`session-entry ${session.sessionId === activeId ? 'active' : ''}`}
            key={session.sessionId}
          >
            <button className="session-main" onClick={() => onOpen(session)}>
              <span>{session.title}</span>
              <small>
                {session.snippet ?? session.runStatus ?? `${session.messageCount} messages`}
              </small>
            </button>
            <PluginSlot
              slot="navigation.session"
              contributions={contributions}
              owner={{ kind: 'session', id: session.sessionId, data: session }}
            />
            <button
              className="session-more"
              aria-label={`Actions for ${session.title}`}
              onClick={() =>
                setMenuId(menuId === session.sessionId ? undefined : session.sessionId)
              }
            >
              •••
            </button>
            {menuId === session.sessionId && (
              <div className="session-menu" role="menu">
                {(['rename', 'export', 'fork', 'rewind', 'delete'] as const).map((action) => (
                  <button
                    key={action}
                    role="menuitem"
                    onClick={() => {
                      setMenuId(undefined);
                      onAction(action, session);
                    }}
                  >
                    {action[0].toUpperCase() + action.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {sessions.length === 0 && <p className="no-sessions">No matching tasks.</p>}
      </nav>
      <footer className="sidebar-footer">
        <PluginSlot
          slot="navigation.footer"
          contributions={contributions}
          owner={{ kind: 'workspace', id: workspaceId ?? 'current' }}
        />
        <Button variant="ghost" size="small" onClick={onSettings}>
          <Glyph>⚙</Glyph> Settings
        </Button>
        <Button variant="ghost" size="small" onClick={onGallery}>
          <Glyph>▣</Glyph> Components
        </Button>
        <div className="runtime-state" role="status" aria-live="polite">
          <span className={online ? 'online' : 'offline'} />
          <div>
            <strong>Local runtime</strong>
            <small>{running ? 'Moss is working' : online ? 'Ready' : 'Reconnecting'}</small>
          </div>
        </div>
      </footer>
    </aside>
  );
};
