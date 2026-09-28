import type { Tool, ToolResultOutcome } from '../core/index.js';
import type { SessionMeta } from '../core/session/session.js';
import type { ModelChoiceList } from './model-catalog.js';

export type TranscriptKind = 'user' | 'assistant' | 'system' | 'error' | 'shell' | 'tool';
export type TuiRunState = 'ready' | 'running' | 'approval';

export interface TranscriptItem {
  id: number;
  kind: TranscriptKind;
  text: string;
  turnId?: number;
  status?: 'running' | 'ok' | 'failed';
  toolName?: string;
  toolCallId?: string;
  toolInput?: string;
  toolInputRaw?: unknown;
  startedAt?: number;
  elapsedMs?: number;
  outcome?: ToolResultOutcome;
  result?: string;
  finalized?: boolean;
  channel?: 'btw';
  /** Accumulated reasoning/thinking text for an assistant turn (rendered as a collapsible block). */
  thinking?: string;
}

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

export interface ModelPickerState {
  list: ModelChoiceList;
  selectedIndex: number;
}

export interface SessionPickerState {
  sessions: SessionMeta[];
  selectedIndex: number;
}

export interface ApprovalState {
  question: string;
  selectedIndex: number;
  resolve: (answer: string) => void;
}

/** TUI state for ask_user_question (not tool-approval y/a/n). */
export interface UserQuestionState {
  question: string;
  /** Parsed option labels (empty = freeform-only). */
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  selectedIndex: number;
  /** Multi-select: toggled option indices. */
  selectedIndices: number[];
  /** Freeform draft (Other / freeform-only). */
  freeform: string;
  masked?: boolean;
  resolve: (answer: string) => void;
}
export interface GoalActivityState {
  objective: string;
  startedAt: number;
  runCount: number;
  /** Live counters so long goal runs read as structured progress, not a spinner. */
  turns?: number;
  toolCalls?: number;
  lastCheckpoint?: { status: string; nextAction: string };
}

export interface RunPromptOptions {
  echoUser?: boolean;
  autoGoal?: boolean;
  ephemeralTools?: Tool[];
}

export interface GoalAutoRefState {
  running: boolean;
  suspended: boolean;
  scheduled: boolean;
  startedAt: number;
  runCount: number;
  objective: string;
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

export function nextId(): number {
  return createTranscriptId();
}
