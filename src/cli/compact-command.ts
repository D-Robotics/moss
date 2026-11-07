import type { MossAgent } from '../core/index.js';

export function formatCompactSessionResult(
  result: Awaited<ReturnType<MossAgent['compactSession']>>
): string {
  if (!result.compacted) {
    // B295: an empty conversation got a three-line "no savings" report; one
    // honest line is the whole answer.
    if (result.tokensAfter <= 0) return 'Conversation is empty — nothing to compact yet.';
    return [
      'Conversation context was not compacted; original history is unchanged.',
      `  tokens after check: ~${result.tokensAfter.toLocaleString()}`,
      '  No context savings are currently available.',
    ].join('\n');
  }
  return [
    'Compacted conversation context.',
    `  dropped messages: ${result.droppedMessages}`,
    `  summary chars: ${result.summaryChars.toLocaleString()}`,
    `  tokens after: ~${result.tokensAfter.toLocaleString()}`,
  ].join('\n');
}

export async function handleCompactCommand(
  agent: MossAgent,
  sessionKey: string,
  customInstructions?: string,
  options: { abortSignal?: AbortSignal } = {}
): Promise<string> {
  const result = await agent.compactSession(sessionKey, customInstructions, options);
  return formatCompactSessionResult(result);
}
