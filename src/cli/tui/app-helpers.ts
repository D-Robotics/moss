/**
 * Pure presentation layer for the CLI shell (`app.ts`).
 *
 * Everything here is side-effect-free: the option/contract types the host hands
 * to `runTuiApp`, the approval and question dialog shapes, the inline ink style
 * maps, and the palette / resume-picker / control-command adapters. Splitting
 * them out keeps the stateful shell module (`TuiAppRoot`, one hook-heavy
 * component) reading as render logic, and lets a spec import a helper without
 * pulling React in.
 *
 * No ink/react import may appear in this file — that boundary is what keeps the
 * helper layer testable and the dynamic-import discipline of `src/cli/tui/**`
 * honest.
 */
import type { MossAgent } from '../../core/agent/moss-agent.js';
import type { TaskRuntime } from '../../core/task-runtime/runtime.js';
import { errorMessage } from '../../errors.js';
import {
  CLI_APPROVAL_FOOTER,
  CLI_APPROVAL_OPTIONS,
  type CliApprovalView,
} from '../approval-view.js';
import { resolveCliConfig, type ResolvedCliConfig } from '../config.js';
import type { CliInteractionMode } from '../interaction-mode.js';
import type { CliRuntimeStatus } from '../onboarding.js';
import type { ContextUsageSnapshot } from '../usage-display.js';
import { tui } from './copy.js';
import {
  HELP_KEYS,
  HELP_PREFIXES,
  ALL_SHELL_COMMANDS,
  SHELL_COMMANDS,
  SHELL_COMMAND_NAMES,
  SHELL_COMMAND_ROWS,
} from './help.js';
import { slashPaletteRows, type PaletteRow } from './palette.js';
import type { TranscriptRow, TuiUsageState } from './render-bridge.js';
import { clip, line, type TuiColor, type TuiLine } from './text.js';

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
  /** `inline` keeps the primary screen. `fullscreen` is the alternate-screen default from `runTuiApp`. */
  renderer?: 'inline' | 'fullscreen';
  version?: string;
  /**
   * CLI locale (the host passes `cliLocale()`, i.e. LC_ALL/LC_MESSAGES/LANG).
   * Decides whether moss's own chrome renders zh; the environment is only a
   * fallback when the host does not supply it.
   */
  locale?: string;
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

/**
 * shift+tab cycle order (`claude-code-surface.md` §6.6: manual → accept edits
 * → plan → auto). v0.26 (PRD W1): the policy layer has four real modes —
 * manual → acceptEdits → plan → full → manual — and the cycle visits all of
 * them. The LIST is the single source of truth for the key.
 */
export const INTERACTION_MODE_CYCLE: readonly CliInteractionMode[] = [
  'manual',
  'acceptEdits',
  'plan',
  'full',
];

export function nextInteractionMode(current: CliInteractionMode): CliInteractionMode {
  const index = INTERACTION_MODE_CYCLE.indexOf(current);
  return INTERACTION_MODE_CYCLE[(index + 1) % INTERACTION_MODE_CYCLE.length] ?? 'manual';
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
  const body = lines[0] ?? tui('Approval required');
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
    question: tui('Do you want to proceed?'),
    options: [...CLI_APPROVAL_OPTIONS],
    footer: CLI_APPROVAL_FOOTER,
  };
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
      title: tui('Question'),
      question: title.join(' ') || tui('Question'),
      options: options.map((label, index) => ({
        key: String(index + 1),
        answer: 'y' as const,
        label,
      })),
      footer: options.length
        ? multiSelect
          ? tui('type 1,3 below · ↑↓ then Enter · Esc to skip')
          : tui('{keys} · ↑↓ then Enter · Esc to skip', {
              keys: options.map((_, index) => index + 1).join('/'),
            })
        : tui('type your answer below · Enter to send · Esc to skip'),
      cursor: 0,
    },
    answers,
    multiSelect,
  };
}

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
  '/compact',
  '/task',
  '/resume',
  '/diff',
  '/permissions',
  '/help',
  '/clear',
];

/** Compact help (prefixes + shortcuts + common commands) or the full reference. */
export function buildHelpOverlayLines(all: boolean): string[] {
  // The labels, keys and usages stay as-is (they are command/key surfaces); only
  // moss's own descriptions are localized, at the render site.
  return [
    tui('prefixes'),
    ...HELP_PREFIXES.map(([prefix, what]) => `  ${prefix.padEnd(3)} ${tui(what)}`),
    '',
    tui('shortcuts'),
    ...HELP_KEYS.map(([keys, what]) => `${keys.padEnd(12)} ${tui(what)}`),
    '',
    all ? tui('all commands') : tui('common commands'),
    ...(all
      ? ALL_SHELL_COMMANDS
      : SHELL_COMMANDS.filter((entry) => COMMON_HELP_COMMANDS.includes(entry.command))
    ).map((entry) => `  ${entry.usage.padEnd(24)} ${tui(entry.description)}`),
    ...(all ? [] : ['', tui('type / to browse commands · /help --all for the rest')]),
  ];
}

/** `5m` / `2h` / `3d` — a session's age in one glance. */
export function relativeAge(updatedAt: number | undefined, now = Date.now()): string {
  if (updatedAt === undefined) return '';
  const s = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (s < 60) return tui('now');
  if (s < 3600) return tui('{n}m', { n: Math.floor(s / 60) });
  if (s < 86_400) return tui('{n}h', { n: Math.floor(s / 3600) });
  return tui('{n}d', { n: Math.floor(s / 86_400) });
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
    line(clip(tui('Resume session  ⌕ {query}▌', { query }), width), { color: 'cyan', bold: true }),
  ];
  const sel = Math.max(0, Math.min(selected, matches.length - 1));
  matches.slice(0, maxRows).forEach((s, index) => {
    const title = s.title?.trim() || s.key;
    const meta = [
      relativeAge(s.updatedAt),
      s.messageCount !== undefined ? tui('{count} messages', { count: s.messageCount }) : '',
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
    out.push(
      line(clip(tui('  … {count} more', { count: matches.length - maxRows }), width), { dim: true })
    );
  }
  if (matches.length === 0) {
    out.push(line(clip(tui('  no matching session'), width), { dim: true }));
  }
  out.push(
    line(clip(tui('  ↑/↓ to pick · type to filter · Esc starts fresh'), width), { dim: true })
  );
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
              if (b.type === 'tool_use') return tui('[tool {name}]', { name: b.name ?? '' });
              if (b.type === 'tool_result') return tui('[tool result]');
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
 * One catalog (`interactive-commands.ts`) feeds both surfaces; `SHELL_COMMAND_ROWS`
 * is its `tui` projection — the same table `/help` prints — run through the
 * shared ranker. The `allowed` filter keeps REPL-only commands (/loop /goal
 * /init) out of the shell menu, so the menu can neither hide an advertised
 * command nor offer an unadvertised one.
 */
export function shellPaletteRows(
  input: string,
  extra: ReadonlyArray<PaletteRow> = []
): PaletteRow[] {
  const allowed = new Set(SHELL_COMMAND_NAMES);
  const byCommand = new Map<string, PaletteRow>();
  for (const row of slashPaletteRows(input, SHELL_COMMAND_ROWS)) {
    if (!allowed.has(row[0])) continue;
    // The catalog is Moss's own chrome, so its description follows the UI
    // locale here exactly as it does in the `/help` overlay. Skill rows below
    // are author content and stay verbatim.
    byCommand.set(row[0], [row[0], tui(row[1])]);
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
