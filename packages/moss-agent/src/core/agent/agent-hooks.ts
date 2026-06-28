






import type { Tool, ToolContext, ToolCall, ToolResult } from '../tools/tool-types.js';
import type { LLMStreamEvent, LLMResponse } from '../llm/llm-provider.js';

export interface ToolApprovalRequest {
  tool: Tool;
  input: Record<string, unknown>;
  sessionKey: string;
}

export type ToolApprovalDecision = { approved: true } | { approved: false; reason: string };

export interface InputGuardrailRequest {
  sessionKey: string;
  runId: string;
  userMessage: string;
  platform?: string;
}

export type InputGuardrailDecision =
  | { approved: true; userMessage?: string }
  | { approved: false; reason: string };

export interface OutputGuardrailRequest {
  sessionKey: string;
  runId: string;
  turn: number;
  response: string;
  stopReason?: string;
  platform?: string;
}

export type OutputGuardrailDecision =
  | { approved: true; response?: string }
  | { approved: false; reason: string; response?: string };

























export interface AgentHooks {
  




  onInputGuardrail?(request: InputGuardrailRequest): Promise<InputGuardrailDecision>;

  





  onOutputGuardrail?(request: OutputGuardrailRequest): Promise<OutputGuardrailDecision>;

  



  onBeforeToolExec?(request: ToolApprovalRequest): Promise<ToolApprovalDecision>;

  


  onToolResult?(call: ToolCall, result: ToolResult): void;

  


  onLLMRequestStart?(opts: { model: string; messageCount: number; toolCount: number }): void;

  


  onLLMResponseEnd?(response: LLMResponse): void;

  




  onStream?(event: LLMStreamEvent): void;

  


  onCompaction?(opts: { messagesBefore: number; messagesAfter: number }): void;

  


  onError?(error: unknown, context: { attempt: number; sessionKey: string }): Promise<boolean>;

  


  onTurnComplete?(opts: { turn: number; maxTurns: number; toolCallCount: number }): void;

  



  enrichToolContext?(baseCtx: ToolContext, sessionKey: string): ToolContext;
}
