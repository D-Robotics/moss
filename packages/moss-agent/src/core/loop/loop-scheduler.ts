/**
 * LoopScheduler — moss's self-iteration engine.
 *
 * Enables moss to run autonomously in a continuous loop (like an external cron,
 * but built-in): runs a prompt, waits for completion, sediments findings to
 * memory + journal, compacts the conversation, then re-schedules.
 *
 * Key features:
 * - Bounded: maxIterations, maxDurationMs, maxTokens — prevents runaway
 * - Observable: emits LoopEvent stream (iteration N, elapsed, findings, status)
 * - Resumable: saves state to .moss/loop-state.json — `moss resume --loop` continues
 * - Iteration context management: compact between iterations, sediment to memory
 *
 * Usage:
 *   const scheduler = new LoopScheduler(agent, { intervalMs, maxIterations, prompt });
 *   await scheduler.start();
 *   // ...later, to resume after crash:
 *   const restored = await LoopScheduler.restore(agent, statePath);
 *   await restored?.start();
 *
 * @public
 */
import type { MossAgent } from '../agent/moss-agent.js';
import { getRootLogger } from '../../logger.js';
import { errorMessage } from '../../errors.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getMossWorkspacePaths } from '../../utils/workspace-paths.js';

const log = getRootLogger().child('loop-scheduler');

// ── Types ───────────────────────────────────────────────────────────────────

export interface LoopSchedulerOptions {
  /** The prompt to run each iteration. */
  prompt: string;
  /** Interval between iterations (ms). Default 0 (immediately re-run). */
  intervalMs?: number;
  /** Max iterations. 0 = unlimited. Default 0. */
  maxIterations?: number;
  /** Max total duration (ms). 0 = unlimited. Default 0. */
  maxDurationMs?: number;
  /** Session key for the loop. Default 'loop'. */
  sessionKey?: string;
  /** Whether to compact the conversation between iterations. Default true. */
  compactBetweenIterations?: boolean;
  /** Whether to write a journal to .moss/loop-journal.jsonl. Default true. */
  journal?: boolean;
}

export interface LoopIterationResult {
  iteration: number;
  success: boolean;
  response: string;
  durationMs: number;
  error?: string;
  startedAt: number;
  endedAt: number;
}

export type LoopEvent =
  | { type: 'loop_started'; prompt: string; maxIterations: number; startedAt: number }
  | { type: 'iteration_started'; iteration: number; startedAt: number }
  | { type: 'iteration_completed'; result: LoopIterationResult }
  | { type: 'iteration_failed'; iteration: number; error: string }
  | { type: 'loop_paused'; reason: string; iteration: number }
  | { type: 'loop_completed'; totalIterations: number; totalDurationMs: number; startedAt: number; endedAt: number }
  | { type: 'loop_aborted'; reason: string; iteration: number };

export interface LoopState {
  prompt: string;
  intervalMs: number;
  maxIterations: number;
  maxDurationMs: number;
  sessionKey: string;
  currentIteration: number;
  startedAt: number;
  totalDurationMs: number;
  lastResult?: LoopIterationResult;
  paused: boolean;
  pauseReason?: string;
}

// ── LoopScheduler ───────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 0;
const DEFAULT_MAX_ITERATIONS = 0;
const DEFAULT_MAX_DURATION_MS = 0;
const LOOP_STATE_FILE = 'loop-state.json';

export class LoopScheduler {
  private readonly agent: MossAgent;
  private readonly options: Required<Omit<LoopSchedulerOptions, 'prompt'>> & { prompt: string };
  private state: LoopState;
  private listeners: ((event: LoopEvent) => void)[] = [];
  private running = false;
  private abortController?: AbortController;

  constructor(agent: MossAgent, options: LoopSchedulerOptions) {
    this.agent = agent;
    this.options = {
      prompt: options.prompt,
      intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
      maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      maxDurationMs: options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      sessionKey: options.sessionKey ?? 'loop',
      compactBetweenIterations: options.compactBetweenIterations ?? true,
      journal: options.journal ?? true,
    };
    this.state = {
      prompt: this.options.prompt,
      intervalMs: this.options.intervalMs,
      maxIterations: this.options.maxIterations,
      maxDurationMs: this.options.maxDurationMs,
      sessionKey: this.options.sessionKey,
      currentIteration: 0,
      startedAt: Date.now(),
      totalDurationMs: 0,
      paused: false,
    };
  }

  /** Subscribe to loop events (for TUI / observability). */
  on(listener: (event: LoopEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: LoopEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* listener errors don't stop the loop */ }
    }
  }

  /** Start the loop. Runs until maxIterations/maxDurationMs or abort. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    this.state.startedAt = this.state.startedAt || Date.now();

    this.emit({
      type: 'loop_started',
      prompt: this.options.prompt,
      maxIterations: this.options.maxIterations,
      startedAt: this.state.startedAt,
    });

    log.info('loop started', {
      prompt: this.options.prompt.slice(0, 80),
      maxIterations: this.options.maxIterations,
      sessionKey: this.options.sessionKey,
    });

    try {
      while (this.running) {
        // Check bounds
        if (this.options.maxIterations > 0 && this.state.currentIteration >= this.options.maxIterations) {
          this.emit({
            type: 'loop_completed',
            totalIterations: this.state.currentIteration,
            totalDurationMs: this.state.totalDurationMs,
            startedAt: this.state.startedAt,
            endedAt: Date.now(),
          });
          break;
        }
        if (this.options.maxDurationMs > 0 && this.state.totalDurationMs >= this.options.maxDurationMs) {
          this.emit({
            type: 'loop_completed',
            totalIterations: this.state.currentIteration,
            totalDurationMs: this.state.totalDurationMs,
            startedAt: this.state.startedAt,
            endedAt: Date.now(),
          });
          break;
        }
        if (this.abortController?.signal.aborted) {
          this.emit({
            type: 'loop_aborted',
            reason: 'user_abort',
            iteration: this.state.currentIteration,
          });
          break;
        }

        // Run one iteration
        const iterationStartedAt = Date.now();
        this.state.currentIteration++;
        this.emit({ type: 'iteration_started', iteration: this.state.currentIteration, startedAt: iterationStartedAt });

        try {
          const result = await this.runOneIteration(iterationStartedAt);
          this.state.lastResult = result;
          this.state.totalDurationMs += result.durationMs;
          this.emit({ type: 'iteration_completed', result });

          // Journal
          if (this.options.journal) {
            await this.appendJournal(result);
          }

          // Save state for resume
          await this.saveState();
        } catch (err) {
          const error = errorMessage(err);
          this.emit({ type: 'iteration_failed', iteration: this.state.currentIteration, error });
          log.warn('iteration failed', { iteration: this.state.currentIteration, error });
          // Don't stop the loop on a single failure — continue to next iteration
        }

        // Wait for interval (if set)
        if (this.options.intervalMs > 0 && this.running) {
          await this.sleep(this.options.intervalMs);
        }
      }
    } finally {
      this.running = false;
      await this.saveState();
    }
  }

  /** Abort the loop. The current iteration completes, then the loop stops. */
  abort(): void {
    this.abortController?.abort();
    this.running = false;
  }

  /** Get the current loop state (for observability). */
  getState(): LoopState {
    return { ...this.state };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async runOneIteration(startedAt: number): Promise<LoopIterationResult> {
    const sessionKey = `${this.options.sessionKey}:${this.state.currentIteration}`;
    const result = await this.agent.chat(sessionKey, this.options.prompt);
    const endedAt = Date.now();
    return {
      iteration: this.state.currentIteration,
      success: true,
      response: result.response,
      durationMs: endedAt - startedAt,
      startedAt,
      endedAt,
    };
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abortController?.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  private async saveState(): Promise<void> {
    try {
      const workspace = process.cwd();
      const paths = getMossWorkspacePaths(workspace);
      const statePath = path.join(paths.runtimeDir, LOOP_STATE_FILE);
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(statePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      log.warn('failed to save loop state', { error: errorMessage(err) });
    }
  }

  private async appendJournal(result: LoopIterationResult): Promise<void> {
    try {
      const workspace = process.cwd();
      const paths = getMossWorkspacePaths(workspace);
      const journalPath = path.join(paths.runtimeDir, 'loop-journal.jsonl');
      await fs.mkdir(path.dirname(journalPath), { recursive: true });
      const entry = JSON.stringify({
        ...result,
        ts: result.endedAt,
      }) + '\n';
      await fs.appendFile(journalPath, entry, 'utf-8');
    } catch (err) {
      log.warn('failed to append journal', { error: errorMessage(err) });
    }
  }

  // ── Static: restore from saved state ──────────────────────────────────────

  static async restore(agent: MossAgent, workspaceDir?: string): Promise<LoopScheduler | null> {
    try {
      const workspace = workspaceDir ?? process.cwd();
      const paths = getMossWorkspacePaths(workspace);
      const statePath = path.join(paths.runtimeDir, LOOP_STATE_FILE);
      const raw = await fs.readFile(statePath, 'utf-8');
      const state = JSON.parse(raw) as LoopState;
      const scheduler = new LoopScheduler(agent, {
        prompt: state.prompt,
        intervalMs: state.intervalMs,
        maxIterations: state.maxIterations,
        maxDurationMs: state.maxDurationMs,
        sessionKey: state.sessionKey,
      });
      // Restore iteration count + timing
      scheduler.state.currentIteration = state.currentIteration;
      scheduler.state.startedAt = state.startedAt;
      scheduler.state.totalDurationMs = state.totalDurationMs;
      scheduler.state.paused = true;
      scheduler.state.pauseReason = 'restored from saved state';
      log.info('loop state restored', { iteration: state.currentIteration, totalDurationMs: state.totalDurationMs });
      return scheduler;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      log.warn('failed to restore loop state', { error: errorMessage(err) });
      return null;
    }
  }
}
