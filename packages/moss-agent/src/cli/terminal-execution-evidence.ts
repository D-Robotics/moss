import type { TerminalExecutionEvidence } from './coding-completion-gate.js';
import type { Message } from '../core/session/session-jsonl.js';
import { toolResultText } from '../context/message-tool-helpers.js';

const EXECUTION_TOOLS = new Set(['exec', 'exec_background']);
const EXIT_CODE_LINE = /^\s*exit_code:\s*(-?\d+)\s*(?:\r?\n|$)/i;
const COMMAND_FAILED = /^Command failed \(exit (-?\d+)\):\s*(?:\r?\n|$)/i;
const BACKGROUND_IMMEDIATE_EXIT = /^Background command \S+ exited immediately \(exit (-?\d+)(?:, signal [^)]+)?\)\.\s*(?:\r?\n|$)/i;
const BACKGROUND_STILL_RUNNING = /^Started \S+ .*\bStill running after \d+ms\./i;
const BACKGROUND_OUTPUT = /^--- (stderr: )?output \(last 20 lines\) ---\s*(?:\r?\n|$)/im;
const STDERR_SECTION = /(?:^|\r?\n)--- stderr(?: \(truncated [^)]+\))? ---\s*(?:\r?\n|$)/im;

interface ToolResultBlock {
  type?: string;
  name?: string;
  tool_name?: string;
  toolName?: string;
  tool_use_id?: string;
  toolCallId?: string;
  is_error?: boolean;
  isError?: boolean;
}

function splitStderr(body: string): { stdout: string; stderr: string } {
  const marker = STDERR_SECTION.exec(body);
  if (!marker || marker.index === undefined) return { stdout: body.trim(), stderr: '' };
  return {
    stdout: body.slice(0, marker.index).trim(),
    stderr: body.slice(marker.index + marker[0].length).trim(),
  };
}

function parseEvidence(
  source: string,
  toolUseId: string | undefined,
  body: string,
  reportedIsError: boolean | undefined,
): TerminalExecutionEvidence {
  let remaining = body.trim();
  let exitCode: number | undefined;

  const failed = COMMAND_FAILED.exec(remaining);
  const immediate = BACKGROUND_IMMEDIATE_EXIT.exec(remaining);
  const exitLine = EXIT_CODE_LINE.exec(remaining);
  const exitMatch = failed ?? immediate ?? exitLine;
  if (exitMatch) {
    exitCode = Number.parseInt(exitMatch[1]!, 10);
    remaining = remaining.slice(exitMatch[0].length);
  } else if (source === 'exec' && reportedIsError === false) {
    // exec omits exit_code for successful commands; is_error is emitted by the
    // tool runtime from the structured process outcome, not assistant prose.
    exitCode = 0;
  }

  if (immediate) {
    const output = BACKGROUND_OUTPUT.exec(remaining);
    if (output) {
      remaining = remaining.slice(output.index + output[0].length);
      const stream = output[1] ? { stdout: '', stderr: remaining.trim() } : splitStderr(remaining);
      return {
        source,
        ...(toolUseId ? { toolUseId } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...stream,
      };
    }
  }

  const streams = splitStderr(remaining);
  return {
    source,
    ...(toolUseId ? { toolUseId } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...streams,
  };
}

export function extractLatestTerminalExecutionEvidence(
  messages: Message[],
): TerminalExecutionEvidence | undefined {
  const toolNameById = new Map<string, string>();
  let latest: TerminalExecutionEvidence | undefined;

  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) continue;

    for (const block of message.content) {
      const candidate = block as ToolResultBlock & { id?: string; input?: unknown };
      if (
        message.role === 'assistant' &&
        candidate.type === 'tool_use' &&
        typeof candidate.id === 'string' &&
        typeof candidate.name === 'string'
      ) {
        toolNameById.set(candidate.id, candidate.name);
        continue;
      }

      if (message.role !== 'user' || candidate.type !== 'tool_result') continue;
      const toolUseId = candidate.tool_use_id ?? candidate.toolCallId;
      const source =
        candidate.name ??
        candidate.tool_name ??
        candidate.toolName ??
        (toolUseId ? toolNameById.get(toolUseId) : undefined);
      if (!source || !EXECUTION_TOOLS.has(source)) continue;

      const body = toolResultText(candidate);
      if (BACKGROUND_STILL_RUNNING.test(body)) {
        latest = undefined;
        continue;
      }
      latest = parseEvidence(
        source,
        toolUseId,
        body,
        candidate.is_error ?? candidate.isError,
      );
    }
  }

  return latest;
}
