/**
 * Ordinary chat does not open a task contract. Only the `/goal` and `/task`
 * entry points do. The task engine sets `taskFlow` itself.
 */
export function messageRequestsTaskContract(message: string): boolean {
  return /(?:^|\s)\/(?:goal|task)\b/u.test(message);
}
