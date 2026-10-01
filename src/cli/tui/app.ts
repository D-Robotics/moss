/**
 * moss CLI shell (v0.22) — the interactive face for TTY sessions.
 *
 * Deliberately the same shape as Claude Code / codex: ONE column. Finished
 * transcript rows are committed to the terminal's own scrollback through ink's
 * `<Static>` (so history survives and terminal selection/copy keeps working),
 * while a small live region, the composer and the status chrome stay pinned at
 * the bottom. There are no side panels and no full-screen overlays: everything
 * the user needs is printed into the conversation where it happened.
 *
 * This module (and only this directory) statically imports ink/react; every
 * entry point must dynamically import it so headless/SDK paths never load UI
 * dependencies. Non-TTY or `--no-tty` sessions fall back to the readline REPL.
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import {
  render,
  Box,
  Static,
  Text,
  useApp,
  useInput,
  useStdin,
  useStdout,
  useWindowSize,
} from 'ink';
import type { MossAgent } from '../../core/agent/moss-agent.js';
import { TaskRuntime, formatDeploymentLine } from '../../core/task-runtime/runtime.js';
import { errorMessage } from '../../errors.js';
import {
  applyAgentEvent,
  appendRow,
  beginRun,
  createTuiStore,
  endRun,
  usageBlock,
  type TranscriptRow,
  type TuiUsageState,
} from './render-bridge.js';
import { createPasteCapture, feedChunk } from './input-box.js';
import {
  getBackgroundProcessOutputTail,
  listBackgroundProcessSnapshots,
  subscribeBackgroundLifecycle,
} from '../../core/tools/background-process-registry.js';
import { formatBackgroundCompletionFlash } from '../background-completion-ui.js';
import { isZhLocale } from '../cli-locale.js';
import { resolveDefaultDeviceTarget } from '../../device/device-target.js';
import { setCliApprovalAsker } from '../approval.js';
import {
  runRegistryCommand,
  type CommandContext,
  type CommandSurface,
} from '../commands/registry.js';
import { cliLocale } from '../cli-locale.js';
import { handleCompactCommand } from '../compact-command.js';
import { runTaskCommand, splitCommandArgs } from '../task-run.js';
import { resolveCliConfig, type ResolvedCliConfig } from '../config.js';
import {
  formatCliInteractionModeLabel,
  getCliInteractionMode,
  setCliInteractionMode,
  subscribeCliInteractionMode,
  type CliInteractionMode,
} from '../interaction-mode.js';
import {
  loadModelChoicesForRuntime,
  resolveContextTokensForModel,
  resolveModelSelection,
  type ModelChoiceList,
} from '../model-catalog.js';
import { createCliProvider } from '../providers.js';
import { writePreferredModel } from '../preferred-model-store.js';
import { runLocalShellCommand } from '../repl-process.js';
import type { CliRuntimeStatus } from '../onboarding.js';
import type { ContextUsageSnapshot } from '../usage-display.js';
import {
  CLI_APPROVAL_FOOTER,
  CLI_APPROVAL_OPTIONS,
  setCliApprovalViewAsker,
  type CliApprovalAnswer,
  type CliApprovalView,
} from '../approval-view.js';
import {
  renderApproval,
  renderBanner,
  renderHint,
  renderLive,
  renderTodoPanel,
  renderRunSummary,
  renderStatusRight,
  renderTranscriptRow,
  CONTEXT_WARN_PCT,
  SHELL_MODE_TONE,
  type LiveView,
  PLACEHOLDER_TEXT,
  type StatusView,
} from './transcript.js';
import { clip, line, rule, type TuiColor, type TuiLine } from './text.js';
import {
  COMPOSER_MAX_ROWS,
  composerDelete,
  composerInsert,
  composerKill,
  composerMove,
  composerNewline,
  composerSetValue,
  createComposer,
  renderComposerEditor,
  type ComposerRun,
  type ComposerState,
} from './composer.js';
import {
  ctrlBinding,
  HELP_COMMANDS,
  HELP_KEYS,
  HELP_PREFIXES,
  SHELL_COMMANDS,
  SHELL_COMMAND_NAMES,
  SHELL_COMMAND_ROWS,
  type CtrlAction,
} from './help.js';
import {
  movePaletteSelection,
  PALETTE_MAX_ROWS,
  renderSlashPalette,
  slashPaletteRows,
  type PaletteRow,
} from './palette.js';
import {
  MENTION_MAX_ROWS,
  completeMention,
  filterMentions,
  mentionTokenAt,
  renderMentionMenu,
  workspaceFileIndex,
  type MentionEntry,
} from './mentions.js';
import { filterHistory, renderHistorySearch } from './history-search.js';
import { buildResumeReplay } from '../resume-replay.js';
import { getPackageVersion } from '../package-info.js';
import { getMossWorkspacePaths } from '../../utils/workspace-paths.js';

export interface TuiReplayRow {
  kind: TranscriptRow['kind'];
  text: string;
}

export interface TuiSessionSummary {
  key: string;
  title?: string;
  messageCount?: number;
  updatedAt?: number;
  current?: boolean;
}

export interface TuiMcpServerStatus {
  name: string;
  state: string;
  toolCount?: number;
  error?: string;
}

/**
 * What the session actually loaded into the model's context — shown once under
 * the boot banner (the reference CLI prints `SessionStart` hook output and
 * loaded-context notes in exactly this spot).
 */
export interface TuiContextInfo {
  /** Registered skills (`.moss/skills/` + user dir); omitted when 0. */
  skills?: number;
  /** Connected MCP servers / total configured; omitted when none configured. */
  mcp?: { connected: number; total: number };
  /** Active soul id when it is not the built-in default. */
  soul?: string;
  /** Current git branch of the workspace, when inside a repo. */
  branch?: string;
}

export interface TuiSkillCommand {
  name: string;
  description: string;
}

export interface TuiAppOptions {
  agent: MossAgent;
  workspaceDir: string;
  sessionKey?: string;
  model?: string;
  version?: string;
  /** Transcript rows replayed on boot (resume). */
  replayRows?: TuiReplayRow[];
  /** Boot-time context note (skills/MCP/soul/branch) printed under the banner. */
  contextInfo?: TuiContextInfo;
  /**
   * Skills as first-class commands (the Qoder pattern): each appears in the
   * `/` palette as `/name` and dispatches a run that invokes the skill. The
   * model already has the skill index and the readonly skill tool.
   */
  skills?: TuiSkillCommand[];
  /** Open the session resume picker at boot (`moss resume` on a TTY). */
  resumePicker?: boolean;
  /** /sessions panel provider (host-side session store). */
  listSessions?: () => Promise<TuiSessionSummary[]>;
  /** /mcp panel data (host-side registry statuses). */
  mcpServers?: TuiMcpServerStatus[];
  /** File checkpoint restore for /rewind (host wires the checkpoint store). */
  rewindTo?: (seq: number) => { ok: boolean; detail: string };
  listCheckpoints?: () => Array<{ seq: number; label: string; files: number }>;
  /** Injected task runtime (specs); created from workspaceDir when omitted. */
  runtime?: TaskRuntime;
  /**
   * Host-side CLI runtime status (workspace, resolved config, safety mode) used
   * by the shared registry commands `/status`, `/doctor`, `/permissions` and
   * `/quickstart`. When omitted the shell resolves the same defaults the REPL
   * uses, so those commands still answer with real config data.
   */
  cliRuntime?: CliRuntimeStatus;
  /**
   * Called once per submitted turn BEFORE streaming starts. The host uses it to
   * open a file checkpoint for the turn, which is what makes `/rewind` able to
   * restore anything later.
   */
  onTurnStart?: (message: string) => void;
}

export const TUI_HELP_TEXT = [
  'moss — describe a goal; moss runs it as a task (plan → execute → device → verify → repair → acceptance).',
  `keys: ${HELP_KEYS.map(([keys, what]) => `${keys} ${what}`).join(' · ')}`,
  `commands: ${HELP_COMMANDS.join(' · ')}`,
].join('\n');

export function buildTuiHelpText(): string {
  return TUI_HELP_TEXT;
}

/**
 * shift+tab cycle order (`claude-code-surface.md` §6.6: manual → accept edits →
 * plan → auto). moss's policy layer (`cli/interaction-mode.ts`) has exactly
 * three modes — there is no fourth "auto" state (full-auto is the safety-mode
 * axis: `--full-access`, §Z8) — so the cycle visits all three real ones and
 * returns to default. The LIST is the single source of truth for the key.
 */
export const INTERACTION_MODE_CYCLE: readonly CliInteractionMode[] = [
  'default',
  'acceptEdits',
  'plan',
];

export function nextInteractionMode(current: CliInteractionMode): CliInteractionMode {
  const index = INTERACTION_MODE_CYCLE.indexOf(current);
  return INTERACTION_MODE_CYCLE[(index + 1) % INTERACTION_MODE_CYCLE.length] ?? 'default';
}

/** `❯ ` and `! ` are both one glyph + one space: the prompt run is 2 cells. */
const PROMPT_CELLS = 2;

/**
 * D-7: how long a first Ctrl+C keeps the quit armed. Long enough to be a real
 * double-press, short enough that a stale confirmation cannot surprise someone
 * typing a goal.
 */
const QUIT_CONFIRM_MS = 1500;

/**
 * D-13: rows reserved below the approval dialog (status, two rules, one composer
 * row and the hint). The dialog may never grow past `terminalRows - this`.
 */
const APPROVAL_CHROME_RESERVE = 6;

/**
 * How long a first Esc on a non-empty composer keeps "Esc again to clear"
 * armed (same idea as the D-7 double-Ctrl+C quit window).
 */
const ESC_CLEAR_MS = 1600;

interface StoreHandle {
  store: ReturnType<typeof createTuiStore>;
  notify: () => void;
  subscribe: (fn: () => void) => () => void;
}

function createStoreHandle(): StoreHandle {
  const listeners = new Set<() => void>();
  return {
    store: createTuiStore(),
    notify: () => {
      for (const l of listeners) l();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** Pull title / subject / preview out of the host's approval question. */
export function describeApproval(question: string): {
  title: string;
  subject?: string;
  preview?: string[];
} {
  const lines = question
    .split('\n')
    .map((text) => text.trim())
    .filter(Boolean);
  // The host phrases the intent as its own line ("Moss wants to write a file")
  // followed by the subject ("notes.txt"): use those, and keep the rest as the
  // preview, instead of dumping the whole paragraph above the options.
  const intentIndex = lines.findIndex((text) => /^moss wants to /i.test(text));
  if (intentIndex >= 0) {
    const intent = lines[intentIndex]!.replace(/^moss wants to /i, '');
    const subject = lines[intentIndex + 1];
    return {
      title: `${intent.charAt(0).toUpperCase()}${intent.slice(1)}`,
      subject: subject ? clip(subject, 120) : undefined,
      preview: lines
        .filter((_, index) => index !== intentIndex && index !== intentIndex + 1)
        .slice(0, 10),
    };
  }
  const body = lines[0] ?? 'Approval required';
  const sentence = body.split(/(?<=\.)\s/)[0] ?? body;
  const rest = lines.slice(1);
  const subject = body.slice(sentence.length).trim() || rest.shift() || undefined;
  return {
    title: sentence.replace(/\.$/, ''),
    subject: subject ? clip(subject, 120) : undefined,
    preview: rest.slice(0, 10),
  };
}

/**
 * ink props for one text style (a row or a single inline run).
 *
 * D-12 regression guard: the ROW style must be applied to a line's outer
 * `<Text>` even when the line carries runs. A heading's `bold` and a
 * blockquote's `dim` live on the row (`TuiLineRun` cannot express `dim`), and
 * ink applies a `<Text>`'s chalk over its composed children, so a nested run
 * keeps its own colour while inheriting the uniform row attribute. Skipping the
 * row style whenever `runs` existed silently un-bolded every heading and
 * un-dimmed every quote.
 */
export function inkTextStyle(style: {
  color?: TuiColor;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
}): Record<string, unknown> {
  return {
    ...(style.color ? { color: style.color } : {}),
    ...(style.bold ? { bold: true } : {}),
    ...(style.italic ? { italic: true } : {}),
    ...(style.underline ? { underline: true } : {}),
    ...(style.dim ? { dimColor: true } : {}),
  };
}

/** The outer `<Text>` style for a line: always the row style, runs included. */
export function inkLineStyle(l: TuiLine): Record<string, unknown> {
  return inkTextStyle(l);
}

/**
 * A legacy flattened question → the frozen structured payload. The old
 * string-port callers (and the `ask_user_question` channel that `approval.ts`
 * mirrors from the same port) get the same dialog as the structured port.
 */
export function legacyApprovalView(question: string): CliApprovalView {
  const described = describeApproval(question);
  return {
    title: described.title,
    ...(described.subject ? { subject: described.subject } : {}),
    ...(described.preview?.length ? { preview: described.preview } : {}),
    question: 'Do you want to proceed?',
    options: [...CLI_APPROVAL_OPTIONS],
    footer: CLI_APPROVAL_FOOTER,
  };
}

function approvalAnswerLabel(answer: CliApprovalAnswer): string {
  if (answer === 'y') return 'yes';
  if (answer === 'a') return 'yes (session)';
  if (answer === 'amend') return 'amend';
  return 'no';
}

/**
 * Is an `error` event the user's own interrupt rather than a failure? The loop
 * tags aborts with `stopReason: 'aborted_by_user'` but still emits an `error`
 * event carrying the provider AbortError ("This operation was aborted"), which
 * the shell used to print as a red bold error row (D-9).
 */
export function isInterruptEvent(controller: AbortController, error: unknown): boolean {
  if (controller.signal.aborted) return true;
  const message = typeof error === 'string' ? error : errorMessage(error);
  return /abort(ed)?\b/i.test(message);
}

/** The visible approval dialog: the frozen payload plus the UI cursor. */
export interface ApprovalDialogView extends CliApprovalView {
  cursor: number;
  /** Tab-to-amend armed (A6.54): option 1 answers `amend`. */
  amend?: boolean;
}

/**
 * N-1: `ask_user_question` is a QUESTION, not a permission request. Its numbered
 * options must be answerable and the CHOSEN option has to reach the model — the
 * approval state machine used to discard the choice and return `y`/`a`/`n`.
 * The prompt the tool builds is deterministic (`formatQuestionPrompt`), so the
 * options are recovered from it here instead of inventing a second contract.
 */
export function questionDialogFromPrompt(promptText: string): {
  view: ApprovalDialogView;
  answers: string[];
  /** `multi_select`: digits must NOT answer immediately (`1,3` is one answer). */
  multiSelect: boolean;
} | null {
  const options: string[] = [];
  const title: string[] = [];
  for (const rawLine of promptText.split('\n')) {
    const match = /^\s*(\d+)\.\s+(\S.*)$/.exec(rawLine);
    if (match && Number(match[1]) === options.length + 1) {
      options.push(match[2]!.trim());
      continue;
    }
    if (/^\s*(Enter a number|Enter one or more|\(Type your answer)/i.test(rawLine)) continue;
    if (/^\s{5,}\S/.test(rawLine)) continue;
    if (rawLine.trim()) title.push(rawLine.trim());
  }
  const freeText = /\(Type your answer and press Enter\)/i.test(promptText);
  const multiSelect = /Enter one or more numbers separated by commas/i.test(promptText);
  if (options.length === 0 && !freeText) return null;
  // Descriptions are rendered on their own indented line, so the option label
  // remains an exact answer value even when it contains punctuation or dashes.
  const answers = options.map((option) => option.trim());
  return {
    view: {
      title: 'Question',
      question: title.join(' ') || 'Question',
      options: options.map((label, index) => ({
        key: String(index + 1),
        answer: 'y' as const,
        label,
      })),
      footer: options.length
        ? multiSelect
          ? 'type 1,3 below · ↑↓ then Enter · Esc to skip'
          : `${options.map((_, index) => index + 1).join('/')} · ↑↓ then Enter · Esc to skip`
        : 'type your answer below · Enter to send · Esc to skip',
      cursor: 0,
    },
    answers,
    multiSelect,
  };
}

interface PendingDialog {
  kind: 'approval' | 'question';
  /** Exactly-once guard: several exit paths can race to resolve the same dialog. */
  settled: boolean;
  cleanup?: () => void;
  /** Approval answers are `CliApprovalAnswer`; question answers are free text. */
  resolve: (value: string) => void;
  /** Question dialogs: what each numbered option answers with. */
  optionAnswers?: string[];
  /** `multi_select` questions: digits are typed, only Enter answers. */
  freeTextEntry?: boolean;
  /**
   * What the dialog was about (`Write(wordfreq/Makefile)`-style subject, else
   * the title). A bare `approval: yes` row floating under an unrelated block
   * told the user nothing; the commit row names what was decided.
   */
  label?: string;
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  return out;
}

/**
 * The registry's `CommandSurface` vocabulary has no shell member and no command
 * branches on it, so `'repl'` is the only type-legal value today. Widening the
 * union is a `src/cli/commands/registry.ts` change owned outside this task (the
 * registry spec already passes `'tui'`).
 */
const COMMAND_SURFACE: CommandSurface = 'repl';

/** `/status` → `Status`: the canonical title of a command's inline block. */
export function commandBlockTitle(head: string): string {
  const name = head.trim().replace(/^\//, '');
  if (!name) return 'Command';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const COMMON_HELP_COMMANDS = [
  '/status',
  '/model',
  '/mode',
  '/task',
  '/resume',
  '/context',
  '/usage',
  '/permissions',
  '/help',
  '/quit',
];

/** Compact help (prefixes + shortcuts + common commands) or the full reference. */
export function buildHelpOverlayLines(all: boolean): string[] {
  return [
    'prefixes',
    ...HELP_PREFIXES.map(([prefix, what]) => `  ${prefix.padEnd(3)} ${what}`),
    '',
    'shortcuts',
    ...HELP_KEYS.map(([keys, what]) => `${keys.padEnd(12)} ${what}`),
    '',
    all ? 'all commands' : 'common commands',
    ...SHELL_COMMANDS.filter((entry) => all || COMMON_HELP_COMMANDS.includes(entry.command)).map(
      (entry) => `  ${entry.usage.padEnd(24)} ${entry.description}`
    ),
    ...(all ? [] : ['', 'type / to browse all commands · /help --all for the full reference']),
  ];
}

/** `5m` / `2h` / `3d` — a session's age in one glance. */
export function relativeAge(updatedAt: number | undefined, now = Date.now()): string {
  if (updatedAt === undefined) return '';
  const s = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** Sessions matching the picker's query (title or key contains it). */
export function filterPickerSessions(
  sessions: readonly TuiSessionSummary[],
  query: string
): TuiSessionSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...sessions];
  return sessions.filter(
    (s) => s.key.toLowerCase().includes(q) || (s.title ?? '').toLowerCase().includes(q)
  );
}

/** The boot resume-picker overlay: rows of `title · age · N messages`. */
export function renderSessionPicker(
  query: string,
  matches: readonly TuiSessionSummary[],
  selected: number,
  width: number,
  maxRows = 8
): TuiLine[] {
  const out: TuiLine[] = [
    line(clip(`Resume session  ⌕ ${query}▌`, width), { color: 'cyan', bold: true }),
  ];
  const sel = Math.max(0, Math.min(selected, matches.length - 1));
  matches.slice(0, maxRows).forEach((s, index) => {
    const title = s.title?.trim() || s.key;
    const meta = [
      relativeAge(s.updatedAt),
      s.messageCount !== undefined ? `${s.messageCount} messages` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    out.push(
      line(
        clip(`${index === sel ? '❯ ' : '  '}${title}${meta ? `  (${meta})` : ''}`, width),
        index === sel ? { bold: true } : { dim: true }
      )
    );
  });
  if (matches.length > maxRows) {
    out.push(line(clip(`  … ${matches.length - maxRows} more`, width), { dim: true }));
  }
  if (matches.length === 0) {
    out.push(line(clip('  no matching session', width), { dim: true }));
  }
  out.push(line(clip('  ↑/↓ to pick · type to filter · Esc starts fresh', width), { dim: true }));
  return out;
}

/** One `HH:MM:SS role: snippet…` line for a conversation-log JSONL entry. */
export function describeConversationLogEntry(raw: string): string | undefined {
  let entry: {
    type?: string;
    message?: { role?: string; content?: unknown; timestamp?: number };
  };
  try {
    entry = JSON.parse(raw) as typeof entry;
  } catch {
    return undefined;
  }
  if (entry.type !== 'message' || !entry.message) return undefined;
  const content = entry.message.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((block) => {
              const b = block as { type?: string; text?: string; name?: string };
              if (b.type === 'text' && typeof b.text === 'string') return b.text;
              if (b.type === 'tool_use') return `[tool ${b.name}]`;
              if (b.type === 'tool_result') return '[tool result]';
              return '';
            })
            .filter(Boolean)
            .join(' ')
        : '';
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 90);
  if (!snippet) return undefined;
  const time =
    entry.message.timestamp !== undefined
      ? ` ${new Date(entry.message.timestamp).toISOString().slice(11, 19)}`
      : '';
  return `${time.trim()} ${entry.message.role === 'user' ? '❯' : '⏺'} ${snippet}`;
}

/**
 * Provider-reported context snapshot for the shared `/context` command. Returns
 * undefined until the provider reports a window, which makes the registry fall
 * back to a labelled local estimate instead of showing a fake 100%.
 */
export function shellContextUsage(usage: TuiUsageState): ContextUsageSnapshot | undefined {
  if (usage.contextTotal <= 0) return undefined;
  return { used: usage.contextUsed, total: usage.contextTotal, source: 'provider' };
}

/** Resolve the CLI config the shell's control commands report on; never throws. */
export function resolveShellCliConfig(): ResolvedCliConfig | undefined {
  try {
    return resolveCliConfig();
  } catch {
    return undefined;
  }
}

/**
 * Palette rows for the shell's OWN command surface.
 *
 * `slashPaletteRows` ranks the shared REPL table (`interactive-commands.ts`),
 * which is a superset: it knows `/loop`, `/goal`, `/task`, `/init` (still
 * REPL/headless-only, so the shell must not offer them) and it does NOT know the
 * eleven task/control commands the shell owns (`/tasks`, `/history`,
 * `/evidence`, `/deployments`, `/failures`, `/resume`, `/queue`, `/steer`,
 * `/bg`, `/subs`, `/mcp`), which is why filtering alone could never surface
 * them. Feeding `SHELL_COMMAND_ROWS` — the same table `/help` prints — through
 * the shared ranker and keeping only the shell's names makes the menu and
 * `/help` one list: the menu can neither hide an advertised command nor offer an
 * unadvertised one. The map keeps the ranker's position for a name but takes the
 * shell table's description, so the wording has one source too.
 */
export function shellPaletteRows(
  input: string,
  extra: ReadonlyArray<PaletteRow> = []
): PaletteRow[] {
  const allowed = new Set(SHELL_COMMAND_NAMES);
  const byCommand = new Map<string, PaletteRow>();
  for (const row of slashPaletteRows(input, SHELL_COMMAND_ROWS)) {
    if (!allowed.has(row[0])) continue;
    byCommand.set(row[0], row);
  }
  // Skills ride the SAME ranker as first-class commands (outside the static
  // table, so `/help` honesty is untouched); a static command always wins a
  // name collision. Only rows that CAME from `extra` may enter — the ranker
  // also folds the REPL table, whose /loop /goal /task /init are not this
  // shell's commands.
  const extraNames = new Set(extra.map((row) => row[0]));
  for (const row of slashPaletteRows(input, extra)) {
    if (!extraNames.has(row[0]) || byCommand.has(row[0])) continue;
    byCommand.set(row[0], row);
  }
  return [...byCommand.values()];
}

/**
 * First row of the visible palette window (D-15).
 *
 * The selection index is absolute over the whole menu, while `renderSlashPalette`
 * draws at most `maxRows` rows. Without an offset the renderer clamped its `❯`
 * marker into that slice while Tab/Enter used the absolute index — past row 8 the
 * menu highlighted one command and executed another (`/sessions` marked,
 * `/doctor` run). The window therefore follows the cursor: the marker row is
 * always the row `paletteRows[selected]` that Enter/Tab act on. Returns 0 while
 * everything fits, so short menus never scroll.
 */
export function paletteWindowOffset(selected: number, total: number, maxRows: number): number {
  if (maxRows <= 0 || total <= maxRows) return 0;
  return Math.min(Math.max(0, selected - maxRows + 1), total - maxRows);
}

/**
 * Rows handed to `renderSlashPalette`: the window first, so the marker index
 * `selected - offset` maps onto the row the shell actually acts on. The hidden
 * rows are appended so the renderer keeps owning its `… N more` counter — it
 * only ever draws the first `maxRows` entries.
 */
export function paletteFrameRows(
  rows: readonly PaletteRow[],
  offset: number,
  maxRows: number
): PaletteRow[] {
  if (offset <= 0) return [...rows];
  return [
    ...rows.slice(offset, offset + maxRows),
    ...rows.slice(0, offset),
    ...rows.slice(offset + maxRows),
  ];
}

export function TuiAppRoot({
  options,
  handle,
  runtime,
}: {
  options: TuiAppOptions;
  handle: StoreHandle;
  runtime: TaskRuntime;
}): React.ReactElement {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  const [composer, setComposer] = useState<ComposerState>(() => createComposer());
  const input = composer.value;
  // Bulk edits (history recall, staged prompts, paste) replace the whole value
  // and park the caret at the end; the fine-grained keys use the editor ops.
  const setInput = useCallback((next: string | ((value: string) => string)) => {
    setComposer((current) => {
      const value = typeof next === 'function' ? next(current.value) : next;
      return composerSetValue(value, value.length);
    });
  }, []);
  const [pastePreview, setPastePreview] = useState<string | undefined>(undefined);
  const [approval, setApproval] = useState<ApprovalDialogView | undefined>(undefined);
  const [statusLine, setStatusLine] = useState<string | undefined>(undefined);
  /**
   * D-7: `Ctrl+C` is a two-press quit, exactly as `?` advertises. The first
   * press interrupts (or arms the quit on an idle composer) and NEVER touches
   * the draft; the second press inside the confirm window exits.
   */
  const [quitArmed, setQuitArmed] = useState(false);
  /**
   * `!` shell mode for the CURRENT draft. Entered by typing `!` as the first
   * character; the `!` itself is consumed (the composer prefix becomes `! `),
   * exactly like the reference.
   */
  const [shellMode, setShellMode] = useState(false);
  /**
   * The active interaction mode MIRRORS the policy layer — it is never owned
   * here. `setCliInteractionMode` is what the approval policy reads, and its
   * subscription is what makes a shift+tab change visible on the next frame
   * (including changes made by `/mode`, the CLI flags or another host).
   */
  const [interactionMode, setInteractionModeState] = useState<CliInteractionMode>(() =>
    getCliInteractionMode()
  );
  /** Active model, so `/model` is reflected in the status row immediately. */
  const [currentModel, setCurrentModel] = useState<string | undefined>(options.model);
  const [modelPicker, setModelPicker] = useState<
    { choices: ModelChoiceList; cursor: number } | undefined
  >(undefined);
  const [helpOverlay, setHelpOverlay] = useState<{ lines: string[]; all: boolean } | undefined>(
    undefined
  );
  /** ctrl+o: detailed transcript (full tool output + reasoning). */
  const [verbose, setVerbose] = useState(false);
  /**
   * Bumped by ctrl+o. Committed rows live in ink's `<Static>`, which memoises
   * the items it has already emitted and NEVER re-renders them in place, so
   * flipping `verbose` alone left every old row collapsed and made the printed
   * `· ctrl+o` marker a false affordance (D-5). A new `key` remounts the Static
   * with index 0, which re-emits the whole transcript in the new state.
   */
  const [verboseRevision, setVerboseRevision] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);
  /** Ctrl+R prompt search: `{ query, cursor }` while the overlay is open. */
  const [historySearch, setHistorySearch] = useState<{ query: string; cursor: number } | undefined>(
    undefined
  );
  /** Boot session picker (`moss resume` on a TTY): query + cursor overlay. */
  const [sessionPicker, setSessionPicker] = useState<{ query: string; cursor: number } | undefined>(
    options.resumePicker ? { query: '', cursor: 0 } : undefined
  );
  const [pickerSessions, setPickerSessions] = useState<TuiSessionSummary[]>([]);
  const [paletteCursor, setPaletteCursor] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [mentionCursor, setMentionCursor] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState<MentionEntry[]>([]);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const modelProbeGenerationRef = useRef(0);
  /** Plan-mode exit gate, filled in after `dispatchRun` exists (below). */
  const planGateRef = useRef<(() => void) | undefined>(undefined);
  const runStartedAtRef = useRef<number | undefined>(undefined);
  const pendingDialogRef = useRef<PendingDialog | null>(null);
  /** Timer behind the D-7 two-press Ctrl+C quit confirmation. */
  const quitTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queueRef = useRef<string[]>([]);
  const queuePausedRef = useRef(false);
  const [queueRevision, setQueueRevision] = useState(0);
  void queueRevision;
  /** Kill ring: the text the last Ctrl+U/K/W removed, pasted back by Ctrl+Y. */
  const killRef = useRef<string>('');
  /** Ctrl+S stash: a parked draft, swapped back with a second Ctrl+S (A2.24). */
  const stashRef = useRef<string | undefined>(undefined);
  /** `Esc again to clear` arming (see ESC_CLEAR_MS); the composer survives one Esc. */
  const escClearTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [escClearArmed, setEscClearArmed] = useState(false);
  /**
   * `/clear` remounts the committed transcript (same trick as `verboseRevision`:
   * ink's <Static> never un-renders committed rows, so the key change is what
   * drops them from the visible screen after the ANSI clear).
   */
  const [clearRevision, setClearRevision] = useState(0);
  const pasteRef = useRef(createPasteCapture());
  /**
   * ACTIVE session key — state, not a const, because the resume picker can
   * switch conversations in place (replay + subsequent turns go to the
   * picked session's log).
   */
  const [activeSession, setActiveSession] = useState(options.sessionKey ?? 'tui');
  const sessionKey = activeSession;
  const { store } = handle;
  /**
   * D-1: the width must come from a REACT-REACTIVE source. `stdout.columns` read
   * during a render is only re-read when something re-renders the tree, and
   * ink's own `resize` handler just re-runs layout + repaints the stale tree — so
   * the chrome stayed at the old width until the next keystroke, and a shrink left
   * the old and new frames interleaved. `useWindowSize()` subscribes to the
   * stdout `resize` event and re-renders this component, so SIGWINCH now reflows
   * immediately with no user input.
   */
  const windowSize = useWindowSize();
  const columns = windowSize.columns || stdouts(stdout);

  useEffect(() => handle.subscribe(forceUpdate), [handle, forceUpdate]);
  useEffect(() => runtime.onChange(forceUpdate), [runtime, forceUpdate]);
  // The policy layer is authoritative: any mode change (shift+tab, `/mode`, a
  // flag, an embedded host) re-renders the hint row immediately.
  useEffect(() => subscribeCliInteractionMode(setInteractionModeState), []);

  /** Inline information block: a ⏺ title plus ⎿ rows, right in the transcript. */
  const printBlock = useCallback(
    (title: string, lines: string[]) => {
      appendRow(store, 'tool', title);
      for (const text of lines.length > 0 ? lines : ['(nothing to show)']) {
        appendRow(store, 'detail', text);
      }
      handle.notify();
    },
    [handle, store]
  );

  /**
   * Terminal attention for the unfocused case: BEL plus an OSC 9 growl
   * (iTerm2/WezTerm/Kitty render it as a notification; harmless elsewhere).
   * A long run finishing — or a dialog blocking on the user — while the
   * terminal is in the background is moss's core long-run use case, and it
   * used to be completely silent. MOSS_NOTIFY=0 opts out.
   */
  const notifyAttention = useCallback(
    (message: string) => {
      if (process.env.MOSS_NOTIFY === '0') return;
      try {
        stdout.write(`\x07\x1b]9;moss: ${message}\x07`);
      } catch {
        // A closed stream must never break a run.
      }
    },
    [stdout]
  );

  // Dialog bridge: the policy hands the frozen structured payload (N1) to the
  // structured port, and this ONE state machine renders it inline above the
  // composer (1/2/3, or y/a/n) instead of letting the tool be answered blind.
  //
  // Resolve EXACTLY ONCE, from any exit path: an explicit answer, Esc, Ctrl+C,
  // the run ending for any reason, the asker's abort signal, or unmount. A
  // dialog that outlives its run keeps `● waiting for you` on screen and
  // swallows every keystroke until the dead prompt is answered (D-2).
  const resolveDialog = useCallback(
    (value: string, options: { silent?: boolean; commit?: string } = {}): boolean => {
      const pending = pendingDialogRef.current;
      if (!pending || pending.settled) return false;
      pending.settled = true;
      pendingDialogRef.current = null;
      pending.cleanup?.();
      setApproval(undefined);
      runtime.setApprovalPending(false);
      if (!options.silent) {
        const base =
          options.commit ??
          (pending.kind === 'question'
            ? `answer: ${value || 'skipped'}`
            : `approval: ${approvalAnswerLabel(value as CliApprovalAnswer)}`);
        appendRow(store, 'result', pending.label ? `${base} · ${pending.label}` : base);
        handle.notify();
      }
      pending.resolve(value);
      return true;
    },
    [handle, runtime, store]
  );

  const resolveApproval = useCallback(
    (answer: CliApprovalAnswer, options: { silent?: boolean } = {}): boolean =>
      // No explicit commit: resolveDialog adds the dialog's label (the file or
      // command that was approved) so the row reads `approval: yes · Write(x)`.
      resolveDialog(answer, options),
    [resolveDialog]
  );

  /**
   * Settle whatever dialog is open from a shared exit path (Ctrl+C, the run
   * ending, unmount). A question is skipped; an approval is denied.
   */
  const settleDialog = useCallback(
    (silent: boolean): boolean => {
      const pending = pendingDialogRef.current;
      if (!pending) return false;
      return pending.kind === 'question'
        ? resolveDialog('', silent ? { silent: true } : { commit: 'answer: skipped' })
        : resolveApproval('n', silent ? { silent: true } : {});
    },
    [resolveApproval, resolveDialog]
  );

  useEffect(() => {
    const ask = (
      view: CliApprovalView,
      abortSignal: AbortSignal | undefined,
      question: { answers: string[]; multiSelect: boolean } | undefined
    ): Promise<string> =>
      new Promise<string>((resolve) => {
        // A second request can only arrive if the first was never answered:
        // deny the stale one instead of orphaning it.
        settleDialog(true);
        runtime.setApprovalPending(true);
        notifyAttention(question ? 'question needs your answer' : 'approval needed');
        handle.notify();
        const entry: PendingDialog = {
          kind: question ? 'question' : 'approval',
          resolve,
          settled: false,
          ...(question
            ? { optionAnswers: question.answers, freeTextEntry: question.multiSelect }
            : {}),
          // Approvals name their target (subject → title); a question's title
          // is the generic word "Question", which would add noise, not signal.
          ...(!question && (view.subject ?? view.title)
            ? { label: (view.subject ?? view.title)! }
            : {}),
        };
        pendingDialogRef.current = entry;
        if (abortSignal) {
          const onAbort = () => settleDialog(true);
          if (abortSignal.aborted) {
            onAbort();
            return;
          }
          abortSignal.addEventListener('abort', onAbort, { once: true });
          entry.cleanup = () => abortSignal.removeEventListener('abort', onAbort);
        }
        // Verbatim payload: title/subject/preview/question/options/footer.
        setApproval({ ...view, cursor: 0 });
      });

    const uninstallViewAsker = setCliApprovalViewAsker(
      async (view, abortSignal) =>
        // The structured port only ever answers with the frozen option values.
        (await ask(view, abortSignal, undefined)) as CliApprovalAnswer
    );
    // The legacy string port stays installed because `approval.ts` also mirrors
    // it into the core `ask_user_question` channel; it funnels into the SAME
    // state machine, so there is one view, not two competing ones. A prompt that
    // carries numbered options is a QUESTION: its options render and the chosen
    // option's text is the answer the model receives (N-1), instead of the
    // approval state machine discarding the choice and replying `y`.
    setCliApprovalAsker(async (question: string, abortSignal) => {
      const parsed = questionDialogFromPrompt(question);
      return parsed
        ? ask(parsed.view, abortSignal, parsed)
        : ask(legacyApprovalView(question), abortSignal, undefined);
    });
    return () => {
      uninstallViewAsker();
      setCliApprovalAsker(null);
      settleDialog(true);
    };
  }, [handle, notifyAttention, resolveDialog, runtime, settleDialog]);

  // Boot: banner + replayed rows + artifacts.
  useEffect(() => {
    let device: string | undefined;
    try {
      device = resolveDefaultDeviceTarget()?.deviceId;
    } catch {
      device = undefined;
    }
    const home = process.env.HOME ?? '';
    const cwd =
      home && options.workspaceDir.startsWith(home)
        ? `~${options.workspaceDir.slice(home.length)}`
        : options.workspaceDir;
    appendRow(
      store,
      'banner',
      renderBanner(
        {
          version: options.version ?? getPackageVersion(),
          model: options.model,
          device,
          cwd,
        },
        // Clip at render time, not here.
        Number.MAX_SAFE_INTEGER
      )
        .map((l) => l.text)
        .join('\n')
        .trim()
    );
    // What the model actually starts with (skills index, MCP servers, a custom
    // soul, the git branch) — the reference CLI prints this as its SessionStart
    // context line; moss used to load all of it silently.
    const info = options.contextInfo;
    if (info) {
      const parts: string[] = [];
      if (info.branch) parts.push(`git:${info.branch}`);
      if (info.skills) parts.push(`${info.skills} skill${info.skills === 1 ? '' : 's'}`);
      if (info.mcp && info.mcp.total > 0) {
        parts.push(
          info.mcp.connected === info.mcp.total
            ? `${info.mcp.total} MCP server${info.mcp.total === 1 ? '' : 's'}`
            : `${info.mcp.connected}/${info.mcp.total} MCP servers connected`
        );
      }
      if (info.soul) parts.push(`soul:${info.soul}`);
      if (parts.length > 0) appendRow(store, 'detail', `context: ${parts.join(' · ')}`);
    }
    // A failed MCP server is the most common boot problem and it used to be
    // readable only if the user already knew about /mcp: the context line
    // counts servers, this row names the failures (codex §1.4's ⚠ shape).
    const failedMcp = (options.mcpServers ?? []).filter((s) => s.state !== 'connected');
    if (failedMcp.length > 0) {
      const names = failedMcp
        .slice(0, 3)
        .map((s) => s.name)
        .join(', ');
      appendRow(
        store,
        'system',
        `⚠ ${failedMcp.length} MCP server${failedMcp.length === 1 ? '' : 's'} failed to start` +
          `${names ? ` (${names})` : ''} — /mcp for details`
      );
    }
    // Crash/quit recovery: history survives per-message, but a bare `moss`
    // used to start blank with no path back. One hint row names the newest
    // session and the flag that resumes it (only when this boot is fresh —
    // a resumed boot is already replaying, and the picker replaces the hint).
    if (!options.replayRows?.length && !options.resumePicker) {
      void (async () => {
        try {
          const sessions = (await options.listSessions?.()) ?? [];
          const previous = sessions.find((s) => !s.current);
          if (previous) {
            const title = previous.title?.trim() || previous.key;
            appendRow(
              store,
              'system',
              `previous session: ${title}${previous.messageCount !== undefined ? ` (${previous.messageCount} messages)` : ''} — restart with \`moss --continue\` to resume it`
            );
            handle.notify();
          }
        } catch {
          // Session listing must never break boot.
        }
      })();
    }
    if (options.resumePicker) {
      // `moss resume` on a TTY: the picker overlay opens with real sessions.
      void (async () => {
        try {
          setPickerSessions((await options.listSessions?.()) ?? []);
        } catch {
          setPickerSessions([]);
        }
        handle.notify();
      })();
    }
    for (const row of options.replayRows ?? []) appendRow(store, row.kind, row.text);
    if (options.replayRows?.length) {
      appendRow(store, 'result', `resumed — replayed ${options.replayRows.length} rows`);
    }
    void runtime.refresh().then(() => handle.notify());
    handle.notify();
  }, []);

  // Background shell tasks (`exec_background`) finish while the user reads or
  // types: surface the completion in the transcript instead of leaving it to
  // `/bg`. (The REPL/oneshot renderer has its own subscription in output.ts.)
  useEffect(
    () =>
      subscribeBackgroundLifecycle((snap) => {
        if (snap.status === 'running') return;
        const failed = snap.status === 'error' || (snap.exitCode !== null && snap.exitCode !== 0);
        appendRow(
          store,
          failed ? 'error' : 'summary',
          formatBackgroundCompletionFlash(snap, isZhLocale())
        );
        if (failed) {
          let tail = '';
          try {
            tail = getBackgroundProcessOutputTail(snap.id, 4);
          } catch {
            tail = snap.errorMessage ?? '';
          }
          for (const text of tail
            .split('\n')
            .filter((l) => l.trim())
            .slice(-4)) {
            appendRow(store, 'detail', text);
          }
        }
        handle.notify();
      }),
    [handle, store]
  );

  /**
   * Run through the RECORDED stream when the agent offers it, so the TUI's
   * turns land in `.moss/events/<sessionKey>.jsonl` (steps · tool calls ·
   * retries · failures) next to the conversation log — post-hoc analysis of a
   * stalled or duplicated run has ground truth instead of screenshots. Spec
   * mock agents only implement `streamChat` and fall back cleanly.
   */
  const streamTurn = useCallback(
    (message: string, abortSignal: AbortSignal) => {
      const agent = options.agent as MossAgent & {
        streamChatRecorded?: typeof options.agent.streamChat;
      };
      return typeof agent.streamChatRecorded === 'function'
        ? agent.streamChatRecorded(sessionKey, message, { abortSignal })
        : options.agent.streamChat(sessionKey, message, { abortSignal });
    },
    [options.agent, sessionKey]
  );

  /**
   * A2: the end of a MODEL RUN is not the end of a TASK. When a task reached a
   * verdict during this run, the transcript's last word names it — PASS with
   * criteria, or FAIL with the recovery command — so completion is the
   * acceptance verdict, never the model's prose.
   */
  const appendTaskVerdictIfAny = useCallback(
    (startedAt: number) => {
      if (!startedAt) return;
      const decided = runtime
        .taskSummaries()
        .filter(
          (task) =>
            task.updatedAt >= startedAt && (task.result === 'PASS' || task.result === 'FAIL')
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!decided) return;
      const short = decided.taskId.slice(-6);
      const criteria = `${decided.criteriaMet}/${decided.criteriaTotal} criteria`;
      appendRow(
        store,
        'summary',
        decided.result === 'PASS'
          ? `◇ task ${short} — PASS (${criteria} met)`
          : `◇ task ${short} — FAIL (${criteria} met) · /task resume ${decided.taskId} to repair`
      );
      handle.notify();
    },
    [handle, runtime, store]
  );

  const runTurn = useCallback(
    async (message: string) => {
      options.onTurnStart?.(message);
      // Rows committed from this run on — the plan gate asks whether the run
      // actually produced a plan (tools were used, or a substantial answer).
      const firstRowId = store.nextId;
      runtime.beginRun();
      beginRun(store);
      runStartedAtRef.current = Date.now();
      handle.notify();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        for await (const event of streamTurn(message, controller.signal)) {
          if (event.type === 'error' && isInterruptEvent(controller, event.error)) {
            // D-9: the loop reports the user's own abort as an `error` event
            // ("This operation was aborted"), which used to land in the
            // transcript as a red bold failure. An interrupt is an outcome the
            // user asked for: record it quietly and keep the partial output.
            runtime.applyEvent(event);
            appendRow(store, 'summary', 'interrupted — partial output kept');
            handle.notify();
            continue;
          }
          if (event.type === 'tool_start' && store.run.streamingText.trim()) {
            // D-6: prose that introduced a tool call belongs to the step that
            // announced it. `endRun` commits one assistant row from the whole
            // run, which concatenated pre-tool and post-tool prose into a single
            // run-on line (`⏺ Planning the refactor.Todo list is live.`). Flush
            // the pending prose into its own row at the tool boundary; the rest
            // of the run streams into a fresh buffer.
            appendRow(store, 'assistant', store.run.streamingText, {
              ...(store.run.thinkingText.trim() ? { reasoning: store.run.thinkingText } : {}),
            });
            store.run.streamingText = '';
            store.run.thinkingText = '';
            store.version++;
          }
          if (event.type === 'retry' && store.run.streamingText.trim()) {
            // Same boundary rule as D-6: a retried call REGENERATES from
            // scratch, so keeping the stalled call's partial text in the buffer
            // would splice two generations into one duplicated row. Commit the
            // partial as its own row; the retry marker row (bridge) separates
            // the two generations visually.
            appendRow(store, 'assistant', store.run.streamingText, {
              ...(store.run.thinkingText.trim() ? { reasoning: store.run.thinkingText } : {}),
            });
            store.run.streamingText = '';
            store.run.thinkingText = '';
            store.version++;
          }
          applyAgentEvent(store, event);
          runtime.applyEvent(event);
          if (event.type === 'done') {
            const response = event.result?.response;
            if (typeof response === 'string' && response.trim()) {
              if (!store.run.streamingText.trim()) {
                appendRow(store, 'assistant', response);
              } else if (response.length > store.run.streamingText.length) {
                // N-4 (found while reproducing D-12): the live tail is capped
                // (`render-bridge` keeps the last 400 chars), and `endRun` commits
                // that tail — so an answer longer than 400 chars lost its HEAD in
                // the transcript (`⏺ ith bold, …` for a paragraph starting
                // "A paragraph w…"). The provider's final response is
                // authoritative: commit that instead of the truncated tail.
                store.run.streamingText = response;
                store.version++;
              }
            }
          }
          handle.notify();
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          appendRow(store, 'error', errorMessage(err));
          runtime.applyEvent({ type: 'error', error: errorMessage(err), retriable: false });
        }
      }
      // Every exit path from a run — done, throw, abort, interrupt — releases a
      // pending dialog: it can never outlive its run and hold the composer
      // hostage (D-2).
      settleDialog(true);
      abortRef.current = undefined;
      const startedAt = runStartedAtRef.current;
      runStartedAtRef.current = undefined;
      const halted = controller.signal.aborted;
      endRun(store, halted);
      if (startedAt !== undefined) {
        // Claude leaves a finalizing status line in the transcript; keep the
        // same shape (`✻ Worked for 5s`) and add the run's token spend.
        const summary = renderRunSummary(Date.now() - startedAt, halted, Number.MAX_SAFE_INTEGER, {
          input: store.usage.runTokensIn,
          output: store.usage.runTokensOut,
        });
        const text = summary.find((l) => l.text.trim())?.text.trim();
        if (text) appendRow(store, 'summary', text);
      }
      await runtime.endRun(halted);
      if (startedAt !== undefined) appendTaskVerdictIfAny(startedAt);
      notifyAttention(halted ? 'run interrupted' : 'run finished');
      // Plan-mode exit ritual (the reference's `Ready to code?` gate): a
      // finished plan-mode run that actually produced a plan — it explored
      // with tools, or answered at length — hands the decision to the user.
      // An interrupted run or a quick question does not get the ceremony.
      const rowsThisRun = store.rows.filter((row) => row.id >= firstRowId);
      const producedPlan =
        !halted &&
        getCliInteractionMode() === 'plan' &&
        (rowsThisRun.some((row) => row.kind === 'tool') ||
          rowsThisRun.some((row) => row.kind === 'assistant' && row.text.length > 300));
      handle.notify();
      if (producedPlan) planGateRef.current?.();
    },
    [
      appendTaskVerdictIfAny,
      handle,
      notifyAttention,
      options.agent,
      runtime,
      sessionKey,
      settleDialog,
      store,
      streamTurn,
    ]
  );

  const drainQueue = useCallback(async (): Promise<void> => {
    while (queueRef.current.length > 0 && !queuePausedRef.current) {
      const next = queueRef.current.shift();
      if (!next) break;
      setQueueRevision((n) => n + 1);
      appendRow(store, 'user', next);
      handle.notify();
      await runTurn(next);
    }
    if (queueRef.current.length === 0) setQueueRevision((n) => n + 1);
  }, [handle, runTurn, store]);

  const sessionInfo = useCallback(
    async (command: 'sessions' | 'mcp' | 'subs' | 'bg'): Promise<string[]> => {
      if (command === 'sessions') {
        const sessions = (await options.listSessions?.()) ?? [];
        if (sessions.length === 0) return ['no saved sessions'];
        return sessions.map(
          (x) =>
            `${x.current ? '*' : ' '} ${x.key}${x.title ? ` — ${x.title}` : ''}${
              x.messageCount !== undefined ? ` (${x.messageCount} messages)` : ''
            }`
        );
      }
      if (command === 'mcp') {
        const servers = options.mcpServers ?? [];
        if (servers.length === 0) return ['no MCP servers configured (.moss/mcp.json)'];
        return servers.map(
          (x) =>
            `${x.state === 'connected' ? '●' : '○'} ${x.name} — ${x.state}${
              x.toolCount !== undefined ? ` (${x.toolCount} tools, lazy)` : ''
            }${x.error ? `: ${x.error.slice(0, 80)}` : ''}`
        );
      }
      if (command === 'subs') {
        const snaps = options.agent.asyncTasks?.list() ?? [];
        if (snaps.length === 0) return ['no sub-agent tasks'];
        return snaps.map((t) => `#${t.taskId.slice(-6)} ${t.status}`);
      }
      const running = listBackgroundProcessSnapshots().filter((p) => p.status === 'running');
      if (running.length === 0) return ['no background tasks running'];
      return running.map((p) => `#${p.id} ${p.command}${p.label ? ` (${p.label})` : ''}`);
    },
    [options]
  );

  /** One place that knows how to print each task-runtime view. */
  const showBlock = useCallback(
    async (
      action: CtrlAction | 'tasks' | 'history' | 'sessions' | 'mcp' | 'subs' | 'bg' | 'usage'
    ) => {
      if (action === 'tasks') {
        const summaries = runtime.taskSummaries();
        printBlock(
          `Tasks (${summaries.length})`,
          summaries.map(
            (s) =>
              `${s.kind.toUpperCase().padEnd(8)} ${(s.result ?? s.state).padEnd(10)} ${s.criteriaMet}/${s.criteriaTotal} met  ${s.goal}` +
              (s.blockedReason ? `\n         blocked: ${s.blockedReason}` : '')
          )
        );
        return;
      }
      if (action === 'evidence') {
        const records = runtime.getArtifacts().evidence;
        printBlock(
          `Evidence (${records.length})`,
          records.map(
            (r) =>
              `${r.result.toUpperCase().padEnd(5)} ${r.metric} = ${r.observed ?? '?'}${
                r.expected ? ` (want ${r.expected})` : ''
              }`
          )
        );
        return;
      }
      if (action === 'deployments') {
        const deployments = runtime.getArtifacts().deployments;
        printBlock(`Deployments (${deployments.length})`, deployments.map(formatDeploymentLine));
        return;
      }
      if (action === 'history') {
        const summaries = runtime.taskSummaries();
        const details = summaries
          .map((s) => runtime.taskDetail(s.taskId))
          .filter((d): d is NonNullable<typeof d> => Boolean(d));
        printBlock(
          `History (${details.length})`,
          details.flatMap((d) => [
            `${d.summary.taskId}`,
            ...d.history.slice(-6).map((entry) => `  ${entry.kind.padEnd(11)} ${entry.label}`),
          ])
        );
        return;
      }
      if (action === 'failures') {
        const details = runtime
          .taskSummaries()
          .map((s) => runtime.taskDetail(s.taskId))
          .filter((d): d is NonNullable<typeof d> => Boolean(d?.failure));
        printBlock(
          `Failures (${details.length})`,
          details.flatMap((d) => [
            `${d.summary.taskId}: ${d.failure?.headline ?? ''}`,
            ...collectStrings(d.failure?.items.map((i) => `  ${i.label}`) ?? []),
          ])
        );
        return;
      }
      printBlock(action, await sessionInfo(action as 'sessions'));
    },
    [printBlock, runtime, sessionInfo]
  );

  /** Every command answers in its own named block; failures add a loud error row. */
  const printCommandError = useCallback(
    (title: string, message: string) => {
      appendRow(store, 'tool', title);
      appendRow(store, 'error', message);
      handle.notify();
    },
    [handle, store]
  );

  /** Run a message the shell itself composed (e.g. `/review`'s review prompt). */
  const dispatchRun = useCallback(
    (message: string) => {
      if (store.run.running) {
        queueRef.current.push(message);
        setQueueRevision((n) => n + 1);
        return;
      }
      void runTurn(message).then(() => void drainQueue());
    },
    [drainQueue, runTurn, store]
  );

  const runTaskShellCommand = useCallback(
    async (args: string): Promise<void> => {
      if (store.run.running) {
        printBlock('Task', ['a run is in flight — press Esc to interrupt it first']);
        return;
      }
      const parsed = splitCommandArgs(args);
      if (parsed.length === 0) {
        printBlock('Task', [
          'usage: /task run <goal...> [--accept "<cmd>"]',
          '/task status|timeline [id]',
          '/task resume [id]',
        ]);
        return;
      }
      if (parsed[0] === 'resume' && !parsed[1]) {
        const candidate = runtime
          .taskSummaries()
          .filter((task) => task.state === 'BLOCKED' || task.result === 'FAIL')
          .sort((left, right) => right.updatedAt - left.updatedAt)[0];
        if (!candidate) {
          printBlock('Resume', ['no failed, blocked, or abandoned task is available to resume']);
          return;
        }
        parsed.push(candidate.taskId);
      }
      if (parsed[0] === 'run' || parsed[0] === 'resume') {
        appendRow(store, 'user', `/task ${parsed.join(' ')}`);
        runtime.beginRun();
        beginRun(store);
        runStartedAtRef.current = Date.now();
        const controller = new AbortController();
        abortRef.current = controller;
        handle.notify();
        try {
          await runTaskCommand(parsed, {
            agent: options.agent,
            workspace: options.workspaceDir,
            sessionKey,
            signal: controller.signal,
            onAgentEvent: (event) =>
              applyAgentEvent(store, event as Parameters<typeof applyAgentEvent>[1]),
            onOutput: (stream, text) => {
              if (stream === 'stderr') {
                const line = text.trim();
                setStatusLine(line);
                // Phase transitions are transcript history, not a rotating
                // status: a minute-long device task must stay reviewable.
                const phase = /^\[task ([a-z]+)\] (.+)$/.exec(line);
                if (phase) {
                  appendRow(store, 'summary', `◇ task ${phase[1]} — ${phase[2]}`);
                }
              } else printBlock('Task', text.trimEnd().split('\n'));
            },
          });
        } catch (err) {
          printCommandError('Task', errorMessage(err));
        } finally {
          abortRef.current = undefined;
          endRun(store, controller.signal.aborted);
          await runtime.endRun(controller.signal.aborted);
          appendTaskVerdictIfAny(runStartedAtRef.current ?? 0);
          runStartedAtRef.current = undefined;
          setStatusLine(undefined);
          handle.notify();
        }
        return;
      }
      try {
        await runTaskCommand(parsed, {
          agent: options.agent,
          workspace: options.workspaceDir,
          sessionKey,
          onOutput: (stream, text) => {
            if (stream === 'stdout') printBlock('Task', text.trimEnd().split('\n'));
          },
        });
      } catch (err) {
        printCommandError('Task', errorMessage(err));
      }
    },
    [
      handle,
      options.agent,
      options.workspaceDir,
      printBlock,
      printCommandError,
      runtime,
      sessionKey,
      store,
    ]
  );

  /**
   * The plan-mode exit gate (A7.60-62, Qoder's core "present plan → approve →
   * execute" ritual). A finished plan run hands the user three decisions:
   * proceed with edits auto-accepted, proceed behind manual approvals, or
   * type what should change (which stays in plan mode). Esc keeps planning —
   * the gate is an offer, never a wall.
   */
  const openPlanGate = useCallback(() => {
    if (pendingDialogRef.current) return;
    runtime.setApprovalPending(true);
    handle.notify();
    const PROCEED_AUTO = 'Proceed: accept edits this session.';
    const PROCEED_MANUAL = 'Proceed: keep manual approvals.';
    const entry: PendingDialog = {
      kind: 'question',
      settled: false,
      resolve: (value) => {
        if (value === PROCEED_AUTO) {
          setCliInteractionMode('acceptEdits');
          dispatchRun('The plan above is approved — proceed with execution now.');
        } else if (value === PROCEED_MANUAL) {
          setCliInteractionMode('default');
          dispatchRun(
            'The plan above is approved — proceed with execution now (manual approvals stay on).'
          );
        } else if (value.trim()) {
          dispatchRun(`Plan feedback — revise the plan accordingly: ${value}`);
        }
      },
      optionAnswers: [PROCEED_AUTO, PROCEED_MANUAL, ''],
    };
    pendingDialogRef.current = entry;
    setApproval({
      title: 'Ready to code?',
      question: 'The plan is above. How should moss proceed?',
      options: [
        { key: '1', answer: 'y', label: 'Proceed — accept edits this session' },
        { key: '2', answer: 'y', label: 'Proceed — keep manual approvals' },
        { key: '3', answer: 'y', label: 'Tell moss what to change (type below)' },
      ],
      footer: '↑↓ then Enter · or type feedback below · Esc keeps planning',
      cursor: 0,
    });
  }, [dispatchRun, handle, runtime]);
  useEffect(() => {
    planGateRef.current = openPlanGate;
    return () => {
      planGateRef.current = undefined;
    };
  }, [openPlanGate]);

  /**
   * `/diff` — the real working-tree diff through the same helper the readline
   * REPL uses. A `result` row (not a detail dump) so the transcript keeps its
   * diff gutter and the ctrl+o expander instead of hundreds of plain lines.
   */
  const runDiffCommand = useCallback(async () => {
    try {
      const result = await runLocalShellCommand({
        command: 'git --no-pager diff --stat && git --no-pager diff',
        cwd: options.workspaceDir,
      });
      if (result.exitCode !== 0) {
        const notRepo = /not a git repository/i.test(result.output);
        printBlock('Diff', [
          notRepo
            ? `Not a git repository: ${options.workspaceDir} — /diff needs a git workspace.`
            : `git diff failed (exit ${result.exitCode}): ${
                result.output.trim().split('\n')[0] || 'unknown error'
              }`,
        ]);
        return;
      }
      appendRow(store, 'tool', 'Diff');
      appendRow(store, 'result', result.output.trim() || '(no unstaged working-tree changes)');
      handle.notify();
    } catch (err) {
      printCommandError('Diff', `git diff failed: ${errorMessage(err)}`);
    }
  }, [handle, options.workspaceDir, printBlock, printCommandError, store]);

  /**
   * `! <cmd>` — run the command inline through the SAME helper `/diff` uses
   * (`runLocalShellCommand`), commit the echo as a `user` row and the real
   * output as a `result` row so the diff gutter / ctrl+o expander apply. This is
   * deliberately synchronous to the transcript: no model turn is started (the
   * reference continues the turn with the output; that needs a live provider and
   * is left to the agent loop — see the task report).
   */
  const runShellSubmission = useCallback(
    async (command: string) => {
      appendRow(store, 'user', `! ${command}`);
      handle.notify();
      try {
        const result = await runLocalShellCommand({
          command,
          cwd: options.workspaceDir,
        });
        const output = result.output.replace(/\s+$/, '');
        // "(no output)" is a real result: the command ran and printed nothing.
        appendRow(
          store,
          'result',
          output ||
            `(no output${result.exitCode === 0 ? '' : ` · exit ${result.exitCode ?? 'signal'}`})`
        );
        if (result.exitCode !== 0) {
          appendRow(
            store,
            'detail',
            result.exitCode === null
              ? `terminated by ${result.signal ?? 'signal'}`
              : `exit code ${result.exitCode}`
          );
        }
      } catch (err) {
        appendRow(store, 'error', `! ${command} failed: ${errorMessage(err)}`);
      }
      handle.notify();
    },
    [handle, options.workspaceDir, store]
  );

  /**
   * `/compact` — reuses `handleCompactCommand`, the exact helper the REPL calls,
   * so the reported dropped-message/token numbers are the real compaction result.
   */
  const runCompactCommand = useCallback(
    async (args: string) => {
      if (store.run.running) {
        printBlock('Compact', ['a run is in flight — press Esc to interrupt it, then /compact']);
        return;
      }
      try {
        const outcome = await handleCompactCommand(
          options.agent,
          sessionKey,
          args.trim() || undefined
        );
        printBlock('Compact', outcome.split('\n'));
      } catch (err) {
        printCommandError('Compact', `compaction failed: ${errorMessage(err)}`);
      }
    },
    [options.agent, printBlock, printCommandError, sessionKey, store]
  );

  /**
   * `/model [name|number]` — lists the catalog or really switches the session
   * model: the agent config, the provider (rebuilt, because the loop reads
   * `config.llmProvider` per call), the persisted per-gateway preference and the
   * status row all change together, and the new context window is re-probed.
   */
  const runModelCommand = useCallback(
    async (args: string) => {
      if (store.run.running) {
        printBlock('Model', [
          'a run is in flight — press Esc to interrupt it before switching models',
        ]);
        return;
      }
      const config = resolveShellCliConfig();
      const fallbackProvider = (options.agent.config as { provider?: string }).provider;
      let choices: ModelChoiceList | undefined;
      try {
        choices = await loadModelChoicesForRuntime(config, currentModel ?? '', {
          fallbackProvider,
        });
      } catch (err) {
        choices = undefined;
        printCommandError('Model', `could not load the model catalog: ${errorMessage(err)}`);
      }
      const token = args.trim();
      if (!token) {
        if (!choices) return;
        setModelPicker({
          choices,
          cursor: Math.max(
            0,
            choices.choices.findIndex((item) => item.model === currentModel)
          ),
        });
        return;
      }
      if (token === 'config' || token.startsWith('config ')) {
        printBlock('Model', [
          '/model config is not wired in the shell — use `moss setup` for a guided',
          'provider/model/key change, or `moss config set model <name>` to persist one.',
          '`/model <name>` still switches the active model for this session.',
        ]);
        return;
      }
      const selected = choices ? resolveModelSelection(token, choices.choices) : null;
      const model = selected?.model ?? token;
      const provider = selected?.provider ?? choices?.provider ?? config?.provider;
      if (!config || !provider) {
        printCommandError('Model', 'could not resolve the provider config — run `moss setup`.');
        return;
      }
      try {
        options.agent.config.model = model;
        const mutable = options.agent.config as { provider?: string; baseUrl?: string };
        mutable.provider = provider;
        mutable.baseUrl = config.baseUrl;
        options.agent.config.llmProvider = createCliProvider({
          provider,
          apiKey: config.apiKey,
          model,
          baseUrl: config.baseUrl,
          ...(config.usingBundledDefault ? { usingBundledDefault: true } : {}),
        });
        writePreferredModel(config.baseUrl, model);
      } catch (err) {
        printCommandError('Model', `could not switch to ${model}: ${errorMessage(err)}`);
        return;
      }
      setCurrentModel(model);
      store.usage.lastModel = undefined;
      store.usage.contextUsed = 0;
      store.usage.contextTotal = 0;
      const probeGeneration = ++modelProbeGenerationRef.current;
      printBlock('Model', [
        selected
          ? `switched to ${model} (${provider})`
          : `switched to custom model ${model} (${provider})`,
        'context usage will appear after the first response from this model',
      ]);
      // Re-probe the new model's context window. Ignore an older probe that
      // finishes after a later model switch.
      void (async () => {
        try {
          const detected = await resolveContextTokensForModel({
            model,
            ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
            ...(config.apiKey ? { apiKey: config.apiKey } : {}),
            provider,
            timeoutMs: 4000,
          });
          if (probeGeneration !== modelProbeGenerationRef.current) return;
          options.agent.config.contextTokens = detected.contextTokens;
          store.usage.contextTotal = detected.contextTokens;
          handle.notify();
        } catch {
          // Best-effort — the name-matching fallback already ran during config load.
        }
      })();
    },
    [currentModel, handle, options.agent, printBlock, printCommandError, store]
  );

  /**
   * The shell's control-command router. It runs the SAME registry the readline
   * REPL runs (`src/cli/commands/registry.ts`) — no second implementation — and
   * only adds the commands that need live shell state: `/model`, `/compact`,
   * `/diff` and `/stop`. Returns false when nothing in the shell knows the input.
   */
  const runShellCommand = useCallback(
    async (text: string): Promise<boolean> => {
      const head = text.split(/\s+/, 1)[0] ?? text;
      const args = text.slice(head.length).trim();
      const title = commandBlockTitle(head);
      const locale = cliLocale();

      const context: CommandContext = {
        agent: options.agent,
        runtime: {
          ...(options.cliRuntime ?? {}),
          workspace: options.cliRuntime?.workspace ?? options.workspaceDir,
          sessionKey: options.cliRuntime?.sessionKey ?? sessionKey,
        },
        sessionKey,
        workspace: options.workspaceDir,
        ...(locale ? { locale } : {}),
        surface: COMMAND_SURFACE,
        say: (kind, out) =>
          kind === 'error' ? printCommandError(title, out) : printBlock(title, out.split('\n')),
        prefillInput: (value) => setInput(value),
        submitPrompt: (value) => dispatchRun(value),
        getContextUsage: () => shellContextUsage(store.usage),
        setInteractionMode: (mode: CliInteractionMode) => {
          // The policy layer already switched the mode; surface it so the change
          // is visible instead of silent.
          setStatusLine(`interaction mode: ${formatCliInteractionModeLabel(mode)}`);
        },
      };

      if (head === '/task') {
        await runTaskShellCommand(args);
        return true;
      }

      try {
        if (await runRegistryCommand(text, context)) return true;
      } catch (err) {
        printCommandError(title, `${head} failed: ${errorMessage(err)}`);
        return true;
      }

      if (head === '/model') {
        await runModelCommand(args);
        return true;
      }
      if (head === '/compact') {
        await runCompactCommand(args);
        return true;
      }
      if (head === '/diff') {
        await runDiffCommand();
        return true;
      }
      if (head === '/stop' || head === '/abort') {
        if (abortRef.current) {
          abortRef.current.abort();
          printBlock('Stop', ['interrupted the active run']);
        } else {
          printBlock('Stop', ['no run in flight — nothing to interrupt']);
        }
        return true;
      }
      return false;
    },
    [
      dispatchRun,
      options,
      printBlock,
      printCommandError,
      runCompactCommand,
      runDiffCommand,
      runModelCommand,
      sessionKey,
      setInput,
      store,
    ]
  );

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      setInput('');
      setHistoryIndex(undefined);
      setStatusLine(undefined);

      // `!` shell mode is checked FIRST: `/quit` typed in shell mode is a shell
      // command, not the shell's quit. Shell commands are also not prompt
      // history (↑ recalls goals), so nothing is pushed here.
      if (shellMode) {
        setShellMode(false);
        await runShellSubmission(text);
        return;
      }
      setHistory((entries) => [...entries.filter((entry) => entry !== text), text].slice(-100));

      if (text === '/quit' || text === '/exit') {
        exit();
        return;
      }
      if (text === '/help --all') {
        setHelpOverlay({ lines: buildHelpOverlayLines(true), all: true });
        return;
      }
      if (text === '/help' || text === '?') {
        setHelpOverlay({ lines: buildHelpOverlayLines(false), all: false });
        return;
      }
      if (text === '/usage') {
        printBlock('Usage', usageBlock(store.usage));
        return;
      }
      if (text === '/log') {
        // The session's full I/O is persisted on disk all along — the
        // conversation log (every message: user text, assistant text +
        // thinking, complete tool input/output) and the run-event log (steps,
        // tool calls, retries, failures). Nobody could find them, so this is
        // the map.
        const paths = getMossWorkspacePaths(options.workspaceDir);
        const conversation = path.join(paths.sessionsDir, `${sessionKey}.jsonl`);
        const events = path.join(
          paths.runtimeDir,
          'events',
          `${encodeURIComponent(sessionKey)}.jsonl`
        );
        const lines: string[] = [
          `session        ${sessionKey}`,
          `conversation   ${conversation}${fs.existsSync(conversation) ? '' : '  (after the first turn)'}`,
          `run events     ${events}${fs.existsSync(events) ? '' : '  (after the first run)'}`,
          '',
          `tail -f ${conversation}`,
        ];
        try {
          const tail = fs
            .readFileSync(conversation, 'utf8')
            .trim()
            .split('\n')
            .slice(-6)
            .map((raw) => describeConversationLogEntry(raw))
            .filter((line): line is string => Boolean(line));
          if (tail.length > 0) lines.push('', ...tail);
        } catch {
          // Not created yet — the paths above already say so.
        }
        printBlock('Log', lines);
        return;
      }
      if (text === '/clear') {
        // Clear the visible transcript but keep the banner (reference: /clear
        // leaves the header). Committed <Static> rows live in the terminal's
        // scrollback and cannot be un-printed — an ANSI clear wipes the visible
        // screen, and the `clearRevision` remount re-renders only what remains.
        store.rows = store.rows.filter((row) => row.kind === 'banner');
        store.version++;
        stdout.write('\x1b[2J\x1b[H');
        setClearRevision((n) => n + 1);
        appendRow(
          store,
          'summary',
          'transcript cleared — the conversation context is kept (see /compact to shrink it)'
        );
        handle.notify();
        return;
      }
      if (text === '/tasks') {
        await showBlock('tasks');
        return;
      }
      if (text === '/history') {
        await showBlock('history');
        return;
      }
      if (text === '/evidence') {
        await showBlock('evidence');
        return;
      }
      if (text === '/deployments') {
        await showBlock('deployments');
        return;
      }
      if (text === '/failures') {
        await showBlock('failures');
        return;
      }
      if (text === '/hooks') {
        // The hooks subsystem is the most powerful config surface (9 events,
        // blocking vetoes) and used to be manageable only by hand-editing
        // JSON. The view lists what is live and where to edit it.
        const hooks = (
          options.cliRuntime?.config as
            | {
                hooks?: Record<
                  string,
                  Array<{
                    matcher?: string;
                    command: string;
                    timeoutMs?: number;
                    blocking?: boolean;
                  }>
                >;
              }
            | undefined
        )?.hooks;
        const lines: string[] = [];
        if (hooks) {
          for (const [event, entries] of Object.entries(hooks)) {
            for (const hook of entries ?? []) {
              lines.push(
                `${event.padEnd(14)} ${hook.matcher ? `[${hook.matcher}] ` : ''}${hook.command}` +
                  `${hook.blocking ? ' · blocking' : ''}` +
                  `${hook.timeoutMs !== undefined ? ` · ${hook.timeoutMs}ms` : ''}`
              );
            }
          }
        }
        if (lines.length === 0) {
          lines.push(
            'no hooks configured — add a "hooks" object to the config file:',
            '  PreToolUse · PostToolUse · SessionStart · Stop · SubagentStop',
            '  PreCompact · PostCompact · SessionEnd · Notification',
            'each entry: { "command": "…", "matcher": "tool-glob", "timeoutMs": 5000, "blocking": true }'
          );
        }
        if (options.cliRuntime?.configDir) {
          lines.push('', `config dir: ${options.cliRuntime.configDir} (or MOSS_CONFIG_FILE)`);
        }
        printBlock('Hooks', lines);
        return;
      }
      if (text === '/sessions' || text === '/mcp' || text === '/subs' || text === '/bg') {
        await showBlock(text.slice(1) as 'sessions');
        return;
      }
      if (text === '/resume' || text.startsWith('/resume ')) {
        await runTaskShellCommand(`resume${text.slice('/resume'.length)}`);
        return;
      }
      if (
        text === '/rewind' ||
        text === '/undo' ||
        text.startsWith('/rewind ') ||
        text.startsWith('/undo ')
      ) {
        const arg = text.split(' ')[1];
        const checkpoints = options.listCheckpoints?.() ?? [];
        if (!arg) {
          printBlock(
            `Checkpoints (${checkpoints.length})`,
            checkpoints.map((c) => `${c.seq}. ${c.label} (${c.files} files)`)
          );
        } else {
          const seq = Number(arg);
          const result = options.rewindTo?.(seq);
          printBlock('Rewind', [
            result?.ok
              ? `restored checkpoint ${seq}: ${result.detail}`
              : (result?.detail ?? `rewind to ${seq} failed`),
          ]);
        }
        return;
      }
      if (text === '/queue' || text.startsWith('/queue ')) {
        const sub = text.split(' ')[1] ?? 'list';
        if (sub === 'pause') {
          queuePausedRef.current = true;
          setQueueRevision((n) => n + 1);
          printBlock('Queue', ['paused — new submissions wait']);
        } else if (sub === 'resume') {
          queuePausedRef.current = false;
          setQueueRevision((n) => n + 1);
          printBlock('Queue', ['resumed']);
          if (!store.run.running && queueRef.current.length > 0) void drainQueue();
        } else if (sub === 'drop') {
          const dropped = queueRef.current.shift();
          setQueueRevision((n) => n + 1);
          printBlock('Queue', [dropped ? `dropped: ${dropped.slice(0, 60)}` : 'queue empty']);
        } else if (sub === 'clear') {
          const count = queueRef.current.length;
          queueRef.current.length = 0;
          setQueueRevision((n) => n + 1);
          printBlock('Queue', [`cleared ${count} queued item${count === 1 ? '' : 's'}`]);
        } else {
          printBlock(
            `Queue (${queuePausedRef.current ? 'paused' : 'active'})`,
            queueRef.current.map((q, i) => `${i + 1}. ${q.slice(0, 60)}`)
          );
        }
        return;
      }
      if (text.startsWith('/steer')) {
        const constraint = text.slice('/steer'.length).trim();
        if (!constraint) {
          printBlock('Steer', ['usage: /steer <constraint> — injects at the next boundary']);
        } else {
          const entry = options.agent.steer?.(sessionKey, constraint);
          printBlock('Steer', [
            entry === null || entry === undefined
              ? 'rejected — no single active run on this session'
              : `queued: ${constraint.slice(0, 80)}`,
          ]);
        }
        return;
      }
      if (text.startsWith('/')) {
        // Shared registry first (status/doctor/permissions/mode/context/export/
        // review/quickstart), then the shell-local control commands, then
        // skills as first-class commands, then the honest unknown-command path.
        if (await runShellCommand(text)) return;
        const head = text.split(/\s+/, 1)[0] ?? text;
        const skill = options.skills?.find((entry) => `/${entry.name}` === head);
        if (skill) {
          appendRow(store, 'user', text);
          handle.notify();
          dispatchRun(
            `Use the "${skill.name}" skill${skill.description ? ` (${skill.description})` : ''} for this task. Read the skill body with the skill tool first, then follow it.`
          );
          return;
        }
        appendRow(store, 'error', `unknown command "${text.split(' ')[0]}" — try /help`);
        handle.notify();
        return;
      }
      if (pastePreview !== undefined) {
        const staged = pasteRef.current.pending.shift() ?? pastePreview;
        setPastePreview(undefined);
        if (!store.run.running) {
          appendRow(store, 'user', staged);
          handle.notify();
          void runTurn(staged).then(() => void drainQueue());
        }
        return;
      }
      appendRow(store, 'user', text);
      handle.notify();
      if (store.run.running) {
        queueRef.current.push(text);
        setQueueRevision((n) => n + 1);
        return;
      }
      void runTurn(text).then(() => void drainQueue());
    },
    [
      drainQueue,
      dispatchRun,
      exit,
      handle,
      options,
      pastePreview,
      printBlock,
      runShellCommand,
      runShellSubmission,
      runTurn,
      runtime,
      sessionKey,
      shellMode,
      showBlock,
      store,
    ]
  );

  const answerApproval = useCallback(
    (answer: CliApprovalAnswer) => {
      if (answer === 'amend') {
        // The tool runs; the user's next composer message steers it. Tell
        // them so the queued message does not feel like it vanished.
        setStatusLine('approved — type what moss should do next; your message is queued');
      }
      resolveApproval(answer);
    },
    [resolveApproval]
  );

  // Spinner ticker: only while a run is in flight, and cheap because ink's
  // <Static> rows are never re-rendered.
  const running = store.run.running;
  // Palette: open while the user is typing a command name; any edit resets the
  // selection and re-opens it (dismissal only lasts until the next keystroke).
  // `shellPaletteRows` is the shell's own surface (the same table `/help` prints),
  // so the menu cannot hide an advertised command or offer an unadvertised one.
  const paletteRows: PaletteRow[] = running
    ? []
    : shellPaletteRows(
        input,
        (options.skills ?? []).map((skill) => [`/${skill.name}`, skill.description] as const)
      );
  const paletteOpen =
    paletteRows.length > 0 &&
    !paletteDismissed &&
    !approval &&
    !shellMode &&
    !modelPicker &&
    !helpOverlay;
  const paletteSelection = Math.min(paletteCursor, Math.max(0, paletteRows.length - 1));
  /** First row of the rendered window — keeps the marked row and the acted row equal (D-15). */
  const paletteWindow = paletteWindowOffset(paletteSelection, paletteRows.length, PALETTE_MAX_ROWS);
  useEffect(() => {
    setPaletteCursor(0);
    setPaletteDismissed(false);
    setMentionCursor(0);
    setMentionDismissed(false);
  }, [input]);

  // `@` mentions: the index is built lazily, once per session, the first time
  // the user types an `@` token (a workspace walk is not free).
  const mentionToken =
    running || approval || shellMode ? null : mentionTokenAt(input, composer.caret);
  useEffect(() => {
    if (mentionToken && mentionIndex.length === 0) {
      setMentionIndex(workspaceFileIndex(options.workspaceDir));
    }
  }, [mentionToken?.query, mentionIndex.length, options.workspaceDir]);
  const mentionRows = mentionToken ? filterMentions(mentionIndex, mentionToken.query) : [];
  const mentionOpen = mentionToken !== null && !mentionDismissed && mentionRows.length > 0;
  const mentionSelection = Math.min(mentionCursor, Math.max(0, mentionRows.length - 1));

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => forceUpdate(), 140);
    return () => clearInterval(timer);
  }, [running, forceUpdate]);

  /**
   * Arm the Ctrl+C quit confirmation (D-7): the notice is a status line, not a
   * transcript row, because a confirm prompt that scrolls away is not a prompt.
   */
  const armQuitConfirm = useCallback(
    (inFlight: boolean) => {
      if (quitTimerRef.current !== undefined) clearTimeout(quitTimerRef.current);
      setQuitArmed(true);
      setStatusLine(
        inFlight ? 'run interrupted — press Ctrl+C again to quit' : 'press Ctrl+C again to quit'
      );
      handle.notify();
      quitTimerRef.current = setTimeout(() => {
        quitTimerRef.current = undefined;
        setQuitArmed(false);
        setStatusLine(undefined);
      }, QUIT_CONFIRM_MS);
    },
    [handle]
  );

  // A pending confirmation timer must not outlive the component.
  useEffect(
    () => () => {
      if (quitTimerRef.current !== undefined) clearTimeout(quitTimerRef.current);
      if (escClearTimerRef.current !== undefined) clearTimeout(escClearTimerRef.current);
    },
    []
  );

  /**
   * `Esc again to clear` (reference §2): one Esc on a non-empty idle composer
   * arms the affordance instead of destroying the draft; the second Esc clears.
   * Any real edit disarms it.
   */
  const disarmEscClear = useCallback(() => {
    if (escClearTimerRef.current !== undefined) clearTimeout(escClearTimerRef.current);
    escClearTimerRef.current = undefined;
    setEscClearArmed(false);
    setStatusLine((current) =>
      current === 'Esc again to clear the composer' ? undefined : current
    );
  }, []);

  const armEscClear = useCallback(() => {
    if (escClearTimerRef.current !== undefined) clearTimeout(escClearTimerRef.current);
    setEscClearArmed(true);
    setStatusLine('Esc again to clear the composer');
    escClearTimerRef.current = setTimeout(() => {
      escClearTimerRef.current = undefined;
      setEscClearArmed(false);
      setStatusLine((current) =>
        current === 'Esc again to clear the composer' ? undefined : current
      );
    }, ESC_CLEAR_MS);
  }, []);

  useInput((chunk, key) => {
    if (key.ctrl && chunk === 'c') {
      // D-7: `?` advertises `Ctrl+C interrupt the run · press again to quit`, and
      // the shell must keep that promise. ONE press never quits: it interrupts
      // (or, on an idle composer, arms the quit and KEEPS the draft); a second
      // press inside the confirm window exits. The old handler called `exit()`
      // straight away on an idle composer and destroyed the draft.
      //
      // The approval dismissal comes first (D-2): a pending dialog is denied
      // exactly once, so an aborted run can never leave a zombie modal behind.
      settleDialog(false);
      const inFlight = abortRef.current !== undefined;
      if (inFlight) abortRef.current?.abort();
      if (quitArmed) {
        exit();
        return;
      }
      armQuitConfirm(inFlight);
      return;
    }
    if (key.ctrl && chunk === 'd') {
      // A12.96: Ctrl+D quits only at an EMPTY composer — quitting on a
      // half-written draft silently destroys it. Esc-Esc is the deliberate
      // way to drop a draft; Ctrl+D on one gets a pointer instead.
      if (input.length > 0) {
        setStatusLine('Ctrl+D quits — press Esc twice to drop the draft first');
        return;
      }
      exit();
      return;
    }
    if (key.tab && key.shift) {
      if (approval) {
        setStatusLine('finish the pending approval before changing interaction mode');
        return;
      }
      // shift+tab (CSI Z) cycles the REAL policy mode; the subscription above
      // paints the new label on the same frame. Read through the getter, never
      // the React state, so a rapid double press cannot skip a mode.
      setCliInteractionMode(nextInteractionMode(getCliInteractionMode()));
      return;
    }
    if (approval) {
      const pending = pendingDialogRef.current;
      if (pending?.kind === 'question') {
        // N-1: an `ask_user_question` dialog is answered with the CHOSEN option
        // (or with free text typed into the composer), never with a permission
        // code. Unhandled keys fall through to the composer below so "Other" and
        // `multi_select` ("1,3") are typeable.
        if (key.escape) {
          resolveDialog('', { commit: 'answer: skipped' });
          return;
        }
        if (key.upArrow || key.downArrow) {
          setApproval((current) =>
            current
              ? {
                  ...current,
                  cursor: Math.min(
                    Math.max(0, current.options.length - 1),
                    Math.max(0, current.cursor + (key.upArrow ? -1 : 1))
                  ),
                }
              : current
          );
          return;
        }
        const pressed = typeof chunk === 'string' ? chunk.toLowerCase() : '';
        const optionIndex = approval.options.findIndex((option) => option.key === pressed);
        if (key.return) {
          if (input.trim()) {
            resolveDialog(input.trim());
            setInput('');
            return;
          }
          // Enter answers the CURSOR-selected option (the footer has always
          // advertised `↑↓ then Enter` — but only digit keys actually worked,
          // which the plan gate ran straight into).
          const idx = optionIndex >= 0 ? optionIndex : approval.cursor;
          const option = approval.options[idx];
          if (option) {
            resolveDialog(pending.optionAnswers?.[idx] ?? option.label);
            return;
          }
          return;
        }
        if (optionIndex >= 0 && !pending.freeTextEntry) {
          resolveDialog(
            pending.optionAnswers?.[optionIndex] ?? approval.options[optionIndex]!.label
          );
          return;
        }
      } else {
        if (key.escape) {
          answerApproval('n');
          return;
        }
        if (key.tab) {
          // A6.54 Tab-to-amend: option 1 becomes "Yes, and tell moss what to
          // do next" — the tool runs, and the composer message the user types
          // lands in the queue to steer the very next step.
          setApproval((current) =>
            current ? { ...current, amend: !current.amend, cursor: 0 } : current
          );
          return;
        }
        if (key.upArrow) {
          setApproval({ ...approval, cursor: Math.max(0, approval.cursor - 1) });
          return;
        }
        if (key.downArrow) {
          setApproval({
            ...approval,
            cursor: Math.min(approval.options.length - 1, approval.cursor + 1),
          });
          return;
        }
        if (key.return) {
          const amendArmed = approval.amend === true && approval.cursor === 0;
          answerApproval(amendArmed ? 'amend' : (approval.options[approval.cursor]?.answer ?? 'n'));
          return;
        }
        const pressed = chunk?.toLowerCase();
        const direct = approval.options.find((option) => option.key === pressed);
        if (direct) {
          answerApproval(direct.answer);
          return;
        }
        if (pressed === 'y' || pressed === 'a' || pressed === 'n') answerApproval(pressed);
        return;
      }
    }

    if (sessionPicker) {
      // The boot resume picker owns the keyboard: typing filters by title or
      // key, ↑↓ move, Enter RESUMES the session in place (replay + switch),
      // Esc keeps the fresh session.
      const matches = filterPickerSessions(pickerSessions, sessionPicker.query);
      if (key.escape) {
        setSessionPicker(undefined);
        setStatusLine('fresh session — `moss resume` reopens the picker');
        return;
      }
      if (key.upArrow || key.downArrow) {
        setSessionPicker((current) =>
          current
            ? {
                ...current,
                cursor: movePaletteSelection(current.cursor, matches.length, key.upArrow ? -1 : 1),
              }
            : current
        );
        return;
      }
      if (key.return) {
        const pick = matches[sessionPicker.cursor];
        setSessionPicker(undefined);
        if (pick) {
          void (async () => {
            try {
              const sessionStore = (
                options.agent.config as {
                  sessionStore?: { loadMessages: (key: string) => Promise<unknown[]> };
                }
              ).sessionStore;
              const messages = sessionStore ? await sessionStore.loadMessages(pick.key) : [];
              const replay = buildResumeReplay(messages as Parameters<typeof buildResumeReplay>[0]);
              for (const item of replay.items) appendRow(store, item.kind, item.text);
              appendRow(
                store,
                'result',
                `resumed ${pick.key} — replayed ${replay.items.length} rows`
              );
              setActiveSession(pick.key);
            } catch (err) {
              appendRow(store, 'error', `could not resume ${pick.key}: ${errorMessage(err)}`);
            }
            handle.notify();
          })();
        }
        return;
      }
      if (key.backspace || key.delete) {
        setSessionPicker((current) =>
          current ? { ...current, query: current.query.slice(0, -1), cursor: 0 } : current
        );
        return;
      }
      if (
        typeof chunk === 'string' &&
        chunk &&
        !key.ctrl &&
        !key.meta &&
        !key.tab &&
        !chunk.startsWith('\x1b') &&
        !/[\r\n]/.test(chunk)
      ) {
        setSessionPicker((current) =>
          current ? { ...current, query: current.query + chunk, cursor: 0 } : current
        );
        return;
      }
      return;
    }

    if (historySearch) {
      // The Ctrl+R overlay owns the keyboard: typing filters, ↑↓ move, Enter
      // STAGES the match into the composer (using ≠ sending), Esc cancels.
      const matches = filterHistory(history, historySearch.query);
      if (key.escape) {
        setHistorySearch(undefined);
        return;
      }
      if (key.upArrow || key.downArrow) {
        setHistorySearch((current) =>
          current
            ? {
                ...current,
                cursor: movePaletteSelection(current.cursor, matches.length, key.upArrow ? -1 : 1),
              }
            : current
        );
        return;
      }
      if (key.return) {
        const picked = matches[historySearch.cursor];
        setHistorySearch(undefined);
        if (picked) {
          setInput(picked);
          setStatusLine('prompt staged from history — Enter sends');
        }
        return;
      }
      if (key.backspace || key.delete) {
        setHistorySearch((current) =>
          current ? { ...current, query: current.query.slice(0, -1), cursor: 0 } : current
        );
        return;
      }
      if (
        typeof chunk === 'string' &&
        chunk &&
        !key.ctrl &&
        !key.meta &&
        !key.tab &&
        !chunk.startsWith('\x1b') &&
        !/[\r\n]/.test(chunk)
      ) {
        setHistorySearch((current) =>
          current ? { ...current, query: current.query + chunk, cursor: 0 } : current
        );
        return;
      }
      return;
    }

    if (mentionOpen) {
      if (key.upArrow || key.downArrow) {
        setMentionCursor((current) =>
          movePaletteSelection(current, mentionRows.length, key.upArrow ? -1 : 1)
        );
        return;
      }
      if (key.tab) {
        // The reference completes the highlighted path into the composer and
        // does NOT run anything.
        const entry = mentionRows[mentionSelection];
        if (entry && mentionToken) {
          const completed = completeMention(input, mentionToken, entry);
          setComposer(composerSetValue(completed.value, completed.caret));
        }
        return;
      }
      if (key.escape) {
        setMentionDismissed(true);
        return;
      }
    }

    if (helpOverlay) {
      if (key.escape || key.return || (key.ctrl && chunk === 'c')) {
        setHelpOverlay(undefined);
      }
      return;
    }

    if (modelPicker) {
      if (key.upArrow || key.downArrow) {
        setModelPicker((current) =>
          current
            ? {
                ...current,
                cursor: movePaletteSelection(
                  current.cursor,
                  current.choices.choices.length,
                  key.upArrow ? -1 : 1
                ),
              }
            : current
        );
        return;
      }
      if (key.escape) {
        setModelPicker(undefined);
        return;
      }
      if (key.return) {
        const choice = modelPicker.choices.choices[modelPicker.cursor];
        setModelPicker(undefined);
        if (choice) void runModelCommand(choice.model);
        return;
      }
      return;
    }

    if (paletteOpen) {
      if (key.upArrow || key.downArrow) {
        setPaletteCursor((current) =>
          movePaletteSelection(current, paletteRows.length, key.upArrow ? -1 : 1)
        );
        return;
      }
      if (key.tab) {
        const command = paletteRows[paletteSelection]?.[0];
        if (command) setComposer(composerSetValue(command, command.length));
        return;
      }
      if (key.escape) {
        setPaletteDismissed(true);
        // The menu is closed; the composer still holds the typed `/…` — offer
        // the reference's second-Esc clear instead of leaving a dead command.
        if (input.length > 0) armEscClear();
        return;
      }
      if (key.return) {
        const command = paletteRows[paletteSelection]?.[0];
        if (command) {
          void submit(command);
          return;
        }
      }
    }

    if (key.return) {
      // Shift/Alt+Enter inserts a newline; a trailing backslash is the classic
      // fallback for terminals that cannot report Shift+Enter.
      if (key.shift || key.meta) {
        setComposer((current) => composerNewline(current));
        return;
      }
      if (input.endsWith('\\')) {
        setComposer((current) => composerInsert(composerDelete(current, 'backward'), '\n'));
        return;
      }
      void submit(input);
      return;
    }
    // Ctrl+J (line feed) is the portable newline key.
    if (chunk === '\n') {
      setComposer((current) => composerNewline(current));
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      const word = Boolean(key.meta || key.ctrl);
      const motion = key.leftArrow ? (word ? 'word-left' : 'left') : word ? 'word-right' : 'right';
      setComposer((current) => composerMove(current, motion, Math.max(4, columns - 2)));
      return;
    }
    if (key.escape) {
      if (pastePreview !== undefined) {
        pasteRef.current.pending.length = 0;
        setPastePreview(undefined);
        setInput('');
        return;
      }
      if (shellMode) {
        // Esc cancels shell mode: the draft is discarded and the composer
        // returns to the normal `❯` prompt (nothing was executed).
        setShellMode(false);
        setInput('');
        return;
      }
      if (abortRef.current) {
        abortRef.current.abort();
        return;
      }
      // Idle with a draft: one Esc must not destroy it. The first Esc arms the
      // `Esc again to clear` affordance; only the second press clears (D-7's
      // double-press pattern, applied to the draft).
      if (input.length > 0) {
        if (escClearArmed) {
          disarmEscClear();
          setInput('');
          setStatusLine(undefined);
        } else {
          armEscClear();
        }
      }
      return;
    }
    if (
      pastePreview !== undefined ||
      pasteRef.current.active ||
      pasteRef.current.pending.length > 0
    ) {
      return;
    }
    if (key.upArrow || key.downArrow) {
      // Inside a multi-line draft the arrows move between visual rows; on a
      // single-line draft they walk the input history.
      if (input.includes('\n')) {
        setComposer((current) =>
          composerMove(current, key.upArrow ? 'up' : 'down', Math.max(4, columns - 2))
        );
        return;
      }
      if (history.length === 0) return;
      if (key.upArrow) {
        const next =
          historyIndex === undefined ? history.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(next);
        setInput(history[next] ?? '');
        setStatusLine(`history ${next + 1}/${history.length} — ↑↓ to walk · type to edit`);
      } else if (historyIndex !== undefined) {
        const next = historyIndex + 1;
        if (next >= history.length) {
          setHistoryIndex(undefined);
          setInput('');
          setStatusLine(undefined);
        } else {
          setHistoryIndex(next);
          setInput(history[next] ?? '');
          setStatusLine(`history ${next + 1}/${history.length} — ↑↓ to walk · type to edit`);
        }
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (shellMode && input.length === 0) {
        // Backspacing an empty shell draft leaves shell mode (same as Esc).
        setShellMode(false);
        return;
      }
      setComposer((current) => composerDelete(current, key.delete ? 'forward' : 'backward'));
      return;
    }
    // Ctrl+<letter> shortcuts, driven by the same table the help block prints.
    if (key.ctrl && typeof chunk === 'string' && chunk.length === 1) {
      const code = chunk.charCodeAt(0);
      const letter = code >= 1 && code <= 26 ? String.fromCharCode(code + 96) : chunk.toLowerCase();
      if (letter === 'a') {
        setComposer((current) => composerMove(current, 'line-start'));
        return;
      }
      if (letter === 'e') {
        // Readline muscle memory (and the reference CLI): end of line. The
        // evidence panel moved to Ctrl+V so this key could be an editor key.
        setComposer((current) => composerMove(current, 'line-end'));
        return;
      }
      if (letter === 'y') {
        // Yank the last killed text back (readline's kill ring, depth 1).
        if (killRef.current) {
          const killed = killRef.current;
          setComposer((current) => composerInsert(current, killed));
          setStatusLine(undefined);
        } else {
          setStatusLine('nothing to paste — Ctrl+U / Ctrl+K / Ctrl+W delete into the kill ring');
        }
        return;
      }
      if (letter === 'r') {
        // A2.22: readline/reference muscle memory — search earlier prompts.
        setHistorySearch({ query: '', cursor: 0 });
        return;
      }
      if (letter === 's') {
        // A2.24: stash the prompt when something urgent arrives; a second
        // Ctrl+S SWAPS — the new draft goes into the stash and the parked
        // one comes back (neither is ever lost).
        if (input.length > 0) {
          const restore = stashRef.current;
          stashRef.current = input;
          setInput(restore ?? '');
          setStatusLine(
            restore !== undefined
              ? 'swapped — Ctrl+S again to swap back'
              : 'prompt stashed — Ctrl+S brings it back'
          );
        } else if (stashRef.current !== undefined) {
          const stashed = stashRef.current;
          stashRef.current = undefined;
          setInput(stashed);
          setStatusLine(undefined);
        } else {
          setStatusLine('nothing to stash — the composer is empty');
        }
        return;
      }
      if (letter === 'w' || letter === 'u' || letter === 'k') {
        const unit = letter === 'u' ? 'line-start' : letter === 'k' ? 'line-end' : 'word-backward';
        const { next, killed } = composerKill(composer, unit);
        if (killed) {
          killRef.current = killed;
          setComposer(next);
          const shown = killed.length > 24 ? `${killed.length} chars` : `"${killed.trim()}"`;
          setStatusLine(`deleted ${shown} — Ctrl+Y to paste back`);
        }
        return;
      }
      if (letter === 'o') {
        setVerbose((current) => !current);
        // Re-emit the transcript (see `verboseRevision`): the key change remounts
        // <Static> so the rows the marker pointed at are really re-rendered.
        setVerboseRevision((n) => n + 1);
        return;
      }
      const action = ctrlBinding(letter);
      if (action === 'clear') {
        setInput('');
        setStatusLine(undefined);
        return;
      }
      if (action) void showBlock(action);
      return;
    }
    // NB: key.shift must NOT be in this guard — ink reports shift=true for
    // every single uppercase letter (parse-keypress.js: "shift+letter"),
    // so filtering on it silently dropped R/D/K/M/C… and made goals like
    // "RDK X5" untypable. Shifted sequences that matter arrive as \x1b…
    // and are filtered below.
    if (!chunk || key.meta || key.tab || key.upArrow || key.downArrow) return;
    if (chunk.startsWith('\x1b')) return;
    const newlineIdx = chunk.search(/[\r\n]/);
    if (newlineIdx >= 0) {
      const head = chunk.slice(0, newlineIdx);
      const tail = chunk.slice(newlineIdx + 1);
      if (tail.length === 0 && head.length > 0 && !/[\r\n]/.test(head)) {
        // A batched `!cmd\r` (paste / fast typing) never saw `!` as its own
        // keypress: run it as a shell submission instead of a goal.
        if (input.length === 0 && head.startsWith('!')) {
          const command = head.slice(1).trim();
          if (command) void runShellSubmission(command);
          else setShellMode(true);
          return;
        }
        void submit(input + head);
      }
      return;
    }
    // `!` as the FIRST character enters shell mode for this draft: the `!` is
    // consumed and becomes the composer prefix, exactly like the reference
    // (`claude-code-surface.md` §5). A batched chunk beginning with `!` counts.
    if (!shellMode && input.length === 0 && chunk.startsWith('!')) {
      setShellMode(true);
      const rest = chunk.slice(1);
      if (rest) setComposer((current) => composerInsert(current, rest));
      return;
    }
    // Insert AT THE CARET (the bulk setInput shim parks the caret at the end,
    // which silently turned every mid-text edit into an append).
    // A real edit ends every transient affordance: history-walk mode, the
    // `Esc again to clear` arming, and the status note that came with them.
    if (historyIndex !== undefined) setHistoryIndex(undefined);
    disarmEscClear();
    setStatusLine((current) =>
      current !== undefined && /^(history |deleted |nothing to paste)/.test(current)
        ? undefined
        : current
    );
    setComposer((current) => composerInsert(current, chunk));
  });

  // Bracketed paste: staged so one paste becomes ONE message with newlines.
  useEffect(() => {
    if (!stdin) return;
    const onData = (chunk: Buffer | string) => {
      const disposition = feedChunk(pasteRef.current, chunk.toString('utf8'));
      if (disposition.completed) {
        const staged = pasteRef.current.pending[0] ?? '';
        setPastePreview(staged);
        // A multi-hundred-KB paste goes to the model verbatim — the staging
        // line must say so out loud before Enter commits it.
        const size = staged.length;
        setInput(
          size > 100_000
            ? `[paste: ${staged.split('\n').length} lines · LARGE ${Math.round(size / 1000)}k chars — Enter sends it all; @-mention a file instead to send a path]`
            : `[paste: ${staged.split('\n').length} lines — Enter sends as one message, Esc discards]`
        );
        handle.notify();
      }
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin, handle]);

  // ─── render ────────────────────────────────────────────────────────────

  // Reasoning is hidden by default, exactly like the reference CLI: the
  // composer line (`✢ Thinking… (4s · ↓ N tokens)`) is the activity signal, and
  // the inner monologue is opt-in through moss's own env convention.
  const showThinking = process.env.MOSS_SHOW_THINKING === 'true';
  const live: LiveView = {
    running,
    startedAt: runStartedAtRef.current,
    toolLine: store.run.toolLine,
    streaming: store.run.streamingText,
    thinking: showThinking ? store.run.thinkingText : '',
    tokensOut: store.usage.runTokensOut,
    queued: queueRef.current.length,
    ...(queueRef.current[0] ? { queuePreview: queueRef.current[0] } : {}),
    ...(store.run.retry ? { retry: store.run.retry } : {}),
    ...(store.run.lastEventAt !== undefined ? { lastEventAt: store.run.lastEventAt } : {}),
    blocked: Boolean(approval),
  };
  const actualModel =
    store.usage.lastModel && store.usage.lastModel !== currentModel
      ? store.usage.lastModel
      : undefined;
  const status: StatusView = {
    running,
    blocked: Boolean(approval),
    ...(actualModel ? { model: actualModel } : {}),
    ...(approval ? { dialogKind: pendingDialogRef.current?.kind } : {}),
    ...(approval && pendingDialogRef.current?.kind === 'question'
      ? { dialogHasOptions: approval.options.length > 0 }
      : {}),
    tokens: running ? store.usage.runTokensOut : store.usage.tokensIn + store.usage.tokensOut,
    taskCount: runtime.taskSummaries().length,
    queueLength: queueRef.current.length,
    contextUsed: store.usage.contextUsed,
    contextTotal: store.usage.contextTotal,
    // A7: the policy layer's live mode is part of the chrome, always.
    mode: interactionMode,
    verbose,
    ...(stashRef.current !== undefined ? { stashed: true } : {}),
    shellMode,
  };
  const editor = renderComposerEditor(composer, {
    width: columns,
    maxRows: COMPOSER_MAX_ROWS,
    placeholder: input.length === 0 && !running ? PLACEHOLDER_TEXT : undefined,
    // Shell mode swaps the prompt glyph (`! ` instead of `❯ `) — E2.
    firstPrefix: shellMode ? '! ' : '❯ ',
    restPrefix: '  ',
  });
  const composerRuns: ComposerRun[][] = editor.lines;
  // The composer sits between two full-width rules; everything else is plain.
  // D-15: hand the renderer the window that contains the cursor, so the `❯`
  // marker and the command Enter/Tab act on are the same row.
  const helpOverlayLines = helpOverlay
    ? [
        line(rule(columns)),
        line(
          clip(
            helpOverlay.all
              ? '  Help · full reference · Esc to close'
              : '  Help · Esc or Enter to close',
            columns
          ),
          { dim: true }
        ),
        ...helpOverlay.lines
          .slice(
            0,
            Math.max(1, Math.min(helpOverlay.lines.length, Math.max(6, windowSize.rows - 8)))
          )
          .map((text) => line(clip(`  ${text}`, columns), { dim: true })),
        ...(helpOverlay.lines.length > Math.max(6, windowSize.rows - 8)
          ? [
              line(
                clip(
                  helpOverlay.all
                    ? '  … shorter terminal — resize or use / <name>'
                    : '  … more commands in /help --all',
                  columns
                ),
                { dim: true }
              ),
            ]
          : []),
      ]
    : [];
  const modelPickerStart = modelPicker
    ? Math.min(
        Math.max(0, modelPicker.cursor - 7),
        Math.max(0, modelPicker.choices.choices.length - 8)
      )
    : 0;
  const modelPickerLines = modelPicker
    ? [
        line(rule(columns)),
        line(
          clip(
            `  Select model · ${modelPicker.choices.choices.length} available · ↑↓ move · Enter choose · Esc close`,
            columns
          ),
          { dim: true }
        ),
        ...modelPicker.choices.choices
          .slice(modelPickerStart, modelPickerStart + 8)
          .map((choice, offset) => {
            const index = modelPickerStart + offset;
            return line(
              clip(
                `${index === modelPicker.cursor ? '❯' : ' '} ${String(index + 1).padStart(2, ' ')}. ${choice.model}${choice.label ? ` — ${choice.label}` : ''}`,
                columns
              ),
              index === modelPicker.cursor ? { color: 'cyan', bold: true } : { dim: true }
            );
          }),
        ...(modelPicker.choices.choices.length > 8
          ? [line(clip('  … type /model <name> for any other model', columns), { dim: true })]
          : []),
      ]
    : [];
  const palette = paletteOpen
    ? renderSlashPalette(paletteFrameRows(paletteRows, paletteWindow, PALETTE_MAX_ROWS), {
        width: columns,
        selected: paletteSelection - paletteWindow,
        query: input.trimStart(),
      })
    : [];
  const mentions =
    mentionOpen && !modelPicker
      ? renderMentionMenu(mentionRows.slice(0, MENTION_MAX_ROWS), {
          width: columns,
          selected: Math.min(mentionSelection, Math.max(0, mentionRows.length - 1)),
        })
      : [];
  // Shell mode tints both rules (E2): the composer sits between them, so the
  // whole input block reads as one state.
  const ruleTone = shellMode ? { color: SHELL_MODE_TONE } : {};
  // Ctrl+R prompt-search overlay (A2.22): query box + matches + footer, in
  // the pinned chrome right above the status row.
  const historySearchMatches = historySearch ? filterHistory(history, historySearch.query) : [];
  const historySearchOverlay = historySearch
    ? renderHistorySearch(historySearch.query, historySearchMatches, {
        width: columns,
        selected: Math.min(historySearch.cursor, Math.max(0, historySearchMatches.length - 1)),
      })
    : [];
  const sessionPickerMatches = sessionPicker
    ? filterPickerSessions(pickerSessions, sessionPicker.query)
    : [];
  const sessionPickerOverlay = sessionPicker
    ? renderSessionPicker(
        sessionPicker.query,
        sessionPickerMatches,
        Math.min(sessionPicker.cursor, Math.max(0, sessionPickerMatches.length - 1)),
        columns
      )
    : [];
  // Context-window high-water mark: the status row paints the percentage, and
  // past the warn line a full row says what happens next (auto-compact) and
  // what the user can do now (/compact).
  const contextPct =
    store.usage.contextTotal > 0
      ? Math.round((store.usage.contextUsed / store.usage.contextTotal) * 100)
      : 0;
  // A5: a blocked task is a standing decision the user owes — it stays pinned
  // (even behind an approval dialog) with the reason and the recovery command.
  const blockedTask = runtime
    .taskSummaries()
    .filter((task) => task.state === 'BLOCKED')
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const blockedLine = blockedTask
    ? line(
        clip(
          `◇ task ${blockedTask.taskId.slice(-6)} blocked — ${
            blockedTask.blockedReason ?? 'user decision required'
          } · /task resume ${blockedTask.taskId}`,
          columns
        ),
        { color: 'yellow' }
      )
    : undefined;
  const chromeTop: TuiLine[] = [
    // D-13: the dialog gets a height budget (terminal rows minus the rest of the
    // pinned chrome and any extra composer rows) so a short terminal can never
    // push the question of a security prompt off screen.
    ...(approval
      ? renderApproval(approval, columns, {
          maxHeight: Math.max(
            3,
            windowSize.rows - APPROVAL_CHROME_RESERVE - Math.max(0, editor.lines.length - 1)
          ),
        })
      : []),
    ...(blockedLine ? [blockedLine] : []),
    // A pending approval/question owns the decision area. Suppress secondary
    // overlays and live checklist noise so its question and options remain
    // visible on short terminals.
    ...(!approval ? renderTodoPanel(store.todos, columns) : []),
    ...(!approval && statusLine ? [line(clip(statusLine, columns), { dim: true })] : []),
    ...(!approval && contextPct >= CONTEXT_WARN_PCT
      ? [
          line(
            clip(
              `context ${contextPct}% full — auto-compact will trim older messages · /compact to do it now`,
              columns
            ),
            { color: 'yellow' }
          ),
        ]
      : []),
    ...(!approval && !helpOverlay ? palette : []),
    ...(!approval && !helpOverlay ? sessionPickerOverlay : []),
    ...(!approval && !helpOverlay ? historySearchOverlay : []),
    ...(!approval && !helpOverlay ? mentions : []),
    ...(!helpOverlay ? modelPickerLines : []),
    ...helpOverlayLines,
    renderStatusRight(status, columns),
    line(rule(columns), ruleTone),
  ];
  const chromeBottom: TuiLine[] = [line(rule(columns), ruleTone), renderHint(status, columns)];
  const liveLines = renderLive(live, columns, verbose);

  /**
   * Blank separator lines are part of the grammar (every block starts after an
   * empty line), but ink renders `<Text></Text>` as a ZERO-height element — the
   * separators silently disappear. A single space keeps the row.
   */
  /**
   * D-12: a line that carries inline runs is rendered run-by-run (nested
   * `<Text>`), so inline code keeps its colour inside mixed prose and bold +
   * italic can coexist.
   *
   * The ROW style is applied to the outer `<Text>` even when runs exist: a
   * heading's `bold` and a blockquote's `dim` live on the row (a run cannot
   * express `dim`), and ink applies a `<Text>`'s chalk over its composed
   * children, so a nested run keeps its own colour while inheriting the uniform
   * row attribute. Row fields are uniform-only, so they never contradict a run.
   */
  const inkLine = (l: TuiLine, key: string): React.ReactElement =>
    React.createElement(
      Text,
      { key, ...inkLineStyle(l) },
      ...(l.runs?.length
        ? l.runs.map((run, index) =>
            React.createElement(Text, { key: `${key}-${index}`, ...inkTextStyle(run) }, run.text)
          )
        : [l.text === '' ? ' ' : l.text])
    );

  /**
   * Composer row: styled runs, so the caret is a real inverted cell. In shell
   * mode the row takes the shell accent on its prompt glyph (`! `) without
   * touching the command text — `renderComposerEditor` emits the prefix as its
   * own run, except for the placeholder where it is glued to the placeholder.
   */
  const inkRuns = (runs: ComposerRun[], key: string, accentPrompt: boolean): React.ReactElement => {
    const children: React.ReactElement[] = [];
    runs.forEach((run, index) => {
      const accent = accentPrompt && index === 0;
      const head = accent ? run.text.slice(0, PROMPT_CELLS) : '';
      const tail = accent ? run.text.slice(PROMPT_CELLS) : run.text;
      if (head) {
        children.push(
          React.createElement(
            Text,
            {
              key: `${key}-${index}-prompt`,
              color: SHELL_MODE_TONE,
              ...(run.inverse ? { inverse: true } : {}),
            },
            head
          )
        );
      }
      children.push(
        React.createElement(
          Text,
          { key: `${key}-${index}`, ...(run.inverse ? { inverse: true } : {}) },
          tail
        )
      );
    });
    return React.createElement(
      Text,
      { key, ...(editor.placeholder ? { dimColor: true } : {}) },
      ...children
    );
  };

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Static, {
      // ink's <Static> memoizes on the ITEM ARRAY IDENTITY, so the store array
      // must be copied every render — pushing into it in place renders nothing
      // (the memo keeps returning the empty slice taken at mount).
      //
      // The key carries the ctrl+o revision: remounting is the only way ink
      // re-renders rows it has already committed (D-5). `/clear` rides the same
      // mechanism: after the ANSI wipe, the remount re-prints only the rows the
      // store kept (the banner).
      key: `transcript-${verboseRevision}-${clearRevision}`,
      items: store.rows.slice(),
      // ink types Static's children as (item: unknown, index) => ReactNode.
      children: (item: unknown) => {
        const row = item as TranscriptRow;
        return React.createElement(
          Box,
          { key: row.id, flexDirection: 'column' },
          ...renderTranscriptRow(row, columns, verbose).map((l, index) =>
            inkLine(l, `${row.id}-${index}`)
          )
        );
      },
    }),
    ...liveLines.map((l, index) => inkLine(l, `live-${index}`)),
    ...chromeTop.map((l, index) => inkLine(l, `chrome-top-${index}`)),
    ...composerRuns.map((runs, index) =>
      inkRuns(runs, `composer-${index}`, shellMode && index === 0)
    ),
    ...chromeBottom.map((l, index) => inkLine(l, `chrome-bottom-${index}`))
  );
}

function stdouts(stdout: { columns?: number } | undefined): number {
  // `||` (not `??`): a PTY without a negotiated winsize reports 0, which would
  // collapse every clip() to nothing.
  return stdout?.columns || 80;
}

/** Boot the TUI; resolves when the user quits. TTY-only entry point. */
export async function runTuiApp(options: TuiAppOptions): Promise<void> {
  const handle = createStoreHandle();
  const runtime = options.runtime ?? new TaskRuntime({ workspaceDir: options.workspaceDir });
  const instance = render(React.createElement(TuiAppRoot, { options, handle, runtime }), {
    exitOnCtrlC: false,
  });
  await instance.waitUntilExit();
}
