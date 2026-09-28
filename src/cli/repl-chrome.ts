import type { MossAgentEvent } from '../core/index.js';
import type { SessionMeta } from '../core/session/session.js';
import type { CliRuntimeStatus } from './onboarding.js';
import { compactPath } from './ui.js';
import type { TuiRunState } from './transcript-types.js';

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

export function footerHint(state: TuiRunState): string {
  if (state === 'approval')
    return '←/→ choose · Enter submit · y approve · a trust scope · n/Esc deny';
  // Keep running footer short — long multi-action strings fight the Working line.
  if (state === 'running') return 'Esc stop · Enter queue · /steer · /btw';
  return `${process.platform === 'darwin' ? 'Ctrl+V attach · ' : ''}paste file path + Enter · Tab complete · Up/Down history · Ctrl+O details · Ctrl+C exit`;
}

export function statusBadge(state: TuiRunState): string {
  if (state === 'approval') return 'approval needed';
  if (state === 'running') return 'running';
  return 'ready';
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

export function activityLabel(event: MossAgentEvent): string | null {
  // 'compaction' is surfaced as a full transcript banner (with the kept-context
  // outline) by the event loop, not a one-word activity flash — see runPrompt.
  if (event.type === 'microcompact') return `compressed ${event.compressedCount} items`;
  return null;
}
