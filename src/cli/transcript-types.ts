import type { ToolResultOutcome } from '../core/index.js';

export type TranscriptKind = 'user' | 'assistant' | 'system' | 'error' | 'shell' | 'tool';
export type TuiRunState = 'ready' | 'running' | 'approval';

export interface ActivityItem {
  id: string;
  toolName: string;
  toolCallId: string;
  startedAt: number;
  status: 'running' | 'ok' | 'failed';
  inputSummary?: string;
  /** CC-style sub-line shown below the headline (e.g. "Added 7 lines, removed 1 line"). */
  inputSubline?: string;
  elapsedMs?: number;
  outcome?: ToolResultOutcome;
  inputRaw?: unknown;
  result?: string;
}

export interface TranscriptViewportRowsOptions {
  transcriptLength: number;
  terminalRows: number;
  headerRows: number;
  promptRows: number;
  queueRows: number;
  footerRows: number;
  approvalRows: number;
  noticeRows: number;
}

export interface AttachmentRef {
  index: number;
  kind: 'image' | 'file';
  label: string;
}

let lastTranscriptId = 0;

export function createTranscriptId(now = Date.now()): number {
  const timestamp = Number.isFinite(now) ? Math.trunc(now) : Date.now();
  lastTranscriptId = Math.max(lastTranscriptId + 1, timestamp);
  return lastTranscriptId;
}
