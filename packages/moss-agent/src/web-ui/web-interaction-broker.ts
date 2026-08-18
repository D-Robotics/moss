import { randomUUID } from 'node:crypto';

import { ErrorCode, MossError } from '../errors.js';

/** Browser interaction categories that can temporarily take over the composer. @beta */
export type MossWebInteractionKind = 'approval' | 'question';
/** Lifecycle state for one browser-mediated interaction. @beta */
export type MossWebInteractionState = 'pending' | 'resolved' | 'cancelled';

/** Browser-safe pending approval or user-question request. @beta */
export interface MossWebPendingInteraction {
  readonly id: string;
  readonly kind: MossWebInteractionKind;
  readonly prompt: string;
  readonly state: MossWebInteractionState;
  readonly createdAt: number;
  readonly resolvedAt?: number;
}

interface InteractionRecord {
  snapshot: MossWebPendingInteraction;
  resolve: (answer: string) => void;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
}

/** Bridges blocking CLI approval/question prompts to a browser-owned pending protocol. @internal */
export class MossWebInteractionBroker {
  private readonly records = new Map<string, InteractionRecord>();

  readonly askApproval = (prompt: string, abortSignal?: AbortSignal): Promise<string> =>
    this.ask('approval', prompt, abortSignal);

  readonly askQuestion = (prompt: string, abortSignal?: AbortSignal): Promise<string> =>
    this.ask('question', prompt, abortSignal);

  pending(): readonly MossWebPendingInteraction[] {
    return [...this.records.values()]
      .map(({ snapshot }) => snapshot)
      .filter(({ state }) => state === 'pending')
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  get(id: string): MossWebPendingInteraction | undefined {
    return this.records.get(id)?.snapshot;
  }

  resolve(id: string, answer: string): boolean {
    const record = this.records.get(id);
    if (!record || record.snapshot.state !== 'pending') return false;
    const resolvedAnswer = this.normalizeAnswer(record.snapshot.kind, answer);
    this.finish(record, 'resolved', resolvedAnswer);
    return true;
  }

  cancel(id: string): boolean {
    const record = this.records.get(id);
    if (!record || record.snapshot.state !== 'pending') return false;
    this.finish(record, 'cancelled', '');
    return true;
  }

  cancelAll(): void {
    for (const record of this.records.values()) {
      if (record.snapshot.state === 'pending') this.finish(record, 'cancelled', '');
    }
  }

  private ask(
    kind: MossWebInteractionKind,
    prompt: string,
    abortSignal?: AbortSignal
  ): Promise<string> {
    if (abortSignal?.aborted) return Promise.resolve('');
    return new Promise((resolve) => {
      const id = `interaction-${randomUUID()}`;
      const record: InteractionRecord = {
        snapshot: {
          id,
          kind,
          prompt,
          state: 'pending',
          createdAt: Date.now(),
        },
        resolve,
        abortSignal,
      };
      record.onAbort = () => this.finish(record, 'cancelled', '');
      abortSignal?.addEventListener('abort', record.onAbort, { once: true });
      this.records.set(id, record);
      this.pruneHistory();
    });
  }

  private finish(
    record: InteractionRecord,
    state: Extract<MossWebInteractionState, 'resolved' | 'cancelled'>,
    answer: string
  ): void {
    record.abortSignal?.removeEventListener('abort', record.onAbort!);
    record.snapshot = { ...record.snapshot, state, resolvedAt: Date.now() };
    record.resolve(answer);
  }

  private normalizeAnswer(kind: MossWebInteractionKind, answer: string): string {
    if (kind === 'question') return answer;
    if (answer === 'allow_once') return 'y';
    if (answer === 'allow_always') return 'a';
    if (answer === 'deny') return 'n';
    throw new MossError({
      code: ErrorCode.USER_INPUT_INVALID,
      message: 'approval answer must be allow_once, allow_always, or deny',
    });
  }

  private pruneHistory(): void {
    if (this.records.size <= 200) return;
    for (const [id, record] of this.records) {
      if (record.snapshot.state === 'pending') continue;
      this.records.delete(id);
      if (this.records.size <= 200) break;
    }
  }
}
