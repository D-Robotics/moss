import type { MossAgentEvent } from '../core/index.js';

export interface LoopTuiEventBridgeDeps {
  addAssistant(): number;
  appendAssistant(id: number, text: string): void;
  finalizeAssistant(id: number): void;
  addTool(event: Extract<MossAgentEvent, { type: 'tool_start' }>): void;
  finishTool(event: Extract<MossAgentEvent, { type: 'tool_end' }>): void;
  addError(message: string): void;
  addNotice(message: string): void;
  resetAssistant(id: number): void;
  onActivity?(kind: 'reasoning' | 'output'): void;
}

export function formatLoopStatusLine(input: {
  iteration: number;
  maxIterations: number;
  elapsedSeconds: number;
  stopping?: boolean;
}): string {
  const limit = input.maxIterations === 0 ? '∞' : String(input.maxIterations);
  if (input.stopping) {
    return `loop ${input.iteration}/${limit} · ${input.elapsedSeconds}s · stopping after current step…`;
  }
  return `loop ${input.iteration}/${limit} · ${input.elapsedSeconds}s · /steer update · /btw aside · /loop stop`;
}

export function resolveLoopMaxIterations(
  env: Record<string, string | undefined>,
  goal = false
): number {
  const value = goal ? (env.MOSS_GOAL_AUTO_MAX_RUNS ?? env.MOSS_LOOP_MAX) : env.MOSS_LOOP_MAX;
  if (value === undefined || value.trim() === '') return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function createLoopTuiEventBridge(
  deps: LoopTuiEventBridgeDeps
): (event: MossAgentEvent) => void {
  let answerId: number | null = null;
  return (event) => {
    if (event.type === 'retry') {
      if (answerId !== null) deps.resetAssistant(answerId);
      answerId = null;
      deps.addNotice(`Retrying (attempt ${event.attempt}): ${event.error}`);
      return;
    }
    if (event.type === 'text_delta') {
      if (answerId === null) answerId = deps.addAssistant();
      deps.appendAssistant(answerId, event.delta);
      deps.onActivity?.('output');
      return;
    }
    if (event.type === 'thinking_delta') {
      deps.onActivity?.('reasoning');
      return;
    }
    if (event.type === 'tool_start') {
      deps.addTool(event);
      return;
    }
    if (event.type === 'tool_end') {
      deps.finishTool(event);
      return;
    }
    if (event.type === 'turn_end') {
      if (answerId !== null) deps.finalizeAssistant(answerId);
      answerId = null;
      return;
    }
    if (event.type === 'error') {
      deps.addError(String(event.error));
    }
  };
}
