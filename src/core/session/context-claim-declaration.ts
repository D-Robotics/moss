import type { ContextClaimDraft } from '../../contracts/versioned-context.js';

export const CONTEXT_CLAIMS_TOOL = 'context_claims';

export const claimDraftSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    sourceIds: { type: 'array', items: { type: 'string' } },
    dependsOn: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'sourceIds', 'dependsOn'],
  additionalProperties: false,
};

export function parseClaimDrafts(input: unknown): ContextClaimDraft[] {
  if (!Array.isArray(input) || input.length > 16) throw new Error('Invalid context claims');
  return input.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid context claim');
    const { text, sourceIds, dependsOn } = value as Partial<ContextClaimDraft>;
    const validIds = (ids: unknown): ids is string[] =>
      Array.isArray(ids) &&
      ids.length <= 16 &&
      ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 240);
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 1600 ||
      !validIds(sourceIds) ||
      !sourceIds.length ||
      !validIds(dependsOn)
    ) {
      throw new Error('A context claim requires bounded text and original sources');
    }
    return { text, sourceIds: [...new Set(sourceIds)], dependsOn: [...new Set(dependsOn)] };
  });
}
