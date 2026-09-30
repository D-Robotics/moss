/**
 * moss Mission Control TUI (v0.21) — the interactive face for TTY sessions,
 * rebuilt task-first around the shared TaskRuntime: Task Navigator | Task
 * Execution Canvas | Contextual Device + Verification, with the transcript
 * demoted to an expandable execution detail.
 *
 * This module (and only this directory) statically imports ink/react; every
 * entry point must dynamically import it so headless/SDK paths never load UI
 * dependencies. Non-TTY or `--no-tty` sessions fall back to the readline REPL.
 *
 * Input model stays hand-rolled (append + backspace + return) rather than
 * ink-text-input, with bracketed-paste staged at the raw stdin layer — both
 * are deterministic under ink-testing-library (see project TUI notes).
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { render, Text, Box, useApp, useInput, useStdin, useStdout } from 'ink';
import type { MossAgent } from '../../core/agent/moss-agent.js';
import { TaskRuntime } from '../../core/task-runtime/runtime.js';
import { errorMessage } from '../../errors.js';
import {
  applyAgentEvent,
  appendRow,
  beginRun,
  createTuiStore,
  endRun,
  formatUsage,
  type TranscriptRowKind,
} from './render-bridge.js';
import { createPasteCapture, feedChunk } from './input-box.js';
import {
  listBackgroundProcessSnapshots,
  type BackgroundProcSnapshot,
} from '../../core/tools/background-process-registry.js';
import { resolveDefaultDeviceTarget } from '../../device/device-target.js';
import { EMPTY_STATE_EXAMPLES } from './panels.js';
import { setCliApprovalAsker } from '../approval.js';
import { transcriptLines } from './transcript-view.js';
import { computeLayout } from './layout.js';
import {
  clip,
  renderApprovalBanner,
  renderCanvas,
  renderContextPanel,
  renderExecutionDetailTail,
  renderInputLine,
  renderNavigator,
  type PanelColor,
  type PanelLine,
} from './panels.js';
import {
  actionMenuItems,
  HELP_COMMANDS,
  HELP_KEYS,
  renderActionMenu,
  renderDeploymentInspector,
  renderEvidenceInspector,
  renderFailureRepair,
  renderHelp,
  renderTaskHistory,
  renderTaskSwitcher,
  type OverlayKind,
} from './overlays.js';

export const TUI_HELP_TEXT = [
  'moss Mission Control — describe a goal below; moss runs it as a task (plan → execute → device → verify → repair → acceptance).',
  `keys: ${HELP_KEYS.map(([keys, what]) => `${keys} ${what}`).join(' · ')}`,
  `commands: ${HELP_COMMANDS.join(' · ')}`,
].join('\n');

export interface TuiReplayRow {
  kind: TranscriptRowKind;
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

export interface TuiAppOptions {
  agent: MossAgent;
  workspaceDir: string;
  sessionKey?: string;
  model?: string;
  /** Transcript rows replayed on boot (resume). */
  replayRows?: TuiReplayRow[];
  /** /sessions panel provider (host-side session store). */
  listSessions?: () => Promise<TuiSessionSummary[]>;
  /** /mcp panel data (host-side registry statuses). */
  mcpServers?: TuiMcpServerStatus[];
  /** File checkpoint restore for /rewind (host wires the checkpoint store). */
  rewindTo?: (seq: number) => { ok: boolean; detail: string };
  listCheckpoints?: () => Array<{ seq: number; label: string; files: number }>;
  /** Injected task runtime (specs); created from workspaceDir when omitted. */
  runtime?: TaskRuntime;
}

export function buildTuiHelpText(): string {
  return TUI_HELP_TEXT;
}

interface StatusSegment {
  text: string;
  color?: PanelColor;
  bold?: boolean;
  dim?: boolean;
}

/**
 * Keep the status bar to exactly one row. Ink wraps a `<Text>` whose children
 * overflow the terminal — which silently steals a row from the panels — so
 * whole trailing segments are dropped instead, and the first is clipped.
 */
function fitStatusBar(segments: StatusSegment[], width: number): React.ReactElement[] {
  const kept: StatusSegment[] = [];
  let used = 0;
  for (const segment of segments) {
    if (kept.length === 0) {
      const text = clip(segment.text, width);
      kept.push({ ...segment, text });
      used = text.length;
      continue;
    }
    if (used + segment.text.length > width) break;
    kept.push(segment);
    used += segment.text.length;
  }
  return kept.map((segment, i) =>
    React.createElement(
      Text,
      {
        key: `status-${i}`,
        ...(segment.color ? { color: segment.color } : {}),
        ...(segment.bold ? { bold: true } : {}),
        ...(segment.dim ? { dimColor: true } : {}),
      },
      segment.text
    )
  );
}

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

type FocusZone = 'composer' | 'navigator';
type NarrowView = 'canvas' | 'context' | 'detail';

interface OverlayState {
  kind: OverlayKind;
  cursor: number;
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
  const [input, setInput] = useState('');
  const [scrollOffset, setScrollOffset] = useState(0);
  const [pastePreview, setPastePreview] = useState<string | undefined>(undefined);
  const [overlay, setOverlay] = useState<OverlayState | undefined>(undefined);
  const [focusZone, setFocusZone] = useState<FocusZone>('composer');
  const [narrowView, setNarrowView] = useState<NarrowView>('canvas');
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [notice, setNotice] = useState<string[]>([]);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const pendingApprovalRef = useRef<{
    question: string;
    resolve: (answer: string) => void;
  } | null>(null);
  const queueRef = useRef<{ text: string; kind: 'prompt' }[]>([]);
  const queuePausedRef = useRef(false);
  const [queuePaused, setQueuePaused] = useState(false);
  const [queueRevision, setQueueRevision] = useState(0);
  void queueRevision;
  const pasteRef = useRef(createPasteCapture());
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(undefined);
  const [deviceSummary, setDeviceSummary] = useState<string>('checking…');
  const [selectedExample, setSelectedExample] = useState<number | undefined>(undefined);
  const sessionKey = options.sessionKey ?? 'tui';
  const { store } = handle;

  useEffect(() => handle.subscribe(forceUpdate), [handle, forceUpdate]);
  useEffect(() => runtime.onChange(forceUpdate), [runtime, forceUpdate]);

  const sayNotice = useCallback((lines: string[]) => {
    setNotice(lines.map((text) => clip(text, 200)));
  }, []);

  /** Command answers leave a durable transcript row (execution log) + a
   * short-lived notice above the composer. */
  const logNotice = useCallback(
    (lines: string[]) => {
      appendRow(store, 'banner', lines.join('\n'));
      sayNotice(lines.slice(0, 6));
      handle.notify();
    },
    [handle, sayNotice, store]
  );

  // Approval bridge: when a mutating tool needs consent mid-run, the question
  // surfaces as a banner and the NEXT input line is the answer (y/a/n).
  useEffect(() => {
    setCliApprovalAsker(async (question: string) => {
      const pending = pendingApprovalRef.current;
      if (pending) pending.resolve('n');
      runtime.setApprovalPending(true);
      appendRow(
        store,
        'banner',
        `APPROVAL NEEDED — reply y (once) / a (session) / n (deny):\n${question.slice(0, 300)}`
      );
      sayNotice([`APPROVAL NEEDED — y (once) / a (session) / n (deny):`, question.slice(0, 160)]);
      handle.notify();
      return new Promise<string>((resolve) => {
        pendingApprovalRef.current = { question, resolve };
      });
    });
    return () => {
      const pending = pendingApprovalRef.current;
      if (pending) pending.resolve('n');
      pendingApprovalRef.current = null;
      runtime.setApprovalPending(false);
      setCliApprovalAsker(null);
    };
  }, [handle, runtime, sayNotice, store]);

  // Boot: banner, replay rows, task artifacts.
  useEffect(() => {
    appendRow(store, 'banner', 'moss Mission Control — /help for keys');
    for (const row of options.replayRows ?? []) {
      appendRow(store, row.kind, row.text);
    }
    if (options.replayRows?.length) {
      appendRow(store, 'banner', `Resumed — replayed ${options.replayRows.length} rows above.`);
    }
    void runtime.refresh().then(() => {
      const focusId = runtime.getLiveState().focusTaskId;
      if (focusId) setSelectedTaskId(focusId);
      handle.notify();
    });
    try {
      const target = resolveDefaultDeviceTarget();
      setDeviceSummary(
        target
          ? `${target.deviceId} (kind=${target.kind})`
          : 'not configured — set MOSS_DEVICE_HOST in .env'
      );
    } catch {
      setDeviceSummary('not configured — set MOSS_DEVICE_HOST in .env');
    }
    handle.notify();
  }, []);

  const runTurn = useCallback(
    async (message: string) => {
      runtime.beginRun();
      beginRun(store);
      handle.notify();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        for await (const event of options.agent.streamChat(sessionKey, message, {
          abortSignal: controller.signal,
        })) {
          applyAgentEvent(store, event);
          runtime.applyEvent(event);
          if (event.type === 'done') {
            const response = event.result?.response;
            if (
              typeof response === 'string' &&
              response.trim() &&
              !store.run.streamingText.trim()
            ) {
              appendRow(store, 'assistant', response);
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
      abortRef.current = undefined;
      const halted = controller.signal.aborted;
      endRun(store, halted);
      await runtime.endRun(halted);
      const focusId = runtime.getLiveState().focusTaskId;
      if (focusId && !selectedTaskId) setSelectedTaskId(focusId);
      if (halted) {
        appendRow(store, 'banner', 'Run halted at a safe boundary — you can continue.');
        sayNotice(['Run halted at a safe boundary — you can continue.']);
      }
      handle.notify();
    },
    [handle, options.agent, runtime, sayNotice, selectedTaskId, sessionKey, store]
  );

  const drainQueue = useCallback(async (): Promise<void> => {
    while (queueRef.current.length > 0 && !queuePausedRef.current) {
      const next = queueRef.current.shift();
      if (!next) break;
      setQueueRevision((n) => n + 1);
      appendRow(store, 'user', next.text);
      handle.notify();
      await runTurn(next.text);
    }
    if (queueRef.current.length === 0) setQueueRevision((n) => n + 1);
  }, [handle, runTurn, store]);

  const buildResumePrompt = useCallback(
    (taskId?: string): string => {
      const detail = runtime.taskDetail(taskId);
      if (!detail) return '';
      const unmet = detail.progress
        .filter((criterion) => criterion.result !== 'pass')
        .map((criterion) => `${criterion.metric} (${criterion.result})`)
        .join(', ');
      return (
        `Continue task ${detail.summary.taskId} — goal: ${detail.goal}. ` +
        `State: ${detail.summary.state}${detail.summary.result ? ` / ${detail.summary.result}` : ''}. ` +
        (unmet ? `Unmet criteria: ${unmet}. ` : '') +
        'Repair what failed, record fresh evidence, and re-run task_acceptance when done.'
      );
    },
    [runtime]
  );

  const openOverlay = useCallback((kind: OverlayKind) => {
    setOverlay({ kind, cursor: 0 });
    setNotice([]);
  }, []);

  const runInfoCommand = useCallback(
    async (command: 'sessions' | 'mcp' | 'subs' | 'bg'): Promise<string[]> => {
      if (command === 'sessions') {
        const sessions = (await options.listSessions?.()) ?? [];
        if (sessions.length === 0) return ['No saved sessions.'];
        return [
          ...sessions.map(
            (x) =>
              `${x.current ? '*' : ' '} ${x.key}${x.title ? ` — ${x.title}` : ''}${
                x.messageCount !== undefined ? ` (${x.messageCount} messages)` : ''
              }`
          ),
          'Switch or fork from the shell: moss resume --last / moss fork --fork-from <key>',
        ];
      }
      if (command === 'mcp') {
        const servers = options.mcpServers ?? [];
        if (servers.length === 0) return ['No MCP servers configured (.moss/mcp.json).'];
        return servers.map(
          (x) =>
            `${x.state === 'connected' ? '●' : '○'} ${x.name} — ${x.state}${
              x.toolCount !== undefined ? ` (${x.toolCount} tools, lazy)` : ''
            }${x.error ? `: ${x.error.slice(0, 80)}` : ''}`
        );
      }
      if (command === 'subs') {
        const snaps = options.agent.asyncTasks?.list() ?? [];
        if (snaps.length === 0) return ['No sub-agent tasks.'];
        return snaps.map((t) => `#${t.taskId.slice(-6)} ${t.status}`);
      }
      const running = listBackgroundProcessSnapshots().filter(
        (p: BackgroundProcSnapshot) => p.status === 'running'
      );
      if (running.length === 0) return ['No background tasks running.'];
      return running.map((p) => `#${p.id} ${p.command}${p.label ? ` (${p.label})` : ''}`);
    },
    [options]
  );

  const showInfo = useCallback(
    async (command: 'sessions' | 'mcp' | 'subs' | 'bg') => {
      const lines = await runInfoCommand(command);
      appendRow(store, 'banner', `[${command}] ${lines.join('\n')}`);
      sayNotice(lines.slice(0, 6));
      handle.notify();
    },
    [handle, runInfoCommand, sayNotice, store]
  );

  const submit = useCallback(
    async (raw: string) => {
      const pending = pendingApprovalRef.current;
      if (pending) {
        pendingApprovalRef.current = null;
        runtime.setApprovalPending(false);
        const answer = raw.trim().toLowerCase();
        const normalized =
          answer === 'y' || answer === 'yes'
            ? 'y'
            : answer === 'a' || answer === 'always'
              ? 'a'
              : 'n';
        appendRow(store, 'user', raw.trim() || '(no)');
        appendRow(store, 'banner', `Approval answered: ${normalized}`);
        sayNotice([`Approval answered: ${normalized}`]);
        handle.notify();
        setInput('');
        pending.resolve(normalized);
        return;
      }
      if (pastePreview !== undefined) {
        const staged = pasteRef.current.pending.shift() ?? pastePreview;
        setPastePreview(undefined);
        setInput('');
        if (!store.run.running) {
          appendRow(store, 'user', staged);
          handle.notify();
          void runTurn(staged).then(() => void drainQueue());
        }
        return;
      }
      const text = raw.trim();
      if (!text) return;
      setInput('');
      setNotice([]);
      if (text === '/quit' || text === '/exit') {
        exit();
        return;
      }
      if (text === '/help') {
        appendRow(store, 'banner', buildTuiHelpText());
        sayNotice(buildTuiHelpText().split('\n'));
        handle.notify();
        return;
      }
      if (text === '/usage') {
        logNotice([`tokens: ${formatUsage(store.usage)}`]);
        return;
      }
      if (text === '/bg' || text === '/subs' || text === '/sessions' || text === '/mcp') {
        await showInfo(text.slice(1) as 'bg' | 'subs' | 'sessions' | 'mcp');
        return;
      }
      if (text === '/tasks') {
        openOverlay('task-switcher');
        logNotice(['opened task switcher — ↑↓ select · ↵ switch · r resume']);
        return;
      }
      if (text === '/evidence') {
        openOverlay('evidence');
        logNotice(['opened evidence inspector']);
        return;
      }
      if (text === '/deployments') {
        openOverlay('deployments');
        logNotice(['opened deployment inspector']);
        return;
      }
      if (text === '/history') {
        openOverlay('task-history');
        logNotice(['opened task history']);
        return;
      }
      if (text === '/failures') {
        openOverlay('failure-repair');
        logNotice(['opened failure / repair view']);
        return;
      }
      if (text === '/actions' || text === '/menu') {
        openOverlay('action-menu');
        logNotice(['opened action menu']);
        return;
      }
      if (text === '/detail' || text === '/transcript') {
        setDetailExpanded((expanded) => !expanded);
        if (layoutModeRef.current === 'standard') setNarrowView('detail');
        logNotice(['toggled execution detail (transcript) view']);
        return;
      }
      if (text === '/resume' || text.startsWith('/resume ')) {
        const taskId = text.split(' ')[1];
        const prompt = buildResumePrompt(taskId);
        if (!prompt) {
          logNotice(['No task to resume — define one first (describe a goal).']);
        } else {
          setInput(prompt);
          logNotice(['Resume prompt staged below — edit if needed, Enter to send.']);
        }
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
          logNotice(
            checkpoints.length === 0
              ? ['No checkpoints recorded yet.']
              : [
                  'Checkpoints:',
                  ...checkpoints.map((c) => `${c.seq}. ${c.label} (${c.files} files)`),
                  '/rewind <seq> restores files.',
                ]
          );
        } else {
          const seq = Number(arg);
          const result = options.rewindTo?.(seq);
          logNotice(
            result?.ok
              ? [`Rewound to checkpoint ${seq}: ${result.detail}`]
              : [result?.detail ?? `Rewind to ${seq} failed.`]
          );
        }
        return;
      }
      if (text === '/queue' || text.startsWith('/queue ')) {
        const sub = text.split(' ')[1] ?? 'list';
        if (sub === 'pause') {
          queuePausedRef.current = true;
          setQueuePaused(true);
          logNotice(['Queue paused — new submissions wait.']);
        } else if (sub === 'resume') {
          queuePausedRef.current = false;
          setQueuePaused(false);
          logNotice(['Queue resumed.']);
          if (!store.run.running && queueRef.current.length > 0) void drainQueue();
        } else if (sub === 'drop') {
          const dropped = queueRef.current.shift();
          logNotice([
            dropped ? `Dropped: ${dropped.text.slice(0, 60)}` : 'Queue empty — nothing to drop.',
          ]);
          setQueueRevision((n) => n + 1);
        } else if (sub === 'clear') {
          const n = queueRef.current.length;
          queueRef.current.length = 0;
          setQueueRevision((n2) => n2 + 1);
          logNotice([`Cleared ${n} queued item${n === 1 ? '' : 's'}.`]);
        } else {
          const items = queueRef.current.map((q, i) => `${i + 1}. ${q.text.slice(0, 60)}`);
          logNotice([
            items.length
              ? `Queue (${queuePaused ? 'paused' : 'active'}): ${items.join(' · ')}`
              : 'Queue empty.',
          ]);
        }
        return;
      }
      if (text.startsWith('/steer')) {
        const constraint = text.slice('/steer'.length).trim();
        if (!constraint) {
          logNotice(['Usage: /steer <constraint> — injects at the next boundary.']);
        } else {
          const entry = options.agent.steer?.(sessionKey, constraint);
          logNotice([
            entry === null || entry === undefined
              ? 'Steer rejected — no single active run on this session.'
              : `Steer queued: ${constraint.slice(0, 80)}`,
          ]);
        }
        return;
      }
      if (text.startsWith('/')) {
        logNotice([
          `Unknown command "${text.split(' ')[0]}" in the TUI. ${buildTuiHelpText().split('\n')[2]}`,
        ]);
        return;
      }
      if (store.run.running) {
        queueRef.current.push({ text, kind: 'prompt' });
        setQueueRevision((n) => n + 1);
        appendRow(
          store,
          'banner',
          `Queued #${queueRef.current.length} (runs when the current turn ends; /queue to manage)`
        );
        sayNotice([`Queued #${queueRef.current.length} (/queue to manage)`]);
        handle.notify();
        return;
      }
      setScrollOffset(0);
      appendRow(store, 'user', text);
      handle.notify();
      void runTurn(text);
    },
    [
      buildResumePrompt,
      drainQueue,
      exit,
      handle,
      logNotice,
      openOverlay,
      pastePreview,
      runTurn,
      runtime,
      sessionKey,
      showInfo,
      store,
      sayNotice,
    ]
  );

  const layoutModeRef = useRef<'wide' | 'standard'>('wide');
  // Empty workspace + empty composer: the example picker is live (↑↓ + Enter,
  // 1/2/3 quick-pick) — the fastest path to a first verified task.
  const examplesActive =
    input.length === 0 && !store.run.running && runtime.taskSummaries().length === 0;

  const overlayDataLength = useCallback(
    (kind: OverlayKind): number => {
      if (kind === 'task-switcher') return runtime.taskSummaries().length;
      if (kind === 'evidence') return runtime.getArtifacts().evidence.length;
      if (kind === 'deployments') return runtime.getArtifacts().deployments.length;
      if (kind === 'action-menu') return actionMenuItems().length;
      return 0;
    },
    [runtime]
  );

  const closeOverlay = useCallback(() => setOverlay(undefined), []);

  const activateOverlay = useCallback(
    (state: OverlayState) => {
      if (state.kind === 'task-switcher') {
        const summaries = runtime.taskSummaries();
        const summary = summaries[state.cursor];
        if (summary) {
          setSelectedTaskId(summary.taskId);
          sayNotice([`Switched to ${summary.taskId} — ${clip(summary.goal, 80)}`]);
        }
        closeOverlay();
        return;
      }
      if (state.kind === 'action-menu') {
        const item = actionMenuItems()[state.cursor];
        if (!item) {
          closeOverlay();
          return;
        }
        switch (item.id) {
          case 'new-task':
            setFocusZone('composer');
            closeOverlay();
            break;
          case 'switch-task':
            setOverlay({ kind: 'task-switcher', cursor: 0 });
            break;
          case 'task-history':
            setOverlay({ kind: 'task-history', cursor: 0 });
            break;
          case 'resume-task': {
            const prompt = buildResumePrompt(selectedTaskId);
            if (prompt) {
              setInput(prompt);
              sayNotice(['Resume prompt staged below — edit if needed, Enter to send.']);
              setFocusZone('composer');
            } else {
              sayNotice(['No task to resume — describe a goal first.']);
            }
            closeOverlay();
            break;
          }
          case 'evidence':
            setOverlay({ kind: 'evidence', cursor: 0 });
            break;
          case 'deployments':
            setOverlay({ kind: 'deployments', cursor: 0 });
            break;
          case 'failure-repair':
            setOverlay({ kind: 'failure-repair', cursor: 0 });
            break;
          case 'execution-detail':
            setDetailExpanded(true);
            closeOverlay();
            break;
          case 'sessions':
            closeOverlay();
            void showInfo('sessions');
            break;
          case 'mcp':
            closeOverlay();
            void showInfo('mcp');
            break;
          case 'subs':
            closeOverlay();
            void showInfo('subs');
            break;
          case 'help':
            setOverlay({ kind: 'help', cursor: 0 });
            break;
          case 'quit':
            exit();
            break;
          default:
            closeOverlay();
        }
        return;
      }
      closeOverlay();
    },
    [buildResumePrompt, closeOverlay, exit, runtime, sayNotice, selectedTaskId, showInfo]
  );

  useInput((chunk, key) => {
    // Ctrl+<letter>: ink 7 reports the letter itself as the chunk (with
    // key.ctrl true); accept the raw control byte too for robustness.
    if (key.ctrl && !key.return && typeof chunk === 'string' && chunk.length === 1) {
      const code = chunk.charCodeAt(0);
      const controlKey =
        code >= 1 && code <= 26 ? String.fromCharCode(code + 96) : chunk.toLowerCase();
      if (controlKey === 't') {
        openOverlay('task-switcher');
        return;
      }
      if (controlKey === 'h') {
        openOverlay('task-history');
        return;
      }
      if (controlKey === 'e') {
        openOverlay('evidence');
        return;
      }
      if (controlKey === 'g') {
        openOverlay('deployments');
        return;
      }
      if (controlKey === 'f') {
        openOverlay('failure-repair');
        return;
      }
      if (controlKey === 'a') {
        openOverlay('action-menu');
        return;
      }
      if (controlKey === 'o') {
        setDetailExpanded((expanded) => !expanded);
        if (layoutModeRef.current === 'standard') {
          setNarrowView((view) => (view === 'detail' ? 'canvas' : 'detail'));
        }
        return;
      }
      return;
    }

    if (overlay) {
      const max = Math.max(0, overlayDataLength(overlay.kind) - 1);
      if (key.escape) {
        closeOverlay();
        return;
      }
      if (key.upArrow) {
        setOverlay({ ...overlay, cursor: Math.max(0, overlay.cursor - 1) });
        return;
      }
      if (key.downArrow) {
        setOverlay({ ...overlay, cursor: Math.min(max, overlay.cursor + 1) });
        return;
      }
      if (key.return) {
        void activateOverlay(overlay);
        return;
      }
      if (overlay.kind === 'task-switcher' && chunk?.toLowerCase() === 'r') {
        const summaries = runtime.taskSummaries();
        const summary = summaries[overlay.cursor];
        const prompt = buildResumePrompt(summary?.taskId);
        if (prompt) {
          setInput(prompt);
          sayNotice(['Resume prompt staged below — edit if needed, Enter to send.']);
        }
        setFocusZone('composer');
        closeOverlay();
        return;
      }
      return;
    }

    // `?` on an empty composer opens the key/command reference, from either
    // focus zone. Deliberately ahead of the printable-chunk guard below:
    // terminals deliver '?' as shift+'/', which that guard would drop.
    if (chunk === '?' && input.length === 0) {
      openOverlay('help');
      return;
    }

    if (key.tab) {
      const mode = layoutModeRef.current;
      if (mode === 'wide') {
        setFocusZone((zone) => (zone === 'composer' ? 'navigator' : 'composer'));
      } else {
        // Standard (two-pane): cycle what the canvas pane shows.
        setNarrowView((view) =>
          view === 'canvas' ? 'context' : view === 'context' ? 'detail' : 'canvas'
        );
        setDetailExpanded(false);
      }
      return;
    }

    if (focusZone === 'navigator') {
      const summaries = runtime.taskSummaries();
      const index = summaries.findIndex((s) => s.taskId === selectedTaskId);
      if (key.upArrow || key.downArrow) {
        const next = key.upArrow
          ? Math.max(0, index - 1)
          : Math.min(summaries.length - 1, index + 1);
        const summary = summaries[next];
        if (summary) setSelectedTaskId(summary.taskId);
        return;
      }
      if (key.return) {
        setFocusZone('composer');
        return;
      }
      if (key.escape) {
        setFocusZone('composer');
        return;
      }
      return;
    }

    // Composer focus.
    // Empty workspace + empty input: ↑↓ moves the example selection and
    // Enter loads it (so the fastest path to a first task is two keys).
    if (examplesActive && (key.upArrow || key.downArrow)) {
      setSelectedExample((current) => {
        const max = EMPTY_STATE_EXAMPLES.length - 1;
        if (current === undefined) return key.upArrow ? max : 0;
        return key.upArrow ? Math.max(0, current - 1) : Math.min(max, current + 1);
      });
      return;
    }
    if (key.return) {
      if (examplesActive && selectedExample !== undefined) {
        setInput(EMPTY_STATE_EXAMPLES[Math.min(selectedExample, EMPTY_STATE_EXAMPLES.length - 1)]);
        return;
      }
      void submit(input);
      return;
    }
    if (key.escape) {
      if (pastePreview !== undefined) {
        pasteRef.current.pending.length = 0;
        setPastePreview(undefined);
        setInput('');
        sayNotice(['Paste discarded.']);
        handle.notify();
        return;
      }
      if (abortRef.current) {
        abortRef.current.abort();
      }
      return;
    }
    // A staged paste owns the composer until confirmed (Enter) or dropped
    // (Esc): every other keystroke — including the paste echo ink re-delivers
    // without its ESC prefix — must neither leak into the input nor fire a
    // premature submit. Ref (not state): the paste listener and ink's input
    // handler fire within the same event, before the state update flushes.
    if (
      pastePreview !== undefined ||
      pasteRef.current.active ||
      pasteRef.current.pending.length > 0
    ) {
      return;
    }
    // Empty-state examples: 1/2/3 loads a ready-to-edit goal into the
    // composer (fastest path to the aha moment — see it become a task).
    // Only when the composer is EMPTY — never hijack digits inside a typed
    // command like "/rewind 1".
    if (
      input.length === 0 &&
      !store.run.running &&
      runtime.taskSummaries().length === 0 &&
      (chunk === '1' || chunk === '2' || chunk === '3')
    ) {
      setInput(EMPTY_STATE_EXAMPLES[Number(chunk) - 1]);
      return;
    }
    if (key.pageUp) {
      setScrollOffset((n) => Math.min(n + 10, Math.max(0, store.rows.length)));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((n) => Math.max(0, n - 10));
      return;
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1));
      return;
    }
    if (!chunk || key.ctrl || key.meta || key.shift || key.tab || key.upArrow || key.downArrow) {
      return;
    }
    if (chunk.startsWith('\x1b')) return;
    // Control characters inside a chunk: only the "one line + one trailing
    // break" shape ('/quit\r' merged by the terminal) is a typed submit.
    // Multi-line chunks are bracketed-paste content (ink strips the ESC[200~
    // marker before we see it) — the paste-capture confirmation flow owns
    // them; treating them as input would double-submit.
    const newlineIdx = chunk.search(/[\r\n]/);
    if (newlineIdx >= 0) {
      const head = chunk.slice(0, newlineIdx);
      const tail = chunk.slice(newlineIdx + 1);
      if (tail.length === 0 && head.length > 0 && !/[\r\n]/.test(head)) {
        const combined = input + head;
        setInput('');
        void submit(combined);
      }
      return;
    }
    setInput((v) => v + chunk);
  });

  // Bracketed-paste capture at the raw stdin level: ESC[200~…ESC[201~ is
  // staged for confirmation so one paste becomes ONE message with newlines
  // intact — never N accidental turns.
  useEffect(() => {
    if (!stdin) return;
    const onData = (chunk: Buffer | string) => {
      const disposition = feedChunk(pasteRef.current, chunk.toString('utf8'));
      if (disposition.completed) {
        const staged = pasteRef.current.pending[0] ?? '';
        setPastePreview(staged);
        setInput(
          `[paste: ${staged.split('\n').length} lines — Enter sends as one message, Esc discards]`
        );
        handle.notify();
      }
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin, handle]);

  // `||` (not `??`): a PTY without a negotiated winsize reports 0, which
  // would collapse every clip() to nothing — fall back to 80x24.
  const columns = stdout?.columns || 80;
  const rows = stdout?.rows || 24;
  const layout = computeLayout(columns, rows);
  layoutModeRef.current = layout.mode;

  const summaries = runtime.taskSummaries();
  const detail = runtime.taskDetail(selectedTaskId);
  const live = runtime.getLiveState();

  const renderLines = (lines: PanelLine[], keyPrefix: string): React.ReactElement[] =>
    lines.map((panelLine, i) =>
      React.createElement(
        Text,
        {
          key: `${keyPrefix}-${i}`,
          ...(panelLine.color ? { color: panelLine.color } : {}),
          ...(panelLine.bold ? { bold: true } : {}),
          ...(panelLine.dim ? { dimColor: true } : {}),
        },
        panelLine.text
      )
    );

  /** A bordered main-area panel; contents are clipped to width-2 by the
   * projections, so ink only needs the fixed Box geometry. */
  const panelBox = (
    lines: PanelLine[],
    key: string,
    width: number | undefined,
    accent: boolean
  ): React.ReactElement =>
    React.createElement(
      Box,
      {
        key,
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: accent ? 'cyan' : 'gray',
        ...(width !== undefined ? { width } : { flexGrow: 1 }),
        height: layout.bodyHeight,
      },
      ...renderLines(lines, key)
    );

  const padTo = (lines: PanelLine[]): PanelLine[] => {
    const filled = [...lines];
    while (filled.length < layout.contentHeight) filled.push(line0(''));
    return filled.slice(0, layout.contentHeight);
  };

  const transcriptPanelLines = (): PanelLine[] => {
    const lines = transcriptLines(store, scrollOffset, {
      height: layout.contentHeight,
    }).map((text) => line0(text));
    lines.push(
      ...renderExecutionDetailTail({
        toolLine: store.run.toolLine,
        streamingText: store.run.streamingText,
        width: layout.canvasWidth - 2,
        maxLines: 2,
      })
    );
    return padTo(lines);
  };

  const canvasPanelLines = (): PanelLine[] =>
    detailExpanded
      ? transcriptPanelLines()
      : padTo(
          renderCanvas({
            detail,
            summaries,
            selectedTaskId,
            width: layout.canvasWidth - 2,
            height: layout.contentHeight,
            detailExpanded,
            selectedExample: examplesActive ? selectedExample : undefined,
            workspace: {
              device: deviceSummary,
              tasks: summaries.length,
              evidence: runtime.getArtifacts().evidence.length,
              acceptance: runtime.getArtifacts().acceptance.length,
            },
          })
        );

  const navigatorPanelLines = (): PanelLine[] =>
    padTo(
      renderNavigator({
        summaries,
        selectedTaskId,
        focusTaskId: live.focusTaskId,
        width: layout.navigatorWidth - 2,
        height: layout.contentHeight,
      })
    );

  const contextPanelLines = (): PanelLine[] =>
    padTo(
      renderContextPanel({
        detail,
        width: layout.contextWidth - 2,
        height: layout.contentHeight,
      })
    );

  let mainArea: React.ReactElement;
  if (overlay) {
    const artifacts = runtime.getArtifacts();
    const overlayWidth = columns - 2;
    let overlayLines: PanelLine[];
    if (overlay.kind === 'task-switcher') {
      overlayLines = renderTaskSwitcher(
        summaries,
        overlay.cursor,
        selectedTaskId,
        overlayWidth,
        layout.contentHeight
      );
    } else if (overlay.kind === 'task-history') {
      overlayLines = renderTaskHistory(detail, overlayWidth, layout.contentHeight);
    } else if (overlay.kind === 'evidence') {
      overlayLines = renderEvidenceInspector(
        artifacts.evidence,
        overlay.cursor,
        overlayWidth,
        layout.contentHeight
      );
    } else if (overlay.kind === 'deployments') {
      overlayLines = renderDeploymentInspector(
        artifacts.deployments,
        overlay.cursor,
        overlayWidth,
        layout.contentHeight
      );
    } else if (overlay.kind === 'action-menu') {
      overlayLines = renderActionMenu(overlay.cursor, overlayWidth, layout.contentHeight);
    } else if (overlay.kind === 'help') {
      overlayLines = renderHelp(overlayWidth, layout.contentHeight);
    } else {
      overlayLines = renderFailureRepair(detail, overlayWidth, layout.contentHeight);
    }
    mainArea = panelBox(overlayLines, 'overlay', columns, true);
  } else if (layout.mode === 'standard') {
    // Two-pane IDE shell at the common width: navigator | main pane
    // (canvas ⇄ context ⇄ transcript via Tab).
    const width = layout.canvasWidth - 2;
    let mainLines: PanelLine[];
    if (narrowView === 'context') {
      mainLines = padTo(renderContextPanel({ detail, width, height: layout.contentHeight }));
    } else if (narrowView === 'detail' || detailExpanded) {
      mainLines = transcriptPanelLines();
    } else {
      mainLines = padTo(
        renderCanvas({
          detail,
          summaries,
          selectedTaskId,
          width,
          height: layout.contentHeight,
          detailExpanded: false,
          selectedExample: examplesActive ? selectedExample : undefined,
          workspace: {
            device: deviceSummary,
            tasks: summaries.length,
            evidence: runtime.getArtifacts().evidence.length,
            acceptance: runtime.getArtifacts().acceptance.length,
          },
        })
      );
    }
    mainArea = React.createElement(
      Box,
      { key: 'main-row', flexDirection: 'row', gap: 1 },
      panelBox(navigatorPanelLines(), 'nav', layout.navigatorWidth, focusZone === 'navigator'),
      panelBox(mainLines, 'main', undefined, false)
    );
  } else {
    const panels: React.ReactElement[] = [];
    if (layout.showNavigator) {
      panels.push(
        panelBox(navigatorPanelLines(), 'nav', layout.navigatorWidth, focusZone === 'navigator')
      );
    }
    panels.push(panelBox(canvasPanelLines(), 'canvas', undefined, false));
    if (layout.showContext) {
      panels.push(panelBox(contextPanelLines(), 'ctx', layout.contextWidth, false));
    }
    mainArea = React.createElement(
      Box,
      { key: 'main-row', flexDirection: 'row', gap: 1 },
      ...panels
    );
  }

  const approvalBanner = pendingApprovalRef.current
    ? renderApprovalBanner(pendingApprovalRef.current.question, columns)
    : [];

  // Live tail (≤2 lines) above the composer: streaming response / tool
  // progress stays visible without promoting the transcript to the main view.
  const liveTail = renderExecutionDetailTail({
    toolLine: store.run.toolLine,
    streamingText: store.run.streamingText,
    width: columns,
    maxLines: 2,
  });

  const statusWord = store.run.running ? 'RUNNING' : live.approvalPending ? 'BLOCKED' : 'READY';
  const statusColor: PanelColor = store.run.running
    ? 'yellow'
    : live.approvalPending
      ? 'magenta'
      : 'green';
  const deviceUnconfigured = deviceSummary.startsWith('not configured');
  const usageText = formatUsage(store.usage);

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(
      Text,
      { key: 'statusbar' },
      ...fitStatusBar(
        [
          { text: ' moss', bold: true, color: 'cyan' },
          { text: ` ${statusWord}`, bold: true, color: statusColor },
          // The key reference lives in the `?` overlay; the bar only advertises
          // it, early enough that a narrow terminal never drops it.
          { text: ' · ? help', dim: true },
          deviceUnconfigured
            ? { text: ' · ⚠ set MOSS_DEVICE_HOST in .env', bold: true, color: 'yellow' }
            : { text: ` · device ${deviceSummary}`, color: 'green' },
          ...(options.model ? [{ text: ` · ${options.model}` }] : []),
          {
            text: ` · ${usageText}${queueRef.current.length > 0 ? ` · queue:${queueRef.current.length}` : ''}`,
            dim: true,
          },
        ],
        columns
      )
    ),
    mainArea,
    ...renderLines(liveTail, 'tail'),
    ...renderLines(approvalBanner, 'approval'),
    ...notice
      .slice(0, 2)
      .map((text, i) =>
        React.createElement(Text, { key: `notice-${i}`, dimColor: true }, clip(text, columns))
      ),
    ...renderLines(
      renderInputLine(input, columns, input.length === 0 && !store.run.running),
      'input'
    ),
    examplesActive
      ? React.createElement(
          Text,
          { key: 'composer-hint', dimColor: true },
          clip('↑↓ pick an example · ↵ load it · or just type a goal and Enter', columns)
        )
      : null
  );
}

function line0(text: string): PanelLine {
  return { text };
}

/** Boot the TUI; resolves when the user quits. TTY-only entry point. */
export async function runTuiApp(options: TuiAppOptions): Promise<void> {
  const handle = createStoreHandle();
  const runtime = options.runtime ?? new TaskRuntime({ workspaceDir: options.workspaceDir });
  const instance = render(React.createElement(TuiAppRoot, { options, handle, runtime }), {
    exitOnCtrlC: true,
  });
  await instance.waitUntilExit();
}
