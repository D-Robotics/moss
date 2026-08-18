import type { MossAgent } from '../core/agent/moss-agent.js';
import type { DeliveryReviewScope, DeliveryReviewVerdict } from './delivery-case.js';
import type { DeliveryReviewer, DeliveryReviewerResult } from './delivery-run-finalizer.js';

function responseText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      Boolean(block.type === 'text' && block.text)
    )
    .map((block) => block.text)
    .join('\n');
}

function parseReview(text: string): DeliveryReviewerResult {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { verdict: 'PARTIAL', blockers: ['Reviewer returned no structured verdict'], notes: [] };
  }
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const verdicts: readonly DeliveryReviewVerdict[] = [
      'PASS',
      'PASS_WITH_NOTES',
      'FAIL',
      'PARTIAL',
    ];
    const verdict = verdicts.find((candidate) => candidate === value.verdict) ?? 'PARTIAL';
    const strings = (candidate: unknown): string[] =>
      Array.isArray(candidate)
        ? candidate.filter((item): item is string => typeof item === 'string' && Boolean(item))
        : [];
    return { verdict, blockers: strings(value.blockers), notes: strings(value.notes) };
  } catch {
    return { verdict: 'PARTIAL', blockers: ['Reviewer returned invalid JSON'], notes: [] };
  }
}

function reviewPrompt(scope: DeliveryReviewScope, goal: string, assistantSummary: string): string {
  const focus =
    scope === 'node'
      ? 'Verify that the delivered result satisfies the requested node outcome.'
      : 'Review end-to-end requirement coverage, consistency, regressions, and evidence quality.';
  return [
    focus,
    `Goal: ${goal}`,
    `Candidate result: ${assistantSummary}`,
    'Return JSON only: {"verdict":"PASS|PASS_WITH_NOTES|FAIL|PARTIAL","blockers":[],"notes":[]}.',
    'Use PASS only when the supplied result is sufficient. Do not assume tools ran or files changed.',
  ].join('\n\n');
}

/** Create a read-only reviewer that uses a fresh provider context for every review scope. @internal */
export function createIndependentDeliveryReviewer(agent: MossAgent): DeliveryReviewer {
  return async ({ scope, goal, assistantSummary }) => {
    try {
      const response = await agent.config.llmProvider.complete({
        model: agent.config.model ?? 'default',
        systemPrompt:
          'You are an independent, read-only delivery reviewer. You have no tools and must not claim unobserved evidence.',
        messages: [{ role: 'user', content: reviewPrompt(scope, goal, assistantSummary) }],
        maxTokens: Math.min(agent.config.maxTokens ?? 512, 512),
        temperature: 0,
      });
      return parseReview(responseText(response.content));
    } catch (error) {
      return {
        verdict: 'PARTIAL',
        blockers: ['Independent reviewer failed to return a verdict'],
        notes: [error instanceof Error ? error.message : String(error)],
      };
    }
  };
}
