/**
 * Agent turn adapter (Task OS M5) — the ONE way an engine turn talks to a
 * MossAgent. Duck-types streamChat/chat so REPL / headless / SDK / TUI drive
 * identical behavior per interface parity, including the stop reason.
 */
import type { MossAgentEvent } from '../agent/moss-agent-types.js';
import type { HarnessAdapter } from '../agent/harness-adapter.js';

interface TaskChatOptions {
  abortSignal?: AbortSignal;
  taskFlow?: boolean;
  goalExecWait?: boolean;
  harnessAdapter?: HarnessAdapter;
  taskId?: string;
  userInput?: false | { id: string; text: string; taskId: string };
}

type StreamChatFn = (
  sessionKey: string,
  prompt: string,
  options?: TaskChatOptions
) => AsyncIterable<MossAgentEvent>;

type ChatFn = (
  sessionKey: string,
  prompt: string,
  options?: TaskChatOptions
) => Promise<{ response: string; stopReason?: string }>;

export interface AgentTurnRunnerOptions {
  harnessAdapter?: HarnessAdapter;
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
export interface TaskTurnBinding {
  taskId: string;
  userGoal?: string;
}

function taskInputOptions(binding?: TaskTurnBinding): Partial<TaskChatOptions> {
  if (!binding) return {};
  return {
    taskId: binding.taskId,
    userInput: binding.userGoal
      ? { id: `goal:${binding.taskId}`, text: binding.userGoal, taskId: binding.taskId }
      : false,
  };
}

export interface AgentTurnRunner {
  (prompt: string, phase: string, binding?: TaskTurnBinding): Promise<string>;
  stopReason?: string;
  captureAcceptanceGuard?(taskId: string): (() => void) | undefined;
  pendingUserInput?(): boolean;
}

function stringRunner(
  run: (prompt: string, binding?: TaskTurnBinding) => Promise<AgentTurnResult>
): AgentTurnRunner {
  const runner: AgentTurnRunner = async (prompt, _phase, binding) => {
    const result = await run(prompt, binding);
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
  const duck = agent as {
    streamChat?: StreamChatFn;
    chat?: ChatFn;
    captureTaskExecutionGuard?(sessionKey: string, taskId: string): (() => void) | undefined;
    getTaskIntent?(sessionKey: string): { pending: boolean } | undefined;
  };
  const bind = (runner: AgentTurnRunner): AgentTurnRunner => {
    runner.captureAcceptanceGuard = (taskId) =>
      duck.captureTaskExecutionGuard?.(sessionKey, taskId);
    runner.pendingUserInput = () => duck.getTaskIntent?.(sessionKey)?.pending === true;
    return runner;
  };
  if (typeof duck.streamChat === 'function') {
    return bind(
      stringRunner(async (prompt, binding) => {
        let accText = '';
        let doneResponse: string | undefined;
        let stopReason: string | undefined;
        // Method call on the agent (never a detached binding) — moss-agent
        // internals rely on `this`.
        for await (const event of duck.streamChat!(sessionKey, prompt, {
          ...taskInputOptions(binding),
          taskFlow: true,
          goalExecWait: true,
          ...(options.harnessAdapter ? { harnessAdapter: options.harnessAdapter } : {}),
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
      })
    );
  }
  if (typeof duck.chat === 'function') {
    return bind(
      stringRunner(async (prompt, binding) => {
        const result = await duck.chat!(sessionKey, prompt, {
          ...taskInputOptions(binding),
          taskFlow: true,
          goalExecWait: true,
          ...(options.harnessAdapter ? { harnessAdapter: options.harnessAdapter } : {}),
          ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        });
        return result.stopReason
          ? { text: result.response, stopReason: result.stopReason }
          : { text: result.response };
      })
    );
  }
  throw new Error('task engine agent must implement streamChat or chat');
}
