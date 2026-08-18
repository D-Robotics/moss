/**
 * Package-private capability used to authorize terminal execution events.
 *
 * This value is intentionally absent from every package export. Stores may expose
 * a forwarding seam for composition, but callers cannot mint the capability.
 */
export const executionCompletionAuthority = Object.freeze({});
