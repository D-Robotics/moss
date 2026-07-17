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
 * - Resumable: saves state to .moss/loop-state.json for the CLI or SDK to continue
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
import { logLLMUsage } from '../../observability/llm-usage.js';

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
  /**
   * Whether to compact the conversation between iterations.
   * Currently declared but not implemented — each iteration uses an isolated
   * sessionKey so there is no shared context to compact. Kept for future use.
   * Default true.
   */
  compactBetweenIterations?: boolean;
  /** Whether to write a journal to .moss/loop-journal.jsonl. Default true. */
  journal?: boolean;
  /**
   * Autonomous mode: after each iteration, the scheduler asks the model whether
   * the goal is complete. If not, the model provides the next sub-task prompt;
   * the loop continues autonomously until the model signals completion or
   * maxIterations is reached. Default false (legacy: re-run the same prompt).
   */
  autonomous?: boolean;
  /** Consecutive iteration failures before pausing. Default 5. */
  maxConsecutiveFailures?: number;
  /**
   * Optional callback to receive streaming events from each iteration.
   * Provides real-time streaming output (text_delta, tool_start/end, etc.)
   * so TUI / REPL can show the agent working live rather than waiting for
   * iteration completion.
   */
  onIterationEvent?: (event: import('../index.js').MossAgentEvent) => void;
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
  currentPrompt?: string;
  intervalMs: number;
  maxIterations: number;
  maxDurationMs: number;
  maxConsecutiveFailures?: number;
  sessionKey: string;
  compactBetweenIterations?: boolean;
  journal?: boolean;
  autonomous?: boolean;
  currentIteration: number;
  startedAt: number;
  totalDurationMs: number;
  lastResult?: LoopIterationResult;
  paused: boolean;
  pauseReason?: string;
  status?: 'running' | 'paused' | 'completed';
}

export interface LoopRestoreOptions {
  onIterationEvent?: LoopSchedulerOptions['onIterationEvent'];
  maxIterations?: number;
}

// ── LoopScheduler ───────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 0;
const DEFAULT_MAX_ITERATIONS = 0;
const DEFAULT_MAX_DURATION_MS = 0;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const LOOP_STATE_FILE = 'loop-state.json';

export class LoopScheduler {
  private readonly agent: MossAgent;
  private readonly options: Required<Omit<LoopSchedulerOptions, 'prompt' | 'onIterationEvent'>> & {
    prompt: string;
    onIterationEvent?: LoopSchedulerOptions['onIterationEvent'];
  };
  private state: LoopState;
  private listeners: ((event: LoopEvent) => void)[] = [];
  private running = false;
  private consecutiveFailures = 0;
  private abortController?: AbortController;
  /**
   * In autonomous mode, the prompt for the current iteration. Starts as the
   * original goal; after each iteration, `checkCompletion` may replace it with
   * a model-generated continuation prompt for the next sub-task.
   */
  private currentPrompt: string;
  private activeSessionKey?: string;
  private steeringRevision = 0;
  private workspaceDir = process.cwd();
  private resumePending = false;

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
      autonomous: options.autonomous ?? false,
      maxConsecutiveFailures:
        options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
      onIterationEvent: options.onIterationEvent,
    };
    this.currentPrompt = this.options.prompt;
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
      status: 'paused',
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
    if (!this.resumePending) {
      this.state.currentIteration = 0;
      this.state.totalDurationMs = 0;
      this.state.startedAt = Date.now();
      this.currentPrompt = this.options.prompt;
    }
    this.resumePending = false;
    this.state.paused = false;
    this.state.pauseReason = undefined;
    this.state.status = 'running';
    this.consecutiveFailures = 0;

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
      while (true) {
        // Check abort (from abort() call or signal) — must be FIRST so that
        // an abort triggered during an event listener is caught before the
        // next iteration starts.
        if (!this.running || this.abortController?.signal.aborted) {
          this.state.paused = true;
          this.state.pauseReason = 'stopped by user';
          this.state.status = 'paused';
          this.emit({
            type: 'loop_aborted',
            reason: 'user_abort',
            iteration: this.state.currentIteration,
          });
          break;
        }
        // Check bounds
        if (this.options.maxIterations > 0 && this.state.currentIteration >= this.options.maxIterations) {
          const reason = `Paused at the configured iteration limit (${this.options.maxIterations}).`;
          this.state.paused = true;
          this.state.pauseReason = reason;
          this.state.status = 'paused';
          this.emit({ type: 'loop_paused', reason, iteration: this.state.currentIteration });
          break;
        }
        if (this.options.maxDurationMs > 0 && this.state.totalDurationMs >= this.options.maxDurationMs) {
          const reason = `Paused at the configured duration limit (${this.options.maxDurationMs}ms).`;
          this.state.paused = true;
          this.state.pauseReason = reason;
          this.state.status = 'paused';
          this.emit({ type: 'loop_paused', reason, iteration: this.state.currentIteration });
          break;
        }

        // Run one iteration
        const iterationStartedAt = Date.now();
        this.state.currentIteration++;
        this.emit({ type: 'iteration_started', iteration: this.state.currentIteration, startedAt: iterationStartedAt });

        try {
          const result = await this.runOneIteration(iterationStartedAt);
          this.consecutiveFailures = 0;
          this.state.lastResult = result;
          this.state.totalDurationMs += result.durationMs;
          this.emit({ type: 'iteration_completed', result });

          // Journal
          if (this.options.journal) {
            await this.appendJournal(result);
          }

          // Save state for resume
          await this.saveState();

          // Autonomous completion check: ask the model if the goal is done.
          // If done, emit loop_completed and break. If not, update currentPrompt
          // for the next iteration and continue autonomously.
          if (this.options.autonomous && this.running && !this.abortController?.signal.aborted) {
            const steeringRevision = this.steeringRevision;
            const completion = await this.checkCompletion(
              this.options.prompt,
              result.response,
              this.state.currentIteration
            );
            if (this.steeringRevision !== steeringRevision) {
              await this.saveState();
              continue;
            }
            if (completion.done) {
              this.state.status = 'completed';
              await this.saveState();
              this.emit({
                type: 'loop_completed',
                totalIterations: this.state.currentIteration,
                totalDurationMs: this.state.totalDurationMs,
                startedAt: this.state.startedAt,
                endedAt: Date.now(),
              });
              break;
            }
            // Model says not done — use its suggested next step as the next prompt
            if (completion.nextPrompt) {
              this.currentPrompt = completion.nextPrompt;
              this.state.currentPrompt = completion.nextPrompt;
              await this.saveState();
            }
          }
        } catch (err) {
          if (this.abortController?.signal.aborted) {
            this.state.currentIteration--;
            this.state.paused = true;
            this.state.pauseReason = 'stopped by user';
            this.state.status = 'paused';
            this.emit({
              type: 'loop_aborted',
              reason: 'user_abort',
              iteration: this.state.currentIteration,
            });
            break;
          }
          const error = errorMessage(err);
          this.emit({ type: 'iteration_failed', iteration: this.state.currentIteration, error });
          log.warn('iteration failed', { iteration: this.state.currentIteration, error });
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= this.options.maxConsecutiveFailures) {
            const reason = `Paused after ${this.consecutiveFailures} consecutive failures. Last error: ${error}`;
            this.state.paused = true;
            this.state.pauseReason = reason;
            this.state.status = 'paused';
            this.emit({ type: 'loop_paused', reason, iteration: this.state.currentIteration });
            log.warn('loop paused after consecutive failures', {
              consecutiveFailures: this.consecutiveFailures,
              iteration: this.state.currentIteration,
              error,
            });
            break;
          }
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

  /** Abort the active agent run and preserve the last completed iteration. */
  abort(): void {
    this.abortController?.abort();
    this.running = false;
  }

  /** Get the current loop state (for observability). */
  getState(): LoopState {
    return { ...this.state };
  }

  getActiveSessionKey(): string | undefined {
    return this.activeSessionKey;
  }

  /** Update the active loop now, or its next iteration at the next safe boundary. */
  steer(prompt: string): boolean {
    const constraint = prompt.trim();
    if (!this.running || !constraint) return false;

    this.currentPrompt = constraint;
    this.state.currentPrompt = constraint;
    this.steeringRevision++;
    void this.saveState().catch((err) => {
      log.warn('failed to persist loop steering update', { error: errorMessage(err) });
    });

    if (this.activeSessionKey) {
      this.agent.steer(this.activeSessionKey, constraint);
    }
    return true;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async runOneIteration(startedAt: number): Promise<LoopIterationResult> {
    const sessionKey = `${this.options.sessionKey}:${this.state.currentIteration}`;
    const iterationPrompt = this.buildIterationPrompt();
    this.activeSessionKey = sessionKey;
    try {
      // Prefer streamChat so hosts that pass onIterationEvent see live tool/text
      // output (Claude Code / goal auto-run UX). Prefer the terminal
      // done.result.response when present — text_delta alone can be empty if
      // the provider buffers or only emits a final message.
      // Fall back to chat() for lightweight test doubles / older host shims.
      const onEvent = this.options.onIterationEvent;
      let response: string;
      const agentAny = this.agent as MossAgent & {
        streamChat?: (
          sessionKey: string,
          prompt: string,
          options?: { abortSignal?: AbortSignal }
        ) => AsyncIterable<import('../index.js').MossAgentEvent>;
        chat?: (
          sessionKey: string,
          prompt: string,
          options?: { abortSignal?: AbortSignal }
        ) => Promise<{ response: string }>;
      };

      if (typeof agentAny.streamChat === 'function') {
        let accText = '';
        let doneResponse: string | undefined;
        for await (const event of agentAny.streamChat(sessionKey, iterationPrompt, {
          abortSignal: this.abortController?.signal,
        })) {
          onEvent?.(event);
          if (event.type === 'text_delta') accText += event.delta;
          if (event.type === 'done') {
            const r = event.result?.response;
            if (typeof r === 'string' && r.trim()) doneResponse = r;
          }
        }
        response = (doneResponse && doneResponse.trim()) || accText;
      } else if (typeof agentAny.chat === 'function') {
        const result = await agentAny.chat(sessionKey, iterationPrompt, {
          abortSignal: this.abortController?.signal,
        });
        response = result.response;
      } else {
        throw new Error('LoopScheduler agent must implement streamChat or chat');
      }

      if (this.abortController?.signal.aborted) {
        throw new Error('Loop iteration aborted by user');
      }
      const endedAt = Date.now();
      return {
        iteration: this.state.currentIteration,
        success: true,
        response,
        durationMs: endedAt - startedAt,
        startedAt,
        endedAt,
      };
    } finally {
      if (this.activeSessionKey === sessionKey) this.activeSessionKey = undefined;
    }
  }

  private buildIterationPrompt(): string {
    if (!this.options.autonomous) return this.currentPrompt;
    const previous = this.state.lastResult?.response.trim();
    return [
      '<moss_autonomous_loop_context>',
      `Original goal: ${this.options.prompt}`,
      `Iteration: ${this.state.currentIteration}`,
      `Current focus: ${this.currentPrompt}`,
      previous
        ? `Previous iteration evidence:\n${previous.slice(-6000)}`
        : 'Previous iteration evidence: none — this is the first iteration.',
      '',
      'Work only toward the original goal. Treat the current focus as the next step, not as a replacement goal.',
      'Inspect the current state before acting. Do not redo work already proven complete by the previous evidence.',
      'Match verification to the goal: a review/proposal task can finish with evidence-backed findings; an implementation task requires the requested changes and relevant verification.',
      'End with a concise status that states whether the original goal is complete and what evidence proves it.',
      '</moss_autonomous_loop_context>',
    ].join('\n');
  }

  /**
   * Ask the model whether the overall goal is complete. In autonomous mode this
   * runs after each iteration; if the model says the goal is NOT done, it also
   * provides a continuation prompt for the next sub-task.
   *
   * Returns `{ done: true }` when the goal is achieved, or `{ done: false,
   * nextPrompt }` with the model-suggested next step.
   */
  private async checkCompletion(
    goal: string,
    lastResponse: string,
    iteration: number
  ): Promise<{ done: boolean; nextPrompt?: string }> {
    const provider = this.agent.config.llmProvider;
    const model = this.agent.config.model ?? 'moss-default';
    const startedAt = Date.now();
    const checkPrompt = [
      `You are a task-completion judge for an autonomous agent loop.`,
      ``,
      `Original goal: ${goal}`,
      `Current user steering focus: ${this.currentPrompt}`,
      ``,
      `Latest iteration result (iteration ${iteration}):`,
      lastResponse.slice(0, 4000),
      ``,
      `Judge completion against the requested outcome, not against a generic coding workflow.`,
      `For review, research, explanation, or proposal goals, evidence-backed findings can be complete without editing files.`,
      `For implementation goals, require the requested behavior change plus relevant verification.`,
      `If the iteration explicitly reports completion with concrete verification evidence that matches the goal, accept it unless the evidence contradicts itself.`,
      ``,
      `Has the original goal been FULLY achieved? Reply in EXACTLY one of these two formats:`,
      `1. If done: DONE`,
      `2. If not done: CONTINUE: <one-sentence description of what the agent should do next>`,
    ].join('\n');
    try {
      const response = await provider.complete({
        model,
        systemPrompt: 'You are a concise task-completion judge. Reply only with DONE or CONTINUE: <next step>.',
        messages: [{ role: 'user', content: checkPrompt }],
        maxTokens: 200,
        abortSignal: this.abortController?.signal,
      });
      if (this.agent.config.recordLlmUsage) {
        await this.recordCompletionUsage({
          runId: `${this.options.sessionKey}:judge:${iteration}`,
          providerId: provider.id,
          model,
          inputTokens: response.usage?.inputTokens ?? 0,
          outputTokens: response.usage?.outputTokens ?? 0,
          cacheReadTokens: response.usage?.cacheReadTokens,
          cacheCreationTokens: response.usage?.cacheCreationTokens,
          durationMs: Date.now() - startedAt,
          success: true,
        });
      }
      const text = response.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (/^DONE\b/i.test(text)) return { done: true };
      const contMatch = text.match(/^CONTINUE:\s*(.+)/i);
      if (contMatch?.[1]) {
        return { done: false, nextPrompt: contMatch[1].trim() };
      }
      // A missing or malformed verdict is not evidence of completion.
      return { done: false, nextPrompt: 'Continue working toward the goal and verify completion with concrete evidence.' };
    } catch (err) {
      if (this.agent.config.recordLlmUsage) {
        await this.recordCompletionUsage({
          runId: `${this.options.sessionKey}:judge:${iteration}`,
          providerId: provider.id,
          model,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: Date.now() - startedAt,
          success: false,
          error: errorMessage(err),
        });
      }
      // If the completion check fails, be conservative: continue the loop.
      return { done: false, nextPrompt: 'Continue working toward the goal.' };
    }
  }

  private async recordCompletionUsage(
    record: Parameters<typeof logLLMUsage>[0]
  ): Promise<void> {
    try {
      await logLLMUsage(record, { logPath: this.agent.config.llmUsageLogPath });
    } catch (err) {
      log.warn('failed to record loop completion usage', { error: errorMessage(err) });
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const onTimeout = () => {
        if (settled) return;
        settled = true;
        // Remove the abort listener on the normal timeout path — without this,
        // every sleep() leaks one listener on the AbortSignal (found by moss
        // self-iteration). { once: true } only auto-removes if abort FIRES.
        this.abortController?.signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(onTimeout, ms);
      this.abortController?.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async saveState(): Promise<void> {
    try {
      this.state.currentPrompt = this.currentPrompt;
      this.state.maxConsecutiveFailures = this.options.maxConsecutiveFailures;
      this.state.compactBetweenIterations = this.options.compactBetweenIterations;
      this.state.journal = this.options.journal;
      this.state.autonomous = this.options.autonomous;
      const paths = getMossWorkspacePaths(this.workspaceDir);
      const statePath = path.join(paths.runtimeDir, LOOP_STATE_FILE);
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(statePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      log.warn('failed to save loop state', { error: errorMessage(err) });
    }
  }

  private async appendJournal(result: LoopIterationResult): Promise<void> {
    try {
      const paths = getMossWorkspacePaths(this.workspaceDir);
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

  static async restore(
    agent: MossAgent,
    workspaceDir?: string,
    options: LoopRestoreOptions = {}
  ): Promise<LoopScheduler | null> {
    try {
      const workspace = workspaceDir ?? process.cwd();
      const paths = getMossWorkspacePaths(workspace);
      const statePath = path.join(paths.runtimeDir, LOOP_STATE_FILE);
      const raw = await fs.readFile(statePath, 'utf-8');
      const state = JSON.parse(raw) as LoopState;
      if (state.status === 'completed') return null;
      const scheduler = new LoopScheduler(agent, {
        prompt: state.prompt,
        intervalMs: state.intervalMs,
        maxIterations: options.maxIterations ?? state.maxIterations,
        maxDurationMs: state.maxDurationMs,
        sessionKey: state.sessionKey,
        compactBetweenIterations: state.compactBetweenIterations,
        journal: state.journal,
        autonomous: state.autonomous,
        maxConsecutiveFailures: state.maxConsecutiveFailures,
        onIterationEvent: options.onIterationEvent,
      });
      scheduler.state = { ...scheduler.state, ...state };
      if (options.maxIterations !== undefined) {
        scheduler.state.maxIterations = options.maxIterations;
      }
      scheduler.state.paused = true;
      scheduler.state.pauseReason = 'restored from saved state';
      scheduler.state.status = 'paused';
      scheduler.currentPrompt = state.currentPrompt || state.prompt;
      scheduler.workspaceDir = workspace;
      scheduler.resumePending = true;
      log.info('loop state restored', { iteration: state.currentIteration, totalDurationMs: state.totalDurationMs });
      return scheduler;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      log.warn('failed to restore loop state', { error: errorMessage(err) });
      return null;
    }
  }
}
