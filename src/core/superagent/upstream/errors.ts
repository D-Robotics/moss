/** User-facing error codes mapped to their category ('missing' or 'refused') and English message template. */
export const USER_ERRORS = {
  unknownTicket: ['missing', 'Unknown ticket'],
  unknownProblem: ['missing', 'Unavailable Eval not found'],
  unknownTrigger: ['missing', 'Unknown trigger'],
  unknownAssignment: ['missing', 'Unknown assignment'],
  unknownBlock: ['missing', 'Unknown settings block: {block}'],
  unknownPromptRevision: ['missing', 'Unknown prompt revision {revision}'],
  unknownPromptPart: ['refused', 'Unknown built-in prompt part {part}'],
  ticketEnded: ['refused', 'Ticket has ended'],
  assignmentEnded: ['refused', 'Assignment has ended; a newer assignment owns this ticket'],
  evalFinished: [
    'refused',
    "Eval {eval} has finished or a later eval replaced it; decide the trigger's current eval",
  ],
  notAdmissible: ['refused', 'Trigger is not admissible: {reason}'],
  notExplicit: [
    'refused',
    'An accept through orchestrator_route is for explicit requests from allowed senders; assess proactive candidates with orchestrator_eval and orchestrator_eval_decide',
  ],
  ticketStopped: [
    'refused',
    'A person stopped this ticket; new work needs an accept through orchestrator_route',
  ],
  mandateRevoked: [
    'refused',
    "The current policy no longer holds this ticket's mandate; new work needs an accept through orchestrator_route",
  ],
  notRetryable: [
    'refused',
    'Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed',
  ],
  sourceThread: ['refused', 'This is the thread the ticket started on; it stays subscribed'],
  followedThread: [
    'refused',
    "This thread is the ticket's own, such as its pull request's; it stays subscribed",
  ],
  notFollowing: ['refused', 'This ticket does not follow that thread'],
  questionWithResult: [
    'refused',
    'A question for a person cannot also be a ready result or an answer; report it separately',
  ],
  askerWithoutQuestion: [
    'refused',
    'The message that raised a question needs the question it raised',
  ],
  notAsker: [
    'refused',
    "A question must name the person's message that raised it, which reached this ticket",
  ],
  notAnswerable: [
    'refused',
    "An answer must name the person's question it answers, which reached this ticket",
  ],
  ackEnded: ['refused', 'Ticket ended; do not acknowledge historical requests'],
  notReached: ['refused', 'Trigger does not belong to this worker'],
  handedBack: ['refused', 'This ticket handed that trigger back already'],
  handedBackHere: [
    'refused',
    'The worker of this ticket handed that trigger back as beyond it: accept it as new work, attach it to another ticket, or ignore it',
  ],
  workerDecides: [
    'refused',
    'This message reached ticket {tickets} on its thread: its worker decides whether it belongs there and hands back what does not, which then arrives as a candidate. Only a stop goes through orchestrator_route, with kind stop',
  ],
  ackNoChannel: ['refused', 'Acknowledgement requires an assigned human source message'],
  ackNotPerson: ['refused', 'Use the original human trigger, not a bot, CI or worker report'],
  notReady: [
    'refused',
    'Ticket is not ready for delivery. Keep progress internal and wait for a verified ready report; do not relabel progress as an answer or send it through another channel.',
  ],
  notAttention: [
    'refused',
    "Attention requires the ticket's current attention question in human_action. Routine unfinished work stays internal.",
  ],
  notQuestion: [
    'refused',
    'An answer must target the original human question, not a worker report or automated trigger',
  ],
  noAnswer: [
    'refused',
    "No worker answer is ready for this human trigger. Wait for the worker's report, or request one with orchestrator_ticket_request_status, which acts only on a worker that reported waiting; ordinary progress cannot be relabelled as an answer.",
  ],
  noChannel: ['refused', 'No reply channel for this ticket or trigger'],
  panelOnlyEnvironment: [
    'refused',
    'The execution environment (ticket directory, prepare command, blocked commands) can only be changed in the management panel',
  ],
  panelOnlyAccounts: [
    'refused',
    'Source fields that setup reads, such as account CLIs, can only be changed in the management panel',
  ],
  setupComplete: ['refused', 'Setup is complete'],
  modelUnavailable: ['refused', 'The {block} model is not available: {error}'],
  promptTooLong: ['refused', 'Prompt configuration exceeds {limit} characters'],
  promptPlaceholders: [
    'refused',
    'The “{part}” template must keep {placeholders}, which the system fills in',
  ],
  promptPartEmpty: [
    'refused',
    'The “{part}” part cannot be empty; reset it to follow its built-in text',
  ],
  sourceNotInstalled: ['refused', 'The {source} Source kind is not installed'],
  noLabels: ['refused', 'This Source has no names to refresh'],
  nothingToSync: [
    'refused',
    "The {source} Source's part of the Policy has nothing to sync from, or the Source is off or waiting for setup",
  ],
} as const satisfies Record<string, readonly ['missing' | 'refused', string]>;
export type UserErrorCode = keyof typeof USER_ERRORS;

/**
 * Structured error thrown by Engine parts and application services when a caller request is invalid or references missing state.
 * Tool handlers and HTTP routes inspect its code and missing flag to return appropriate status responses, while the web panel localizes the code.
 */
export class UserError extends Error {
  readonly missing: boolean;
  constructor(
    readonly code: UserErrorCode,
    readonly values: Record<string, string> = {}
  ) {
    const [kind, text] = USER_ERRORS[code];
    super(text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match));
    this.missing = kind === 'missing';
  }
}
