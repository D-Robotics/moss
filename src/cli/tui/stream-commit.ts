/**
 * Commit the stable markdown prefix of a streaming answer so the head of a
 * long reply reaches the transcript before the turn ends.
 */
import { stableMarkdownPrefix } from './markdown.js';

export interface StreamCommit {
  /** Closed markdown blocks, ready for a transcript row. Empty when nothing closed. */
  commit: string;
  /** Still-open tail that stays in the live region. */
  rest: string;
}

export function nextStreamCommit(uncommitted: string): StreamCommit {
  const { stable, rest } = stableMarkdownPrefix(uncommitted);
  if (!stable.trim()) return { commit: '', rest: uncommitted };
  return { commit: stable, rest };
}
