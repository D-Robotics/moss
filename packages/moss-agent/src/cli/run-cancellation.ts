import { ErrorCode, MossError } from '../errors.js';
import type { MossAgent } from '../core/agent/moss-agent.js';
import type { SkillLearner } from '../core/memory/skill-learner.js';
import { runOneShot, type RunOneShotOptions } from './oneshot.js';

export interface CliSignalTarget {
  on(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
}

export interface CliCancellationOptions {
  /** Second SIGINT is an explicit hard-stop escape hatch for an uncooperative provider. */
  forceExit?: (code: number) => void;
}

/**
 * Give a single non-interactive CLI run ownership of SIGINT and always release
 * the process listener when that run settles.
 */
export async function withCliRunCancellation<T>(
  run: (signal: AbortSignal) => Promise<T>,
  signalTarget: CliSignalTarget = process,
  options: CliCancellationOptions = {}
): Promise<T> {
  const controller = new AbortController();
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));
  const onSigInt = () => {
    if (controller.signal.aborted) {
      forceExit(130);
      return;
    }
    controller.abort(
      new MossError({
        code: ErrorCode.USER_ABORTED,
        message: 'Run cancelled by user.',
        hint: 'Start a new run when you are ready to continue.',
        recoverable: true,
      })
    );
  };

  signalTarget.on('SIGINT', onSigInt);
  try {
    return await run(controller.signal);
  } finally {
    signalTarget.off('SIGINT', onSigInt);
  }
}

export function runOneShotWithCliCancellation(
  agent: MossAgent,
  message: string,
  learner?: SkillLearner,
  options: RunOneShotOptions = {}
) {
  return withCliRunCancellation((abortSignal) =>
    runOneShot(agent, message, learner, { ...options, abortSignal })
  );
}
