import fs from 'node:fs';
import path from 'node:path';
import stringWidth from 'string-width';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { spawnProcess, type ChildProcess } from '../utils/run-process.js';
import type { MossAgentEvent, Tool, ToolResultOutcome } from '../core/index.js';
import type { SessionMeta } from '../core/session/session.js';
import type { PreparedPromptAttachment, PromptAttachmentBlock } from './attachments.js';
import type { CliRuntimeStatus } from './onboarding.js';
import { compactPath } from './ui.js';
import { highlight } from '../utils/syntax-highlight.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import { legacyTheme as theme } from './theme/theme.js';
import type { ModelChoiceList } from './model-catalog.js';
import { INTERACTIVE_COMPLETION_COMMANDS } from './interactive-commands.js';

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

export interface QueuedInput {
  raw: string;
  message: string;
  enqueuedAt?: number;
  attachments?: PreparedPromptAttachment[];
  attachmentBlocks?: PromptAttachmentBlock[];
}

export interface QueueDrainState {
  busy: boolean;
  approvalActive: boolean;
  pausedAfterCancel: boolean;
  queueLength: number;
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

// ────────────────────────────────────────────────────────────────────────────
// Theme & icons (headless agent-inspired warm, low-noise terminal palette)
// ────────────────────────────────────────────────────────────────────────────

// Glyphs — emoji at line-start only (never in alignment columns).
// Falls back to bracket tags when MOSS_TUI_NO_EMOJI=1 or terminal lacks UTF-8.
export function emojiEnabled(): boolean {
  if (process.env.MOSS_TUI_NO_EMOJI === '1') return false;
  const lang = `${process.env.LANG || ''} ${process.env.LC_ALL || ''} ${process.env.LC_CTYPE || ''}`;
  if (lang && !/utf-?8/i.test(lang)) return false;
  return true;
}

// Tool-call rows use agent UI `⏺` bullet and `⎿` result connector
// (see ActivityItemLine). The old per-tool emoji map and status glyphs were
// retired in favor of that single, consistent marker style.

// ────────────────────────────────────────────────────────────────────────────
// Sanitizers & helpers (unchanged public surface)
// ────────────────────────────────────────────────────────────────────────────

let lastTranscriptId = 0;

export function createTranscriptId(now = Date.now()): number {
  const timestamp = Number.isFinite(now) ? Math.trunc(now) : Date.now();
  lastTranscriptId = Math.max(lastTranscriptId + 1, timestamp);
  return lastTranscriptId;
}

export function nextId(): number {
  return createTranscriptId();
}

export const ANSI_RE = new RegExp(
  String.raw`\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))`,
  'g'
);
export const CONTROL_CHAR_RE = new RegExp(
  String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]`,
  'g'
);
export const LONG_TOKEN_RE = /[^\s]{33,}/g;
// CJK (incl. fullwidth punctuation) — these wrap naturally at every character,
// so the long-token breaker must leave them alone.
export const CJK_CHAR_RE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
export const COPY_SENSITIVE_TOKEN_RE =
  /^(?:https?:\/\/|file:\/\/|[A-Za-z]:\\|\/|\.\/|\.\.\/|[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+|[A-Za-z0-9_-]*_[A-Za-z0-9_-]*|\[[^\]\n]{1,160}\]\((?:https?:\/\/|file:\/\/)[^)]+\))/;
export const RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
export const LOCAL_SHELL_OUTPUT_LIMIT = 40_000;
export const MAX_INPUT_HISTORY = 100;
export const WELCOME_PANEL_ROWS_ESTIMATE = 18;
export const HEADLINE_MAX = 72;
export const DEFAULT_MARKDOWN_TABLE_WIDTH = 96;
export const MIN_MARKDOWN_TABLE_WIDTH = 40;
export const MAX_MARKDOWN_TABLE_WIDTH = 160;
export const MARKDOWN_TABLE_CELL = '\u001F';
export const MARKDOWN_TABLE_ROW = '\u001E';

export const AGENTS_MD_TEMPLATE = `# AGENTS.md

Project memory for Moss and coding agents. Auto-loaded at the start of every session.

## Overview
<!-- What this project is, in one or two sentences. -->

## Build / test / run
<!-- The exact commands an agent should use, e.g. install / build / test / lint. -->

## Layout
<!-- Top-level directories and what lives in each. -->

## Conventions
<!-- Code style, naming, patterns to follow, and things NOT to touch. -->
`;

export const KNOWN_COMMANDS = INTERACTIVE_COMPLETION_COMMANDS;

export { cliLocale, isZhLocale } from './cli-locale.js';

export function sanitizeTextForTerminal(
  text: string,
  options: { breakLongTokens: boolean }
): string {
  const withoutAnsi = text.includes('\x1B') ? text.replace(ANSI_RE, '') : text;
  const withoutControls = CONTROL_CHAR_RE.test(withoutAnsi)
    ? withoutAnsi.replace(CONTROL_CHAR_RE, '')
    : withoutAnsi;
  const binarySafe = withoutControls
    .split('\n')
    .map((line) => {
      const replacementCount = (line.match(/\uFFFD/g) ?? []).length;
      return replacementCount >= 12 && replacementCount / Math.max(1, line.length) > 0.2
        ? '[binary data omitted]'
        : line;
    })
    .join('\n');
  const tokenSafe = options.breakLongTokens
    ? binarySafe.replace(LONG_TOKEN_RE, (token) => {
        if (COPY_SENSITIVE_TOKEN_RE.test(token)) return token;
        // Chinese/Japanese/Korean prose contains no ASCII spaces, so whole
        // sentences match LONG_TOKEN_RE — injecting spaces every 24 chars
        // mangled them mid-word ("apply_pa tch", "read_f ile"). CJK has a
        // natural wrap point at every character; only space-free ASCII blobs
        // (base64, hashes, long URLs) actually need soft breaks.
        if (CJK_CHAR_RE.test(token)) return token;
        return token.replace(/(.{24})/g, '$1 ');
      })
    : binarySafe;
  return tokenSafe
    .split('\n')
    .map((line) => (RTL_RE.test(line) ? `\u2067${line}\u2069` : line))
    .join('\n');
}

export function sanitizeRenderableText(text: string): string {
  return sanitizeTextForTerminal(text, { breakLongTokens: true });
}

export function sanitizePromptEditorText(text: string): string {
  return sanitizeTextForTerminal(text, { breakLongTokens: false });
}

export function isLocalShellLine(raw: string): boolean {
  return raw.startsWith('!') && raw.trim() !== '!';
}

export function appendLimited(
  current: string,
  chunk: string,
  limit = LOCAL_SHELL_OUTPUT_LIMIT
): string {
  const next = `${current}${chunk}`;
  if (next.length <= limit) return next;
  return next.slice(-limit);
}

export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).unref();
      return;
    } catch {
      // Fall through to the direct child kill.
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The process may have exited before the group kill.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Process may have already exited.
  }
}

export function runLocalShellCommand(options: {
  command: string;
  cwd: string;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}): Promise<{ output: string; exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Local shell command aborted before start'));
      return;
    }
    let output = '';
    let settled = false;
    const child = spawnProcess(options.command, {
      cwd: options.cwd,
      shell: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, MOSS_TUI_LOCAL_SHELL: '1' },
    });
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const push = (chunk: Buffer) => {
      const text = sanitizeRenderableText(chunk.toString('utf8'));
      output = appendLimited(output, text);
      options.onChunk?.(text);
    };
    const onAbort = () => {
      killProcessTree(child);
      settle(() => reject(new Error('Local shell command aborted')));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code, signal) => {
      settle(() => resolve({ output, exitCode: code, signal }));
    });
  });
}

export function visibleText(text: string, maxLines = Number.POSITIVE_INFINITY): string {
  const clean = sanitizeRenderableText(text).trimEnd();
  if (!Number.isFinite(maxLines)) return clean;
  const lines = clean.split('\n');
  if (lines.length <= maxLines) return clean;
  return [
    `... ${lines.length - maxLines} earlier lines hidden ...`,
    ...lines.slice(-maxLines),
  ].join('\n');
}

export function truncateTerminalText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return '…';
  let out = '';
  for (const ch of Array.from(text)) {
    if (stringWidth(`${out}${ch}…`) > maxWidth) break;
    out += ch;
  }
  return `${out}…`;
}

/**
 * A stored conversation message, structurally typed so the resume-replay helpers
 * don't need to import the core session schema.
 * @internal
 */
export type ResumableMessage = {
  role: string;
  content: string | Array<{ type: string; text?: string; name?: string; input?: unknown }>;
};

/**
 * The human-readable text a user typed or the assistant said — drops tool_use /
 * tool_result blocks and internal goal checkpoints — so a resumed session can be
 * re-displayed as the conversation, not as raw protocol.
 * @internal
 */
export function resumedMessageText(message: ResumableMessage): string {
  const raw =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text ?? '')
          .join('\n');
  const text = raw.trim();
  if (!text || text.includes('<moss_working_context_checkpoint')) return '';
  return text;
}

/**
 * One-line summaries of the tool_use blocks in an assistant message, so a
 * resumed session can show WHAT the agent did on each turn (not just the prose)
 * — e.g. `⎿ edit_file (hello.js)`, `⎿ exec (node verify.js)`. Reuses toolHeadline
 * for the input summary. Returns [] for user messages or text-only turns.
 * @internal
 */
export function resumedToolLines(message: ResumableMessage): string[] {
  if (message.role !== 'assistant') return [];
  if (typeof message.content === 'string') return [];
  const lines: string[] = [];
  for (const block of message.content) {
    if (!block || block.type !== 'tool_use') continue;
    const name = typeof block.name === 'string' ? block.name : 'tool';
    const headline = toolHeadline(block.input);
    lines.push(headline ? `⎿ ${name} (${headline})` : `⎿ ${name}`);
  }
  return lines;
}

/** How many recent conversation turns /resume replays into the transcript. @internal */
export const RESUME_REPLAY_MAX = 24;

/**
 * Build the transcript rows that replay a resumed conversation's recent turns, so
 * resuming SHOWS the conversation (like Claude Code / Codex / opencode) instead of
 * a blank screen. Tool/checkpoint-only turns are dropped; returns the visible rows
 * plus how many older conversation turns were elided.
 *
 * Each assistant turn also emits a `system` row per tool_use block (via
 * resumedToolLines) so the user can see the agent's prior actions, not just its
 * prose — previously the replay stripped all tool calls and the user had no idea
 * what the agent had already done after resuming.
 * @internal
 */
export function buildResumeReplay(
  messages: ReadonlyArray<ResumableMessage>,
  max: number = RESUME_REPLAY_MAX
): { items: Array<{ kind: 'user' | 'assistant' | 'system'; text: string }>; hiddenCount: number } {
  const rows: Array<{ kind: 'user' | 'assistant' | 'system'; text: string }> = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = resumedMessageText(message);
    if (text) rows.push({ kind: message.role, text });
    // After an assistant turn's prose, surface the tools it called so the
    // resumed user can see the action history. (Skipped on user turns.)
    if (message.role === 'assistant') {
      for (const toolLine of resumedToolLines(message)) {
        rows.push({ kind: 'system', text: toolLine });
      }
    }
  }
  const hiddenCount = Math.max(0, rows.length - max);
  return { items: hiddenCount > 0 ? rows.slice(rows.length - max) : rows, hiddenCount };
}

export function formatQueueWait(enqueuedAt: number | undefined, now = Date.now()): string | null {
  if (enqueuedAt === undefined || !Number.isFinite(enqueuedAt)) return null;
  const waitMs = Math.max(0, now - enqueuedAt);
  if (waitMs < 1000) return '<1s';
  if (waitMs < 60_000) return `${Math.floor(waitMs / 1000)}s`;
  if (waitMs < 3_600_000) return `${Math.floor(waitMs / 60_000)}m`;
  return `${Math.floor(waitMs / 3_600_000)}h`;
}

export function queueItemKind(item: QueuedInput): string {
  if (isLocalShellLine(item.raw)) return 'local shell';
  if (item.message.startsWith('/')) return 'command';
  return 'prompt';
}

export function dropLastQueuedInput(items: QueuedInput[]): {
  next: QueuedInput[];
  dropped?: QueuedInput;
} {
  if (items.length === 0) return { next: [] };
  return {
    next: items.slice(0, -1),
    dropped: items[items.length - 1],
  };
}

export function queueItemMeta(item: QueuedInput, now = Date.now()): string {
  const lineCount = sanitizeRenderableText(item.message).split('\n').length;
  const charCount = sanitizeRenderableText(item.message).length;
  const wait = formatQueueWait(item.enqueuedAt, now);
  const attachmentCount = item.attachments?.length ?? 0;
  return [
    queueItemKind(item),
    wait ? `waiting ${wait}` : null,
    `${lineCount} line${lineCount === 1 ? '' : 's'}`,
    `${charCount} chars`,
    attachmentCount > 0 ? `${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function shouldDrainQueue(state: QueueDrainState): boolean {
  return !state.busy && !state.approvalActive && !state.pausedAfterCancel && state.queueLength > 0;
}

export class SerialQueueDrain {
  private running = false;

  isRunning(): boolean {
    return this.running;
  }

  async run(task: () => Promise<void>): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await task();
      return true;
    } finally {
      this.running = false;
    }
  }
}

export function stopRequestedMessage(queueLength: number): string {
  if (queueLength > 0) {
    return `Stopping current run… ${queueLength} queued prompt${queueLength === 1 ? '' : 's'} will run next — /queue drop to discard the next, /queue clear to discard all.`;
  }
  return 'Stopping current run…';
}

export function queueResumedMessage(queueLength: number): string {
  if (queueLength > 0) {
    return `Queue resumed (${queueLength} item${queueLength === 1 ? '' : 's'} waiting).`;
  }
  return 'Queue resumed.';
}

export function queuePausedSubmissionMessage(queueLength: number, message: string): string {
  return `Queued #${queueLength}; queue remains paused until /queue resume: ${message}`;
}

export function isQueueControlCommand(message: string): boolean {
  return (
    message === '/queue' ||
    message === '/queued' ||
    message === '/queue pause' ||
    message === '/queue drop' ||
    message === '/queue pop' ||
    message === '/queue clear' ||
    message === '/clearqueue' ||
    message === '/queue resume' ||
    message === '/queue continue'
  );
}

export function isImmediateGoalCommand(message: string): boolean {
  return (
    message === '/goal clear' ||
    message === '/goal pause' ||
    message === '/goal complete' ||
    message.startsWith('/goal complete ') ||
    message === '/goal block' ||
    message.startsWith('/goal block ')
  );
}

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

export function extractAttachmentRefs(text: string): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  const seen = new Set<string>();
  const re = /\[((?:Image|File) #(\d+))\]/g;
  for (const match of text.matchAll(re)) {
    const label = match[1] || '';
    if (seen.has(label)) continue;
    seen.add(label);
    refs.push({
      index: Number(match[2]),
      kind: label.startsWith('Image') ? 'image' : 'file',
      label,
    });
  }
  return refs;
}

export function attachmentRefIndexes(text: string): Set<number> {
  return new Set(extractAttachmentRefs(text).map((ref) => ref.index));
}

export function removeAttachmentRefsFromInput(value: string): string {
  return value
    .replace(/\s*\[(?:Image|File)(?: #\d*)?\]?/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trimEnd();
}

export function inputWithAttachmentRefs(
  value: string,
  attachments: PreparedPromptAttachment[]
): string {
  const refs = attachments
    .map((item) => `[${item.kind === 'image' ? 'Image' : 'File'} #${item.index}]`)
    .join(' ');
  if (!refs) return value;
  const trimmed = value.trimEnd();
  return `${trimmed ? `${trimmed} ` : ''}${refs} `;
}

export function blockCountForAttachment(item: PreparedPromptAttachment): number {
  return item.kind === 'image' ? 2 : 1;
}

export function selectReferencedPromptAttachments(
  text: string,
  attachments: PreparedPromptAttachment[],
  blocks: PromptAttachmentBlock[]
): { attachments: PreparedPromptAttachment[]; blocks: PromptAttachmentBlock[] } {
  const keep = attachmentRefIndexes(text);
  if (keep.size === 0) return { attachments: [], blocks: [] };
  const nextAttachments: PreparedPromptAttachment[] = [];
  const nextBlocks: PromptAttachmentBlock[] = [];
  let blockOffset = 0;
  for (const item of attachments) {
    const blockCount = blockCountForAttachment(item);
    const itemBlocks = blocks.slice(blockOffset, blockOffset + blockCount);
    blockOffset += blockCount;
    if (!keep.has(item.index)) continue;
    nextAttachments.push(item);
    nextBlocks.push(...itemBlocks);
  }
  return { attachments: nextAttachments, blocks: nextBlocks };
}

export function formatAttachmentChip(ref: AttachmentRef): string {
  return `[${ref.label}] ${ref.kind}`;
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

export function editorPreviewLines(value: string, placeholder: string, maxLines = 8): string[] {
  if (!value) return [placeholder];
  const normalized = sanitizeRenderableText(value).replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length <= maxLines) return lines;
  return [`... ${lines.length - maxLines} earlier input lines ...`, ...lines.slice(-maxLines)];
}

export interface PromptEditState {
  value: string;
  cursor: number;
}

export type PromptEditIntent =
  | { type: 'insert'; text: string }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'killBefore' }
  | { type: 'killAfter' }
  | { type: 'deletePreviousWord' };

export function clampPromptCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.max(0, Math.min(value.length, Math.trunc(cursor)));
}

interface GraphemeSegment {
  index: number;
  segment: string;
}

type GraphemeSegmenter = {
  segment(input: string): Iterable<GraphemeSegment>;
};

type GraphemeSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: 'grapheme' }
) => GraphemeSegmenter;

export const NativeSegmenter = (Intl as typeof Intl & { Segmenter?: GraphemeSegmenterConstructor })
  .Segmenter;
const graphemeSegmenter = NativeSegmenter
  ? new NativeSegmenter(undefined, { granularity: 'grapheme' })
  : null;

export function codePointSegments(value: string): GraphemeSegment[] {
  const segments: GraphemeSegment[] = [];
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    const length = codePoint && codePoint > 0xffff ? 2 : 1;
    segments.push({ index, segment: value.slice(index, index + length) });
    index += length;
  }
  return segments;
}

export function graphemeSegments(value: string): GraphemeSegment[] {
  if (!value) return [];
  return graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(value))
    : codePointSegments(value);
}

export function previousGraphemeStart(value: string, cursor: number): number {
  const index = clampPromptCursor(value, cursor);
  if (index <= 0) return 0;
  let previous = 0;
  for (const segment of graphemeSegments(value)) {
    if (segment.index >= index) break;
    previous = segment.index;
  }
  return previous;
}

export function nextGraphemeEnd(value: string, cursor: number): number {
  const index = clampPromptCursor(value, cursor);
  if (index >= value.length) return value.length;
  for (const segment of graphemeSegments(value)) {
    const end = segment.index + segment.segment.length;
    if (end > index) return end;
  }
  return value.length;
}

export function previousWordStart(value: string, cursor: number): number {
  let index = clampPromptCursor(value, cursor);
  while (index > 0 && /\s/.test(value[index - 1] || '')) index -= 1;
  while (index > 0 && !/\s/.test(value[index - 1] || '')) index -= 1;
  return index;
}

export function applyPromptEdit(state: PromptEditState, intent: PromptEditIntent): PromptEditState {
  const value = state.value;
  const cursor = clampPromptCursor(value, state.cursor);
  switch (intent.type) {
    case 'insert': {
      const text = intent.text.replace(/\r\n?/g, '\n');
      return {
        value: `${value.slice(0, cursor)}${text}${value.slice(cursor)}`,
        cursor: cursor + text.length,
      };
    }
    case 'left':
      return { value, cursor: previousGraphemeStart(value, cursor) };
    case 'right':
      return { value, cursor: nextGraphemeEnd(value, cursor) };
    case 'home':
      return { value, cursor: 0 };
    case 'end':
      return { value, cursor: value.length };
    case 'backspace':
      if (cursor === 0) return { value, cursor };
      {
        // Check if the cursor is right after an attachment token like [Image #1] or @[file.ts]
        // and delete the whole token atomically instead of char-by-char.
        const beforeCursor = value.slice(0, cursor);
        const attachTokenMatch = beforeCursor.match(/(\[(?:Image|File)\s+#\d+\]|@\[[^\]]+\])\s*$/);
        if (attachTokenMatch) {
          const tokenStart = cursor - attachTokenMatch[0].length;
          return {
            value: `${value.slice(0, tokenStart)}${value.slice(cursor)}`,
            cursor: tokenStart,
          };
        }
        const start = previousGraphemeStart(value, cursor);
        return { value: `${value.slice(0, start)}${value.slice(cursor)}`, cursor: start };
      }
    case 'delete':
      if (cursor >= value.length) return { value, cursor };
      return {
        value: `${value.slice(0, cursor)}${value.slice(nextGraphemeEnd(value, cursor))}`,
        cursor,
      };
    case 'killBefore':
      return { value: value.slice(cursor), cursor: 0 };
    case 'killAfter':
      return { value: value.slice(0, cursor), cursor };
    case 'deletePreviousWord': {
      const start = previousWordStart(value, cursor);
      return { value: `${value.slice(0, start)}${value.slice(cursor)}`, cursor: start };
    }
  }
}

export function shouldPromptReturnInsertNewline(key: { shift?: boolean; ctrl?: boolean }): boolean {
  return Boolean(key.shift);
}

interface EditorPreviewLine {
  text: string;
  /** Terminal display cells from line start to cursor, not a UTF-16 index. */
  cursorColumn: number | null;
}

interface LineViewportResult {
  text: string;
  cursorColumn: number;
}

interface DisplaySegment {
  segment: string;
  startColumn: number;
  endColumn: number;
}

export function displaySegments(value: string): DisplaySegment[] {
  const segments: DisplaySegment[] = [];
  let column = 0;
  for (const { segment } of graphemeSegments(value)) {
    const width = stringWidth(segment);
    segments.push({ segment, startColumn: column, endColumn: column + width });
    column += width;
  }
  return segments;
}

export function lineViewportAroundCursor(
  text: string,
  cursorColumn: number,
  maxWidth?: number
): LineViewportResult {
  if (!maxWidth || !Number.isFinite(maxWidth)) return { text, cursorColumn };
  const width = Math.max(1, Math.trunc(maxWidth));
  const lineWidth = stringWidth(text);
  const safeCursor = Math.max(0, Math.min(lineWidth, cursorColumn));
  if (lineWidth <= width) return { text, cursorColumn: safeCursor };

  const startTarget = safeCursor > width ? safeCursor - width : 0;
  const segments = displaySegments(text);
  let startIndex = segments.findIndex((segment) => segment.startColumn >= startTarget);
  if (startIndex < 0) startIndex = Math.max(0, segments.length - 1);
  const visibleStart = segments[startIndex]?.startColumn ?? 0;
  let visibleWidth = 0;
  let visibleText = '';
  for (const segment of segments.slice(startIndex)) {
    const segmentWidth = segment.endColumn - segment.startColumn;
    if (visibleText && visibleWidth + segmentWidth > width) break;
    if (!visibleText && segmentWidth > width) break;
    visibleText += segment.segment;
    visibleWidth += segmentWidth;
  }

  return {
    text: visibleText,
    cursorColumn: Math.max(0, Math.min(width, safeCursor - visibleStart)),
  };
}

export function editorPreviewLinesWithCursor(
  value: string,
  _placeholder: string,
  cursor: number,
  maxLines = 8,
  maxLineWidth?: number
): EditorPreviewLine[] {
  if (!value) return [{ text: '', cursorColumn: 0 }];
  const normalized = sanitizePromptEditorText(value).replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const normalizedCursor = clampPromptCursor(value, cursor);
  const normalizedBeforeCursor = sanitizePromptEditorText(value.slice(0, normalizedCursor)).replace(
    /\r\n?/g,
    '\n'
  );
  const cursorLineIndex = normalizedBeforeCursor.split('\n').length - 1;
  const cursorColumn = stringWidth(
    normalizedBeforeCursor.slice(normalizedBeforeCursor.lastIndexOf('\n') + 1)
  );
  const fitLine = (line: string, lineCursorColumn: number | null): EditorPreviewLine => {
    const viewport = lineViewportAroundCursor(
      line,
      lineCursorColumn ?? stringWidth(line),
      maxLineWidth
    );
    return {
      text: viewport.text,
      cursorColumn: lineCursorColumn === null ? null : viewport.cursorColumn,
    };
  };
  if (lines.length <= maxLines) {
    return lines.map((line, index) =>
      fitLine(line, index === cursorLineIndex ? cursorColumn : null)
    );
  }
  const hiddenCount = lines.length - maxLines;
  return [
    { text: `... ${hiddenCount} earlier input lines ...`, cursorColumn: null },
    ...lines.slice(-maxLines).map((line, index) => {
      const originalIndex = hiddenCount + index;
      return fitLine(line, originalIndex === cursorLineIndex ? cursorColumn : null);
    }),
  ];
}

export function commandSuggestion(command: string): string | null {
  const normalized = command.trim().toLowerCase();
  if (!normalized.startsWith('/')) return null;
  const firstMeaningfulChar = normalized.replace(/^\//, '')[0] ?? '';
  const preferSubcommand = normalized.includes(' ');
  const scored = KNOWN_COMMANDS.map((known, index) => {
    const prefixMatch = known.startsWith(normalized) || normalized.startsWith(known);
    if (prefixMatch) return { known, score: 0, prefixMatch, index };
    const knownToken = known.replace(/^\//, '');
    const knownFirstChar = knownToken[0] ?? '';
    if (!firstMeaningfulChar || knownFirstChar !== firstMeaningfulChar) {
      return { known, score: Number.POSITIVE_INFINITY, prefixMatch, index };
    }
    const score = editDistance(known, normalized);
    return { known, score, prefixMatch, index };
  }).sort(
    (a, b) =>
      a.score - b.score ||
      Number(b.prefixMatch) - Number(a.prefixMatch) ||
      (a.prefixMatch && b.prefixMatch
        ? preferSubcommand
          ? b.known.length - a.known.length
          : a.index - b.index
        : a.index - b.index)
  );
  const best = scored[0];
  return best && best.score <= 2 ? best.known : null;
}

export function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost
      );
    }
  }
  return rows[a.length]![b.length]!;
}

export function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0] || '';
  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

export function completeSlashCommandInput(value: string, cursor: number): PromptEditState | null {
  const currentCursor = clampPromptCursor(value, cursor);
  const beforeCursor = value.slice(0, currentCursor);
  const afterCursor = value.slice(currentCursor);
  if (!beforeCursor.startsWith('/')) return null;
  if (afterCursor && !/^\s/.test(afterCursor)) return null;

  const normalized = beforeCursor.toLowerCase();
  const exactCandidates = KNOWN_COMMANDS.filter((command) => command.startsWith(normalized));
  if (/\s/.test(beforeCursor) && exactCandidates.length === 0) return null;
  const prefixCompletion = exactCandidates.length > 0 ? commonPrefix(exactCandidates) : '';
  const completion =
    prefixCompletion && prefixCompletion !== beforeCursor
      ? prefixCompletion
      : beforeCursor.length >= 4
        ? commandSuggestion(normalized)
        : prefixCompletion;
  if (!completion || completion === beforeCursor) return null;
  return {
    value: `${completion}${afterCursor}`,
    cursor: completion.length,
  };
}

export function commandArgumentHint(value: string): string | null {
  const normalized = value.trimStart().toLowerCase();
  if (!normalized.startsWith('/')) return null;
  const [command, ...rest] = normalized.split(/\s+/);
  const hasArg = rest.some(Boolean);
  if (command === '/attach') return hasArg ? null : '<image-or-text-file>';
  if (command === '/model') return hasArg ? null : '<model-name-or-number>';
  if (command === '/auth') return hasArg ? null : '[status | logout]';
  if (command === '/status') return hasArg ? null : '[--verbose]';
  if (command === '/compact') return hasArg ? null : '[instructions]';
  if (command === '/steer') return hasArg ? null : '<constraint>';
  return null;
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

export function summarizeToolInput(input: unknown, maxChars = 80): string {
  if (input === undefined || input === null) return '';
  let raw: string;
  try {
    raw = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    raw = String(input);
  }
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Pull the most informative arg out of a tool input for the headline.
 * Examples:
 *   `{ path: 'src/foo.ts' }` → 'src/foo.ts'
 *   `{ command: 'npm run build' }` → 'npm run build'
 *   `{ query: 'authStore' }` → 'authStore'
 *   `{ url: 'https://...' }` → 'https://...'
 * Falls back to summarizeToolInput.
 */
export function toolHeadline(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return summarizeToolInput(input, HEADLINE_MAX);
  if (typeof input !== 'object') return String(input);
  const obj = input as Record<string, unknown>;
  const preferred = [
    'path',
    'file_path',
    'filepath',
    'file',
    'command',
    'cmd',
    'query',
    'pattern',
    'url',
    'symbol',
    'task',
    'description',
    'subject',
  ];
  for (const key of preferred) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      const compact = value.replace(/\s+/g, ' ').trim();
      return compact.length > HEADLINE_MAX
        ? `${compact.slice(0, HEADLINE_MAX - 1).trimEnd()}…`
        : compact;
    }
  }
  return summarizeToolInput(input, HEADLINE_MAX);
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

let markdownRendererConfigured = false;
let activeMarkdownRenderWidth: number | undefined;

export function resolveMarkdownTableWidth(): number {
  const rawWidth =
    activeMarkdownRenderWidth ?? process.stdout.columns ?? DEFAULT_MARKDOWN_TABLE_WIDTH;
  // Transcript lines are indented by Ink and still need one spare column to
  // avoid the terminal's automatic wrap at the right edge. Rendering against
  // the full TTY width made table dividers spill onto a second line at 80 cols.
  const width = Number.isFinite(rawWidth) ? Math.floor(rawWidth) - 3 : DEFAULT_MARKDOWN_TABLE_WIDTH;
  return Math.max(MIN_MARKDOWN_TABLE_WIDTH, Math.min(MAX_MARKDOWN_TABLE_WIDTH, width));
}

export function markdownTableCellText(content: unknown, context: unknown): string {
  if (content && typeof content === 'object') {
    const maybeTokens = (content as { tokens?: unknown[] }).tokens;
    const parser = (context as { parser?: { parseInline?: (tokens: unknown[]) => string } }).parser;
    if (Array.isArray(maybeTokens) && typeof parser?.parseInline === 'function') {
      return parser.parseInline(maybeTokens);
    }
    if ('text' in content) {
      const raw = String((content as { text?: unknown }).text ?? '');
      // Decode basic HTML entities that marked inserts during parsing
      return raw
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
    }
  }
  return String(content ?? '');
}

export function markdownTableTokenRows(content: unknown, context: unknown): string {
  if (!Array.isArray(content)) return '';
  const rows = Array.isArray(content[0]) ? content : [content];
  return rows
    .map((row) => {
      if (!Array.isArray(row)) return '';
      const cells = row.map(
        (cell) => `${markdownTableCellText(cell, context)}${MARKDOWN_TABLE_CELL}`
      );
      return `${MARKDOWN_TABLE_ROW}${cells.join('')}${MARKDOWN_TABLE_ROW}`;
    })
    .filter(Boolean)
    .join('\n');
}

export function renderMarkdownTableFromRendererArgs(args: unknown[], context: unknown): string {
  const [first, second] = args;
  if (args.length === 1 && first && typeof first === 'object') {
    const token = first as { header?: unknown; rows?: unknown };
    if ('header' in token || 'rows' in token) {
      return renderTerminalFriendlyMarkdownTable(
        markdownTableTokenRows(token.header, context),
        markdownTableTokenRows(token.rows, context)
      );
    }
  }
  return renderTerminalFriendlyMarkdownTable(String(first ?? ''), String(second ?? ''));
}

export function cleanMarkdownTableCell(cell: string): string {
  const withoutAnsi = cell.includes('\x1B') ? cell.replace(ANSI_RE, '') : cell;
  const withoutControls = CONTROL_CHAR_RE.test(withoutAnsi)
    ? withoutAnsi.replace(CONTROL_CHAR_RE, '').trim()
    : withoutAnsi.trim();
  // Decode HTML entities that marked inserts during parsing
  return withoutControls
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

export function splitMarkdownTableRows(text: string): string[][] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const unwrapped = line.split(MARKDOWN_TABLE_ROW).join('');
      const cells = unwrapped.split(MARKDOWN_TABLE_CELL);
      if (cells[cells.length - 1] === '') cells.pop();
      return cells.map(cleanMarkdownTableCell);
    })
    .filter((row) => row.length > 0);
}

export function splitWideWord(word: string, width: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const char of Array.from(word)) {
    const next = `${current}${char}`;
    if (current && stringWidth(next) > width) {
      parts.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function wrapMarkdownTableCell(value: string, width: number): string[] {
  const text = value.replace(/、\s*/g, '、 ').replace(/\s+/g, ' ').trim();
  if (!text) return [''];

  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    const pieceWidth = COPY_SENSITIVE_TOKEN_RE.test(word) ? width : Math.min(width, 32);
    const pieces = stringWidth(word) > pieceWidth ? splitWideWord(word, pieceWidth) : [word];
    for (const piece of pieces) {
      if (!current) {
        current = piece;
      } else if (stringWidth(`${current} ${piece}`) <= width) {
        current = `${current} ${piece}`;
      } else {
        lines.push(current);
        current = piece;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

export function padMarkdownTableCell(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - stringWidth(value)))}`;
}

export function markdownTableColumnWidths(rows: string[][], tableWidth: number): number[] {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const separatorWidth = Math.max(0, columnCount - 1) * 3;
  const available = Math.max(columnCount * 3, tableWidth - separatorWidth);
  const fairWidth = Math.max(3, Math.floor(available / columnCount));
  const desired = Array.from({ length: columnCount }, (_, index) =>
    Math.max(3, ...rows.map((row) => stringWidth(row[index] ?? '')))
  );
  const widths = desired.map((width) => Math.min(width, fairWidth));
  let remaining = available - widths.reduce((sum, width) => sum + width, 0);

  while (remaining > 0) {
    let bestIndex = -1;
    let bestDeficit = 0;
    for (let index = 0; index < desired.length; index += 1) {
      const deficit = desired[index] - widths[index];
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    widths[bestIndex] += 1;
    remaining -= 1;
  }

  return widths;
}

export function renderMarkdownTableRows(rows: string[][], widths: number[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    const wrapped = widths.map((width, index) => wrapMarkdownTableCell(row[index] ?? '', width));
    const rowHeight = Math.max(1, ...wrapped.map((cell) => cell.length));
    for (let lineIndex = 0; lineIndex < rowHeight; lineIndex += 1) {
      lines.push(
        widths
          .map((width, columnIndex) =>
            padMarkdownTableCell(wrapped[columnIndex][lineIndex] ?? '', width)
          )
          .join(' | ')
          .trimEnd()
      );
    }
  }
  return lines;
}

export function shouldStackMarkdownTable(rows: string[][], tableWidth: number): boolean {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  if (columnCount < 3) return false;
  const separatorWidth = Math.max(0, columnCount - 1) * 3;
  const fairWidth = Math.floor((tableWidth - separatorWidth) / columnCount);
  const hasVerboseCell = rows.some((row) =>
    row.some((cell) => stringWidth(cell) > fairWidth * 1.5)
  );
  return fairWidth < 18 || (tableWidth <= 90 && hasVerboseCell);
}

export function renderStackedMarkdownTable(header: string[], rows: string[][]): string {
  return (
    rows
      .map((row, rowIndex) => {
        const title = row[0]?.trim() || `Row ${rowIndex + 1}`;
        const fields = header
          .slice(1)
          .map(
            (label, columnIndex) =>
              `   ${label || `Column ${columnIndex + 2}`}： ${row[columnIndex + 1] ?? ''}`
          );
        return [`${rowIndex + 1}. ${title}`, ...fields].join('\n');
      })
      .join('\n\n') + '\n\n'
  );
}

export function renderTerminalFriendlyMarkdownTable(headerText: string, bodyText: string): string {
  const headerRows = splitMarkdownTableRows(headerText);
  const bodyRows = splitMarkdownTableRows(bodyText);
  const rows = [...headerRows, ...bodyRows];
  if (rows.length === 0) return '';

  const tableWidth = resolveMarkdownTableWidth();
  if (
    headerRows.length === 1 &&
    bodyRows.length > 0 &&
    shouldStackMarkdownTable(rows, tableWidth)
  ) {
    return renderStackedMarkdownTable(headerRows[0], bodyRows);
  }
  const widths = markdownTableColumnWidths(rows, tableWidth);
  const separator = widths.map((width) => '─'.repeat(width)).join('─┼─');
  return (
    [
      ...renderMarkdownTableRows(headerRows, widths),
      separator,
      ...renderMarkdownTableRows(bodyRows, widths),
    ].join('\n') + '\n\n'
  );
}

export function ensureMarkdownRenderer(): void {
  if (markdownRendererConfigured) return;
  marked.setOptions({ mangle: false, headerIds: false } as Parameters<typeof marked.setOptions>[0]);
  // marked-terminal's runtime extension shape is valid for marked.use(), but
  // its current .d.ts does not model the MarkedExtension intersection.
  // Tone down the default colors so the outer theme drives accent — code/quote
  // become dim, headings keep bold so they remain scannable.
  // Use direct ANSI cyan for codespan (inline `code`) — ui.cyan uses picocolors
  // which gates on stdout.isTTY, but Ink intercepts stdout so it's always false.
  const { env: _pe } = process;
  const _ansiEnabled =
    !_pe.NO_COLOR &&
    (!!_pe.FORCE_COLOR ||
      !!_pe.COLORTERM ||
      Boolean((process.stdout as NodeJS.WriteStream).isTTY) ||
      Boolean((process.stderr as NodeJS.WriteStream).isTTY));
  const _cyanAnsi = _ansiEnabled ? (s: string) => `\x1b[36m${s}\x1b[39m` : (s: string) => s;
  // dim gray for blockquotes — also uses direct ANSI so it works in Ink TUI
  const _dimAnsi = _ansiEnabled ? (s: string) => `\x1b[2m${s}\x1b[22m` : (s: string) => s;

  const terminalMarkdown = markedTerminal({
    reflowText: false,
    // `code` option here is only used as a FALLBACK by marked-terminal when
    // cli-highlight throws — it is NOT the primary code renderer. We override
    // terminalRenderer.code below with our own highlight.js implementation.
    blockquote: _dimAnsi,
    codespan: _cyanAnsi,
    // Override paragraph to identity — avoids chalk.reset() wrap which emits
    // \x1b[0m...\x1b[0m and clears the parent Ink <Text color={theme.text}>.
    // NOTE: marked-terminal's paragraph function still calls parseInline(tokens)
    // BEFORE this transform, so HTML entities (&#39; etc.) are decoded correctly.
    paragraph: (s: string) => s,
  }) as unknown as Parameters<typeof marked.use>[0] & {
    renderer: Record<string, (this: unknown, ...args: unknown[]) => string>;
  };
  const terminalRenderer = terminalMarkdown.renderer as Record<
    string,
    (this: unknown, ...args: unknown[]) => string
  >;

  // Override code block renderer to use our highlight.js implementation.
  // marked-terminal's internal `Renderer.prototype.code` delegates to
  // cli-highlight which does its own chalk-based TTY detection — bypassing
  // our ANSI color setup. By replacing the renderer method here we ensure
  // highlight() (with direct ANSI codes, not picocolors) is always used.
  terminalRenderer.code = function code(token: unknown): string {
    // marked v3+ passes a token object: { raw, text, lang }
    // Older versions pass (text, lang, escaped) as separate args.
    let codeText: string;
    let lang: string | undefined;
    if (token && typeof token === 'object' && 'text' in (token as object)) {
      const t = token as { text: string; lang?: string };
      codeText = t.text;
      lang = t.lang || undefined;
    } else {
      codeText = String(token);
    }
    try {
      const highlighted = highlight(codeText, { language: lang });
      // Add a left border bar (┃) to visually separate the code block from
      // surrounding prose — a lightweight version of CC's code block styling.
      const border = '\x1b[90m┃\x1b[39m '; // dim gray bar
      const lines = highlighted.split('\n');
      return lines.map((l) => `${border}${l}`).join('\n') + '\n\n';
    } catch {
      const border = '\x1b[90m┃\x1b[39m ';
      return (
        codeText
          .split('\n')
          .map((l) => `${border}${l}`)
          .join('\n') + '\n\n'
      );
    }
  };

  // Headings inherit the terminal foreground color. Hard-coding bright white
  // (`ANSI 97`) makes headings nearly invisible on light terminals; weight and
  // spacing provide the hierarchy without assuming a background color.
  terminalRenderer.heading = function heading(token: unknown): string {
    let text = '';
    if (token && typeof token === 'object') {
      const t = token as { text?: string };
      text = t.text ?? '';
    } else {
      text = String(token);
    }
    const formatted = `\x1b[1m${text}\x1b[22m`;
    return `\n${formatted}\n\n`;
  };

  // Override hr to render as a short dim separator instead of marked-terminal's
  // default full-width chalk.gray(new Array(cols).join('-')) which fills the
  // entire terminal width with dashes and is visually overwhelming.
  terminalRenderer.hr = function hr(): string {
    return `\n\x1b[2m${'─'.repeat(32)}\x1b[22m\n\n`;
  };

  // NOTE: Do NOT override paragraph. marked-terminal's default paragraph
  // renderer uses chalk.reset() which wraps text in \x1b[0m...\x1b[0m and
  // also decodes HTML entities (&#39; → ', &amp; → &, etc.) that marked
  // produces during parsing. Without the chalk wrapper, entities like &#39;
  // appear literally in the output, breaking apostrophes and quotes.

  // Lists use marked-terminal's native rendering ("* item", numbered ordered
  // lists, correct nesting). Do NOT try to swap the bullet glyph: a `listitem`
  // OPTION is a style hook applied INSIDE the default "* " prefix (the old
  // double-bullet bug, "*   • item"), and rewriting at the list/listitem
  // renderer level breaks ordered numbering or nested-list line structure
  // because outer lists re-process inner lists' already-rendered text.
  terminalRenderer.tablecell = function tablecell(content: unknown) {
    return `${markdownTableCellText(content, this)}${MARKDOWN_TABLE_CELL}`;
  };
  terminalRenderer.tablerow = function tablerow(content: unknown) {
    const text = markdownTableCellText(content, this);
    return `${MARKDOWN_TABLE_ROW}${text}${MARKDOWN_TABLE_ROW}\n`;
  };
  terminalRenderer.table = function table(...args: unknown[]) {
    return renderMarkdownTableFromRendererArgs(args, this);
  };
  marked.use(terminalMarkdown);
  markdownRendererConfigured = true;
}

export function renderMarkdown(text: string, options: { width?: number } = {}): string {
  ensureMarkdownRenderer();
  const previousWidth = activeMarkdownRenderWidth;
  activeMarkdownRenderWidth = options.width;
  try {
    // Sanitize the INPUT markdown source (LLM text) to strip ANSI escape
    // injections. Use breakLongTokens: false to preserve markdown syntax —
    // breakLongTokens inserts spaces every 24 chars which corrupts long URLs
    // like [text](https://long-url) and long inline `code` spans.
    // The output is NOT sanitized so code block syntax colors survive.
    const sanitizedInput = sanitizeTextForTerminal(text, { breakLongTokens: false });
    return (marked.parse(sanitizedInput) as string).trimEnd();
  } finally {
    activeMarkdownRenderWidth = previousWidth;
  }
}

/**
 * Render markdown for streaming (in-progress) text.
 *
 * Strategy: split the text at code block boundaries. Complete code blocks
 * (opened AND closed with three-backtick fences) are syntax-highlighted via renderMarkdown.
 * The incomplete trailing portion (no closing fence) is shown as raw text so
 * the streaming cursor stays at the natural insertion point rather than
 * disappearing mid-fence.
 *
 * This makes code visible with colors as soon as a block is complete, instead
 * of waiting for the full message to finalize.
 */
export function renderStreamingMarkdown(text: string): string {
  // Split at complete fenced code blocks. A "complete" block has both an
  // opening ``` (optionally with a language) and a closing ```.
  // Strategy: find the last un-matched ``` and split there.
  const fenceRe = /^```/gm;
  let fenceCount = 0;
  let lastUnclosedFence = -1;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(text)) !== null) {
    fenceCount++;
    if (fenceCount % 2 === 1) {
      // Opening fence
      lastUnclosedFence = match.index;
    } else {
      // Closing fence — clear the marker
      lastUnclosedFence = -1;
    }
  }

  if (lastUnclosedFence === -1) {
    // All code blocks are complete — render the full text with markdown.
    try {
      return renderMarkdown(text);
    } catch {
      return sanitizeRenderableText(text);
    }
  }

  // There's an unclosed code block. Split: render everything before the
  // unclosed fence with full markdown, then show the tail as raw text.
  const completed = text.slice(0, lastUnclosedFence);
  const streaming = text.slice(lastUnclosedFence);

  const renderedPrefix = completed
    ? (() => {
        try {
          return renderMarkdown(completed);
        } catch {
          return sanitizeRenderableText(completed);
        }
      })()
    : '';

  // Show the streaming code block as dim raw text (no colors yet — block is
  // incomplete). Strip the fence marker for readability during streaming.
  const rawCode = sanitizeRenderableText(streaming);

  return renderedPrefix ? `${renderedPrefix}\n${rawCode}` : rawCode;
}
