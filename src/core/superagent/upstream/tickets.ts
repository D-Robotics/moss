/** Tickets: their lifecycle from an accept to their end, their Subscriptions and their Inputs. */
import { key } from './ids.js';
import { UserError } from './errors.js';
import {
  latestAssignment,
  liveTicket,
  readUntil,
  runningAssignment,
  settled,
  threadKey,
  waitsForPerson,
} from './model.js';
import type {
  Assignment,
  ChannelRef,
  Evaluation,
  Follow,
  Mandate,
  PolicyEffect,
  ThreadRef,
  Ticket,
  TicketEndBy,
  TicketInput,
  TicketOutcome,
  Trigger,
  TriggerDisposition,
} from './model.js';
import type { AssessmentOutcome } from './ports.js';
import { EnginePart, type EngineOptions } from './part.js';
import type { Replies } from './replies.js';
import { canRetry } from './stage.js';

const sameChannel = (a: ChannelRef, b: ChannelRef): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
/** Whether an Input is a message no person wrote, such as CI's, a bot's, or the main Session's note. */
export const automatic = (input: TicketInput | undefined): boolean =>
  input?.kind === 'note' || (input?.kind === 'trigger' && !input.human);
/**
 * Whether a ticket's worker read a Trigger Input before `until`, its latest report or turn end: its Session took the message
 * into a step before then. One delivered before reads were recorded counts as read once it reached the worker by then.
 */
const readBefore = (input: Extract<TicketInput, { kind: 'trigger' }>, until: string): boolean =>
  input.readAt === undefined
    ? (input.deliveredAt && input.deliveredAt > input.at ? input.deliveredAt : input.at) <= until
    : !!input.readAt && input.readAt < until;
const STATUS_REQUEST =
  'Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.';

/**
 * Manages each ticket's lifecycle: creates the ticket for an accept decision with its Mandate, Subscriptions, and first
 * Assignment, binds and attaches Threads, adds Inputs, resumes, retries, restarts, and ends tickets, and drops Subscriptions.
 * Coordinates with Replies for the acknowledgement an accept carries and with Executor to start, deliver to, and stop assignments.
 * Intake, Evals, Assignments, and Engine delegate ticket and subscription mutations here.
 */
export class Tickets extends EnginePart {
  constructor(
    options: EngineOptions,
    private readonly replies: Replies
  ) {
    super(options);
  }

  /**
   * Create the ticket an accept decided, under `mandate`, with the Channels and Threads of the Eval's Triggers, its first
   * Assignment, and the acknowledgement the accept carries, and queue its launch. Its origin is the admissible Trigger that
   * gave the Eval its strength, or the Eval's last Trigger for an Eval recorded before `primary` existed.
   */
  create(
    id: string,
    decisionId: string,
    mandate: Mandate,
    evaluation: Pick<Evaluation, 'triggerIds' | 'primary'>,
    outcome: Extract<AssessmentOutcome, { kind: 'accept' }>,
    at: string
  ): void {
    const { triggerIds } = evaluation;
    // Fall back to the last trigger for Evals recorded before `primary` existed.
    const primary = this.repo.triggers.get(evaluation.primary ?? triggerIds.at(-1)!);
    const origin = { triggerId: primary?.id ?? triggerIds[0]!, triggerIds };
    let ticket: Ticket = {
      id,
      title: outcome.title,
      decisionId,
      mandate,
      channels: [],
      assignments: [],
      inputs: [],
      undelivered: [],
      createdAt: at,
      updatedAt: at,
      origin,
    };
    for (const triggerId of triggerIds) {
      const channel = this.repo.triggers.get(triggerId)?.channel;
      if (channel && !ticket.channels.some((item) => sameChannel(item, channel)))
        ticket.channels.push(channel);
    }
    ticket = this.options.prepareTicket?.(ticket, outcome) ?? ticket;
    const assignment = this.newAssignment(ticket);
    this.repo.tickets.save(ticket);
    for (const triggerId of triggerIds)
      for (const ref of this.repo.triggers.get(triggerId)?.threads ?? []) this.subscribe(id, ref);
    if (outcome.acknowledgement && primary)
      this.replies.acknowledgeAccepted(id, primary, outcome.acknowledgement);
    this.options.executor.start(this.require(id), assignment);
    this.emit('ticket.created', { ticketId: id, decisionId, strength: mandate.strength });
  }
  /**
   * Subscribes an open ticket to `thread` and records it in `ticket.follows` (`own` when opened by the ticket).
   * @throws UserError when the ticket is unknown or has ended.
   */
  bind(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded');
    this.subscribe(ticketId, thread);
    const ticket = this.require(ticketId);
    const followed = threadKey(thread);
    const follow = ticket.follows?.find((item) => item.thread === followed);
    // Re-binding a thread reopens it if previously closed; `own` remains true once set.
    if (follow) {
      follow.own ||= own;
      delete follow.closed;
    } else ticket.follows = [...(ticket.follows ?? []), { thread: followed, own }];
    ticket.updatedAt = this.now();
    this.repo.tickets.save(ticket);
    return ticket;
  }
  /**
   * Record that a Thread open tickets follow closed, and end each one done with its Threads (see `followsDone`), unless its
   * work has not finished (see `unfinished`); such work ends the ticket once it reports ready.
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    const closed = threadKey(thread);
    for (const ticket of this.repo.tickets.open()) {
      const follow = ticket.follows?.find((item) => item.thread === closed && !item.closed);
      if (!follow) continue;
      follow.closed = { at, outcome };
      this.repo.tickets.save(ticket);
      const done = this.followsDone(ticket);
      if (!done || this.unfinished(ticket, at)) continue;
      // Work resumed after the close and finished ends now.
      const resumed = Date.parse(latestAssignment(ticket)?.createdAt ?? '') > Date.parse(at);
      this.end(ticket.id, 'executor', done.outcome, resumed ? this.now() : done.at);
    }
  }
  /**
   * How a ticket that follows Threads is done with them: once no Thread it opened (`own`) is still open, or, when it opened none,
   * once every one it follows closed. It ends as the latest close among those Threads did; undefined while it is not done.
   */
  followsDone(ticket: Ticket): Follow['closed'] {
    const follows = ticket.follows ?? [];
    const own = follows.filter((item) => item.own);
    const counted = own.length ? own : follows;
    if (!counted.length || counted.some((item) => !item.closed)) return undefined;
    return counted
      .map((item) => item.closed!)
      .sort((a, b) => a.at.localeCompare(b.at))
      .at(-1);
  }
  /**
   * The Trigger to attach to a ticket, once the ticket may take it.
   * @throws UserError when the trigger or ticket is unknown, a ticket's worker still decides the trigger, a person stopped the ticket, or an ended ticket's Mandate no longer revalidates.
   */
  attachable(ticketId: string, triggerId: string): Trigger {
    const trigger = this.repo.triggers.get(triggerId);
    if (!trigger) throw new UserError('unknownTrigger');
    // A follow-up that reached a ticket goes elsewhere only once the workers that decide it hand it back.
    this.leftToWorkers(trigger);
    const current = this.require(ticketId);
    if (current.ended?.by === 'human') throw new UserError('ticketStopped');
    if (!liveTicket(current) && !this.policy().revalidate(current.mandate))
      throw new UserError('mandateRevoked');
    return trigger;
  }
  /**
   * Subscribe a ticket to an attached Trigger's Threads and add the Trigger as an Input, with its note. The ticket's worker
   * then decides it, as it decides a message that reached the ticket on its own Thread; a worker that does not hold the
   * message as its ticket's takes it as a new Input, which wakes an ended ticket as any attached message does.
   */
  attach(ticketId: string, trigger: Trigger, note?: string): void {
    for (const ref of trigger.threads) this.subscribe(ticketId, ref);
    // A person's sending it to Eval, which routed it here, is over, and so is the ticket's reading it for context only.
    const current: TriggerDisposition = this.repo.triggers.disposition(trigger.id) ?? {
      fanout: [],
      at: this.now(),
    };
    const { context, requeued, ...disposition } = current;
    const followed = context?.filter((id) => id !== ticketId);
    this.repo.triggers.saveDisposition(trigger.id, {
      ...disposition,
      fanout: [...new Set([...disposition.fanout, ticketId])],
      ...(followed?.length ? { context: followed } : {}),
    });
    const ticket = this.require(ticketId);
    const id = key('input', ticketId, 'trigger', trigger.id);
    const existing = ticket.inputs.find((input) => input.id === id);
    const at = this.now();
    const input = (inputId: string): TicketInput => ({
      id: inputId,
      kind: 'trigger',
      triggerId: trigger.id,
      at,
      ...(note ? { note } : {}),
      ...(trigger.human ? { human: true } : {}),
    });
    if (existing?.kind !== 'trigger') this.addInput(ticket, input(id));
    else if (note && ticket.undelivered.includes(id)) {
      existing.note = note;
      ticket.updatedAt = at;
      this.repo.tickets.save(ticket);
    }
    // A person sent it to Eval, or the ticket let it go before its worker took it up, read it for context only, or ended after
    // its worker had it, so the worker gets it again.
    else if (
      requeued ||
      !current.fanout.includes(ticketId) ||
      context?.includes(ticketId) ||
      !liveTicket(ticket)
    ) {
      this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'attached', at)));
    }
    // The worker has the message already, so the note comes with it again.
    else if (note)
      this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'note', note)));
  }
  /**
   * Ask a running worker whose latest report is `waiting` for a status report; leaves any other ticket alone.
   * @returns whether the status request input was queued.
   * @throws UserError when the ticket is unknown.
   */
  requestStatus(ticketId: string): boolean {
    const ticket = this.require(ticketId);
    if (!liveTicket(ticket) || runningAssignment(ticket)?.report?.state !== 'waiting') return false;
    this.addInput(ticket, {
      id: `status:${ticketId}:${ticket.updatedAt}`,
      kind: 'text',
      text: STATUS_REQUEST,
      at: this.now(),
    });
    return true;
  }
  /**
   * Stops a ticket on behalf of a human, ending any active assignments.
   * @throws UserError when the ticket is unknown.
   */
  stop(ticketId: string, reason?: string): Ticket {
    this.end(ticketId, 'human', 'stopped', this.now(), reason);
    return this.require(ticketId);
  }
  /**
   * Ends the stalled assignment of a retryable open ticket (`failed`, `blocked`, or failed input delivery) and starts a new one.
   * @throws UserError when the ticket is unknown or not retryable.
   */
  retry(ticketId: string): Ticket {
    const ticket = this.require(ticketId);
    const latest = latestAssignment(ticket);
    if (!canRetry(ticket) || !latest) throw new UserError('notRetryable');
    this.endAssignment(ticket, latest, 'retried');
    this.requeueUntaken(ticket, latest);
    const assignment = this.newAssignment(ticket);
    ticket.updatedAt = this.now();
    this.repo.tickets.save(ticket);
    this.options.executor.stop(ticket, latest, 'retried');
    this.options.executor.start(ticket, assignment);
    return ticket;
  }
  /**
   * Drops a ticket's Subscription to a Thread its worker found unrelated, and hands back, with `reason`, the person's messages there that the ticket decides.
   * @throws UserError when the ticket is unknown, or `thread` is an origin thread, a bound `follows` thread, or not subscribed.
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    const ticket = this.require(ticketId);
    if (this.source(ticket)?.threads.some((ref) => threadKey(ref) === thread))
      throw new UserError('sourceThread');
    if (ticket.follows?.some((item) => item.thread === thread))
      throw new UserError('followedThread');
    if (!this.repo.threads.get(thread)?.subscriptions.includes(ticketId))
      throw new UserError('notFollowing');
    this.dropSubscriptions(thread, 'executor', ticketId, reason);
    // Its worker found the Thread is not its ticket's: it hands back, with its reason, the person's messages there it decides.
    for (const trigger of this.triggersOf(ticket)) {
      if (
        trigger.threads.some((ref) => threadKey(ref) === thread) &&
        this.owners(trigger).includes(ticketId)
      )
        this.handBack(ticketId, trigger, reason);
    }
  }
  /**
   * Tell each open ticket a Policy change bears on how it does, oldest first, so their deliveries queue in the order they
   * were accepted; the others are left alone.
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect>): void {
    const at = this.now();
    // Iterate tickets oldest first so deliveries queue in acceptance order.
    for (const ticket of this.repo.tickets
      .open()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const effect = effects.get(ticket.id);
      // Include `at` in the input key so repeated transitions between the same policy versions still record a new input.
      if (effect)
        this.addInput(ticket, {
          id: key('input', ticket.id, 'policy', from, to, at),
          kind: 'policy-changed',
          from,
          to,
          at,
          effect,
        });
    }
  }
  /**
   * Drop a Thread's Subscriptions, every ticket's or only `ticketId`'s, and say so; false when none dropped. A ticket that
   * followed the Thread follows it no more, so its close no longer ends the ticket. Each ticket keeps deciding the messages
   * it received from the Thread.
   */
  dropSubscriptions(
    thread: string,
    by: 'person' | 'executor',
    ticketId?: string,
    reason?: string
  ): boolean {
    const current = this.repo.threads.get(thread);
    const tickets =
      current?.subscriptions.filter((id) => ticketId === undefined || id === ticketId) ?? [];
    if (!current || !tickets.length) return false;
    current.subscriptions = current.subscriptions.filter((id) => !tickets.includes(id));
    this.repo.threads.save(current);
    for (const id of tickets) {
      const ticket = this.repo.tickets.get(id);
      if (!ticket?.follows?.some((item) => item.thread === thread)) continue;
      const { follows: before, ...rest } = ticket;
      const follows = before.filter((item) => item.thread !== thread);
      this.repo.tickets.save(follows.length ? { ...rest, follows } : rest);
    }
    for (const id of tickets)
      this.emit('thread.unsubscribed', {
        threadKey: current.key,
        ticketId: id,
        by,
        ...(reason ? { reason } : {}),
      });
    return true;
  }
  /**
   * Add an Input once (idempotently) and ask the Executor to deliver it, or to launch again a pending Assignment whose launch
   * failed once no person is waited for: a Policy change alone does not launch it again.
   */
  addInput(ticket: Ticket, input: TicketInput): void {
    if (ticket.inputs.some((existing) => existing.id === input.id)) return;
    ticket.inputs.push(input);
    ticket.updatedAt = this.now();
    // Hold back automated inputs while the worker is waiting on a person.
    const held = liveTicket(ticket) && automatic(input) && waitsForPerson(ticket);
    if (!held) ticket.undelivered.push(input.id);
    this.repo.tickets.save(ticket);
    if (!liveTicket(ticket) || held) return;
    const running = runningAssignment(ticket),
      latest = latestAssignment(ticket);
    if (running) this.options.executor.deliver(ticket, running);
    else if (latest?.state === 'pending' && !waitsForPerson(ticket))
      this.options.executor.start(ticket, latest);
  }
  /**
   * Resume an ended ticket under its unchanged Mandate when a person's message on one of its Threads waits for it: no Eval
   * and no Decision, since nothing new is authorized. One whose Mandate the current Policy no longer holds stays ended and
   * takes nothing (see `refuse`). While processing is paused the message waits, and the first pass after the pause resumes
   * the ticket under the Policy then. Reads the ticket afresh, so it is idempotent and leaves an already-resumed ticket alone.
   */
  wake(ticketId: string): void {
    const ticket = this.repo.tickets.get(ticketId);
    if (!ticket || liveTicket(ticket) || ticket.ended?.by === 'human' || !ticket.undelivered.length)
      return;
    const policy = this.policy();
    if (policy.paused) return;
    if (!policy.revalidate(ticket.mandate)) {
      this.refuse(ticket);
      return;
    }
    // Only a human's message resumes an ended ticket; bot/CI triggers wait alongside inputs from before the ticket ended.
    const first = ticket.undelivered
      .map((id) => ticket.inputs.find((input) => input.id === id))
      .find((input) => input?.kind === 'trigger' && input.human);
    if (first?.kind !== 'trigger') return;
    const at = this.now();
    delete ticket.ended;
    ticket.updatedAt = at;
    const assignment = this.newAssignment(ticket);
    // Prepend the resumed marker so it is delivered ahead of the waiting messages.
    const resumed: TicketInput = {
      id: key('input', ticket.id, 'resumed', first.triggerId),
      kind: 'resumed',
      triggerId: first.triggerId,
      at,
    };
    ticket.inputs.push(resumed);
    ticket.undelivered.unshift(resumed.id);
    this.repo.tickets.save(ticket);
    this.options.executor.start(ticket, assignment);
    this.emit('ticket.resumed', { ticketId, triggerId: first.triggerId });
  }
  /** The Triggers of a ticket's trigger Inputs, or of those of them whose Input ids are `ids`. */
  private triggersOf(ticket: Ticket, ids?: readonly string[]): Trigger[] {
    return ticket.inputs.flatMap((input) =>
      input.kind === 'trigger' && (!ids || ids.includes(input.id))
        ? (this.repo.triggers.get(input.triggerId) ?? [])
        : []
    );
  }
  /**
   * Whether a ticket's worker took a person's message up, by acknowledging or answering it. A message acknowledged before
   * acknowledgements were recorded on it has only the acknowledgement's message in the outbox.
   */
  private takenUp(ticket: Ticket, trigger: Trigger): boolean {
    const acked = this.repo.triggers.disposition(trigger.id)?.acked;
    return acked
      ? acked.includes(ticket.id)
      : this.options.outbox.status(key('ack', trigger.id)) !== undefined;
  }
  /** The person's messages among a ticket's Inputs `ids` that it decides and its worker did not take up. */
  private untaken(ticket: Ticket, ids: readonly string[]): Trigger[] {
    return this.triggersOf(ticket, ids).filter(
      (trigger) => this.owners(trigger).includes(ticket.id) && !this.takenUp(ticket, trigger)
    );
  }
  /**
   * A ticket that ended, or cannot resume, lets go of the messages its worker never received, `waiting`, and of the person's
   * messages it decided but may not have taken up, `left`: it no longer counts as having reached them, and each of `left`
   * that no other ticket decides goes to Eval, as a person's message that reached no ticket does, unless a ticket took it
   * up, a Decision settled it, or it is the message a stop ended this ticket on.
   */
  private letGo(ticketId: string, waiting: readonly Trigger[], left: readonly Trigger[]): void {
    for (const trigger of [...waiting, ...left]) {
      const disposition = this.repo.triggers.disposition(trigger.id);
      if (disposition?.fanout.includes(ticketId)) {
        this.repo.triggers.saveDisposition(trigger.id, {
          ...disposition,
          fanout: disposition.fanout.filter((id) => id !== ticketId),
        });
      }
    }
    for (const trigger of left) {
      const disposition = this.repo.triggers.disposition(trigger.id);
      const decision = disposition?.decisionId
        ? this.repo.decisions.get(disposition.decisionId)
        : undefined;
      // The main Session that stopped this ticket on the message decides the rest of it itself, unless a ticket handed it back.
      const stopped =
        decision?.kind === 'stop' &&
        decision.ticketId === ticketId &&
        !disposition?.handbacks?.length;
      const decided = !!decision && (settled(decision) || stopped);
      if (!this.owners(trigger).length && !disposition?.acked?.length && !decided)
        this.queueForEval(trigger);
    }
  }
  /** An ended ticket that cannot resume takes none of the messages that waited for it (see `letGo`). */
  private refuse(ticket: Ticket): void {
    const waiting = this.triggersOf(ticket, ticket.undelivered),
      left = this.untaken(ticket, ticket.undelivered);
    ticket.undelivered = [];
    this.repo.tickets.save(ticket);
    this.letGo(ticket.id, waiting, left);
  }
  /** Replace a ticket's running Assignment with a new one that receives `note` first, and queue it for launch. */
  restart(ticket: Ticket, running: Assignment, reason: string, note: string): void {
    this.endAssignment(ticket, running, reason);
    this.requeueUntaken(ticket, running);
    const assignment = this.newAssignment(ticket);
    const at = this.now();
    const input: TicketInput = {
      id: key('input', ticket.id, 'restart', assignment.id),
      kind: 'text',
      text: note,
      at,
    };
    ticket.inputs.push(input);
    ticket.undelivered.push(input.id);
    ticket.updatedAt = at;
    this.repo.tickets.save(ticket);
    this.options.executor.start(ticket, assignment);
  }
  /**
   * Put back, ahead of what waits, the Trigger Inputs delivered to `replaced` that no step of its worker took: a cancel may
   * have dropped them, or a step that claimed them was cut off, and the new Assignment's launch takes a copy still waiting
   * in the Session out, so its delivery is the only one. An earlier end let go of what earlier Assignments left.
   */
  private requeueUntaken(ticket: Ticket, replaced: Assignment): void {
    const untaken = ticket.inputs.filter(
      (input) =>
        input.kind === 'trigger' &&
        input.readAt === null &&
        input.deliveredTo === replaced.id &&
        !ticket.undelivered.includes(input.id)
    );
    ticket.undelivered.unshift(...untaken.map((input) => input.id));
  }
  /**
   * End a ticket with its outcome. `at` records when the ending fact happened, such as a PR merge, and `reason` says
   * why in words, by default the outcome. The ticket lets go (see `letGo`) of the messages its worker never received, and of
   * the person's messages it decides that its worker did not read before its latest report or turn end, the report that
   * ends the ticket included (see `readBefore`), and neither acknowledged, answered nor handed back: one may have come while
   * the worker wrote the report that ends the ticket, or after its turn ended, and either way it can no longer hand it back.
   */
  end(
    ticketId: string,
    by: TicketEndBy,
    outcome: TicketOutcome,
    at = this.now(),
    reason?: string
  ): void {
    const ticket = this.require(ticketId);
    if (!liveTicket(ticket)) return;
    const stopping = ticket.assignments.filter((assignment) => assignment.state !== 'ended');
    const why = reason && reason !== outcome ? { reason } : {};
    const until = readUntil(ticket);
    const waiting = this.triggersOf(ticket, ticket.undelivered);
    const left = this.untaken(
      ticket,
      ticket.inputs.flatMap((input) =>
        input.kind === 'trigger' &&
        (!readBefore(input, until) || ticket.undelivered.includes(input.id))
          ? [input.id]
          : []
      )
    );
    // An end dated earlier, such as a PR's merge, does not move the ticket's last change back.
    ticket.ended = { at, by, outcome, ...why };
    ticket.undelivered = [];
    ticket.updatedAt = this.now();
    delete ticket.attention;
    delete ticket.delivery;
    // The Assignments the end stops end with it; the ticket's end says why.
    for (const assignment of stopping) {
      assignment.state = 'ended';
      assignment.endedAt = at;
    }
    this.repo.tickets.save(ticket);
    this.letGo(ticketId, waiting, left);
    this.emit('ticket.ended', { ticketId, by, outcome, ...why });
    for (const assignment of stopping)
      this.options.executor.stop(ticket, assignment, reason ?? outcome);
  }
  /**
   * Whether a ticket's work has not finished at a close at `at`: its worker took up a person's message the ticket decides and
   * has not reported other than progress, or ended a turn, since its Session took that message into a step, or work resumed
   * after the close, whose Assignment started after it, has no ready report or Input arrived after that report; a Policy
   * change asks for no work.
   */
  private unfinished(ticket: Ticket, at: string): boolean {
    const until = readUntil(ticket, false);
    const taken = this.triggersOf(
      ticket,
      ticket.inputs.flatMap((input) =>
        input.kind === 'trigger' && !readBefore(input, until) ? [input.id] : []
      )
    ).some((trigger) => this.owners(trigger).includes(ticket.id) && this.takenUp(ticket, trigger));
    const latest = latestAssignment(ticket);
    if (taken || !(Date.parse(latest?.createdAt ?? '') > Date.parse(at))) return taken;
    const report = latest?.report;
    const later = ticket.inputs.some(
      (input) =>
        input.kind !== 'policy-changed' && Date.parse(input.at) > Date.parse(report?.at ?? '')
    );
    return report?.state !== 'ready' || ticket.undelivered.length > 0 || later;
  }
  /** Add a pending Assignment; a failed delivery to the one before it no longer concerns the ticket. */
  private newAssignment(ticket: Ticket): Assignment {
    const assignment: Assignment = {
      id: key('assignment', ticket.id, String(ticket.assignments.length)),
      state: 'pending',
      createdAt: this.now(),
    };
    ticket.assignments.push(assignment);
    delete ticket.delivery;
    return assignment;
  }
  private endAssignment(ticket: Ticket, assignment: Assignment, reason: string): void {
    assignment.state = 'ended';
    assignment.endedAt = this.now();
    assignment.endedReason = reason;
    this.emit('assignment.ended', { ticketId: ticket.id, assignmentId: assignment.id, reason });
  }
  /**
   * Give an open ticket's Executor a fact as a note Input, such as what another ticket found; it grants nothing (see `TicketInput`).
   * @throws UserError when the ticket is unknown or has ended.
   */
  note(ticketId: string, text: string): Ticket {
    const ticket = this.require(ticketId);
    if (!liveTicket(ticket)) throw new UserError('ticketEnded');
    const at = this.now();
    this.addInput(ticket, { id: key('input', ticketId, 'note', at, text), kind: 'note', text, at });
    return this.require(ticketId);
  }
  /**
   * Subscribe an open ticket to a Thread its Executor found related, for context: see `Thread.context`.
   * @returns false when the ticket follows the Thread already.
   * @throws UserError when the ticket is unknown or has ended.
   */
  followForContext(ticketId: string, ref: ThreadRef): boolean {
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded');
    if (this.thread(ref).subscriptions.includes(ticketId)) return false;
    this.subscribe(ticketId, ref);
    const thread = this.thread(ref);
    thread.context = [...(thread.context ?? []), ticketId];
    this.repo.threads.save(thread);
    return true;
  }
  /** Subscribe a ticket to a Thread; later Triggers on it reach the ticket as Inputs, as the ticket's own once it was for context. */
  private subscribe(ticketId: string, ref: ThreadRef): void {
    const thread = this.thread(ref);
    if (!thread.subscriptions.includes(ticketId)) {
      thread.subscriptions.push(ticketId);
      this.emit('thread.subscribed', { threadKey: thread.key, ticketId });
    }
    if (thread.context?.includes(ticketId))
      thread.context = thread.context.filter((id) => id !== ticketId);
    this.repo.threads.save(thread);
  }
}
