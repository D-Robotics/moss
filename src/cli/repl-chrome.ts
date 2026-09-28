import fs from 'node:fs';
import path from 'node:path';
import type { MossAgentEvent } from '../core/index.js';
import type { SessionMeta } from '../core/session/session.js';
import type { CliRuntimeStatus } from './onboarding.js';
import { compactPath } from './ui.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import { legacyTheme as theme } from './theme/theme.js';
import type {
  ActivityItem,
  TranscriptKind,
  TranscriptViewportRowsOptions,
  TuiRunState,
} from './transcript-types.js';

// Glyphs — emoji at line-start only (never in alignment columns).
// Falls back to bracket tags when MOSS_TUI_NO_EMOJI=1 or terminal lacks UTF-8.
export function emojiEnabled(): boolean {
  if (process.env.MOSS_TUI_NO_EMOJI === '1') return false;
  const lang = `${process.env.LANG || ''} ${process.env.LC_ALL || ''} ${process.env.LC_CTYPE || ''}`;
  if (lang && !/utf-?8/i.test(lang)) return false;
  return true;
}

export const WELCOME_PANEL_ROWS_ESTIMATE = 18;

export function availableTranscriptRows(options: TranscriptViewportRowsOptions): number {
  // Reserve a little vertical slack for Box margins/borders that Ink does not
  // expose as rows in the surrounding chrome estimates.
  return Math.max(
    1,
    options.terminalRows -
      options.headerRows -
      options.promptRows -
      options.queueRows -
      options.footerRows -
      options.approvalRows -
      options.noticeRows -
      2
  );
}

export function shouldRenderCompactWelcome(options: TranscriptViewportRowsOptions): boolean {
  return (
    options.transcriptLength === 0 && availableTranscriptRows(options) < WELCOME_PANEL_ROWS_ESTIMATE
  );
}

export function transcriptViewportRows(options: TranscriptViewportRowsOptions): number | undefined {
  if (options.transcriptLength === 0) return undefined;
  return availableTranscriptRows(options);
}

export function formatSessionTimestamp(updatedAt: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return 'unknown time';
  return new Date(updatedAt).toLocaleString();
}

export function formatTuiSessions(
  sessions: SessionMeta[],
  currentSessionKey: string,
  options: { limit?: number } = {}
): string {
  const limit = Math.max(1, options.limit ?? 10);
  const recent = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  const lines = ['Sessions', `  current: ${currentSessionKey}`];
  if (recent.length === 0) {
    lines.push('  No saved sessions found yet.');
  } else {
    lines.push(
      `  recent (${recent.length}${sessions.length > recent.length ? ` of ${sessions.length}` : ''})`
    );
    for (const session of recent) {
      const marker = session.sessionKey === currentSessionKey ? '*' : ' ';
      const count = `${session.messageCount} message${session.messageCount === 1 ? '' : 's'}`;
      lines.push(
        `  ${marker} ${session.sessionKey} · ${count} · updated ${formatSessionTimestamp(session.updatedAt)}`
      );
      if (session.title) lines.push(`      ${session.title}`);
    }
  }
  lines.push('');
  lines.push('Shell: moss resume --last');
  lines.push('Shell: moss resume --session <key>');
  lines.push('Shell: moss fork --fork-from <key>');
  return lines.join('\n');
}

export function statusLine(options: {
  state: TuiRunState;
  model: string;
  device: string;
  workspace: string;
  cacheMode?: string;
  profile?: string;
}): string {
  const parts = [
    'Moss',
    statusBadge(options.state),
    options.model || 'no model',
    options.profile ? `profile ${options.profile}` : '',
    options.device,
    compactPath(options.workspace),
    options.cacheMode || 'cache stable',
  ];
  return parts.filter(Boolean).join('  ');
}

export function promptCacheModeLabel(runtime?: CliRuntimeStatus): string {
  if (runtime?.config?.promptCacheEnabled === false) return 'cache off';
  return runtime?.config?.promptCacheDebug === true ? 'cache debug' : 'cache stable';
}

export const GETTING_STARTED_WORKFLOWS = [
  {
    title: 'Host Code',
    description: 'inspect files, explain architecture, edit safely, review changes',
  },
  {
    title: 'Host Commands',
    description: 'build, typecheck, lint, test, reproduce failures, collect logs',
  },
] as const;

export const DEFAULT_WELCOME_TIP =
  'Describe the task you want done — Moss picks the tools; /help lists every command.';

export function footerHint(state: TuiRunState): string {
  if (state === 'approval')
    return '←/→ choose · Enter submit · y approve · a trust scope · n/Esc deny';
  // Keep running footer short — long multi-action strings fight the Working line.
  if (state === 'running') return 'Esc stop · Enter queue · /steer · /btw';
  return `${process.platform === 'darwin' ? 'Ctrl+V attach · ' : ''}paste file path + Enter · Tab complete · Up/Down history · Ctrl+O details · Ctrl+C exit`;
}

export function promptPlaceholder(state: TuiRunState): string {
  if (state === 'approval') return 'choose approval with arrows, Enter, y, a, n, or Esc';
  if (state === 'running') return 'running... /stop to cancel';
  return 'Ask Moss to write, explain, or debug code';
}

export function statusBadge(state: TuiRunState): string {
  if (state === 'approval') return 'approval needed';
  if (state === 'running') return 'running';
  return 'ready';
}

export function approvalKeyDecision(
  inputChar: string,
  key: { escape?: boolean }
): 'allow-once' | 'allow-always' | 'deny' | null {
  const normalized = inputChar.toLowerCase();
  if (key.escape || normalized === 'n') return 'deny';
  if (normalized === 'y') return 'allow-once';
  if (normalized === 'a') return 'allow-always';
  return null;
}

export function renderMemory(workspace: string): string {
  const paths = getMossWorkspacePaths(workspace);
  const memDir = paths.memoryDir;
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(memDir, 'index.json'), 'utf-8')) as Array<{
      id: string;
      content: string;
    }>;
    if (entries.length === 0)
      return 'Learned memories: none yet (saved automatically as you work).';
    const shown = entries
      .slice(0, 5)
      .map((entry) => `  • [${entry.id}] ${entry.content.slice(0, 80)}...`);
    return [`Learned memories: ${entries.length} (saved automatically as you work)`, ...shown].join(
      '\n'
    );
  } catch {
    return 'Learned memories: none yet (saved automatically as you work).';
  }
}

export function humanTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(Math.round(n));
}

/** Progressive color for context usage: green → amber → orange → red. */
export function ctxUsageBarColor(usage: { used: number; total: number }): string {
  const pct = usage.total > 0 ? (usage.used / usage.total) * 100 : 0;
  if (pct >= 90) return theme.error;
  if (pct >= 70) return theme.warn;
  if (pct >= 50) return theme.primarySoft;
  return theme.success;
}

export function activityLabel(event: MossAgentEvent): string | null {
  // 'compaction' is surfaced as a full transcript banner (with the kept-context
  // outline) by the event loop, not a one-word activity flash — see runPrompt.
  if (event.type === 'microcompact') return `compressed ${event.compressedCount} items`;
  return null;
}

export function toolOutcomeLabel(item: ActivityItem): string {
  if (!item.outcome) return '';
  if (item.outcome === 'ok' || item.outcome === 'suppressed' || item.outcome === 'replayed')
    return '';
  return `${item.outcome} · `;
}

export function transcriptColor(
  kind: TranscriptKind
): 'cyan' | 'red' | 'gray' | 'green' | 'magenta' | undefined {
  if (kind === 'user') return 'cyan';
  if (kind === 'error') return 'red';
  if (kind === 'shell') return 'green';
  if (kind === 'tool') return 'gray';
  if (kind === 'system') return 'gray';
  return undefined;
}

export function statusBarColor(state: TuiRunState): string {
  if (state === 'approval') return theme.warn;
  if (state === 'running') return theme.tool;
  return theme.success;
}
