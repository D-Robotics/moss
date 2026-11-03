/** Domain model of a proactive agent: the concepts and their invariants, independent of any source, policy, or executor. */
import type { Reason } from './reasons.js';

/** Actor identity in the source's own vocabulary; Policy decides which actors may originate work on that Source. */
export interface ActorRef {
  source: string;
  id: string;
}
/** Thread identity; the rule that derives `id` from a native event belongs to the source. */
export interface ThreadRef {
  source: string;
  id: string;
}
/** Write-only address on a thread; the address format belongs to the source. */
export interface ChannelRef {
  source: string;
  thread: string;
  address: Record<string, string>;
}

/** Stable key of a thread across the whole domain. */
export const threadKey = (ref: ThreadRef): string => `${ref.source}:${ref.id}`;
/**
 * Normalizes valid timestamps to `Date#toISOString` form so stored timestamps compare lexicographically in memory and SQL;
 * values that do not parse as a timestamp are returned unchanged.
 */
export function isoTime(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : value;
}

/** One immutable event produced by a source. `text` and `meta` are untrusted external data. */
export interface Trigger {
  id: string;
  source: string;
  /** Every thread the trigger belongs to; the first (`threads[0]`) is the primary thread that hosts its evaluation. */
  threads: ThreadRef[];
  actor: ActorRef;
  /** Source-declared: the event was written by a person rather than a bot, CI, or this agent. */
  human: boolean;
  /** Source-declared: the sender addressed the agent, by mentioning it or in a direct message to it. */
  addressed?: 'mention' | 'direct';
  at: string;
  text: string;
  channel?: ChannelRef;
  url?: string;
  /** Source-native details for adapters; the core never interprets them. */
  meta: Record<string, unknown>;
}

/** Where a trigger went after intake; it grants nothing, but decides who decides a person's follow-up (see `followupOwners`). */
export interface TriggerDisposition {
  /** Rejected by the source scope filter before entering the domain, for the Source's reason. */
  filtered?: Reason;
  evalId?: string;
  decisionId?: string;
  /**
   * The tickets it reached, by subscription fan-out or attached by the main Session; a ticket that ended or could not resume
   * without its worker taking it up no longer counts.
   */
  fanout: string[];
  /** The tickets of `fanout` it reached only on a Thread their Executor follows for context, which makes it none of theirs. */
  context?: string[];
  /** A person, or the main Session for a message no ticket decides, sent it to Eval again; a hand-back does not set it. */
  requeued?: true;
  /** The tickets whose Executor handed it back as beyond the ticket, each once, with why; it goes to Eval once none decides it. */
  handbacks?: { ticketId: string; reason: string; at: string }[];
  /** The tickets whose Executor acknowledged it or answered it, taking it up as within the ticket. */
  acked?: string[];
  at: string;
}
/** What deciding a follow-up's owners reads: the stored tickets, Threads and dispositions, as the Store and the core keep them. */
export interface FollowupRecords {
  tickets: { get(id: string): Ticket | undefined };
  threads: { get(key: string): Thread | undefined };
  triggers: { disposition(id: string): TriggerDisposition | undefined };
}
/**
 * The tickets whose worker decides a person's follow-up: those it reached on their own Threads that can still decide it
 * and did not hand it back. A ticket can while it is live, also once a person dropped its Subscription to the Thread, and
 * while it is ended, not by a person, with the Trigger waiting to resume it. None once a person sent it to Eval, or while
 * an Eval holds it, which an earlier version may have queued. While a ticket owns it, the message goes to no Eval, and the
 * main Session may only stop the work on it.
 */
export function followupOwners(
  trigger: Pick<Trigger, 'id' | 'human' | 'threads'>,
  records: FollowupRecords
): string[] {
  if (!trigger.human) return [];
  const disposition = records.triggers.disposition(trigger.id);
  if (!disposition || disposition.requeued) return [];
  // The disposition alone rules most messages out, so a Thread or a ticket is read only for one that may have an owner.
  const returned = new Set(disposition.handbacks?.map((item) => item.ticketId));
  const reached = disposition.fanout.filter(
    (id) => !returned.has(id) && !disposition.context?.includes(id)
  );
  if (
    !reached.length ||
    records.threads.get(threadKey(trigger.threads[0]!))?.evaluating?.triggerIds.includes(trigger.id)
  )
    return [];
  return reached.filter((id) => {
    const ticket = records.tickets.get(id);
    return (
      !!ticket &&
      (liveTicket(ticket) ||
        (ticket.ended?.by !== 'human' &&
          ticket.inputs.some(
            (input) =>
              input.kind === 'trigger' &&
              input.triggerId === trigger.id &&
              ticket.undelivered.includes(input.id)
          )))
    );
  });
}
/**
 * Whether a Decision settled what a person's message asks for: a stop on it, taken or refused, decides only that ticket's
 * work, routing it to a ticket leaves it to that ticket's worker, and an unavailable one decided nothing.
 */
export const settled = (decision: Pick<Decision, 'kind' | 'reason'>): boolean =>
  !['stop', 'unavailable'].includes(decision.kind) &&
  !decision.reason.some((reason) =>
    ['stopNotExplicit', 'stopUnknown', 'routed'].includes(reason.code)
  );

export type Strength = 'explicit' | 'inferred';
/** The cells of a receiving scope's row in the admission table, by whether the sender is listed and addresses the agent. */
export type AdmissionCell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed';
/**
 * Whether proactive candidates are assessed and accepted (`auto`), still assessed so Decisions record what they would accept
 * (`would_accept`) without accepting (`observe`), or not admitted (`off`).
 */
export type AcceptMode = 'off' | 'observe' | 'auto';
/** Where a Mandate's Trigger was received: its Source, its receiving scope as the Source recorded it, and its admission row. */
interface Received {
  source?: string;
  scope?: Record<string, unknown>;
  row?: string;
}
/**
 * How the gate admitted the Trigger a Mandate came from, which `revalidate` re-checks (see `docs/002`):
 * - `addressed`: a sender on the Source's list addressed the agent;
 * - `followup`: a message on a Thread that has tickets;
 * - `admission`: the cell of the receiving scope's admission row; `observation` when it made an inferred candidate under
 *   an accept mode;
 * - `listed`: accepted before Mandates recorded their basis, from a sender who must still be on the list; `authority` is
 *   what an earlier version recorded instead.
 * `sender` names the allowed sender at acceptance time, and `rules` the rules an assessment matched.
 */
export type MandateBasis = Received & { sender?: string; rules?: string[] } & (
    | { via: 'addressed'; addressed: 'mention' | 'direct' }
    | { via: 'followup'; authority?: string }
    | {
        via: 'admission';
        cell: AdmissionCell;
        addressed?: 'mention' | 'direct';
        observation?: { mode: AcceptMode };
      }
    | {
        via: 'listed';
        addressed?: 'mention' | 'direct';
        observation?: { mode?: AcceptMode };
        authority?: string;
      }
    /** A message of a bot on its Source's bot list: an inferred candidate at most, never an explicit request or a stop. */
    | { via: 'bot'; addressed?: 'mention' | 'direct'; observation: { mode: AcceptMode } }
  );

/** Immutable authorization produced by an accept decision; execution is bounded by it and it never changes. */
export interface Mandate {
  strength: Strength;
  policyVersion: string;
  /** How the gate admitted it, for re-validation and audit. */
  basis: MandateBasis;
  actor: ActorRef;
  scope: string;
}

/** Active trigger evaluation on a thread; at most one exists per thread. */
export interface Evaluation {
  id: string;
  threadKey: string;
  triggerIds: string[];
  /** The admissible Trigger that gave the batch its strength, which a ticket the Eval starts takes as its origin. */
  primary?: string;
  strength: Strength;
  /** Actor and gate basis of the strongest admissible trigger; they seed the mandate on accept. */
  actor: ActorRef;
  basis: MandateBasis;
  policyVersion: string;
  startedAt: string;
  /** Timestamp when the candidate reached the assessor's Session; it cannot expire before, and its deadline counts from then. */
  delivered?: string;
  /** Expiration timestamp, counted from delivery (or from start until delivered); a processing pause shifts it forward by the pause duration. */
  deadline: string;
  /** Timestamp when processing pause began; resuming shifts `deadline` forward by the pause duration; cleared on resume. */
  pausedAt?: string;
}

/** Thread aggregate: consistency boundary of eval, holder of subscriptions and decision history. */
export interface Thread {
  key: string;
  ref: ThreadRef;
  createdAt: string;
  /** Time of the newest trigger on the thread. */
  lastAt?: string;
  /** Tickets subscribed to this thread; live ones receive every trigger as context through fan-out. */
  subscriptions: string[];
  /**
   * The subscribed tickets whose Executor follows the thread for read-only context, such as an Issue or another pull request
   * it found: its messages reach them, but grant nothing, and a person's message there resumes none of them that ended.
   */
  context?: string[];
  /** Keys of threads that shared a trigger with this one; context only. */
  correlated: string[];
  /** Triggers waiting for the next eval (debounce buffer). */
  pending: string[];
  evaluating?: Evaluation;
  /** How many Evals of its queued Triggers expired in a row, each of which queued them again; a Decision clears it. */
  expired?: number;
  /**
   * Source-native attributes needed by channels or readers (for example a messaging thread id). Its Source may also describe
   * the thread for people: `label`, a display name, and `facts`, a {@link ThreadFacts} map.
   */
  meta: Record<string, unknown>;
}
/** Text in both interface languages, or the same text in both. */
export type Text = string | { zh: string; en: string };
/** One fact a Source states about its thread, such as an issue number or a CI result; `problem` marks one that needs a person. */
export interface ThreadFact {
  label?: Text;
  value: Text;
  problem?: true;
}
/** A thread's facts by id, ordered for display; each writer owns its fact ids. */
export type ThreadFacts = Record<string, ThreadFact>;

export type DecisionKind = 'ignore' | 'accept' | 'reopen' | 'stop' | 'unavailable';
/** Outcome of one eval, recorded on the thread. */
export interface Decision {
  id: string;
  evalId: string;
  threadKey: string;
  triggerIds: string[];
  policyVersion: string;
  at: string;
  kind: DecisionKind;
  /** Why, by code: one reason, or one for each Trigger of the batch it concerns. */
  reason: Reason[];
  strength: Strength;
  ticketId?: string;
  mandate?: Mandate;
  /** Assessor-supplied audit data (rule assessments, direction, evidence). */
  audit?: Record<string, unknown>;
  /** A person dismissed the problem an unavailable Decision shows. */
  dismissed?: true;
}

export type AssignmentState = 'pending' | 'running' | 'ended';
/**
 * What an Assignment reports: work is in progress (`progress`), its worker waits for a Trigger (`waiting`), a result is
 * ready (`ready`), a person must act to unblock or recover it (`blocked` or `failed`), or nothing is left to do (`dropped`).
 */
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped';
/** Binding between a ticket and one executor instance. */
export interface Assignment {
  id: string;
  state: AssignmentState;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  endedReason?: string;
  report?: { state: ReportState; summary: string; at: string };
  /** When Inputs last reached the worker; one at or after `report.at` means the worker has been busy with Inputs since that report. */
  deliveredAt?: string;
  /**
   * When a turn of its worker last ended with nothing left to run for it and nothing waiting for it: what its Session took
   * into a step before, the worker read.
   */
  idleAt?: string;
}

export type TicketInput =
  /** A Trigger on one of its Threads, or attached to it; `human` when a person wrote it. */
  | {
      id: string;
      kind: 'trigger';
      triggerId: string;
      at: string;
      note?: string;
      human?: true;
      /** It reached the ticket only on a Thread its Executor follows for context. */
      context?: true;
      /**
       * When the worker's Session took the message that carried it into a step, from which its model reads it; `null` while
       * it waits in the Session. One delivered before reads were recorded has none, and counts as read from `deliveredAt`.
       */
      readAt?: string | null;
      /** The Assignment it was last delivered to. */
      deliveredTo?: string;
      /** When an earlier version handed it to the worker. */
      deliveredAt?: string;
    }
  /** The Policy changed in a way that bears on the ticket, as `effect` says; Inputs written before effects have none. */
  | {
      id: string;
      kind: 'policy-changed';
      from: string;
      to: string;
      at: string;
      effect?: PolicyEffect;
    }
  /** A Decision reopened the ticket; written before ended tickets resumed on their own. */
  | { id: string; kind: 'reopen'; decisionId: string; at: string }
  /** A human's message on one of its Threads resumed the ended ticket under its unchanged Mandate. */
  | { id: string; kind: 'resumed'; triggerId: string; at: string }
  | { id: string; kind: 'text'; text: string; at: string }
  /** A fact the main Session gave the ticket from other work: context, which asks for nothing and grants nothing. */
  | { id: string; kind: 'note'; text: string; at: string };

/**
 * How a Policy change bears on a ticket: the rules it was accepted under that changed, with their instruction now, or no
 * longer apply; `proactive: false` once inferred work is no longer accepted, as when the accept mode leaves `auto`; and
 * `requesterAllowed: false` once the sender it is for, `requester`, a person or a bot, may no longer start work there.
 */
export interface PolicyEffect {
  rules?: { id: string; name: string; change: 'changed' | 'disabled'; instruction?: string }[];
  proactive?: false;
  requesterAllowed?: false;
  requester?: ActorRef;
}

export type TicketEndBy = 'executor' | 'human';
/** How a ticket ended: with its result, with its pull request merged or closed unmerged, with nothing to do, or stopped by a person. */
export type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped';
/** A question for a person; `triggerId` is the human message that raised it, whose conversation it goes back to. */
export interface Attention {
  id: string;
  question: string;
  triggerId?: string;
}
/** Ticket aggregate: an authorized work item with its assignments, channels, thread bindings, and inputs. */
export interface Ticket {
  id: string;
  title: string;
  decisionId: string;
  mandate: Mandate;
  /** The Channels of the messages it was accepted from, which its replies go to. */
  channels: ChannelRef[];
  /** When, by whom, and how the ticket ended, with a person's or the host's reason beyond the outcome; an open ticket has none. */
  ended?: { at: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string };
  /** Open question for a person; cleared by the executor or when the ticket ends. */
  attention?: Attention;
  assignments: Assignment[];
  inputs: TicketInput[];
  /** Inputs not yet handed to a running assignment. */
  undelivered: string[];
  /**
   * Threads a Source made the ticket follow, such as its pull requests': a `ready` report ends the ticket only once
   * `followsDone` holds; the close that makes it hold ends the ticket with that outcome unless its work has not finished (see
   * `Tickets.unfinished`), and then its next `ready` or `dropped` report ends it.
   */
  follows?: Follow[];
  /** People's questions the worker answered, whose answers the main Session may send. */
  answers?: string[];
  createdAt: string;
  updatedAt: string;
  /** The Triggers it was accepted from: the one that started it, and the batch its Eval held. */
  origin: { triggerId: string; triggerIds: string[] };
  /** What its Executor chose: its short name, directory and assignment text. */
  execution?: Execution;
  /** The latest failed delivery of an Input to its worker, until a delivery succeeds. */
  delivery?: { error: string; at: string };
}
/**
 * A Thread a ticket follows, by its key: `own` when the ticket opened it, such as its own pull request, and when and how it
 * closed. `followsDone` holds once no Thread of its own is open, or, when the ticket has no `own` Thread, once every followed
 * Thread closed; the ticket then ends unless its work has not finished (see `Tickets.unfinished`).
 */
export interface Follow {
  thread: string;
  own: boolean;
  closed?: { at: string; outcome: 'merged' | 'closed' };
}
export interface Execution {
  name: string;
  directory: string;
  assignment: string;
}

/** Whether a ticket is open: it has not ended. */
export const liveTicket = (ticket: Pick<Ticket, 'ended'>): boolean => !ticket.ended;
/** How a ticket ended. */
export const ticketOutcome = (ticket: Pick<Ticket, 'ended'>): TicketOutcome | undefined =>
  ticket.ended?.outcome;
export const runningAssignment = (ticket: Ticket): Assignment | undefined =>
  ticket.assignments.find((assignment) => assignment.state === 'running');
/**
 * Whether a Trigger reached a ticket: it started the ticket, came to it as an Input, or is on a Thread the ticket subscribes
 * to; with `context` false, not a Thread the ticket follows only for context, where its worker may read but not write.
 */
export function reached(
  ticket: Ticket,
  trigger: Trigger,
  thread: (key: string) => Thread | undefined,
  context = true
): boolean {
  if (ticket.origin.triggerId === trigger.id) return true;
  const input = ticket.inputs.some(
    (item) => item.kind === 'trigger' && item.triggerId === trigger.id
  );
  return (
    trigger.threads.some((ref) => {
      const current = thread(threadKey(ref));
      return (
        current?.subscriptions.includes(ticket.id) === true &&
        (context || !current.context?.includes(ticket.id))
      );
    }) ||
    (input &&
      (context ||
        !trigger.threads.every((ref) => thread(threadKey(ref))?.context?.includes(ticket.id))))
  );
}
export const latestAssignment = (ticket: Ticket): Assignment | undefined =>
  ticket.assignments.at(-1);
/** The latest report any of a ticket's Assignments made, which is what the ticket last said. */
export const latestReport = (ticket: Pick<Ticket, 'assignments'>): Assignment['report'] =>
  [...ticket.assignments].reverse().find((assignment) => assignment.report)?.report;
/**
 * Until when a ticket's worker had a turn to read what reached it: its latest report, but a progress report when `progress`
 * is false, or the end of its latest turn, whichever is later.
 */
export function readUntil(ticket: Pick<Ticket, 'assignments'>, progress = true): string {
  const report = [...ticket.assignments]
    .reverse()
    .find(
      (assignment) => assignment.report && (progress || assignment.report.state !== 'progress')
    )?.report;
  return [
    report?.at ?? '',
    ...ticket.assignments.map((assignment) => assignment.idleAt ?? ''),
  ].reduce((a, b) => (a > b ? a : b));
}
/**
 * Whether a ticket waits for a person: its latest Assignment reported blocked or failed, and no person's message reached it
 * since. A later report that is neither, a person's message, or a retry, which starts a new Assignment, lifts it.
 */
export function waitsForPerson(ticket: Ticket): boolean {
  const report = latestAssignment(ticket)?.report;
  if (report?.state !== 'blocked' && report?.state !== 'failed') return false;
  return !ticket.inputs.some(
    (input) => input.kind === 'trigger' && input.human && !input.context && input.at > report.at
  );
}
