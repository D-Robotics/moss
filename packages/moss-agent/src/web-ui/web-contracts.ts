import type { MossWebSlot } from '../core/plugins/plugin-host.js';

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
  '--moss-color-accent-soft',
  '--moss-color-danger',
  '--moss-color-warning',
  '--moss-space-1',
  '--moss-space-2',
  '--moss-space-3',
  '--moss-space-4',
  '--moss-space-5',
  '--moss-space-6',
  '--moss-space-8',
  '--moss-radius-control',
  '--moss-radius-card',
  '--moss-radius-panel',
  '--moss-shadow-control',
  '--moss-shadow-composer',
  '--moss-shadow-float',
] as const;

/** One stable Moss Web theme variable. @beta */
export type MossWebThemeToken = (typeof MOSS_WEB_THEME_TOKENS)[number];

/** Context passed to a trusted plugin Web module mounted in a scoped ShadowRoot. @beta */
export interface MossWebPluginMountContext {
  readonly pluginId: string;
  readonly contributionId: string;
  readonly slot: MossWebSlot;
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
  readonly tools: readonly string[];
  readonly webContributions: readonly string[];
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
  | { readonly type: 'error'; readonly message: string };
