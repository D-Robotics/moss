import type { TerminalExecutionEvidence } from './coding-completion-gate.js';
import type { Message } from '../core/session/session-jsonl.js';

const EXECUTION_TOOLS = new Set(['exec', 'exec_background']);
const EXIT_LINE = /^\s*exit_code:\s*(-?\d+)\s*(?:\r?\n|$)/i;
const STDOUT_LINE = /^stdout:\s?(.*)$/im;
const STDERR_LINE = /^stderr:\s?(.*)$/im;

interface ToolResultBlock {
  type?: string;
  name?: string;
  tool_name?: string;
  toolName?: string;
  tool_use_id?: string;
  toolCallId?: string;
  content?: unknown;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        const value = block as { text?: unknown; content?: unknown };
        return typeof value.text === 'string'
          ? value.text
          : typeof value.content === 'string'
            ? value.content
            : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function parseEvidence(source: string, toolUseId: string | undefined, body: string): TerminalExecutionEvidence {
  const exitMatch = body.match(EXIT_LINE);
  const withoutExitLine = exitMatch ? body.replace(EXIT_LINE, '') : body;
  const stdoutMatch = withoutExitLine.match(STDOUT_LINE);
  const stderrMatch = withoutExitLine.match(STDERR_LINE);

  return {
    source,
    ...(toolUseId ? { toolUseId } : {}),
    ...(exitMatch ? { exitCode: Number.parseInt(exitMatch[1]!, 10) } : {}),
    stdout: stdoutMatch?.[1] ?? (stdoutMatch || stderrMatch ? '' : withoutExitLine),
    stderr: stderrMatch?.[1] ?? '',
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

      const body = resultText(candidate.content);
      if (/Started bg_.*Still running\./i.test(body)) continue;
      latest = parseEvidence(source, toolUseId, body);
    }
  }

  return latest;
}
