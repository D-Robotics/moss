import type { MossAgent } from '../core/agent/moss-agent.js';
import {
  setCliToolApprovalHookAsker,
  setCliToolApprovalHookInteractionMode,
} from '../cli/approval.js';
import type { MossWebInteractionBroker } from './web-interaction-broker.js';
import type { MossWebRuntimeService } from './web-runtime-service.js';

/** Bind host-local browser interactions without changing process-global CLI state. @internal */
export function bindMossWebInteractions(
  agent: MossAgent,
  broker: MossWebInteractionBroker,
  runtime: MossWebRuntimeService
): () => void {
  const unbindApprovalAsker = setCliToolApprovalHookAsker(
    agent.config.hooks?.onBeforeToolExec,
    broker.askApproval
  );
  const unbindApprovalMode = setCliToolApprovalHookInteractionMode(
    agent.config.hooks?.onBeforeToolExec,
    () => runtime.mode()
  );
  const questionCapableAgent = agent as MossAgent & {
    setUserQuestionAsker?: MossAgent['setUserQuestionAsker'];
  };
  const unbindQuestionAsker = questionCapableAgent.setUserQuestionAsker
    ? questionCapableAgent.setUserQuestionAsker(broker.askQuestion)
    : () => {};

  return () => {
    unbindApprovalAsker();
    unbindApprovalMode();
    unbindQuestionAsker();
  };
}
