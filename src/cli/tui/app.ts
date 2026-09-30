/**
 * moss full-screen TUI (v0.17) — the interactive face for TTY sessions.
 *
 * This module (and only this directory) statically imports ink/react; every
 * entry point must dynamically import it so headless/SDK paths never load UI
 * dependencies. Non-TTY or `--no-tty` sessions fall back to the readline REPL.
 *
 * v0.17 surface: full-screen transcript with PgUp/PgDn scrollback, Esc
 * interrupt at run boundaries, bracketed-paste staging (one paste = one
 * message), resume replay rows, and an honest minimal command surface
 * (/help, /quit — the rest lands with the v0.18 control plane).
 *
 * The input line is a minimal ink `useInput` editor (append + backspace +
 * return) rather than ink-text-input: full control over paste/return events
 * across ink versions, and it is deterministic under ink-testing-library.
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { render, Text, Box, useApp, useInput, useStdin } from 'ink';
import type { MossAgent } from '../../core/agent/moss-agent.js';
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
import { renderStatusBar } from './status-bar.js';
import {
  listBackgroundProcessSnapshots,
  type BackgroundProcSnapshot,
} from '../../core/tools/background-process-registry.js';
import { transcriptLines } from './transcript-view.js';

const TRANSCRIPT_HEIGHT = 14;

export const TUI_HELP_TEXT = [
  'moss TUI — keys: Enter send · Esc interrupt run (or discard staged paste) · PgUp/PgDn scroll',
  'commands: /help · /quit (the full command surface lands with the v0.18 control plane)',
].join('\n');

export interface TuiReplayRow {
  kind: TranscriptRowKind;
  text: string;
}

export interface TuiAppOptions {
  agent: MossAgent;
  workspaceDir: string;
  sessionKey?: string;
  model?: string;
  /** Transcript rows replayed on boot (resume). */
  replayRows?: TuiReplayRow[];
}

export function buildTuiHelpText(): string {
  return TUI_HELP_TEXT;
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

export function TuiAppRoot({
  options,
  handle,
}: {
  options: TuiAppOptions;
  handle: StoreHandle;
}): React.ReactElement {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  const [input, setInput] = useState('');
  const [scrollOffset, setScrollOffset] = useState(0);
  const [pastePreview, setPastePreview] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const queueRef = useRef<{ text: string; kind: 'prompt' }[]>([]);
  const queuePausedRef = useRef(false);
  const [queuePaused, setQueuePaused] = useState(false);
  const [queueRevision, setQueueRevision] = useState(0);
  void queueRevision;
  const pasteRef = useRef(createPasteCapture());
  const sessionKey = options.sessionKey ?? 'tui';
  const { store } = handle;

  useEffect(() => handle.subscribe(forceUpdate), [handle, forceUpdate]);

  // Boot banner + resume replay rows land in the transcript on mount.
  useEffect(() => {
    appendRow(store, 'banner', 'moss TUI (v0.17) — /help for keys');
    for (const row of options.replayRows ?? []) {
      appendRow(store, row.kind, row.text);
    }
    if (options.replayRows?.length) {
      appendRow(store, 'banner', `Resumed — replayed ${options.replayRows.length} rows above.`);
    }
    handle.notify();
  }, []);

  const runTurn = useCallback(
    async (message: string) => {
      beginRun(store);
      handle.notify();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        for await (const event of options.agent.streamChat(sessionKey, message, {
          abortSignal: controller.signal,
        })) {
          applyAgentEvent(store, event);
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
        }
      }
      abortRef.current = undefined;
      const halted = controller.signal.aborted;
      endRun(store, halted);
      if (halted) {
        appendRow(store, 'banner', 'Run halted at a safe boundary — you can continue.');
      }
      handle.notify();
    },
    [handle, options.agent, sessionKey, store]
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

  const submit = useCallback(
    (raw: string) => {
      if (pastePreview !== undefined) {
        // A paste is staged: this Enter confirms it as ONE message.
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
      if (text === '/quit' || text === '/exit') {
        exit();
        return;
      }
      if (text === '/help') {
        appendRow(store, 'banner', buildTuiHelpText());
        handle.notify();
        setInput('');
        return;
      }
      if (text === '/usage') {
        appendRow(store, 'banner', `tokens: ${formatUsage(store.usage)}`);
        handle.notify();
        setInput('');
        return;
      }
      if (text === '/bg') {
        const running = listBackgroundProcessSnapshots().filter(
          (p: BackgroundProcSnapshot) => p.status === 'running'
        );
        appendRow(
          store,
          'banner',
          running.length === 0
            ? 'No background tasks running.'
            : running
                .map((p) => `#${p.id} ${p.command}${p.label ? ` (${p.label})` : ''}`)
                .join('\n')
        );
        handle.notify();
        setInput('');
        return;
      }
      if (text === '/queue' || text.startsWith('/queue ')) {
        const sub = text.split(' ')[1] ?? 'list';
        if (sub === 'pause') {
          queuePausedRef.current = true;
          setQueuePaused(true);
          appendRow(store, 'banner', 'Queue paused — new submissions wait.');
        } else if (sub === 'resume') {
          queuePausedRef.current = false;
          setQueuePaused(false);
          appendRow(store, 'banner', 'Queue resumed.');
          if (!store.run.running && queueRef.current.length > 0) void drainQueue();
        } else if (sub === 'drop') {
          const dropped = queueRef.current.shift();
          appendRow(
            store,
            'banner',
            dropped ? `Dropped: ${dropped.text.slice(0, 60)}` : 'Queue empty — nothing to drop.'
          );
          setQueueRevision((n) => n + 1);
        } else if (sub === 'clear') {
          const n = queueRef.current.length;
          queueRef.current.length = 0;
          setQueueRevision((n2) => n2 + 1);
          appendRow(store, 'banner', `Cleared ${n} queued item${n === 1 ? '' : 's'}.`);
        } else {
          const items = queueRef.current
            .map((q, i) => `${i + 1}. ${q.text.slice(0, 60)}`)
            .join('\n');
          appendRow(
            store,
            'banner',
            items ? `Queue (${queuePaused ? 'paused' : 'active'}):\n${items}` : 'Queue empty.'
          );
        }
        handle.notify();
        setInput('');
        return;
      }
      if (text.startsWith('/steer')) {
        const constraint = text.slice('/steer'.length).trim();
        if (!constraint) {
          appendRow(store, 'banner', 'Usage: /steer <constraint> — injects at the next boundary.');
        } else {
          const entry = options.agent.steer?.(sessionKey, constraint);
          appendRow(
            store,
            'banner',
            entry === null || entry === undefined
              ? 'Steer rejected — no single active run on this session.'
              : `Steer queued: ${constraint.slice(0, 80)}`
          );
        }
        handle.notify();
        setInput('');
        return;
      }
      if (text.startsWith('/')) {
        appendRow(
          store,
          'banner',
          `Unknown command "${text.split(' ')[0]}" in the TUI. ${buildTuiHelpText().split('\n')[1]}`
        );
        handle.notify();
        setInput('');
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
        handle.notify();
        setInput('');
        return;
      }
      setScrollOffset(0);
      appendRow(store, 'user', text);
      handle.notify();
      setInput('');
      void runTurn(text);
    },
    [exit, handle, pastePreview, runTurn, store]
  );

  useInput((chunk, key) => {
    if (key.return) {
      submit(input);
      return;
    }
    if (key.escape) {
      if (pastePreview !== undefined) {
        pasteRef.current.pending.length = 0;
        setPastePreview(undefined);
        setInput('');
        appendRow(store, 'banner', 'Paste discarded.');
        handle.notify();
        return;
      }
      if (abortRef.current) {
        abortRef.current.abort();
      }
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
    // Escape-sequence payloads (bracketed-paste markers reach here as raw
    // bytes on some ink versions) are handled at the stdin layer below.
    if (chunk.startsWith('\x1b')) return;
    if (chunk === '\n') return;
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

  const lines = transcriptLines(store, scrollOffset, { height: TRANSCRIPT_HEIGHT });
  const statusLine = `${renderStatusBar({
    model: options.model,
    workspace: options.workspaceDir,
    running: store.run.running,
    scrollOffset,
    halted: store.run.halted,
  })} · ${formatUsage(store.usage)}${
    queueRef.current.length ? ` · queue:${queueRef.current.length}` : ''
  }${queuePaused ? ' (paused)' : ''}`;

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    ...lines.map((line, i) => React.createElement(Text, { key: `line-${i}` }, line)),
    store.run.streamingText
      ? React.createElement(Text, { dimColor: true }, store.run.streamingText)
      : null,
    store.run.toolLine ? React.createElement(Text, { dimColor: true }, store.run.toolLine) : null,
    React.createElement(Text, { color: store.run.running ? 'yellow' : 'green' }, statusLine),
    React.createElement(
      Box,
      {},
      React.createElement(Text, { color: 'cyan' }, '› '),
      React.createElement(Text, null, input),
      React.createElement(Text, { color: 'cyan' }, '▌')
    )
  );
}

/** Boot the TUI; resolves when the user quits. TTY-only entry point. */
export async function runTuiApp(options: TuiAppOptions): Promise<void> {
  const handle = createStoreHandle();
  const instance = render(React.createElement(TuiAppRoot, { options, handle }), {
    exitOnCtrlC: true,
  });
  await instance.waitUntilExit();
}
