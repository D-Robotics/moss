import type {
  CodingCompletionGateRequest,
  CodingCompletionGateResult,
} from '../../cli/coding-completion-gate.js';
import { errorMessage } from '../../errors.js';
import { getRootLogger } from '../../logger.js';

const log = getRootLogger().child('acceptance:promotion-completion');

export type CodingCompletionGate = (
  request: CodingCompletionGateRequest
) => Promise<CodingCompletionGateResult>;

export interface PromotionCompletionObserver<TCompletion> {
  observeCompletion(completion: TCompletion): Promise<void>;
}

export function wrapWithPromotionObservation(
  originalGate: CodingCompletionGate,
  observer: PromotionCompletionObserver<CodingCompletionGateRequest>
): CodingCompletionGate {
  return async (request) => {
    const result = await originalGate(request);
    if (!result.ok) return result;

    try {
      await observer.observeCompletion(request);
    } catch (error) {
      log.warn('promotion observation failed', { error: errorMessage(error) });
    }
    return result;
  };
}
