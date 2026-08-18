import type { MossWebSlot } from '../core/plugins/plugin-host.js';
import type {
  MossPluginConfigSchema,
  MossPluginConfigView,
} from '../plugins/plugin-config-store.js';

/** Stable extension slots available to trusted Moss Web plugins. @beta */
export { MOSS_WEB_SLOTS } from '../core/plugins/plugin-host.js';

/** One stable Moss Web extension slot. @beta */
export type { MossWebSlot } from '../core/plugins/plugin-host.js';

/** Theme variables that every built-in and plugin surface may consume. @beta */
export const MOSS_WEB_THEME_TOKENS = [
  '--moss-color-canvas',
  '--moss-color-surface',
  '--moss-color-panel',
  '--moss-color-panel-raised',
  '--moss-color-border',
  '--moss-color-border-strong',
  '--moss-color-text',
  '--moss-color-muted',
  '--moss-color-faint',
  '--moss-color-accent',
  '--moss-color-accent-hover',
  '--moss-color-accent-soft',
  '--moss-color-danger',
  '--moss-color-danger-soft',
  '--moss-color-warning',
  '--moss-color-warning-soft',
  '--moss-color-success',
  '--moss-color-success-soft',
  '--moss-color-overlay',
  '--moss-color-terminal',
  '--moss-color-terminal-border',
  '--moss-color-terminal-muted',
  '--moss-color-terminal-prompt',
  '--moss-color-terminal-text',
  '--moss-font-family-body',
  '--moss-font-family-display',
  '--moss-font-family-code',
  '--moss-font-size-1',
  '--moss-font-size-2',
  '--moss-font-size-3',
  '--moss-font-size-4',
  '--moss-font-size-5',
  '--moss-font-size-6',
  '--moss-font-size-display',
  '--moss-font-weight-regular',
  '--moss-font-weight-medium',
  '--moss-font-weight-bold',
  '--moss-line-height-tight',
  '--moss-line-height-body',
  '--moss-line-height-code',
  '--moss-space-1',
  '--moss-space-2',
  '--moss-space-3',
  '--moss-space-4',
  '--moss-space-5',
  '--moss-space-6',
  '--moss-space-8',
  '--moss-space-10',
  '--moss-space-12',
  '--moss-radius-control',
  '--moss-radius-small',
  '--moss-radius-card',
  '--moss-radius-panel',
  '--moss-radius-round',
  '--moss-shadow-control',
  '--moss-shadow-composer',
  '--moss-shadow-float',
  '--moss-shadow-dialog',
  '--moss-control-height',
  '--moss-control-height-small',
  '--moss-motion-fast',
  '--moss-motion-standard',
  '--moss-motion-slow',
  '--moss-ease-standard',
  '--moss-z-base',
  '--moss-z-header',
  '--moss-z-drawer',
  '--moss-z-dialog',
  '--moss-z-toast',
  '--moss-z-tooltip',
  '--moss-state-idle',
  '--moss-state-running',
  '--moss-state-success',
  '--moss-state-warning',
  '--moss-state-error',
  '--moss-state-interrupted',
] as const;

/** One stable Moss Web theme variable. @beta */
export type MossWebThemeToken = (typeof MOSS_WEB_THEME_TOKENS)[number];

/** Context passed to a trusted plugin Web module mounted in a scoped ShadowRoot. @beta */
export interface MossWebPluginMountContext {
  readonly pluginId: string;
  readonly contributionId: string;
  readonly slot: MossWebSlot;
  /** Stable owner of the slot instance; arbitrary payloads remain read-only. */
  readonly owner?: {
    readonly kind: 'workspace' | 'session' | 'message' | 'tool' | 'settings';
    readonly id: string;
    readonly data?: unknown;
  };
  /** Same-origin ESM entry exporting Moss controlled React components and a mount helper. */
  readonly componentsUrl: '/assets/moss-web-components.js';
}

/** Controlled browser module shape for an advanced trusted plugin UI. @beta */
export interface MossWebPluginModule {
  mount(
    root: ShadowRoot,
    context: MossWebPluginMountContext
  ): void | (() => void) | Promise<void | (() => void)>;
}

/** Browser-safe installed plugin record; filesystem locations are intentionally omitted. @beta */
export interface MossWebInstalledPlugin {
  readonly id: string;
  readonly version: string;
  readonly enabled: boolean;
}

/** Browser-safe snapshot of one active runtime plugin. @beta */
export interface MossWebPluginSnapshot {
  readonly id: string;
  readonly state: string;
  readonly callState: 'accepting' | 'draining' | 'disposed';
  readonly tools: readonly string[];
  readonly commands: readonly string[];
  readonly providers: readonly string[];
  readonly mcpPresets: readonly string[];
  readonly webContributions: readonly string[];
}

/** Last-good runtime composition used for hot-reload and cache busting. @beta */
export interface MossWebPluginComposition {
  readonly generation: number;
  readonly plugins: readonly MossWebPluginSnapshot[];
}

/** Browser response for schema-rendered plugin configuration. @beta */
export interface MossWebPluginConfigResponse {
  readonly schema: MossPluginConfigSchema;
  readonly config: MossPluginConfigView;
  readonly generation: number;
  readonly restartRequired: false;
}

/** Browser-safe durable run summary. @beta */
export interface MossWebTaskRunSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly status: string;
  readonly verification: string;
  readonly evidenceCount: number;
  readonly updatedAt: number;
}

/** Redacted startup state returned to the browser workbench. @beta */
export interface MossWebBootstrap {
  readonly tools: readonly string[];
  readonly plugins: readonly MossWebPluginSnapshot[];
  readonly pluginComposition: MossWebPluginComposition;
  readonly taskRuns: readonly MossWebTaskRunSnapshot[];
  readonly model: string;
}

/** Durable session metadata safe to expose to the local browser. @beta */
export interface MossWebSessionSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly messageCount: number;
  readonly runId?: string;
  readonly runStatus?: string;
}

/** Browser-safe workspace entry exposed by the local single-workspace host. @beta */
export interface MossWebWorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly current: boolean;
}

/** One bounded match from a Web session title or transcript search. @beta */
export interface MossWebSessionSearchHit extends MossWebSessionSummary {
  readonly snippet: string;
}

/** Durable cursor envelope returned by the Web event journal. @beta */
export interface MossWebJournalEvent {
  readonly runId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly time: number;
  readonly event: MossWebStreamEvent;
}

/** Version-one browser event projection for a streamed Moss turn. @beta */
export type MossWebStreamEvent =
  | { readonly type: 'run'; readonly run: MossWebTaskRunSnapshot }
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'thought'; readonly delta: string }
  | {
      readonly type: 'tool';
      readonly state: 'start' | 'end';
      readonly toolCallId: string;
      readonly name: string;
      readonly input?: Readonly<Record<string, unknown>>;
      readonly result?: string;
      readonly isError?: boolean;
    }
  | {
      readonly type: 'done';
      readonly stopReason: string;
      readonly run?: MossWebTaskRunSnapshot;
    }
  | { readonly type: 'retry'; readonly attempt: number; readonly error: string }
  | {
      readonly type: 'compaction';
      readonly summaryChars: number;
      readonly droppedMessages: number;
      readonly checkpointOutline?: readonly string[];
    }
  | {
      readonly type: 'usage';
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens?: number;
      readonly cacheCreationTokens?: number;
      readonly contextTokens?: number;
    }
  | {
      readonly type: 'context';
      readonly status: string;
      readonly reason: string;
      readonly goal: string;
      readonly nextAction: string;
    }
  | {
      readonly type: 'interrupted';
      readonly reason: string;
      readonly run: MossWebTaskRunSnapshot;
    }
  | { readonly type: 'error'; readonly message: string };
