/**
 * Structured reason codes and templates for decisions, filtered triggers, and ended assignments.
 * Policy gates and source scopes may also emit their own literal reason codes.
 */
export const REASONS = {
  said: '{text}',
  timeout: 'Assessment timed out',
  policyChanged: 'Policy changed during assessment',
  noAdmissible: 'No admissible trigger',
  startedTicket: 'Already started ticket {ticket}',
  acceptedBefore: 'Trigger {trigger} was accepted before',
  routed: 'Routed to ticket {ticket}',
  explicitRouted: 'Explicit request from an allowed sender routed by the orchestrator',
  humanStop: 'Human asked to stop',
  legacyImport: 'Imported from the pre-domain-model task record',
  forwarded: 'Forwarded to the worker of the Ticket already on this Thread',
  senderNotMember: "The sender is not on the Source's list",
  retried: 'Retried by a person',
  hostRestarted: 'dsh-superagent restarted',
  stopUnknown: 'Stop target is unknown or already ended',
  stopNotExplicit: 'A stop needs an explicit request from a sender on the list',
  directionUnsettled:
    'Implementation intent or target direction is not established, or a product/design decision is still required',
  noRuleMatched: 'No enabled admission rule matched',
  ignoredFromCard: 'Ignored from its card, without a rule assessment',
  observed: 'Observe mode: would accept ({text})',
} as const;
export type ReasonCode = keyof typeof REASONS;
/** Reason code and template values; `triggerId` identifies the trigger in a batch that the reason applies to. */
export interface Reason {
  code: ReasonCode | (string & {});
  values?: Record<string, string>;
  triggerId?: string;
}
export const said = (text: string): Reason => ({ code: 'said', values: { text } });
/** Formats reasons in English (prefixed by `triggerId` when present) for agent consumption. */
export function reasonText(reasons: readonly Reason[] | Reason | undefined): string {
  return [reasons ?? []]
    .flat()
    .map((reason) => {
      const template: string = REASONS[reason.code as ReasonCode] ?? reason.code;
      const text = template.replace(
        /\{(\w+)\}/g,
        (match, name: string) => reason.values?.[name] ?? match
      );
      return reason.triggerId ? `${reason.triggerId}: ${text}` : text;
    })
    .join('; ');
}
