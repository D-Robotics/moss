/**
 * Agent turn adapter (Task OS M5) — the ONE way an engine turn talks to a
 * MossAgent. Duck-types streamChat/chat exactly like LoopScheduler does, so
 * REPL / headless / SDK / TUI drive identical behavior per interface parity.
 */
import type { MossAgentEvent } from '../agent/moss-agent-types.js';

type StreamChatFn = (
  sessionKey: string,
  prompt: string,
  options?: { abortSignal?: AbortSignal }
) => AsyncIterable<MossAgentEvent>;

type ChatFn = (
  sessionKey: string,
  prompt: string,
  options?: { abortSignal?: AbortSignal }
) => Promise<{ response: string; stopReason?: string }>;

export interface AgentTurnRunnerOptions {
  /** Live event tap for renderers (CLI run renderer, TUI bridge). */
  onEvent?: (event: MossAgentEvent) => void;
  abortSignal?: AbortSignal;
}

export type AgentTurnRunner = (prompt: string, phase: string) => Promise<string>;

export function createAgentTurnRunner(
  agent: unknown,
  sessionKey: string,
  options: AgentTurnRunnerOptions = {}
): AgentTurnRunner {
  const duck = agent as { streamChat?: StreamChatFn; chat?: ChatFn };
  if (typeof duck.streamChat === 'function') {
    return async (prompt) => {
      let accText = '';
      let doneResponse: string | undefined;
      // Method call on the agent (never a detached binding) — moss-agent
      // internals rely on `this`.
      for await (const event of duck.streamChat!(sessionKey, prompt, {
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      })) {
        options.onEvent?.(event);
        if (event.type === 'text_delta') accText += event.delta;
        if (event.type === 'done') {
          const response = event.result?.response;
          if (typeof response === 'string' && response.trim()) doneResponse = response;
        }
      }
      return (doneResponse && doneResponse.trim()) || accText;
    };
  }
  if (typeof duck.chat === 'function') {
    return async (prompt) => {
      const result = await duck.chat!(sessionKey, prompt, {
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
      return result.response;
    };
  }
  throw new Error('task engine agent must implement streamChat or chat');
}
