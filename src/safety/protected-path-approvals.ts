/**
 * O152 r1 F3: paths the user confirmed (y / a) for a protected-path write.
 * L3 auto-restore must not undo those. Session-scoped in-process set; never
 * persisted. Keys are canonical absolute paths (see {@link grantKey}).
 */
import path from 'node:path';

const approved = new Set<string>();

export function grantKey(resolved: string): string {
  return path.resolve(resolved).replace(/\\/g, '/').toLowerCase();
}

/** Record that the user approved a write to this protected path (y or a). */
export function noteProtectedPathApproved(resolved: string): void {
  if (!resolved) return;
  approved.add(grantKey(resolved));
}

export function isProtectedPathApproved(resolved: string): boolean {
  if (!resolved) return false;
  return approved.has(grantKey(resolved));
}

/** Test helper. */
export function clearProtectedPathApprovals(): void {
  approved.clear();
}

export function listProtectedPathApprovals(): string[] {
  return [...approved];
}
