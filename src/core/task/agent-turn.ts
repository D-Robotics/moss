/**
 * Agent turn adapter (Task OS M5) — the ONE way an engine turn talks to a
 * MossAgent. Duck-types streamChat/chat so REPL / headless / SDK / TUI drive
 * identical behavior per interface parity, including the stop reason.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChatOptions, MossAgentEvent } from '../agent/moss-agent-types.js';

interface ActiveTaskTurn {
  taskId: string;
  workspace: string;
  active: boolean;
}

const activeTaskTurns = new AsyncLocalStorage<ActiveTaskTurn>();

async function workspaceIdentity(workspaceDir: string): Promise<string> {
  const resolved = await fs.realpath(workspaceDir).catch(() => path.resolve(workspaceDir));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Carries task identity through legacy wrappers only while their turn is active. */
export async function withTaskTurnIdentity<T>(
  workspaceDir: string,
  taskId: string,
  action: () => Promise<T>
): Promise<T> {
  const turn = { taskId, workspace: await workspaceIdentity(workspaceDir), active: true };
  try {
    return await activeTaskTurns.run(turn, action);
  } finally {
    turn.active = false;
  }
}

export async function activeTaskTurnId(workspaceDir: string): Promise<string | undefined> {
  const turn = activeTaskTurns.getStore();
  if (!turn?.active || turn.workspace !== (await workspaceIdentity(workspaceDir))) return undefined;
  return turn.active ? turn.taskId : undefined;
}

type TurnChatOptions = Pick<ChatOptions, 'abortSignal' | 'taskFlow' | 'goalExecWait' | 'taskId'>;

type StreamChatFn = (
  sessionKey: string,
  prompt: string,
  options?: TurnChatOptions
) => AsyncIterable<MossAgentEvent>;

type ChatFn = (
  sessionKey: string,
  prompt: string,
  options?: TurnChatOptions
) => Promise<{ response: string; stopReason?: string }>;

export interface AgentTurnRunnerOptions {
  /** Live event tap for renderers (CLI run renderer, TUI bridge). */
  onEvent?: (event: MossAgentEvent) => void;
  abortSignal?: AbortSignal;
}

/**
 * Assistant text plus the stop reason from the `done` event or `chat` result.
 * The runner itself still returns the text string; this shape is for callers
 * that pass an object instead, and for the `stopReason` field on the runner.
 */
export interface AgentTurnResult {
  text: string;
  stopReason?: string;
}

/**
 * String-returning turn function, same as before the budget stop. The latest
 * stop reason is on `stopReason` so existing callers that read the text stay
 * compatible.
 */
export interface AgentTurnRunner {
  (prompt: string, phase: string, context?: { taskId: string }): Promise<string>;
  stopReason?: string;
}

function stringRunner(
  run: (prompt: string, context?: { taskId: string }) => Promise<AgentTurnResult>
): AgentTurnRunner {
  const runner: AgentTurnRunner = async (prompt, _phase, context) => {
    const result = await run(prompt, context);
    runner.stopReason = result.stopReason;
    return result.text;
  };
  return runner;
}

export function createAgentTurnRunner(
  agent: unknown,
  sessionKey: string,
  options: AgentTurnRunnerOptions = {}
): AgentTurnRunner {
  const duck = agent as { streamChat?: StreamChatFn; chat?: ChatFn };
  if (typeof duck.streamChat === 'function') {
    return stringRunner(async (prompt, context) => {
      let accText = '';
      let doneResponse: string | undefined;
      let stopReason: string | undefined;
      // Method call on the agent (never a detached binding) — moss-agent
      // internals rely on `this`.
      for await (const event of duck.streamChat!(sessionKey, prompt, {
        taskFlow: true,
        goalExecWait: true,
        ...(context ? { taskId: context.taskId } : {}),
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      })) {
        options.onEvent?.(event);
        if (event.type === 'text_delta') accText += event.delta;
        if (event.type === 'done') {
          const response = event.result?.response;
          if (typeof response === 'string' && response.trim()) doneResponse = response;
          const stop = event.result?.stopReason;
          if (typeof stop === 'string') stopReason = stop;
        }
      }
      const text = (doneResponse && doneResponse.trim()) || accText;
      return stopReason ? { text, stopReason } : { text };
    });
  }
  if (typeof duck.chat === 'function') {
    return stringRunner(async (prompt, context) => {
      const result = await duck.chat!(sessionKey, prompt, {
        taskFlow: true,
        goalExecWait: true,
        ...(context ? { taskId: context.taskId } : {}),
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
      return result.stopReason
        ? { text: result.response, stopReason: result.stopReason }
        : { text: result.response };
    });
  }
  throw new Error('task engine agent must implement streamChat or chat');
}
