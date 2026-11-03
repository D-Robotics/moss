/** Evals: the Thread-level assessments of queued Triggers, and the Decisions they end with. */
import { key } from './ids.js';
import { UserError } from './errors.js';
import { liveTicket, threadKey } from './model.js';
import type {
  Decision,
  DecisionKind,
  Evaluation,
  Mandate,
  MandateBasis,
  Strength,
  Thread,
  Trigger,
} from './model.js';
import type { AssessmentOutcome, Candidate, Policy } from './ports.js';
import { said, type Reason } from './reasons.js';
import { EnginePart, type EngineOptions } from './part.js';
import type { Tickets } from './tickets.js';

/** An outcome for the Eval that holds a Trigger; `evalId` names the Eval it was judged for, so a later Eval refuses it. */
export type Outcome = AssessmentOutcome & { evalId?: string };
/** What an Eval ends with, as its Decision records it. */
interface Finished {
  kind: DecisionKind;
  reason: Reason[];
  audit?: Record<string, unknown>;
  ticketId?: string;
  mandate?: Mandate;
}
/** An outcome's reason: a code it carries, else the words its assessor or person wrote. */
const reasonOf = (reason: string | Reason): Reason[] => [
  typeof reason === 'string' ? said(reason) : reason,
];
const stronger = (a: Strength, b: Strength): Strength =>
  a === 'explicit' || b === 'explicit' ? 'explicit' : 'inferred';
/** How many times in a row an expired Eval queues its Triggers again before it is recorded unavailable. */
const REQUEUES = 2;

/**
 * Evals runs the Evals of Threads: it batches a Thread's queued Triggers into one Eval, takes its strength, actor, and basis
 * from the gate, asks the assessor, keeps its deadline through a pause, and records the Decision it ends with: accept, stop,
 * ignore, or unavailable. It depends on Tickets to create the ticket an accept decides and to end the one a stop names; the
 * Engine routes the main Session's decisions, people's replays, worker handbacks, and the pass's Eval work here.
 */
export class Evals extends EnginePart {
  constructor(
    options: EngineOptions,
    private readonly tickets: Tickets
  ) {
    super(options);
  }

  /**
   * Expire a Thread's Eval past its deadline (see `expire`), unless processing is paused: then the Eval notes when the
   * processing pause began, and once processing resumes its deadline moves forward by the pause's length. An Eval whose
   * candidate has not reached the assessor's Session does not expire.
   */
  due(thread: Thread, policy: Policy): void {
    const evaluation = thread.evaluating;
    if (!evaluation || (policy.paused && evaluation.pausedAt)) return;
    const now = this.now();
    if (policy.paused) evaluation.pausedAt = now;
    else if (evaluation.pausedAt) {
      evaluation.deadline = new Date(
        Date.parse(evaluation.deadline) + Date.parse(now) - Date.parse(evaluation.pausedAt)
      ).toISOString();
      delete evaluation.pausedAt;
    } else if (evaluation.delivered && evaluation.deadline <= now) {
      this.expire(thread);
      return;
    } else return;
    this.repo.threads.save(thread);
  }
  /** An Eval's candidate reached the assessor's Session: its deadline counts from now. */
  delivered(evalId: string, policy: Policy): void {
    const thread = this.repo.threads.active().find((item) => item.evaluating?.id === evalId);
    if (!thread?.evaluating || thread.evaluating.delivered) return;
    const now = this.now();
    thread.evaluating.delivered = now;
    thread.evaluating.deadline = new Date(Date.parse(now) + policy.evalTimeoutMs).toISOString();
    this.repo.threads.save(thread);
  }
  /**
   * An Eval past its deadline queues its Triggers again for a fresh Eval, up to `REQUEUES` times in a row, so a busy
   * assessor does not drop requests; after that it is recorded unavailable.
   */
  private expire(thread: Thread): void {
    const expired = (thread.expired ?? 0) + 1;
    if (expired > REQUEUES) {
      this.finish(thread, thread.evaluating!, {
        kind: 'unavailable',
        reason: [{ code: 'timeout' }],
      });
      return;
    }
    const { id, triggerIds } = thread.evaluating!;
    delete thread.evaluating;
    thread.expired = expired;
    thread.pending = [
      ...triggerIds,
      ...thread.pending.filter((item) => !triggerIds.includes(item)),
    ];
    this.repo.threads.save(thread);
    this.options.assessor.release?.(id);
  }
  /** Start one Eval of the Triggers queued on a Thread, judged by the gate, and ask the assessor for it. */
  start(threadKeyValue: string, policy: Policy): void {
    const thread = this.repo.threads.get(threadKeyValue)!;
    const at = this.now();
    // A person's follow-up a ticket still decides is that ticket's: one an older version queued leaves the queue without a Decision.
    const delivered = (id: string) => {
      const trigger = this.repo.triggers.get(id);
      return !!trigger && this.owners(trigger).length > 0;
    };
    if (thread.pending.some(delivered)) {
      const followups = thread.pending.filter(delivered);
      thread.pending = thread.pending.filter((id) => !followups.includes(id));
      this.repo.threads.save(thread);
      for (const triggerId of followups) this.emit('trigger.followup', { triggerId });
      if (!thread.pending.length) return;
    }
    // Triggers that already originated a ticket cannot lend authority to a new evaluation or spawn a duplicate ticket.
    const accepted = this.accepted(thread.key);
    const started = thread.pending.filter((id) => accepted.has(id));
    const startedTicket = (id: string): Reason => ({
      code: 'startedTicket',
      triggerId: id,
      values: { ticket: accepted.get(id)!.ticketId! },
    });
    if (started.length) this.ignore(thread, started, started.map(startedTicket), policy, at);
    const triggers = thread.pending.flatMap((id) => {
      const trigger = this.repo.triggers.get(id);
      return trigger ? [trigger] : [];
    });
    const tickets = this.ticketsOnThread(thread);
    const reasons: Reason[] = [];
    let strongest: { trigger: Trigger; strength: Strength; basis: MandateBasis } | undefined;
    for (const trigger of triggers) {
      const gate = policy.gate(trigger, thread, tickets);
      if (!gate.admissible) {
        reasons.push({ code: gate.reason, triggerId: trigger.id });
        continue;
      }
      const later = gate.strength === strongest?.strength && trigger.at >= strongest.trigger.at;
      const weaker =
        !strongest || stronger(strongest.strength, gate.strength) !== strongest.strength;
      if (weaker || later) strongest = { trigger, strength: gate.strength, basis: gate.basis };
    }
    if (!strongest) {
      if (thread.pending.length)
        this.ignore(
          thread,
          [...thread.pending],
          reasons.length ? reasons : [{ code: 'noAdmissible' }],
          policy,
          at
        );
      this.repo.threads.save(thread);
      return;
    }
    const evalId = key('eval', thread.key, policy.version, at, ...thread.pending);
    const deadline = new Date(Date.parse(at) + policy.evalTimeoutMs).toISOString();
    const {
      strength,
      trigger: { actor },
      basis,
    } = strongest;
    thread.evaluating = {
      id: evalId,
      threadKey: thread.key,
      triggerIds: thread.pending,
      primary: strongest.trigger.id,
      strength,
      actor,
      basis,
      policyVersion: policy.version,
      startedAt: at,
      deadline,
    };
    thread.pending = [];
    this.repo.threads.save(thread);
    for (const trigger of triggers) {
      this.repo.triggers.saveDisposition(trigger.id, {
        ...(this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at }),
        evalId,
      });
    }
    this.emit('eval.started', {
      evalId,
      threadKey: thread.key,
      triggerIds: thread.evaluating.triggerIds,
      strength: strongest.strength,
    });
    this.options.assessor.request(this.candidateOf(thread));
  }
  /** The candidate of the Eval that holds `triggerId`, or undefined while no Eval holds it. */
  candidate(triggerId: string): Candidate | undefined {
    const thread = this.holding(triggerId);
    return thread && this.candidateOf(thread);
  }
  /**
   * Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does.
   * @throws UserError when the Trigger is unknown or not admissible, `outcome.evalId` names an Eval that has finished, a
   * ticket's worker still decides the Trigger and the outcome is not a stop, or an inferred candidate is accepted outside `auto`
   * mode or without enabled matching rules.
   */
  decide(triggerId: string, outcome: Outcome): Decision {
    const trigger = this.repo.triggers.get(triggerId);
    if (!trigger) throw new UserError('unknownTrigger');
    const held = this.holding(triggerId);
    if (outcome.evalId && held?.evaluating?.id !== outcome.evalId)
      throw new UserError('evalFinished', { eval: outcome.evalId });
    // Prevent a replayed trigger that already created a ticket from spawning a second one.
    const earlier =
      outcome.kind === 'accept'
        ? this.accepted(threadKey(trigger.threads[0]!)).get(triggerId)
        : undefined;
    if (earlier) {
      // Only an Eval started by an earlier version can still hold it; reassess the remaining triggers without it, or ignore it if alone.
      const others = held?.evaluating?.triggerIds.filter((id) => id !== triggerId) ?? [];
      if (held && others.length)
        this.reassess(held, { code: 'acceptedBefore', values: { trigger: triggerId } }, [
          triggerId,
        ]);
      else if (held) {
        this.finish(held, held.evaluating!, {
          kind: 'ignore',
          reason: [{ code: 'startedTicket', triggerId, values: { ticket: earlier.ticketId! } }],
        });
      }
      return earlier;
    }
    // A follow-up that reached a ticket is its worker's to judge: the main Session may only stop the work on it.
    if (outcome.kind !== 'stop') this.leftToWorkers(trigger);
    const thread = held ?? this.thread(trigger.threads[0]!);
    const evaluation =
      held?.evaluating ??
      this.directEval(
        thread,
        trigger,
        outcome.kind,
        outcome.kind === 'stop' ? outcome.ticketId : undefined
      );
    // An inferred candidate is accepted only on enabled rules its assessment matched, while assessments may accept.
    if (
      outcome.kind === 'accept' &&
      evaluation.strength !== 'explicit' &&
      !this.policy().admitsInferred(outcome.rules ?? [])
    ) {
      throw new UserError('notExplicit');
    }
    return this.decideEval(thread, evaluation, outcome);
  }
  /**
   * Queue a stored Trigger for a fresh Eval on its primary Thread and emit `trigger.requeued`; returns false while an Eval holds it.
   * @throws UserError when the Trigger is unknown.
   */
  reevaluate(triggerId: string): boolean {
    if (!this.requeue(triggerId)) return false;
    this.emit('trigger.requeued', { triggerId });
    return true;
  }
  /** Queue a Trigger for a fresh Eval on its primary Thread; false while an Eval holds it. */
  private requeue(triggerId: string): boolean {
    const trigger = this.repo.triggers.get(triggerId);
    if (!trigger) throw new UserError('unknownTrigger');
    if (this.holding(triggerId)) return false;
    this.queueForEval(trigger);
    const disposition = this.repo.triggers.disposition(triggerId) ?? { fanout: [], at: this.now() };
    this.repo.triggers.saveDisposition(triggerId, { ...disposition, requeued: true });
    return true;
  }
  /**
   * Record that a ticket's Executor hands back a Trigger that reached it as beyond the ticket, and queue it for a fresh Eval
   * when the ticket decided it and no other ticket still does (see `handBack`): the gate judges it as any message on its
   * Thread, and its candidate carries the reasons, so no requeue notice comes before it. The ticket keeps its Subscription,
   * and hands a Trigger back once.
   * @returns whether it was queued: false while another ticket decides it, and for one the ticket did not decide.
   */
  handback(ticketId: string, triggerId: string, reason: string): boolean {
    const ticket = this.require(ticketId);
    if (!ticket.inputs.some((input) => input.kind === 'trigger' && input.triggerId === triggerId))
      throw new UserError('notReached');
    if (
      this.repo.triggers
        .disposition(triggerId)
        ?.handbacks?.some((item) => item.ticketId === ticketId)
    )
      throw new UserError('handedBack');
    return this.handBack(ticketId, this.repo.triggers.get(triggerId)!, reason);
  }
  /**
   * Marks an `unavailable` Decision dismissed so the overview lists it no more.
   * @throws UserError when the Decision is unknown or not `unavailable`.
   */
  dismiss(decisionId: string): Decision {
    const decision = this.repo.decisions.get(decisionId);
    if (decision?.kind !== 'unavailable') throw new UserError('unknownProblem');
    decision.dismissed = true;
    this.repo.decisions.save(decision);
    return decision;
  }
  /** Take a Trigger out of its Thread's queue because it was routed by hand. */
  withdraw(trigger: Trigger): void {
    const thread = this.repo.threads.get(threadKey(trigger.threads[0]!));
    if (!thread?.pending.includes(trigger.id)) return;
    thread.pending = thread.pending.filter((id) => id !== trigger.id);
    this.repo.threads.save(thread);
  }
  /**
   * End the Eval that holds a Trigger routed to a ticket, since the ticket has it now: one that holds other Triggers too
   * queues them again for a fresh Eval without it.
   */
  routed(triggerId: string, ticketId: string): void {
    const held = this.holding(triggerId);
    const reason: Reason = { code: 'routed', values: { ticket: ticketId } };
    if (held?.evaluating?.triggerIds.length === 1)
      this.finish(held, held.evaluating, { kind: 'ignore', reason: [reason] });
    else if (held) this.reassess(held, { ...reason, triggerId }, [triggerId]);
  }
  /** Start the Evals in progress again under the new Policy version, and say that it changed. */
  policyChanged(from: string, to: string): void {
    for (const thread of this.repo.threads.active())
      if (thread.evaluating) this.reassess(thread, { code: 'policyChanged' });
    this.emit('policy.changed', { from, to });
  }
  /** End a Thread's Eval as unavailable for `reason` and queue its Triggers, except `without`, for a new Eval ahead of the others. */
  private reassess(thread: Thread, reason: Reason, without: string[] = []): Decision {
    const ids = thread.evaluating!.triggerIds.filter((id) => !without.includes(id));
    const decision = this.finish(thread, thread.evaluating!, {
      kind: 'unavailable',
      reason: [reason],
    });
    const current = this.repo.threads.get(thread.key)!;
    current.pending = [...ids, ...current.pending.filter((id) => !ids.includes(id))];
    this.repo.threads.save(current);
    return decision;
  }
  /** The Thread whose Eval holds a Trigger: an Eval runs on the primary Thread of each Trigger it holds. */
  private holding(triggerId: string): Thread | undefined {
    const trigger = this.repo.triggers.get(triggerId);
    const thread = trigger && this.repo.threads.get(threadKey(trigger.threads[0]!));
    return thread?.evaluating?.triggerIds.includes(triggerId) ? thread : undefined;
  }
  private candidateOf(thread: Thread): Candidate {
    const evaluation = thread.evaluating!;
    const triggers = evaluation.triggerIds.flatMap((id) => {
      const trigger = this.repo.triggers.get(id);
      return trigger ? [trigger] : [];
    });
    const { id: evalId, strength, policyVersion } = evaluation;
    return {
      evalId,
      thread,
      triggers,
      strength,
      policyVersion,
      tickets: this.ticketsOnThread(thread),
    };
  }
  /**
   * Record that the queued Triggers `ids` of a Thread start no Eval, for `reason`, and take them out of its queue. Its id
   * differs from an Eval's, so it never replaces the Decision of an earlier Eval of the same Triggers.
   */
  private ignore(
    thread: Thread,
    ids: string[],
    reason: Reason[],
    policy: Policy,
    at: string
  ): void {
    const evaluation = {
      id: key('eval', thread.key, 'ignored', policy.version, at, ...ids),
      threadKey: thread.key,
      triggerIds: ids,
      strength: 'inferred' as const,
      actor: { source: thread.ref.source, id: '' },
      basis: { via: 'followup' as const },
      policyVersion: policy.version,
      startedAt: at,
      deadline: at,
    };
    this.record(thread, evaluation, { kind: 'ignore', reason });
    thread.pending = thread.pending.filter((id) => !ids.includes(id));
    delete thread.expired;
  }
  /**
   * The accept Decisions of the Triggers whose primary Thread is `threadKey`, by Trigger: what each one started. An Eval and
   * its Decision run on its Triggers' primary Thread, so the Thread's Decisions, read by their index, hold them all.
   */
  private accepted(threadKey: string): Map<string, Decision> {
    const accepted = new Map<string, Decision>();
    for (const decision of this.repo.decisions.byThread(threadKey)) {
      if (decision.kind !== 'accept' || !decision.ticketId) continue;
      for (const id of decision.triggerIds) if (!accepted.has(id)) accepted.set(id, decision);
    }
    return accepted;
  }
  /**
   * A gate-only Eval of one Trigger, for an outcome decided without a queued Eval, such as on a follow-up that reached a
   * ticket. It is decided at once, beside an Eval its Thread may have in progress, and takes the Trigger out of the queue.
   * Its id names the outcome's kind, so a stop and an accept of one message at the same moment are two Decisions.
   */
  private directEval(
    thread: Thread,
    trigger: Trigger,
    kind: AssessmentOutcome['kind'],
    ticketId?: string
  ): Evaluation {
    const policy = this.policy();
    const gate = policy.gate(trigger, thread, this.ticketsOnThread(thread));
    if (!gate.admissible) throw new UserError('notAdmissible', { reason: gate.reason });
    const at = this.now();
    if (thread.pending.includes(trigger.id)) {
      thread.pending = thread.pending.filter((id) => id !== trigger.id);
      this.repo.threads.save(thread);
    }
    const id = key(
      'eval',
      thread.key,
      'direct',
      trigger.id,
      kind,
      ...(ticketId ? [ticketId] : []),
      at
    );
    return {
      id,
      threadKey: thread.key,
      triggerIds: [trigger.id],
      primary: trigger.id,
      strength: gate.strength,
      actor: trigger.actor,
      basis: gate.basis,
      policyVersion: policy.version,
      startedAt: at,
      deadline: at,
    };
  }
  /** Apply an outcome to an Eval of a Thread: the one in progress, or a gate-only one. */
  private decideEval(thread: Thread, evaluation: Evaluation, outcome: AssessmentOutcome): Decision {
    const audit = outcome.audit ? { audit: outcome.audit } : {};
    // Requeue if Policy changed without a live policyChanged call (such as across an upgrade or restart).
    if (this.policy().version !== evaluation.policyVersion) {
      if (thread.evaluating?.id === evaluation.id)
        return this.reassess(thread, { code: 'policyChanged' });
      return this.finish(thread, evaluation, {
        kind: 'unavailable',
        reason: [{ code: 'policyChanged' }],
        ...audit,
      });
    }
    // An inferred candidate ignored without an assessment, from its card, says so beside the reason given.
    const unassessed =
      outcome.kind === 'ignore' && evaluation.strength !== 'explicit' && !outcome.audit
        ? [{ code: 'ignoredFromCard' }]
        : [];
    if (outcome.kind === 'ignore' || outcome.kind === 'unavailable')
      return this.finish(thread, evaluation, {
        kind: outcome.kind,
        reason: [...unassessed, ...reasonOf(outcome.reason)],
        ...audit,
      });
    if (outcome.kind === 'stop') {
      const ticket = this.repo.tickets.get(outcome.ticketId);
      if (!ticket || !liveTicket(ticket))
        return this.finish(thread, evaluation, {
          kind: 'ignore',
          reason: [{ code: 'stopUnknown' }],
          ...audit,
        });
      if (evaluation.strength !== 'explicit')
        return this.finish(thread, evaluation, {
          kind: 'ignore',
          reason: [{ code: 'stopNotExplicit' }],
          ...audit,
        });
      const decision = this.finish(thread, evaluation, {
        kind: 'stop',
        reason: reasonOf(outcome.reason),
        ticketId: ticket.id,
        ...audit,
      });
      this.tickets.end(
        ticket.id,
        'human',
        'stopped',
        this.now(),
        typeof outcome.reason === 'string' ? outcome.reason : undefined
      );
      return decision;
    }
    return this.accept(thread, evaluation, outcome);
  }
  /** Record an accept with the Mandate the Eval gives, and have Tickets create its ticket. */
  private accept(
    thread: Thread,
    evaluation: Evaluation,
    outcome: Extract<AssessmentOutcome, { kind: 'accept' }>
  ): Decision {
    const at = this.now();
    const basis = { ...evaluation.basis, ...(outcome.rules ? { rules: outcome.rules } : {}) };
    const { strength, policyVersion, actor } = evaluation;
    const mandate: Mandate = { strength, policyVersion, basis, actor, scope: outcome.scope };
    const ticketId = key('ticket', evaluation.id);
    const audit = outcome.audit ? { audit: outcome.audit } : {};
    const decision = this.finish(thread, evaluation, {
      kind: 'accept',
      reason: reasonOf(outcome.reason),
      ...audit,
      mandate,
      ticketId,
    });
    this.tickets.create(ticketId, decision.id, mandate, evaluation, outcome, at);
    return decision;
  }
  /** Record an Eval's Decision; the Thread's own Eval ends with it, while a gate-only one leaves the Thread's Eval going. */
  private finish(thread: Thread, evaluation: Evaluation, outcome: Finished): Decision {
    const decision = this.record(thread, evaluation, outcome);
    // Direct (gate-only) evaluations do not clear the thread's active evaluation.
    if (thread.evaluating?.id !== evaluation.id) return decision;
    delete thread.evaluating;
    delete thread.expired;
    this.repo.threads.save(thread);
    this.options.assessor.release?.(evaluation.id);
    return decision;
  }
  private record(thread: Thread, evaluation: Evaluation, outcome: Finished): Decision {
    const at = this.now();
    const decision: Decision = {
      id: key('decision', evaluation.id),
      evalId: evaluation.id,
      threadKey: thread.key,
      triggerIds: evaluation.triggerIds,
      policyVersion: evaluation.policyVersion,
      at,
      kind: outcome.kind,
      reason: outcome.reason,
      strength: evaluation.strength,
      ...(outcome.ticketId ? { ticketId: outcome.ticketId } : {}),
      ...(outcome.mandate ? { mandate: outcome.mandate } : {}),
      ...(outcome.audit ? { audit: outcome.audit } : {}),
    };
    this.repo.decisions.save(decision);
    for (const id of evaluation.triggerIds) {
      const disposition = this.repo.triggers.disposition(id) ?? { fanout: [], at };
      this.repo.triggers.saveDisposition(id, {
        ...disposition,
        evalId: evaluation.id,
        decisionId: decision.id,
      });
    }
    this.emit('decision.recorded', {
      decisionId: decision.id,
      kind: decision.kind,
      threadKey: thread.key,
    });
    return decision;
  }
}
