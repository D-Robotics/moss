import type {
  CodingCompletionGateRequest,
  CodingCompletionGateResult,
} from './coding-completion-gate.js';
import {
  wrapWithTerminalArbitration,
  type TerminalArbitrationGateDeps,
} from '../core/tools/terminal-arbitration-gate.js';
import {
  wrapWithPromotionObservation,
  type PromotionCompletionObserver,
} from '../core/tools/promotion-completion-gate.js';

export type CliCompletionGate = (
  request: CodingCompletionGateRequest
) => Promise<CodingCompletionGateResult>;

export interface CliCompletionGateCompositionDeps {
  terminalArbitration: TerminalArbitrationGateDeps;
  promotionObserver: PromotionCompletionObserver<CodingCompletionGateRequest>;
}

/**
 * 纯组合 helper:固定 completionGate 链顺序为
 *   coding gate -> terminal arbitration -> promotion observation
 *
 * promotion 是最外层观察者,只在 terminal + coding 都接受后才跑。
 * terminal arbitration 仍可在 coding gate 之前拦截(auditFailed),
 * 此时 promotion 不会被触发(原 gate 未 ok)。
 *
 * 见 docs/self-evolution-loop.md T3.3 / T3.4。
 */
export function composeCliCompletionGate(
  codingGate: CliCompletionGate,
  deps: CliCompletionGateCompositionDeps
): CliCompletionGate {
  return wrapWithPromotionObservation(
    wrapWithTerminalArbitration(codingGate, deps.terminalArbitration),
    deps.promotionObserver
  );
}
