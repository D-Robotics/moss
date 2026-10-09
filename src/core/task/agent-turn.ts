/**
 * Agent turn adapter (Task OS M5) — the ONE way an engine turn talks to a
 * MossAgent. Duck-types streamChat/chat so REPL / headless / SDK / TUI drive
 * identical behavior per interface parity, including the stop reason.
 */
import type { MossAgentEvent } from '../agent/moss-agent-types.js';

type StreamChatFn = (
  sessionKey: string,
  prompt: string,
  options?: { abortSignal?: AbortSignal; taskFlow?: boolean; goalExecWait?: boolean }
) => AsyncIterable<MossAgentEvent>;

type ChatFn = (
  sessionKey: string,
  prompt: string,
  options?: { abortSignal?: AbortSignal; taskFlow?: boolean; goalExecWait?: boolean }
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
  (prompt: string, phase: string): Promise<string>;
  stopReason?: string;
}

function stringRunner(run: (prompt: string) => Promise<AgentTurnResult>): AgentTurnRunner {
  const runner: AgentTurnRunner = async (prompt) => {
    const result = await run(prompt);
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
    return stringRunner(async (prompt) => {
      let accText = '';
      let doneResponse: string | undefined;
      let stopReason: string | undefined;
      // Method call on the agent (never a detached binding) — moss-agent
      // internals rely on `this`.
      for await (const event of duck.streamChat!(sessionKey, prompt, {
        taskFlow: true,
        goalExecWait: true,
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
    return stringRunner(async (prompt) => {
      const result = await duck.chat!(sessionKey, prompt, {
        taskFlow: true,
        goalExecWait: true,
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
      return result.stopReason
        ? { text: result.response, stopReason: result.stopReason }
        : { text: result.response };
    });
  }
  throw new Error('task engine agent must implement streamChat or chat');
}
