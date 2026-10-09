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
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  render,
  Box,
  Static,
  Text,
  useApp,
  useCursor,
  useInput,
  usePaste,
  useStdout,
  useWindowSize,
} from 'ink';
import type { MossAgent } from '../../core/agent/moss-agent.js';
import { planGateEnabled } from '../../tools/plan-gate.js';
import { TaskRuntime, formatDeploymentLine } from '../../core/task-runtime/runtime.js';
import { errorMessage } from '../../errors.js';
import {
  applyAgentEvent,
  flushProse,
  reconcileFinalResponse,
  appendRow,
  beginRun,
  createTuiStore,
  endRun,
  usageBlock,
  type TranscriptRow,
} from './render-bridge.js';
import { isComposerLeak, mouseEventsInChunk, noteDroppedKeys } from './input/key-stream.js';
import { isExpandAffordance, routeMouse, type MouseLayout } from './input/mouse-route.js';
import {
  deleteText,
  expandPasteTokens,
  insertPaste,
  insertText,
  killText,
  moveCaret,
  type PasteToken,
} from './paste-tokens.js';
import {
  getBackgroundProcessOutputTail,
  listBackgroundProcessSnapshots,
  subscribeBackgroundLifecycle,
} from '../../core/tools/background-process-registry.js';
import { formatBackgroundCompletionFlash } from '../background-completion-ui.js';
import { formatMcpStatusLine } from '../rdk-docs-mcp.js';
import { isZhLocale } from '../cli-locale.js';
import { resolveDefaultDeviceTarget } from '../../device/device-target.js';
import { setCliApprovalAsker } from '../approval.js';
import {
  runRegistryCommand,
  type CommandContext,
  type CommandSurface,
} from '../commands/registry.js';
import {
  loadCustomCommands,
  reservedBuiltinNames,
  resolveUserCommand,
} from '../commands/custom-commands.js';
import { formatBackgroundJobLines } from '../commands/background-jobs.js';
import {
  abandonLiveGoal,
  acceptanceProposalLines,
  GOAL_USAGE,
  goalRunArgs,
  planGoalInvocation,
  skippedAcceptanceNotice,
} from '../commands/goal-propose.js';
import {
  availabilityFor,
  isExactSlashCommand,
  rewriteSlashInput,
} from '../interactive-commands.js';
import { resolveLoopMaxIterations } from '../loop-tui-events.js';
import { cliLocale } from '../cli-locale.js';
import { handleCompactCommand } from '../compact-command.js';
import { createCliSessionKey } from '../session.js';
import {
  interactiveTaskUsageLines,
  parseLlmUsageStdout,
  runTaskCommand,
  splitCommandArgs,
} from '../task-run.js';
import { messageRequestsTaskContract } from '../task-flow.js';
import { userFacingAssistantText } from '../user-facing-text.js';
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
import {
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
  renderScrollableActivity,
  foldReadonlyRows,
  stripSgr,
  CONTEXT_WARN_PCT,
  INTERACTION_MODE_TONES,
  SHELL_MODE_TONE,
  type LiveView,
  type StatusView,
} from './transcript.js';
import {
  composerPlaceholder,
  detectComposerProjectKind,
  type ComposerProjectKind,
} from '../composer-placeholder.js';
import { clip, line, padEndTo, rule, type TuiLine } from './text.js';
import { displayWidth } from '../terminal-text.js';
import { isTuiZh, setTuiLocale, transientStatus, tui } from './copy.js';
import { allocateFrame } from './layout.js';
import {
  MOUSE_TRACKING_ON,
  TUI_KITTY_KEYBOARD,
  installTerminalRestore,
  osc52,
  readTmuxMouse,
  restoreTerminalModes,
  selectTuiRenderer,
} from './renderer.js';
import { installTuiLogSink } from './terminal-io.js';
import { noteFrameHeight } from './frame-invariant.js';
import { needsTestHint, type VerifyHintState } from '../verify-hint.js';
import {
  createViewport,
  moveTranscript,
  scrollThumb,
  scrollViewport,
  viewportAtRatio,
  viewportWindow,
  type ViewportLine,
} from './viewport.js';
import { createProjectionCache } from './projection-cache.js';
import {
  currentTuiTheme,
  detectTheme,
  setTuiTheme,
  themeFromOsc11,
  themeLockedByEnv,
  THEME_NAMES,
  TONE,
  type TuiThemeName,
} from './theme.js';
import { caretLine, externalEditorArgs, splitEditorCommand } from './external-editor.js';
import {
  COMPOSER_MAX_ROWS,
  composerDelete,
  composerInsert,
  composerMove,
  composerNewline,
  composerSetValue,
  createComposer,
  composerCaretFromClick,
  renderComposerEditor,
  type ComposerRun,
  type ComposerState,
} from './composer.js';
import { commandForKey, loadKeybindings } from './keymap.js';
import {
  movePaletteSelection,
  PALETTE_MAX_ROWS,
  renderSlashPalette,
  type PaletteRow,
} from './palette.js';
import {
  MENTION_MAX_ROWS,
  completeMention,
  filterMentions,
  mentionTokenAt,
  renderMentionMenu,
  buildWorkspaceIndexAsync,
  type MentionEntry,
} from './mentions.js';
import {
  loadMergedPromptHistory,
  promptHistoryFile,
  savePromptHistory,
  walkPromptHistory,
  type HistoryCursor,
} from './prompt-history.js';
import { selectionText, type SelectionPoint } from './selection.js';
import { spawnProcess, runProcess } from '../../utils/run-process.js';
import { filterHistory, renderHistoryRule, renderHistorySearch } from './history-search.js';
import { renderPermissionsPanel, type PermissionPanelRule } from './permissions-panel.js';
import { buildResumeReplay } from '../resume-replay.js';
import { getPackageVersion } from '../package-info.js';
import { getMossWorkspacePaths } from '../../utils/workspace-paths.js';

import {
  INTERACTION_MODE_CYCLE,
  nextInteractionMode,
  describeApproval,
  inkTextStyle,
  inkLineStyle,
  legacyApprovalView,
  isInterruptEvent,
  questionDialogFromPrompt,
  commandBlockTitle,
  buildHelpOverlayLines,
  relativeAge,
  filterPickerSessions,
  renderSessionPicker,
  describeConversationLogEntry,
  shellContextUsage,
  resolveShellCliConfig,
  shellPaletteRows,
  paletteWindowOffset,
  paletteFrameRows,
} from './app-helpers.js';
import type {
  ApprovalDialogView,
  TuiAppOptions,
  TuiContextInfo,
  TuiMcpServerStatus,
  TuiReplayRow,
  TuiSessionSummary,
  TuiSkillCommand,
} from './app-helpers.js';

/**
 * The shell's option types and pure helpers (dialog shapes, palette math, the
 * resume picker, control-command adapters) live in `./app-helpers.js`. These
 * re-exports keep `dist/cli/tui/app.js` the stable import path for the host and
 * the tui specs while the stateful component below stays readable.
 */
export {
  INTERACTION_MODE_CYCLE,
  nextInteractionMode,
  describeApproval,
  inkTextStyle,
  inkLineStyle,
  legacyApprovalView,
  isInterruptEvent,
  questionDialogFromPrompt,
  commandBlockTitle,
  buildHelpOverlayLines,
  relativeAge,
  filterPickerSessions,
  renderSessionPicker,
  describeConversationLogEntry,
  shellContextUsage,
  resolveShellCliConfig,
  shellPaletteRows,
  paletteWindowOffset,
  paletteFrameRows,
};
export type {
  ApprovalDialogView,
  TuiAppOptions,
  TuiContextInfo,
  TuiMcpServerStatus,
  TuiReplayRow,
  TuiSessionSummary,
  TuiSkillCommand,
};

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

function approvalAnswerLabel(answer: CliApprovalAnswer): string {
  if (answer === 'y') return tui('yes');
  if (answer === 'a') return tui('yes (session)');
  if (answer === 'amend') return tui('amend');
  return tui('no');
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

/** The shell tells the registry it is the TUI, so surface-specific copy can diverge later. */
const COMMAND_SURFACE: CommandSurface = 'tui';

/** How long the scroll bar stays visible after the pointer or a scroll last touched it. */
const SCROLLBAR_HIDE_MS = 1500;

export function TuiAppRoot({
  options,
  handle,
  runtime,
}: {
  options: TuiAppOptions;
  handle: StoreHandle;
  runtime: TaskRuntime;
}): React.ReactElement {
  // Part B: pin moss's own chrome to the locale the host resolved. Idempotent,
  // so running it on every render is fine; the environment is only the fallback
  // and the host's explicit `locale` is authoritative.
  setTuiLocale(isZhLocale(options.locale ?? cliLocale()));
  const composerProjectKind = useMemo(
    (): ComposerProjectKind =>
      detectComposerProjectKind({
        workspaceDir: options.workspaceDir,
        env: process.env,
      }),
    [options.workspaceDir]
  );
  const { exit, suspendTerminal } = useApp();
  const { stdout, write: writeStdout } = useStdout();
  const { setCursorPosition } = useCursor();
  const fullscreen = options.renderer === 'fullscreen';
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  // The scroll bar is shown while the pointer is on it, while the transcript is
  // being scrolled or dragged, and for a moment after that (plan v3 P1).
  const barTouchedRef = useRef(0);
  const barTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touchScrollBar = useCallback((): void => {
    barTouchedRef.current = Date.now();
    if (barTimerRef.current !== undefined) clearTimeout(barTimerRef.current);
    barTimerRef.current = setTimeout(() => {
      barTimerRef.current = undefined;
      forceUpdate();
    }, SCROLLBAR_HIDE_MS + 50);
    forceUpdate();
  }, []);
  useEffect(
    () => () => {
      if (barTimerRef.current !== undefined) clearTimeout(barTimerRef.current);
    },
    []
  );
  const [composer, setComposer] = useState<ComposerState>(() => createComposer());
  const input = composer.value;
  // Bulk edits (history recall, staged prompts, paste) replace the whole value
  // and park the caret at the end; the fine-grained keys use the editor ops.
  const tokensRef = useRef<PasteToken[]>([]);
  const pasteIdRef = useRef(1);
  const lastEditAtRef = useRef(0);
  const approvalGuardUntilRef = useRef(0);
  const setInput = useCallback((next: string | ((value: string) => string)) => {
    tokensRef.current = [];
    setComposer((current) => {
      const value = typeof next === 'function' ? next(current.value) : next;
      return composerSetValue(value, value.length);
    });
  }, []);
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
  // ~/.config/moss/keybindings.json, read once per config dir. Problems are shown
  // in the status row on mount, never silently dropped.
  const keymap = useMemo(() => {
    const dir = options.cliRuntime?.configDir;
    let text: string | undefined;
    if (dir) {
      try {
        text = fs.readFileSync(path.join(dir, 'keybindings.json'), 'utf8');
      } catch {
        text = undefined;
      }
    }
    return loadKeybindings(text);
  }, [options.cliRuntime?.configDir]);
  useEffect(() => {
    const [first, ...rest] = keymap.warnings;
    if (first) {
      setStatusLine(rest.length > 0 ? `${first} (+${rest.length} more)` : first);
    }
  }, [keymap]);
  const [viewport, setViewport] = useState(createViewport);
  const projectionCacheRef = useRef(createProjectionCache());
  const viewportLinesRef = useRef(0);
  const mouseLayoutRef = useRef<MouseLayout>({
    composerTop: 0,
    composerLines: 1,
    viewportRows: 0,
  });
  const projectedTextRef = useRef<string[]>([]);
  const selectionRef = useRef<{ anchor: SelectionPoint; head: SelectionPoint } | undefined>(
    undefined
  );
  const chordRef = useRef('');
  const [rewindOpen, setRewindOpen] = useState(false);
  const [rewindCursor, setRewindCursor] = useState(0);
  const historyReadyRef = useRef(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<HistoryCursor>({
    index: undefined,
    draft: '',
  });
  const historyRef = useRef(history);
  const historyCursorRef = useRef(historyCursor);
  historyRef.current = history;
  historyCursorRef.current = historyCursor;
  /** Rows the user expanded by clicking, independent of the global ctrl+o toggle. */
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<number>>(() => new Set());
  const expandedRowsRef = useRef(expandedRows);
  expandedRowsRef.current = expandedRows;
  const projectedFullRef = useRef<ViewportLine[]>([]);
  const viewportWindowRef = useRef<ViewportLine[]>([]);
  const clickPressRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [permissionCursor, setPermissionCursor] = useState(0);
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
  const queueRef = useRef<Array<{ display: string; text: string }>>([]);
  const queuePausedRef = useRef(false);
  /** Re-entry guard: draining a queued line must not start a second drain. */
  const drainingRef = useRef(false);
  /** The line being executed came from the queue, so the composer stays put. */
  const fromQueueRef = useRef(false);
  const submitRef = useRef<(text: string) => Promise<void>>(async () => undefined);
  /** `/goal` proposal waiting for Enter (accept) or `n` (contract verdict only). */
  const pendingGoalRef = useRef<{ goal: string } | null>(null);
  const customCommands = useMemo(
    () =>
      loadCustomCommands(
        {
          workspace: options.workspaceDir,
          configDir: options.cliRuntime?.configDir ?? path.join(options.workspaceDir, '.moss'),
          reservedNames: reservedBuiltinNames(),
        },
        () => undefined
      ),
    [options.workspaceDir, options.cliRuntime?.configDir]
  );
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
  const prevColumnsRef = useRef(columns);
  useEffect(() => {
    const previous = prevColumnsRef.current;
    prevColumnsRef.current = columns;
    if (!fullscreen && columns < previous) {
      // A shrink soft-wraps the previous frame. One clear is a resize, then
      // ink repaints the new width.
      writeStdout('\x1b[2J\x1b[H');
    }
  }, [columns, fullscreen, writeStdout]);

  useEffect(() => handle.subscribe(forceUpdate), [handle, forceUpdate]);
  useEffect(() => runtime.onChange(forceUpdate), [runtime, forceUpdate]);
  // The policy layer is authoritative: any mode change (shift+tab, `/mode`, a
  // flag, an embedded host) re-renders the hint row immediately.
  useEffect(() => subscribeCliInteractionMode(setInteractionModeState), []);
  const historyFiles = useCallback(() => {
    const workspace = promptHistoryFile(getMossWorkspacePaths(options.workspaceDir).runtimeDir);
    const configDir = options.cliRuntime?.configDir;
    return configDir ? [promptHistoryFile(configDir), workspace] : [workspace];
  }, [options.cliRuntime?.configDir, options.workspaceDir]);
  useEffect(() => {
    historyReadyRef.current = false;
    setHistory(loadMergedPromptHistory(historyFiles()));
  }, [historyFiles]);
  useEffect(() => {
    if (!historyReadyRef.current) {
      historyReadyRef.current = true;
      return;
    }
    for (const file of historyFiles()) savePromptHistory(file, history);
  }, [history, historyFiles]);
  useEffect(() => {
    // A line that is exactly `columns` wide makes real terminals auto-wrap
    // and then honour the newline, inserting a blank row. The hardware cursor
    // is then one row high (it sits on the rule above the prompt).
    writeStdout('\x1b[?7l');
    return () => {
      restoreTerminalModes(stdout);
    };
  }, [stdout, writeStdout]);
  useEffect(() => {
    // Ask the terminal for its background (OSC 11). A reply that never comes
    // leaves the theme from COLORFGBG / the dark default. NO_COLOR and an
    // explicit MOSS_TUI_THEME are not overridden.
    if (themeLockedByEnv() || process.env.MOSS_TUI_THEME) return undefined;
    writeStdout('\x1b]11;?\x07');
    return undefined;
  }, [writeStdout]);
  useEffect(() => {
    if (!fullscreen) return undefined;
    writeStdout(MOUSE_TRACKING_ON);
    return () => {
      restoreTerminalModes(stdout);
    };
  }, [fullscreen, stdout, writeStdout]);
  useEffect(() => {
    const paths = getMossWorkspacePaths(options.workspaceDir);
    return installTuiLogSink({
      logFile: path.join(paths.runtimeDir, 'logs', `tui-${sessionKey}.log`),
      onUserVisible: (message) => {
        appendRow(store, 'system', message);
        handle.notify();
      },
    });
  }, [handle, options.workspaceDir, sessionKey, store]);
  useEffect(
    () =>
      options.noticeSource?.subscribe((message) => {
        appendRow(store, 'system', message);
        handle.notify();
      }),
    [handle, options.noticeSource, store]
  );

  /** Inline information block: a ⏺ title plus ⎿ rows, right in the transcript. */
  const printBlock = useCallback(
    (title: string, lines: string[]) => {
      appendRow(store, 'tool', title);
      const cleaned = lines.map((text) => stripSgr(text));
      const body = cleaned.filter((text, index) => {
        if (index !== 0) return true;
        return text.trim().toLowerCase() !== title.trim().toLowerCase();
      });
      for (const text of body.length > 0 ? body : ['(nothing to show)']) {
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
        writeStdout(`\x07\x1b]9;moss: ${message}\x07`);
      } catch {
        // A closed stream must never break a run.
      }
    },
    [writeStdout]
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
        if (Date.now() - lastEditAtRef.current < 350) {
          approvalGuardUntilRef.current = Date.now() + 350;
        }
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
    const liveMcpServers = options.listMcpServers?.() ?? options.mcpServers;
    const mcpSummary =
      liveMcpServers && liveMcpServers.length > 0
        ? {
            connected: liveMcpServers.filter((s) => s.state === 'connected').length,
            connecting: liveMcpServers.filter((s) => s.state === 'connecting').length,
            total: liveMcpServers.length,
          }
        : info?.mcp
          ? {
              connected: info.mcp.connected,
              connecting: info.mcp.connecting ?? 0,
              total: info.mcp.total,
            }
          : undefined;
    if (info || mcpSummary) {
      const parts: string[] = [];
      if (info?.branch) parts.push(`git:${info.branch}`);
      if (info?.skills) {
        parts.push(
          tui(info.skills === 1 ? '{count} skill' : '{count} skills', { count: info.skills })
        );
      }
      if (mcpSummary && mcpSummary.total > 0) {
        if (mcpSummary.connecting > 0) {
          parts.push(
            tui(
              mcpSummary.connecting === 1
                ? '{count} MCP server connecting'
                : '{count} MCP servers connecting',
              { count: mcpSummary.connecting }
            )
          );
        } else if (mcpSummary.connected === mcpSummary.total) {
          parts.push(
            tui(mcpSummary.total === 1 ? '{count} MCP server' : '{count} MCP servers', {
              count: mcpSummary.total,
            })
          );
        } else {
          parts.push(
            tui('{connected}/{total} MCP servers connected', {
              connected: mcpSummary.connected,
              total: mcpSummary.total,
            })
          );
        }
      }
      if (parts.length > 0) {
        appendRow(store, 'detail', tui('context: {parts}', { parts: parts.join(' · ') }));
      }
    }
    // Only a terminal failure is a boot warning. `connecting` is not failed;
    // the registry notifies once the handshake settles.
    const failedMcp = (liveMcpServers ?? []).filter((s) => s.state === 'failed');
    if (failedMcp.length > 0) {
      const names = failedMcp
        .slice(0, 3)
        .map((s) => s.name)
        .join(', ');
      const reasons = failedMcp
        .slice(0, 3)
        .map((s) => s.error?.trim().split('\n')[0])
        .filter((reason): reason is string => Boolean(reason))
        .join('; ')
        .slice(0, 160);
      appendRow(
        store,
        'system',
        tui(
          failedMcp.length === 1
            ? '⚠ {count} MCP server failed to start'
            : '⚠ {count} MCP servers failed to start',
          { count: failedMcp.length }
        ) +
          `${names ? ` (${names})` : ''}` +
          `${reasons ? `: ${reasons}` : ''}` +
          tui(' — /mcp for details')
      );
    }
    options.onMcpUiReady?.();
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
              previous.messageCount !== undefined
                ? tui(
                    'previous session: {title} ({count} messages) — restart with `moss --continue` to resume it',
                    { title, count: previous.messageCount }
                  )
                : tui('previous session: {title} — restart with `moss --continue` to resume it', {
                    title,
                  })
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
        const stopped = snap.status === 'killed';
        const failed =
          !stopped && (snap.status === 'error' || (snap.exitCode !== null && snap.exitCode !== 0));
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
      const taskFlow = messageRequestsTaskContract(message);
      return typeof agent.streamChatRecorded === 'function'
        ? agent.streamChatRecorded(sessionKey, message, { abortSignal, taskFlow })
        : options.agent.streamChat(sessionKey, message, { abortSignal, taskFlow });
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
      // The verdict token (PASS/FAIL), task id and recover command stay raw.
      appendRow(
        store,
        'summary',
        decided.result === 'PASS'
          ? tui('◇ task {id} — PASS ({criteria} met)', { id: short, criteria })
          : tui('◇ task {id} — FAIL ({criteria} met) · /task resume {task} to repair', {
              id: short,
              criteria,
              task: decided.taskId,
            })
      );
      handle.notify();
    },
    [handle, runtime, store]
  );

  /**
   * A steer that landed after the loop's last poll must not vanish. A finished
   * run queues it (the drain sends it). An aborted run returns it to the
   * composer, the same way Esc hands the visible queue back.
   */
  const absorbDeferredSteers = useCallback(
    (halted: boolean) => {
      const take = options.agent.takeDeferredSteers;
      if (typeof take !== 'function') return;
      const prompts = take
        .call(options.agent, sessionKey)
        .map((text) => text.trim())
        .filter((text) => text.length > 0);
      if (prompts.length === 0) return;
      if (halted) {
        setInput((current) => {
          const extra = prompts.join('\n');
          return current.trim() ? `${current.replace(/\s+$/, '')}\n${extra}` : extra;
        });
        return;
      }
      for (const text of prompts) queueRef.current.push({ display: text, text });
      setQueueRevision((n) => n + 1);
    },
    [options.agent, sessionKey, setInput]
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
          // Prose that introduced a tool call, or a stalled call that is about to
          // regenerate, is a finished message: commit it before the boundary.
          if (
            (event.type === 'tool_start' || event.type === 'retry') &&
            store.run.streamingText.trim()
          ) {
            flushProse(store);
          }
          applyAgentEvent(store, event);
          runtime.applyEvent(event);
          if (event.type === 'done') {
            reconcileFinalResponse(store, event.result?.response);
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
      const unverified = !halted && needsTestHint(store.run as VerifyHintState);
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
      if (unverified) {
        appendRow(store, 'summary', tui('edited JS/TS files but did not run tests'));
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
      if (producedPlan && planGateEnabled()) planGateRef.current?.();
      absorbDeferredSteers(halted);
    },
    [
      absorbDeferredSteers,
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
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      // Stop when a run is already in flight. Submitting again would push the
      // same line back onto the queue and spin. That run's own drain continues it.
      while (queueRef.current.length > 0 && !queuePausedRef.current && !store.run.running) {
        const next = queueRef.current.shift();
        if (!next) break;
        setQueueRevision((n) => n + 1);
        fromQueueRef.current = true;
        try {
          await submitRef.current(next.text);
        } finally {
          fromQueueRef.current = false;
        }
        if (store.run.running) break;
      }
    } finally {
      drainingRef.current = false;
      if (queueRef.current.length > 0 && !queuePausedRef.current && !store.run.running) {
        void drainQueue();
      } else if (queueRef.current.length === 0) {
        setQueueRevision((n) => n + 1);
      }
    }
  }, [store]);

  const sessionInfo = useCallback(
    async (command: 'sessions' | 'mcp' | 'subs' | 'bg'): Promise<string[]> => {
      if (command === 'sessions') {
        const sessions = (await options.listSessions?.()) ?? [];
        if (sessions.length === 0) return [tui('no saved sessions')];
        return sessions.map(
          (x) =>
            `${x.current ? '*' : ' '} ${x.key}${x.title ? ` — ${x.title}` : ''}${
              x.messageCount !== undefined
                ? tui(' ({count} messages)', { count: x.messageCount })
                : ''
            }`
        );
      }
      if (command === 'mcp') {
        const servers = options.listMcpServers?.() ?? options.mcpServers ?? [];
        if (servers.length === 0) return [tui('no MCP servers configured (.moss/mcp.json)')];
        return servers.map((x) =>
          formatMcpStatusLine(
            x,
            x.toolCount !== undefined ? tui(' ({count} tools, lazy)', { count: x.toolCount }) : ''
          )
        );
      }
      if (command === 'subs') {
        const snaps = options.agent.asyncTasks?.list() ?? [];
        if (snaps.length === 0) return [tui('no sub-agent tasks')];
        return snaps.map((t) => `#${t.taskId.slice(-6)} ${t.status}`);
      }
      const running = listBackgroundProcessSnapshots().filter((p) => p.status === 'running');
      if (running.length === 0) return [tui('no background tasks running')];
      return running.map((p) => `#${p.id} ${p.command}${p.label ? ` (${p.label})` : ''}`);
    },
    [options]
  );

  /** One place that knows how to print each task-runtime view. */
  const showBlock = useCallback(
    async (
      action:
        | 'tasks'
        | 'history'
        | 'sessions'
        | 'mcp'
        | 'subs'
        | 'bg'
        | 'usage'
        | 'deployments'
        | 'evidence'
        | 'failures'
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
    (message: string): Promise<void> => {
      if (store.run.running) {
        queueRef.current.push({ display: message, text: message });
        setQueueRevision((n) => n + 1);
        return Promise.resolve();
      }
      const turn = runTurn(message);
      if (drainingRef.current) return turn;
      return turn.then(() => drainQueue());
    },
    [drainQueue, runTurn, store]
  );

  const runTaskShellCommand = useCallback(
    async (args: string): Promise<void> => {
      if (store.run.running) {
        printBlock('Task', [tui('a run is in flight — press Esc to interrupt it first')]);
        return;
      }
      const parsed = splitCommandArgs(args);
      if (parsed.length === 0) {
        printBlock('Task', [...interactiveTaskUsageLines()]);
        return;
      }
      if (parsed[0] === 'resume' && !parsed[1]) {
        const candidate = runtime
          .taskSummaries()
          .filter((task) => task.state === 'BLOCKED' || task.result === 'FAIL')
          .sort((left, right) => right.updatedAt - left.updatedAt)[0];
        if (!candidate) {
          printBlock('Resume', [
            tui('no failed, blocked, or abandoned task is available to resume'),
          ]);
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
                  appendRow(
                    store,
                    'summary',
                    tui('◇ task {phase} — {text}', { phase: phase[1]!, text: phase[2]! })
                  );
                }
              } else if (!parseLlmUsageStdout(text)) {
                printBlock('Task', text.trimEnd().split('\n'));
              }
            },
          });
        } catch (err) {
          printCommandError('Task', errorMessage(err));
        } finally {
          abortRef.current = undefined;
          const halted = controller.signal.aborted;
          const unverifiedTask = !halted && needsTestHint(store.run as VerifyHintState);
          endRun(store, halted);
          if (unverifiedTask) {
            appendRow(store, 'summary', tui('edited JS/TS files but did not run tests'));
          }
          await runtime.endRun(halted);
          appendTaskVerdictIfAny(runStartedAtRef.current ?? 0);
          runStartedAtRef.current = undefined;
          absorbDeferredSteers(halted);
          setStatusLine(undefined);
          handle.notify();
          // A chat turn drains from its own completion. A task run does not go
          // through that path, so messages queued while it was in flight would
          // otherwise sit above the composer forever.
          if (!halted && queueRef.current.length > 0 && !drainingRef.current) {
            void drainQueue();
          }
        }
        return;
      }
      try {
        await runTaskCommand(parsed, {
          agent: options.agent,
          workspace: options.workspaceDir,
          sessionKey,
          onOutput: (stream, text) => {
            if (stream === 'stdout' && !parseLlmUsageStdout(text)) {
              printBlock('Task', text.trimEnd().split('\n'));
            }
          },
        });
      } catch (err) {
        printCommandError('Task', errorMessage(err));
      }
    },
    [
      absorbDeferredSteers,
      drainQueue,
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
          void dispatchRun('The plan above is approved — proceed with execution now.');
        } else if (value === PROCEED_MANUAL) {
          setCliInteractionMode('manual');
          void dispatchRun(
            'The plan above is approved — proceed with execution now (manual approvals stay on).'
          );
        } else if (value.trim()) {
          void dispatchRun(`Plan feedback — revise the plan accordingly: ${value}`);
        }
      },
      optionAnswers: [PROCEED_AUTO, PROCEED_MANUAL, ''],
    };
    pendingDialogRef.current = entry;
    setApproval({
      title: tui('Ready to code?'),
      question: tui('The plan is above. How should moss proceed?'),
      options: [
        { key: '1', answer: 'y', label: tui('Proceed — accept edits this session') },
        { key: '2', answer: 'y', label: tui('Proceed — keep manual approvals') },
        { key: '3', answer: 'y', label: tui('Tell moss what to change (type below)') },
      ],
      footer: tui('↑↓ then Enter · or type feedback below · Esc keeps planning'),
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
            ? tui('Not a git repository: {path} — /diff needs a git workspace.', {
                path: options.workspaceDir,
              })
            : tui('git diff failed (exit {code}): {error}', {
                code: result.exitCode ?? tui('signal'),
                error: result.output.trim().split('\n')[0] || 'unknown error',
              }),
        ]);
        return;
      }
      appendRow(store, 'tool', 'Diff');
      appendRow(store, 'result', result.output.trim() || tui('(no unstaged working-tree changes)'));
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
            (result.exitCode === 0
              ? tui('(no output)')
              : tui('(no output · exit {code})', { code: result.exitCode ?? tui('signal') }))
        );
        if (result.exitCode !== 0) {
          appendRow(
            store,
            'detail',
            result.exitCode === null
              ? tui('terminated by {signal}', { signal: result.signal ?? tui('signal') })
              : tui('exit code {code}', { code: result.exitCode })
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
        printBlock('Compact', [
          tui('a run is in flight — press Esc to interrupt it, then /compact'),
        ]);
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
          tui('a run is in flight — press Esc to interrupt it before switching models'),
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
          tui('/model config is not wired in the shell — use `moss setup` for a guided'),
          tui('provider/model/key change, or `moss config set model <name>` to persist one.'),
          tui('`/model <name>` still switches the active model for this session.'),
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
          ? tui('switched to {model} ({provider})', { model, provider })
          : tui('switched to custom model {model} ({provider})', { model, provider }),
        tui('context usage will appear after the first response from this model'),
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
        submitPrompt: (value) => {
          void dispatchRun(value);
        },
        getContextUsage: () => shellContextUsage(store.usage),
        setInteractionMode: (mode: CliInteractionMode) => {
          // The policy layer already switched the mode; surface it so the change
          // is visible instead of silent.
          setStatusLine(
            tui('interaction mode: {label}', {
              label: formatCliInteractionModeLabel(mode, isTuiZh()),
            })
          );
        },
      };

      if (head === '/goal') {
        const plan = planGoalInvocation(args, options.workspaceDir);
        if (plan.kind === 'usage') {
          printBlock('Goal', [GOAL_USAGE]);
          return true;
        }
        if (plan.kind === 'clear') {
          printBlock('Goal', [await abandonLiveGoal(options.workspaceDir, locale)]);
          return true;
        }
        if (plan.kind === 'resume') {
          await runTaskShellCommand('resume');
          return true;
        }
        if (plan.kind === 'propose') {
          printBlock('Goal', acceptanceProposalLines(plan.goal, plan.candidates, locale));
          pendingGoalRef.current = { goal: plan.goal };
          setInput(plan.candidates[0] ?? '');
          return true;
        }
        if (plan.notice) printBlock('Goal', [plan.notice]);
        const maxTurns = resolveLoopMaxIterations(process.env, true);
        await runTaskShellCommand(
          goalRunArgs(plan.goal, {
            ...(plan.acceptance ? { acceptance: plan.acceptance } : {}),
            ...(maxTurns > 0 ? { maxTurns } : {}),
          })
        );
        return true;
      }

      if (head === '/task' && (args === 'view' || args.startsWith('view '))) {
        const kind = args.slice(4).trim() || 'tasks';
        if (
          kind === 'tasks' ||
          kind === 'history' ||
          kind === 'evidence' ||
          kind === 'deployments' ||
          kind === 'failures'
        ) {
          await showBlock(kind);
        } else {
          printCommandError(
            'Task view',
            `unknown kind "${kind}" — use tasks | history | evidence | deployments | failures`
          );
        }
        return true;
      }

      if (head === '/task') {
        await runTaskShellCommand(args);
        return true;
      }

      try {
        if (await runRegistryCommand(text, context, customCommands)) return true;
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
      return false;
    },
    [
      customCommands,
      dispatchRun,
      options,
      printBlock,
      printCommandError,
      runCompactCommand,
      runDiffCommand,
      runTaskShellCommand,
      runModelCommand,
      sessionKey,
      setInput,
      store,
    ]
  );

  const submit = useCallback(
    async (raw: string) => {
      const submittedTokens = tokensRef.current.slice();
      let text = raw.trim();
      if (!text) return;
      if (pendingGoalRef.current && !text.startsWith('/')) {
        const pending = pendingGoalRef.current;
        pendingGoalRef.current = null;
        setInput('');
        setHistoryCursor({ index: undefined, draft: '' });
        setStatusLine(undefined);
        if (/^n$/i.test(text)) {
          appendRow(store, 'summary', skippedAcceptanceNotice(cliLocale()));
          handle.notify();
          await runTaskShellCommand(goalRunArgs(pending.goal));
          return;
        }
        await runTaskShellCommand(goalRunArgs(pending.goal, { acceptance: text }));
        return;
      }
      if (text.startsWith('/')) {
        pendingGoalRef.current = null;
        const rewritten = rewriteSlashInput(text);
        if (rewritten.migration) {
          appendRow(store, 'summary', rewritten.migration);
          handle.notify();
        }
        text = rewritten.text;
      }
      if (!fromQueueRef.current) {
        setInput('');
        setHistoryCursor({ index: undefined, draft: '' });
        setStatusLine(undefined);
      }

      // `!` shell mode is checked FIRST: `/quit` typed in shell mode is a shell
      // command, not the shell's quit. Shell commands are also not prompt
      // history (↑ recalls goals), so nothing is pushed here. A line drained
      // from the queue is never a shell command — the user already left `!`.
      if (shellMode && !fromQueueRef.current) {
        setShellMode(false);
        await runShellSubmission(text);
        return;
      }
      if (!fromQueueRef.current) {
        setHistory((entries) => [...entries.filter((entry) => entry !== text), text].slice(-100));
      }

      // Running-turn policy comes from the catalog (`availableDuringRun`), the
      // same table the REPL reads. Codex disables Plan/Review/Compact/Init/Clear
      // during a task: those are `reject`. Status/Diff/Model/Tasks stay immediate.
      if (text.startsWith('/') && store.run.running) {
        const policy = availabilityFor(text);
        if (policy === 'queue') {
          queueRef.current.push({ display: text, text });
          setQueueRevision((n) => n + 1);
          return;
        }
        if (policy === 'reject') {
          const head = (text.split(/\s+/, 1)[0] ?? text).toLowerCase();
          appendRow(
            store,
            'summary',
            head === '/clear'
              ? tui('a run is in flight — press Esc to interrupt it, then /clear')
              : tui(
                  '{command} is not available while a run is in flight — press Esc to interrupt, then retry',
                  { command: head }
                )
          );
          handle.notify();
          return;
        }
      }

      if (text === '/quit' || text === '/exit') {
        exit();
        return;
      }
      if (text === '/help --all') {
        setHelpOverlay({ lines: buildHelpOverlayLines(true, keymap.bindings), all: true });
        return;
      }
      if (text === '/help' || text === '?') {
        setHelpOverlay({ lines: buildHelpOverlayLines(false, keymap.bindings), all: false });
        return;
      }
      if (text === '/usage') {
        printBlock('Usage', usageBlock(store.usage));
        return;
      }
      if (text === '/clear') {
        // `/clear` is how a developer drops the thread and starts an unrelated
        // task: empty model context, new session key. `/compact` is the command
        // that keeps the same task and shrinks it. The banner stays; committed
        // <Static> rows live in scrollback, so an ANSI clear plus remount is
        // what actually empties the screen. A run in flight never reaches here:
        // the catalog marks `/clear` `reject` (Codex disables Clear mid-task).
        const next = createCliSessionKey();
        setActiveSession(next);
        options.onNewSession?.(next);
        queueRef.current = [];
        setQueueRevision((n) => n + 1);
        store.todos = [];
        store.usage.tokensIn = 0;
        store.usage.tokensOut = 0;
        store.usage.runTokensIn = 0;
        store.usage.runTokensOut = 0;
        store.usage.contextUsed = 0;
        store.usage.cacheReadTokens = 0;
        store.usage.compactions = 0;
        store.usage.runs = 0;
        store.usage.apiMs = 0;
        store.usage.ttftSamples = [];
        store.rows = store.rows.filter((row) => row.kind === 'banner');
        store.version++;
        writeStdout('\x1b[2J\x1b[H');
        setClearRevision((n) => n + 1);
        appendRow(
          store,
          'summary',
          tui('transcript cleared — new conversation, empty context (previous: `moss --continue`)')
        );
        handle.notify();
        return;
      }
      if (text === '/tasks') {
        const subagents = (options.agent.asyncTasks?.list() ?? []).map((task) => ({
          taskId: task.taskId,
          status: String(task.status),
        }));
        printBlock(
          'Tasks',
          formatBackgroundJobLines({
            processes: listBackgroundProcessSnapshots(),
            subagents,
          })
        );
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
            tui('no hooks configured — add a "hooks" object to the config file:'),
            '  PreToolUse · PostToolUse · SessionStart · Stop · SubagentStop',
            '  PreCompact · PostCompact · SessionEnd · Notification',
            'each entry: { "command": "…", "matcher": "tool-glob", "timeoutMs": 5000, "blocking": true }'
          );
        }
        if (options.cliRuntime?.configDir) {
          lines.push(
            '',
            tui('config dir: {path} (or MOSS_CONFIG_FILE)', {
              path: options.cliRuntime.configDir,
            })
          );
        }
        printBlock('Hooks', lines);
        return;
      }
      if (text === '/mcp') {
        await showBlock('mcp');
        return;
      }
      if (text === '/skills') {
        const rows = options.skills ?? [];
        printBlock(
          'Skills',
          rows.length === 0
            ? [tui('no skills found'), 'create one: moss skill create <name>']
            : rows
                .map((s) => `  ${s.name.padEnd(18)} ${s.description.split('\n')[0] ?? ''}`)
                .concat([
                  tui('  ({count} skill(s) · load with the skill tool)', { count: rows.length }),
                ])
        );
        return;
      }
      if (text === '/resume' || text.startsWith('/resume ')) {
        const query = text.slice('/resume'.length).trim();
        const sessions = (await options.listSessions?.()) ?? [];
        setPickerSessions(sessions);
        if (sessions.length === 0) {
          printBlock('Resume', [tui('no saved sessions')]);
          return;
        }
        const matches = filterPickerSessions(sessions, query);
        if (query && matches.length === 1) {
          const pick = matches[0];
          if (pick) {
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
          }
          return;
        }
        setSessionPicker({ query, cursor: 0 });
        printBlock('Resume', await sessionInfo('sessions'));
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
              ? tui('restored checkpoint {seq}: {detail}', { seq, detail: result.detail })
              : (result?.detail ?? tui('rewind to {seq} failed', { seq })),
          ]);
        }
        return;
      }
      if (text === '/queue' || text.startsWith('/queue ')) {
        const sub = text.split(' ')[1] ?? 'list';
        if (sub === 'pause') {
          queuePausedRef.current = true;
          setQueueRevision((n) => n + 1);
          printBlock('Queue', [tui('paused — new submissions wait')]);
        } else if (sub === 'resume') {
          queuePausedRef.current = false;
          setQueueRevision((n) => n + 1);
          printBlock('Queue', [tui('resumed')]);
          if (!store.run.running && queueRef.current.length > 0) void drainQueue();
        } else if (sub === 'drop') {
          const dropped = queueRef.current.shift();
          setQueueRevision((n) => n + 1);
          printBlock('Queue', [
            dropped
              ? tui('dropped: {text}', { text: dropped.display.slice(0, 60) })
              : tui('queue empty'),
          ]);
        } else if (sub === 'clear') {
          const count = queueRef.current.length;
          queueRef.current.length = 0;
          setQueueRevision((n) => n + 1);
          printBlock('Queue', [
            tui(count === 1 ? 'cleared {count} queued item' : 'cleared {count} queued items', {
              count,
            }),
          ]);
        } else {
          // Block titles mirror command names, so they stay raw (`/queue`).
          printBlock(
            `Queue (${queuePausedRef.current ? 'paused' : 'active'})`,
            queueRef.current.map((q, i) => `${i + 1}. ${q.display.slice(0, 60)}`)
          );
        }
        return;
      }
      if (text.startsWith('/steer')) {
        const constraint = text.slice('/steer'.length).trim();
        if (!constraint) {
          printBlock('Steer', [tui('usage: /steer <constraint> — injects at the next boundary')]);
        } else {
          const entry = options.agent.steer?.(sessionKey, constraint);
          printBlock('Steer', [
            entry === null || entry === undefined
              ? tui('rejected — no single active run on this session')
              : tui('queued: {text}', { text: constraint.slice(0, 80) }),
          ]);
        }
        return;
      }
      if (text === '/permissions') {
        setPermissionsOpen(true);
        setPermissionCursor(0);
        return;
      }
      if (text === '/theme' || text.startsWith('/theme ')) {
        const asked = text.slice('/theme'.length).trim().toLowerCase();
        if (themeLockedByEnv()) {
          printBlock('Theme', [tui('NO_COLOR is set — the theme stays mono')]);
          return;
        }
        if (!asked) {
          printBlock('Theme', [
            tui('current theme: {name}', { name: currentTuiTheme() }),
            THEME_NAMES.join(' · '),
            tui('/theme <name> switches it for this session'),
          ]);
          return;
        }
        if (!(THEME_NAMES as readonly string[]).includes(asked)) {
          printBlock('Theme', [
            tui('unknown theme "{name}" — dark, light, or mono', { name: asked }),
          ]);
          return;
        }
        setTuiTheme(asked as TuiThemeName);
        forceUpdate();
        printBlock('Theme', [tui('theme: {name}', { name: asked })]);
        return;
      }
      if (text.startsWith('/')) {
        // Shared registry first (status/doctor/permissions/mode/context/export/
        // review), then the shell-local control commands, then file commands
        // and skills (arguments kept), then the honest unknown-command path.
        if (await runShellCommand(text)) return;
        const resolved = resolveUserCommand(text, {
          builtinNames: reservedBuiltinNames(),
          customCommands,
          skills: (options.skills ?? []).map((skill) => ({
            name: skill.name,
            description: skill.description,
          })),
        });
        if (resolved.kind === 'custom' || resolved.kind === 'skill') {
          appendRow(store, 'user', text);
          handle.notify();
          await dispatchRun(resolved.prompt);
          return;
        }
        appendRow(
          store,
          'error',
          tui('unknown command "{name}" — try /help', { name: text.split(' ')[0] ?? '' })
        );
        handle.notify();
        return;
      }
      const expanded = expandPasteTokens(raw, submittedTokens).trim();
      const display = text;
      tokensRef.current = [];
      if (!expanded) return;
      if (store.run.running) {
        // A message typed during a run steers the live turn. Steer is refused
        // (null: no single active run, or the host has no steer) → queue, and
        // the queued lines render above the composer for ↑ to edit.
        const steered = options.agent.steer?.(sessionKey, expanded);
        if (steered) {
          appendRow(store, 'summary', tui('queued: {text}', { text: display.slice(0, 80) }));
          handle.notify();
          return;
        }
        queueRef.current.push({ display, text: expanded });
        setQueueRevision((n) => n + 1);
        // The run can finish between the running check and steer() returning
        // null. Nothing else will drain that line.
        if (!store.run.running && !drainingRef.current) void drainQueue();
        return;
      }
      appendRow(store, 'user', display);
      handle.notify();
      {
        const turn = runTurn(expanded);
        if (drainingRef.current) await turn;
        else void turn.then(() => void drainQueue());
      }
    },
    [
      drainQueue,
      dispatchRun,
      exit,
      handle,
      options,
      printBlock,
      customCommands,
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
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  const answerApproval = useCallback(
    (answer: CliApprovalAnswer) => {
      if (answer === 'amend') {
        // The tool runs; the user's next composer message steers it. Tell
        // them so the queued message does not feel like it vanished.
        setStatusLine(tui('approved — type what moss should do next; your message is queued'));
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
  const paletteRows: PaletteRow[] = shellPaletteRows(input, [
    // File commands outrank skills on a name collision, matching resolveUserCommand.
    ...customCommands.map((command) => [command.name, command.summary] as const),
    ...(options.skills ?? []).map((skill) => [`/${skill.name}`, skill.description] as const),
  ]);
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
    if (!mentionToken || mentionIndex.length > 0) return undefined;
    let cancelled = false;
    void buildWorkspaceIndexAsync(options.workspaceDir).then((entries) => {
      if (!cancelled) setMentionIndex(entries);
    });
    return () => {
      cancelled = true;
    };
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
        tui(
          inFlight ? 'run interrupted — press Ctrl+C again to quit' : 'press Ctrl+C again to quit'
        )
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
      current === tui('Esc again to clear the composer') ? undefined : current
    );
  }, []);

  const armEscClear = useCallback(() => {
    if (escClearTimerRef.current !== undefined) clearTimeout(escClearTimerRef.current);
    setEscClearArmed(true);
    setStatusLine(tui('Esc again to clear the composer'));
    escClearTimerRef.current = setTimeout(() => {
      escClearTimerRef.current = undefined;
      setEscClearArmed(false);
      setStatusLine((current) =>
        current === tui('Esc again to clear the composer') || current === tui('Esc again to rewind')
          ? undefined
          : current
      );
    }, ESC_CLEAR_MS);
  }, []);

  const permissionPanelRules = (): PermissionPanelRule[] => {
    const live = options.cliRuntime?.permissionsRules?.().rules ?? [];
    return live.map((rule) => ({
      level: rule.level,
      spec: rule.operandPattern ? `${rule.toolName}(${rule.operandPattern})` : rule.toolName,
      source: rule.source,
      session: rule.source === 'session',
    }));
  };
  const copySelection = (text: string): void => {
    writeStdout(osc52(text));
    if (process.platform === 'darwin') {
      void runProcess('pbcopy', { args: [], stdin: text }).catch(() => undefined);
    }
    setStatusLine(tui('copied {count} chars to clipboard', { count: text.length }));
  };
  const toggleExpandedRow = (rowId: number): void => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  useInput((chunk, key) => {
    const osc = /\]11;([^\u0007\u001b]*)/.exec(chunk);
    if (osc && !themeLockedByEnv() && !process.env.MOSS_TUI_THEME) {
      const detected = themeFromOsc11(osc[1] ?? '');
      if (detected) {
        setTuiTheme(detected);
        forceUpdate();
      }
      return;
    }
    if (fullscreen) {
      const mouseEvents = mouseEventsInChunk(chunk);
      if (mouseEvents.length > 0) {
        for (const event of mouseEvents) {
          const action = routeMouse(event, mouseLayoutRef.current);
          if (action.type === 'hover') {
            if (action.x === mouseLayoutRef.current.scrollbarCol) touchScrollBar();
          } else if (action.type === 'scroll') {
            touchScrollBar();
            const height = Math.max(1, mouseLayoutRef.current.viewportRows);
            setViewport((current) =>
              scrollViewport(current, projectedFullRef.current, action.delta, height)
            );
          } else if (action.type === 'scrollbar') {
            touchScrollBar();
            const height = Math.max(1, mouseLayoutRef.current.viewportRows);
            setViewport(viewportAtRatio(projectedFullRef.current, height, action.y));
          } else if (action.type === 'pin') {
            setViewport(createViewport());
          } else if (action.type === 'caret') {
            setComposer((current) =>
              composerCaretFromClick(
                current,
                {
                  width: columns,
                  maxRows: COMPOSER_MAX_ROWS,
                  firstPrefix: shellMode ? '! ' : '❯ ',
                  restPrefix: '  ',
                },
                action.visibleRow,
                action.cell
              )
            );
          } else if (action.type === 'select') {
            if (action.phase === 'start') {
              clickPressRef.current = { x: action.x, y: action.y };
              selectionRef.current = undefined;
              forceUpdate();
            } else if (action.phase === 'move' && clickPressRef.current) {
              const pressed = clickPressRef.current;
              if (pressed.x !== action.x || pressed.y !== action.y) {
                selectionRef.current = {
                  anchor: { x: pressed.x, y: pressed.y },
                  head: { x: action.x, y: action.y },
                };
                forceUpdate();
              }
            } else if (action.phase === 'end') {
              const pressed = clickPressRef.current;
              clickPressRef.current = undefined;
              if (selectionRef.current) {
                const text = selectionText(
                  projectedTextRef.current,
                  selectionRef.current.anchor,
                  selectionRef.current.head
                );
                selectionRef.current = undefined;
                forceUpdate();
                if (text) copySelection(text);
              } else if (pressed) {
                const hit = viewportWindowRef.current[pressed.y];
                const rowId = hit?.rowId;
                if (
                  rowId !== undefined &&
                  rowId >= 0 &&
                  (expandedRowsRef.current.has(rowId) ||
                    projectedFullRef.current.some(
                      (entry) => entry.rowId === rowId && isExpandAffordance(entry.text)
                    ))
                ) {
                  toggleExpandedRow(rowId);
                }
              }
            }
          }
        }
        return;
      }
    }
    const inkKey =
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow ||
      key.return ||
      key.escape ||
      key.tab ||
      key.backspace ||
      key.delete ||
      key.ctrl ||
      key.meta;
    if (!inkKey && isComposerLeak(chunk)) {
      noteDroppedKeys(1);
      return;
    }
    if (permissionsOpen) {
      const rules = permissionPanelRules();
      if (key.escape) {
        setPermissionsOpen(false);
        return;
      }
      if (key.upArrow || key.downArrow) {
        setPermissionCursor((current) =>
          Math.max(0, Math.min(rules.length - 1, current + (key.upArrow ? -1 : 1)))
        );
        return;
      }
      if ((chunk === 'd' || key.backspace) && rules.length > 0) {
        const rule = rules[Math.min(permissionCursor, rules.length - 1)];
        const registry = options.cliRuntime?.permissionRuleRegistry;
        if (rule?.session && registry?.remove(rule.spec)) {
          setStatusLine(tui('removed session rule {spec}', { spec: rule.spec }));
          forceUpdate();
        } else if (rule) {
          setStatusLine(tui('config rules stay in the config file'));
        }
        return;
      }
      // A typed command (`/permissions add …`) leaves the panel and lands in
      // the composer. Arrow keys and `d` stay inside the panel.
      if (!chunk || inkKey) return;
      setPermissionsOpen(false);
    }
    if (rewindOpen) {
      const checkpoints = options.listCheckpoints?.() ?? [];
      if (key.escape) {
        setRewindOpen(false);
        return;
      }
      if (key.upArrow || key.downArrow) {
        setRewindCursor((current) =>
          Math.max(0, Math.min(checkpoints.length - 1, current + (key.upArrow ? -1 : 1)))
        );
        return;
      }
      if (key.return) {
        const picked = checkpoints[rewindCursor];
        setRewindOpen(false);
        if (picked) {
          const result = options.rewindTo?.(picked.seq);
          setStatusLine(result?.detail ?? tui('rewind to {seq} failed', { seq: picked.seq }));
        }
        return;
      }
      return;
    }
    if (fullscreen && key.end && !approval && input.length === 0) {
      touchScrollBar();
      setViewport(createViewport());
      return;
    }
    if (fullscreen && key.home && !approval && input.length === 0) {
      touchScrollBar();
      const height = Math.max(1, mouseLayoutRef.current.viewportRows);
      setViewport(viewportAtRatio(projectedFullRef.current, height, 0));
      return;
    }
    if (fullscreen && (key.pageUp || key.pageDown) && !approval) {
      touchScrollBar();
      const height = Math.max(1, mouseLayoutRef.current.viewportRows);
      setViewport((current) =>
        scrollViewport(current, projectedFullRef.current, key.pageUp ? -height : height, height)
      );
      return;
    }
    if (chunk === '?' && input.length === 0 && !shellMode && !approval && !key.ctrl && !key.meta) {
      setHelpOverlay({ lines: buildHelpOverlayLines(false, keymap.bindings), all: false });
      return;
    }
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
        setStatusLine(tui('Ctrl+D quits — press Esc twice to drop the draft first'));
        return;
      }
      exit();
      return;
    }
    if (key.tab && key.shift) {
      if (approval) {
        setStatusLine(tui('finish the pending approval before changing interaction mode'));
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
        const pressed = chunk?.toLowerCase();
        const answering = key.return || (typeof pressed === 'string' && /^[1-9]$/.test(pressed));
        if (answering && Date.now() < approvalGuardUntilRef.current) {
          setStatusLine(tui('keys paused — dialog just opened'));
          return;
        }
        if (key.return) {
          const amendArmed = approval.amend === true && approval.cursor === 0;
          answerApproval(amendArmed ? 'amend' : (approval.options[approval.cursor]?.answer ?? 'n'));
          return;
        }
        const direct = approval.options.find((option) => option.key === pressed);
        if (direct) {
          answerApproval(direct.answer);
          return;
        }
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
        setStatusLine(tui('fresh session — `moss resume` reopens the picker'));
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
          setStatusLine(tui('prompt staged from history — Enter sends'));
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
        // A fully typed command wins over the fuzzy highlight. `/mode` is a
        // hidden alias and is a subsequence of `/model`; Enter must run `/mode`.
        const typed = input.trim();
        const head = (typed.split(/\s+/, 1)[0] ?? '').toLowerCase();
        const exact =
          isExactSlashCommand(typed) ||
          customCommands.some((command) => command.name === head) ||
          (options.skills ?? []).some((skill) => `/${skill.name}`.toLowerCase() === head);
        if (exact) {
          void submit(typed);
          return;
        }
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
      setComposer((current) => {
        const doc = moveCaret(
          { state: current, tokens: tokensRef.current },
          motion,
          Math.max(4, columns - 2)
        );
        tokensRef.current = doc.tokens;
        return doc.state;
      });
      return;
    }
    if (key.escape) {
      if (shellMode) {
        // Esc cancels shell mode: the draft is discarded and the composer
        // returns to the normal `❯` prompt (nothing was executed).
        setShellMode(false);
        setInput('');
        return;
      }
      if (abortRef.current) {
        if (queueRef.current.length > 0) {
          const returned = queueRef.current.map((item) => item.display).join('\n');
          queueRef.current = [];
          setQueueRevision((n) => n + 1);
          if (input.length === 0) setInput(returned);
        }
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
      } else if (escClearArmed) {
        disarmEscClear();
        setRewindCursor(0);
        setRewindOpen(true);
        setStatusLine(undefined);
      } else {
        armEscClear();
        setStatusLine(tui('Esc again to rewind'));
      }
      return;
    }
    if (key.upArrow || key.downArrow) {
      // A history walk keeps using Up/Down even when the recalled prompt is
      // multi-line. Otherwise the first multi-line entry traps the arrows.
      const walking = historyCursorRef.current.index !== undefined;
      if (!walking && input.includes('\n')) {
        setComposer((current) =>
          composerMove(current, key.upArrow ? 'up' : 'down', Math.max(4, columns - 2))
        );
        return;
      }
      if (key.upArrow && input.length === 0 && queueRef.current.length > 0 && !walking) {
        const last = queueRef.current.pop();
        setQueueRevision((n) => n + 1);
        if (last) setInput(last.display);
        return;
      }
      // Fullscreen has no terminal scrollback. Up/Down moves the transcript
      // one row at a time; history recall remains once the view cannot move
      // (already at the top, or Down while pinned to the latest row).
      if (fullscreen && !walking && input.length === 0 && !approval) {
        touchScrollBar();
        const height = Math.max(1, mouseLayoutRef.current.viewportRows);
        const motion = moveTranscript(
          viewport,
          projectedFullRef.current,
          height,
          key.upArrow ? 'up' : 'down'
        );
        if (motion.action === 'scroll') {
          setViewport(motion.state);
          return;
        }
      }
      const recalled = walkPromptHistory(
        historyRef.current,
        historyCursorRef.current,
        key.upArrow ? 'older' : 'newer',
        input
      );
      if (!recalled) return;
      historyCursorRef.current = { index: recalled.index, draft: recalled.draft };
      setHistoryCursor({ index: recalled.index, draft: recalled.draft });
      setInput(recalled.text);
      setStatusLine(undefined);
      return;
    }
    if (key.backspace || key.delete) {
      if (shellMode && input.length === 0) {
        // Backspacing an empty shell draft leaves shell mode (same as Esc).
        setShellMode(false);
        return;
      }
      setComposer((current) => {
        const doc = deleteText(
          { state: current, tokens: tokensRef.current },
          key.delete ? 'forward' : 'backward'
        );
        tokensRef.current = doc.tokens;
        return doc.state;
      });
      return;
    }
    // Ctrl+<letter> shortcuts, driven by the same table the help block prints.
    if (key.ctrl && typeof chunk === 'string' && chunk.length === 1) {
      const code = chunk.charCodeAt(0);
      const letter = code >= 1 && code <= 26 ? String.fromCharCode(code + 96) : chunk.toLowerCase();
      // The registry (keymap.ts) owns every action key; `x` is the chord prefix
      // (Ctrl+X Ctrl+S) and stays a plain letter.
      const command = commandForKey(keymap.bindings, `ctrl+${letter}`);
      if (command === 'caret.lineStart') {
        setComposer((current) => composerMove(current, 'line-start'));
        return;
      }
      if (command === 'caret.lineEnd') {
        // Readline muscle memory (and the reference CLI): end of line. The
        // evidence panel moved to Ctrl+V so this key could be an editor key.
        setComposer((current) => composerMove(current, 'line-end'));
        return;
      }
      if (command === 'edit.yank') {
        // Yank the last killed text back (readline's kill ring, depth 1).
        if (killRef.current) {
          const killed = killRef.current;
          setComposer((current) => composerInsert(current, killed));
          setStatusLine(undefined);
        } else {
          setStatusLine(
            tui('nothing to paste — Ctrl+U / Ctrl+K / Ctrl+W delete into the kill ring')
          );
        }
        return;
      }
      if (command === 'history.search') {
        // A2.22: readline/reference muscle memory — search earlier prompts.
        setHistorySearch({ query: '', cursor: 0 });
        return;
      }
      if (letter === 'x') {
        chordRef.current = 'x';
        return;
      }
      if (command === 'editor.external') {
        const editor = process.env.VISUAL || process.env.EDITOR;
        if (!editor) {
          setStatusLine(tui('set $EDITOR to edit the draft externally'));
          return;
        }
        const file = path.join(os.tmpdir(), `moss-draft-${process.pid}.txt`);
        const draft = input;
        fs.writeFileSync(file, draft);
        void suspendTerminal(async () => {
          await new Promise<void>((resolve) => {
            // EDITOR may carry arguments; the editor opens on the caret's line.
            const { bin, args: editorArgs } = splitEditorCommand(editor);
            const line = caretLine(composer.value, composer.caret);
            const child = spawnProcess(
              bin,
              [...editorArgs, ...externalEditorArgs(bin, file, line)],
              { stdio: 'inherit' }
            );
            child.on('exit', () => resolve());
            child.on('error', () => resolve());
          });
          try {
            const next = fs.readFileSync(file, 'utf8').replace(/\n$/, '');
            tokensRef.current = [];
            setComposer(composerSetValue(next));
          } catch {
            setStatusLine(tui('could not read the edited draft'));
          }
        });
        return;
      }
      if (letter === 's' && chordRef.current === 'x') {
        chordRef.current = '';
        if (abortRef.current && queueRef.current.length > 0) abortRef.current.abort();
        return;
      }
      chordRef.current = '';
      if (command === 'draft.stash') {
        // A2.24: stash the prompt when something urgent arrives; a second
        // Ctrl+S SWAPS — the new draft goes into the stash and the parked
        // one comes back (neither is ever lost).
        if (input.length > 0) {
          const restore = stashRef.current;
          stashRef.current = input;
          setInput(restore ?? '');
          setStatusLine(
            tui(
              restore !== undefined
                ? 'swapped — Ctrl+S again to swap back'
                : 'prompt stashed — Ctrl+S brings it back'
            )
          );
        } else if (stashRef.current !== undefined) {
          const stashed = stashRef.current;
          stashRef.current = undefined;
          setInput(stashed);
          setStatusLine(undefined);
        } else {
          setStatusLine(tui('nothing to stash — the composer is empty'));
        }
        return;
      }
      if (
        command === 'edit.killWordBack' ||
        command === 'edit.killLineStart' ||
        command === 'edit.killLineEnd'
      ) {
        const unit =
          command === 'edit.killLineStart'
            ? 'line-start'
            : command === 'edit.killLineEnd'
              ? 'line-end'
              : 'word-backward';
        const { doc, killed } = killText({ state: composer, tokens: tokensRef.current }, unit);
        if (killed) {
          killRef.current = killed;
          tokensRef.current = doc.tokens;
          setComposer(doc.state);
          const shown = killed.length > 24 ? `${killed.length} chars` : `"${killed.trim()}"`;
          setStatusLine(tui('deleted {what} — Ctrl+Y to paste back', { what: shown }));
        }
        return;
      }
      if (command === 'view.toggleVerbose') {
        // Inline: only later rows pick up the new detail. Remounting <Static>
        // reprinted the whole transcript into scrollback.
        setVerbose((current) => !current);
        return;
      }
      if (command === 'composer.clear') {
        setInput('');
        setStatusLine(undefined);
      }
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
    if (historyCursorRef.current.index !== undefined) {
      setHistoryCursor({ index: undefined, draft: '' });
    }
    disarmEscClear();
    setStatusLine((current) =>
      current !== undefined && transientStatus(current) ? undefined : current
    );
    lastEditAtRef.current = Date.now();
    setComposer((current) => {
      const doc = insertText({ state: current, tokens: tokensRef.current }, chunk);
      tokensRef.current = doc.tokens;
      return doc.state;
    });
  });

  usePaste((text) => {
    lastEditAtRef.current = Date.now();
    setComposer((current) => {
      const doc = insertPaste(
        { state: current, tokens: tokensRef.current },
        text,
        pasteIdRef.current
      );
      pasteIdRef.current += 1;
      tokensRef.current = doc.tokens;
      return doc.state;
    });
  });

  // ─── render ────────────────────────────────────────────────────────────

  // Reasoning is hidden like in Claude Code: the spinner says "Thinking…" and
  // ctrl+o (verbose) reveals the text. MOSS_SHOW_THINKING=true keeps a short
  // live preview in the compact view for people who want it.
  const showThinking = verbose || process.env.MOSS_SHOW_THINKING === 'true';
  const live: LiveView = {
    running,
    startedAt: runStartedAtRef.current,
    toolLine: store.run.toolLine,
    streaming: userFacingAssistantText(store.run.streamingText),
    thinking: showThinking ? store.run.thinkingText : '',
    tokensOut: store.usage.runTokensOut,
    queued: queueRef.current.length,
    ...(queueRef.current[0] ? { queuePreview: queueRef.current[0].display } : {}),
    ...(store.run.retry ? { retry: store.run.retry } : {}),
    ...(store.run.lastEventAt !== undefined ? { lastEventAt: store.run.lastEventAt } : {}),
    blocked: Boolean(approval),
    thinkingActive: store.run.thinkingText.trim() !== '' && !store.run.streamingText.trim(),
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
    ...(approval ? { answerKeys: approval.options.map((option) => option.key).join('/') } : {}),
    tokens: running ? store.usage.runTokensOut : store.usage.tokensIn + store.usage.tokensOut,
    turnIn: store.usage.runTokensIn,
    turnOut: store.usage.runTokensOut,
    taskCount: runtime.taskSummaries().length,
    queueLength: queueRef.current.length,
    contextUsed: store.usage.contextUsed,
    contextTotal: store.usage.contextTotal,
    // A7: the policy layer's live mode is part of the chrome, always.
    mode: interactionMode,
    verbose,
    collapsed: projectedFullRef.current.some((entry) => isExpandAffordance(entry.text)),
    ...(stashRef.current !== undefined ? { stashed: true } : {}),
    shellMode,
  };
  const editor = renderComposerEditor(composer, {
    width: columns,
    maxRows: COMPOSER_MAX_ROWS,
    placeholder:
      input.length === 0
        ? queueRef.current.length > 0
          ? tui('Press up to edit queued messages')
          : running
            ? undefined
            : tui(composerPlaceholder(composerProjectKind))
        : undefined,
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
              index === modelPicker.cursor ? { color: TONE.accent, bold: true } : { dim: true }
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
  // Plan / accept-edits tint the same two rules as the hint row below them, so
  // the input block always shows the mode it is in (full / manual stay neutral).
  const ruleTone = shellMode
    ? { color: SHELL_MODE_TONE }
    : interactionMode === 'plan' || interactionMode === 'acceptEdits'
      ? { color: INTERACTION_MODE_TONES[interactionMode] }
      : {};
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
          tui('◇ task {id} blocked — {reason} · /task resume {task}', {
            id: blockedTask.taskId.slice(-6),
            reason: blockedTask.blockedReason ?? tui('user decision required'),
            task: blockedTask.taskId,
          }),
          columns
        ),
        { color: TONE.warn }
      )
    : undefined;
  const statusRight = renderStatusRight(status, columns);
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
              tui(
                'context {pct}% full — auto-compact will trim older messages · /compact to do it now',
                { pct: contextPct }
              ),
              columns
            ),
            { color: TONE.warn }
          ),
        ]
      : []),
    ...(!approval && !helpOverlay ? palette : []),
    ...(!approval && !helpOverlay ? sessionPickerOverlay : []),
    ...(!approval && !helpOverlay ? historySearchOverlay : []),
    ...(!approval && !helpOverlay ? mentions : []),
    ...(!helpOverlay ? modelPickerLines : []),
    ...helpOverlayLines,
    ...(permissionsOpen
      ? renderPermissionsPanel({
          width: columns,
          mode: formatCliInteractionModeLabel(interactionMode, isTuiZh()),
          rules: permissionPanelRules(),
          cursor: permissionCursor,
        })
      : []),
    // An idle status row has nothing to say; a blank row above the rule wastes
    // a line of the transcript (plan v3 N5).
    ...(statusRight.text.trim() ? [statusRight] : []),
    ...(historyCursor.index !== undefined
      ? [renderHistoryRule(historyCursor.index + 1, history.length, columns)]
      : []),
    // Queued follow-ups sit directly above the composer so ↑ can take one back.
    ...(!approval && queueRef.current.length > 0
      ? [
          ...queueRef.current.slice(0, 5).map((item, index) =>
            line(
              clip(
                tui('  queued {n}. {text}', {
                  n: index + 1,
                  text: item.display.replace(/\s+/g, ' ').trim().slice(0, 72),
                }),
                columns
              ),
              { dim: true }
            )
          ),
          line(clip(`  ${tui('Press up to edit queued messages')}`, columns), { dim: true }),
        ]
      : []),
    line(rule(columns), ruleTone),
  ];
  const chromeBottom: TuiLine[] = [line(rule(columns), ruleTone), renderHint(status, columns)];
  const rowDetail = (row: { id: number }): boolean => verbose || expandedRows.has(row.id);
  // Fullscreen reserves the last column for the scroll bar; the body is one cell
  // narrower so no projected line can wrap into it.
  const bodyWidth = fullscreen ? Math.max(1, columns - 1) : columns;
  const activityLines = fullscreen
    ? renderScrollableActivity(
        showThinking ? store.run.thinkingText : '',
        store.run.streamingText,
        bodyWidth
      )
    : [];
  const liveLines = renderLive(
    fullscreen ? { ...live, thinking: '', streaming: '' } : live,
    columns,
    verbose
  );
  // The `Jump to bottom` row is part of the frame budget: leaving it out made
  // the frame one row taller than the terminal, which scrolled the top away.
  const showJump = fullscreen && !viewport.pinned && viewport.offsetFromBottom > 0;
  // The jump row always owns its slot in fullscreen (blank while pinned). A slot
  // that appears and disappears changed the viewport height with the scroll
  // state, so a drag target stopped meaning the same row a frame later.
  const jumpSlot = fullscreen ? 1 : 0;
  const frameLayout = allocateFrame({
    rows: windowSize.rows || 24,
    mode: fullscreen ? 'fullscreen' : 'inline',
    composerLines: approval ? 1 : Math.max(1, editor.lines.length),
    fixedChrome: chromeTop.length + chromeBottom.length + jumpSlot,
    sections: [
      {
        id: 'live',
        lines: liveLines,
        min: liveLines.length > 0 ? 1 : 0,
        priority: 5,
        trim: 'head',
      },
    ],
  });
  const shownLive = frameLayout.sections[0]?.lines ?? liveLines;
  const projected: ViewportLine[] = [];
  if (fullscreen) {
    const folded = foldReadonlyRows(store.rows, verbose);
    const cache = projectionCacheRef.current;
    folded.forEach((row, rowIndex) => {
      cache
        .render(row, bodyWidth, rowDetail(row), folded[rowIndex - 1])
        .forEach((entry, lineIndex) => {
          projected.push({ rowId: row.id, lineIndex, text: entry.text, line: entry });
        });
    });
    activityLines.forEach((entry, lineIndex) => {
      projected.push({ rowId: -1, lineIndex, text: entry.text, line: entry });
    });
  }
  projectedFullRef.current = projected;
  viewportLinesRef.current = projected.length;
  const view = fullscreen
    ? viewportWindow(projected, viewport, frameLayout.viewportRows)
    : undefined;
  viewportWindowRef.current = view?.lines ?? [];
  // One cell per viewport row, right-most column: a thumb while the transcript
  // overflows, nothing otherwise. The thumb follows the same window as the text.
  // The arrows take the first and last rows, so the thumb moves along the rows between.
  const thumb =
    fullscreen && view
      ? scrollThumb(
          projected.length,
          frameLayout.viewportRows,
          view.start,
          Math.max(1, frameLayout.viewportRows - 2)
        )
      : null;
  const barShown = Boolean(thumb) && Date.now() - barTouchedRef.current < SCROLLBAR_HIDE_MS;
  const barCells: Array<{ text: string; color?: TuiLine['color'] } | undefined> =
    thumb && barShown
      ? Array.from({ length: frameLayout.viewportRows }, (_, index) => {
          // The first and last rows are the arrows: a click there goes to the top
          // or bottom of the transcript (see routeMouse / viewportAtRatio).
          if (index === 0) return { text: '↑', color: TONE.accent };
          if (index === frameLayout.viewportRows - 1) return { text: '↓', color: TONE.accent };
          const track = index - 1;
          return track >= thumb.top && track < thumb.top + thumb.size
            ? { text: '┃', color: TONE.accent }
            : { text: '│', color: TONE.muted };
        })
      : [];
  projectedTextRef.current = (view?.lines ?? []).map((entry) => entry.text);
  // A short transcript leaves the viewport partly empty. The composer belongs at
  // the bottom edge (like Claude Code's fullscreen), so the gap is explicit rows.
  const spacerRows =
    fullscreen && view ? Math.max(0, frameLayout.viewportRows - view.lines.length) : 0;
  const permissionDialog = Boolean(approval && pendingDialogRef.current?.kind !== 'question');
  const detailSource =
    verbose && !fullscreen
      ? [...store.rows].reverse().find((row) => row.kind === 'result' && row.text.includes('\n'))
      : undefined;
  const detailLines = detailSource
    ? renderTranscriptRow(detailSource, columns, true).slice(0, 40)
    : [];
  const composerLines = permissionDialog ? 0 : editor.lines.length;
  // Rows the frame paints above the composer, in render order: the fullscreen
  // transcript viewport, then the live block (streaming text, spinner), then the
  // detail block, then the top chrome. Fullscreen renders the live block too, so
  // it must be counted; dropping it parked the hardware cursor above the prompt.
  const aboveComposer =
    (view?.lines.length ?? 0) +
    spacerRows +
    jumpSlot +
    shownLive.length +
    detailLines.length +
    chromeTop.length;
  mouseLayoutRef.current = {
    composerTop: aboveComposer,
    composerLines,
    viewportRows: fullscreen ? frameLayout.viewportRows : 0,
    ...(thumb ? { scrollbarCol: columns - 1 } : {}),
    // The affordance sits directly under the viewport, above the live block.
    ...(showJump && view ? { jumpRow: view.lines.length } : {}),
  };
  // Overlay query boxes (Ctrl+R search, the session picker) take the hardware
  // cursor at the end of their query, the same way the composer does.
  const overlayQueryRow = chromeTop.findIndex((entry) => entry.text.includes('⌕'));
  const overlayQuery = overlayQueryRow >= 0 && Boolean(historySearch || sessionPicker);
  // A selector (approval, model list, session list, permissions) owns the caret:
  // the hardware cursor sits on its `❯` row so IME and screen readers follow the
  // choice, the same way the composer and the search query do.
  const selectorOwnsCaret = Boolean(
    approval || modelPicker || permissionsOpen || (sessionPicker && !overlayQuery)
  );
  const selectorRow = selectorOwnsCaret
    ? chromeTop.findIndex((entry) => /^\s*❯/.test(entry.text))
    : -1;
  // ink only appends the trailing newline its cursor maths assumes while the
  // frame is shorter than the terminal. A frame that fills every row (the
  // fullscreen viewport, or a narrow/short pane) leaves the real cursor one
  // row lower, which parked the caret on the rule above the prompt.
  const frameRows = aboveComposer + composerLines + chromeBottom.length;
  const fillsTerminal = frameRows >= (windowSize.rows || 24);
  if (process.env.MOSS_TUI_DEBUG === '1') {
    noteFrameHeight(options.workspaceDir, frameRows, windowSize.rows || 24, fullscreen);
  }
  if (process.env.MOSS_TUI_HW_CURSOR === '0') {
    setCursorPosition(undefined);
  } else if (overlayQuery) {
    const queryLine = chromeTop[overlayQueryRow];
    setCursorPosition({
      x: displayWidth(queryLine?.text ?? ''),
      y: aboveComposer - chromeTop.length + overlayQueryRow + (fillsTerminal ? 1 : 0),
    });
  } else if (selectorRow >= 0) {
    const marker = chromeTop[selectorRow]?.text ?? '';
    const markAt = marker.indexOf('❯');
    setCursorPosition({
      x: displayWidth(markAt >= 0 ? marker.slice(0, markAt) : marker),
      y: aboveComposer - chromeTop.length + selectorRow + (fillsTerminal ? 1 : 0),
    });
  } else {
    setCursorPosition({
      x: editor.caretCol,
      y: aboveComposer + editor.caretRow + (fillsTerminal ? 1 : 0),
    });
  }

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
  const inkLine = (l: TuiLine, key: string, inverse = false): React.ReactElement =>
    React.createElement(
      Text,
      { key, ...inkLineStyle(l), ...(inverse ? { inverse: true } : {}) },
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
              ...inkTextStyle({ color: SHELL_MODE_TONE }),
            },
            head
          )
        );
      }
      children.push(React.createElement(Text, { key: `${key}-${index}` }, tail));
    });
    return React.createElement(
      Text,
      { key, ...(editor.placeholder ? { dimColor: true } : {}) },
      ...children
    );
  };

  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      ...(fullscreen ? { height: windowSize.rows || 24 } : {}),
    },
    fullscreen
      ? null
      : React.createElement(Static, {
          // ink's <Static> memoizes on the ITEM ARRAY IDENTITY, so the store array
          // must be copied every render — pushing into it in place renders nothing
          // (the memo keeps returning the empty slice taken at mount).
          //
          // The key carries the ctrl+o revision: remounting is the only way ink
          // re-renders rows it has already committed (D-5). `/clear` rides the same
          // mechanism: after the ANSI wipe, the remount re-prints only the rows the
          // store kept (the banner).
          key: `transcript-${clearRevision}`,
          items: store.rows.slice(),
          // ink types Static's children as (item: unknown, index) => ReactNode.
          children: (item: unknown, rowIndex: number) => {
            const row = item as TranscriptRow;
            return React.createElement(
              Box,
              { key: row.id, flexDirection: 'column' },
              ...renderTranscriptRow(row, columns, rowDetail(row), store.rows[rowIndex - 1]).map(
                (l, index) => inkLine(l, `${row.id}-${index}`)
              )
            );
          },
        }),
    ...(fullscreen && view
      ? view.lines.map((entry, index) => {
          const selected = selectionRef.current;
          const top = selected ? Math.min(selected.anchor.y, selected.head.y) : -1;
          const bottom = selected ? Math.max(selected.anchor.y, selected.head.y) : -1;
          const bar = barCells[index];
          const body = entry.line ?? line(entry.text);
          // Runs are needed whenever the bar is drawn: a single row style would
          // paint the bar in the body's colour.
          const runs = body.runs?.length ? body.runs : [{ text: body.text }];
          const padded = padEndTo(body.text, bodyWidth);
          const padding = padded.slice(body.text.length);
          const shown: TuiLine = {
            ...body,
            text: `${padded}${bar?.text ?? ''}`,
            runs: [
              ...runs,
              ...(padding ? [{ text: padding }] : []),
              ...(bar ? [{ text: bar.text, color: bar.color }] : []),
            ],
          };
          return inkLine(shown, `view-${index}`, index >= top && index <= bottom);
        })
      : []),
    ...(fullscreen
      ? [
          inkLine(
            showJump ? line(tui('  ↓ Jump to bottom (click or End)'), { dim: true }) : line(''),
            'jump-bottom'
          ),
        ]
      : []),
    ...shownLive.map((l, index) => inkLine(l, `live-${index}`)),
    ...detailLines.map((l, index) => inkLine(l, `detail-${index}`)),
    // Spare rows sit below the live block: the spinner and the streaming tail stay
    // right under the last message, and the composer still rests on the bottom edge.
    ...Array.from({ length: spacerRows }, (_, index) => inkLine(line(''), `spacer-${index}`)),
    ...chromeTop.map((l, index) => inkLine(l, `chrome-top-${index}`)),
    ...(permissionDialog
      ? []
      : composerRuns.map((runs, index) =>
          inkRuns(runs, `composer-${index}`, shellMode && index === 0)
        )),
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
  installTerminalRestore();
  setTuiLocale(isZhLocale(options.locale ?? cliLocale()));
  setTuiTheme(detectTheme(process.env));
  const choice = selectTuiRenderer({
    env: process.env,
    rows: process.stdout.rows,
    columns: process.stdout.columns,
    term: process.env.TERM,
    inTmux: Boolean(process.env.TMUX),
    tmuxMouse: readTmuxMouse(process.env),
    inScreen: Boolean(process.env.STY),
  });
  if (!options.renderer && choice.mode === 'inline' && /narrower|shorter/.test(choice.reason)) {
    // One line, before Ink takes the screen: the fallback is a fact the user can
    // act on (widen the window), not a silent downgrade.
    process.stderr.write(
      `[moss] ${choice.reason} — using the inline view. Resize the window to use fullscreen.\n`
    );
  }
  const handle = createStoreHandle();
  const runtime = options.runtime ?? new TaskRuntime({ workspaceDir: options.workspaceDir });
  const instance = render(
    React.createElement(TuiAppRoot, {
      options: { ...options, renderer: options.renderer ?? choice.mode },
      handle,
      runtime,
    }),
    {
      exitOnCtrlC: false,
      // Ink treats CI=true as non-interactive and then writes only <Static>
      // (the banner) until exit, so the composer never appears. This entry
      // point is the live TTY; a real terminal stays interactive in CI.
      interactive: process.stdout.isTTY === true,
      alternateScreen: (options.renderer ?? choice.mode) === 'fullscreen',
      incrementalRendering: process.env.MOSS_TUI_INCREMENTAL !== '0',
      kittyKeyboard: TUI_KITTY_KEYBOARD,
    }
  );
  try {
    await instance.waitUntilExit();
  } finally {
    restoreTerminalModes(process.stdout);
    if ((options.renderer ?? choice.mode) === 'fullscreen') {
      const session = options.sessionKey ?? 'current';
      const last = [...handle.store.rows].reverse().find((row) => row.kind === 'assistant');
      process.stdout.write(
        `\nsession ${session}\nmoss resume ${session}\n${last ? last.text.slice(0, 500) : ''}\n`
      );
    }
  }
}
