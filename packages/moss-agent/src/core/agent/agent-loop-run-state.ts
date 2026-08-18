import type { TaskFrame } from '../goal/task-frame.js';
import type { AgentLoopParams } from '../loop/agent-loop-types.js';
import type { ToolCall } from '../tools/tool-types.js';
import type { AgentHooks } from './agent-hooks.js';
import type { createMossAgentLoopEventAdapter } from './moss-agent-loop-adapter.js';

export interface AgentLoopRunState {
  taskFrame: TaskFrame;
  activeToolCalls: Map<string, ToolCall>;
  lastAgentFatalError: string | undefined;
  completedToolCalls: number;
}

export interface AgentLoopRun {
  params: AgentLoopParams;
  state: AgentLoopRunState;
  hooks: AgentHooks | undefined;
  maxTurns: number;
  abortSignal: AbortSignal;
  adapter: ReturnType<typeof createMossAgentLoopEventAdapter>;
  sessionKey: string;
  userMessage: string;
}
