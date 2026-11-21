import { abortable } from './abort.js';
import type { MossAgentConfig, UserIntentDecision } from './moss-agent-types.js';
import type { SessionInboxEntry } from '../session/session-inbox.js';
import type { ToolStartGuard } from '../tools/execute-tool-call.js';
import { getRootLogger } from '../../logger.js';

const log = getRootLogger().child('steering-intent');
const MIN_PROBABILITY = 0.8;
export const INTENT_OBSERVATION_TIMEOUT_MS = 2_000;

interface SteeringEffect {
  replan: boolean;
  editPolicy: 'read_only' | 'allow_edits' | 'unchanged';
}

function effectOf(decision?: UserIntentDecision): SteeringEffect {
  const edit = decision?.editPolicy;
  if (
    !decision ||
    !Number.isFinite(decision.probability) ||
    decision.probability < MIN_PROBABILITY ||
    decision.probability > 1 ||
    !edit ||
    !['read_only', 'allow_edits', 'unchanged'].includes(edit.choice) ||
    !Number.isFinite(edit.probability) ||
    edit.probability < MIN_PROBABILITY ||
    edit.probability > 1 ||
    decision.intent === 'unclear'
  ) {
    return { replan: true, editPolicy: 'read_only' };
  }
  const editPolicy = decision.intent === 'stop_task' ? 'read_only' : edit.choice;
  return {
    replan:
      editPolicy !== 'unchanged' ||
      (decision.intent !== 'question' && decision.intent !== 'continue_task'),
    editPolicy,
  };
}

export class SteeringIntentGate implements ToolStartGuard {
  private readonly requests = new Map<string, Promise<void>>();
  private readonly effects = new Map<string, SteeringEffect & { prompt: string }>();
  private readOnly = false;
  private revised = false;
  private activeRequest?: string;

  constructor(
    private readonly pending: () => readonly SessionInboxEntry[],
    private readonly decide: NonNullable<MossAgentConfig['decideSteeringIntent']>,
    private readonly runSignal: AbortSignal,
    activeRequest?: string,
    private readonly taskFlow = false
  ) {
    this.activeRequest = activeRequest;
  }

  async prepare(signal: AbortSignal, entries = this.pending()): Promise<void> {
    const requests = entries.map((entry) => {
      let request = this.requests.get(entry.id);
      if (!request) {
        const timeout = AbortSignal.timeout(INTENT_OBSERVATION_TIMEOUT_MS);
        const combined = AbortSignal.any([this.runSignal, timeout]);
        const decision = Promise.resolve().then(() => {
          combined.throwIfAborted();
          return this.decide(
            {
              source: 'steering',
              text: entry.prompt,
              ...(this.activeRequest ? { activeRequest: this.activeRequest } : {}),
            },
            combined
          );
        });
        request = abortable(decision, combined)
          .catch(() => {
            if (!this.runSignal.aborted)
              log.warn('Steering intent unavailable', {
                reason: timeout.aborted ? 'timeout' : 'judge-error',
              });
            return undefined;
          })
          .then((outcome) => {
            this.effects.set(entry.id, { ...effectOf(outcome), prompt: entry.prompt });
          });
        this.requests.set(entry.id, request);
      }
      return request;
    });
    if (requests.length > 0) await abortable(Promise.all(requests), signal);
    signal.throwIfAborted();
  }

  superseded(): boolean {
    // Include messages admitted after prepare() resolved, before the synchronous tool start.
    return this.pending().some((entry) => this.effects.get(entry.id)?.replan !== false);
  }

  denialReason(tool: Parameters<ToolStartGuard['denialReason']>[0]): string | undefined {
    if (this.superseded())
      return 'Tool skipped because a new user instruction invalidated the pending plan. Replan from the latest user instruction.';
    if (this.readOnly && tool.metadata?.sideEffectClass !== 'readonly')
      return 'Tool skipped because the latest user instruction limits this run to read-only actions. Explain or inspect without writing, running shell commands, or making changes.';
    if (this.taskFlow && this.revised && tool.metadata?.sideEffectClass === 'runtime_state')
      return 'Tool skipped because the original verified task contract was superseded by a user correction.';
    return undefined;
  }

  notice(id: string): string | undefined {
    const effect = this.effects.get(id);
    if (!effect?.replan) return undefined;
    return effect.editPolicy === 'read_only'
      ? '[Runtime] The prior plan is invalid. Use the update below as the latest user instruction and continue read-only.'
      : '[Runtime] The prior plan is invalid. Replan from the user update below before taking further actions.';
  }

  applied(entryId: string): void {
    const effect = this.effects.get(entryId);
    if (!effect) return;
    this.requests.delete(entryId);
    this.effects.delete(entryId);
    if (effect.replan) {
      this.revised = true;
      this.activeRequest = effect.prompt;
    }
    if (effect.editPolicy !== 'unchanged') this.readOnly = effect.editPolicy === 'read_only';
  }

  revisedIntent(): boolean {
    return this.revised || this.superseded();
  }

  allowsPriorRecovery(): boolean {
    return !this.revisedIntent();
  }
}
