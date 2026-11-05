import { ACCEPTANCE_COMMAND_NOTE_KIND } from '../../contracts/task-runtime.js';
import { appendTaskEvent, listTaskEvents } from './task-store.js';

/**
 * The persisted external oracle survives resume and agent-driven acceptance.
 * A failed run used to be unrecoverable when the command itself was wrong: the
 * oracle lived only in `task_created`, so `resume` kept replaying the broken
 * command. The latest `note{kind:"acceptance_command"}` now overrides it.
 */
export function acceptanceCommandFromEvents(
  events: readonly { type: string; data?: Record<string, unknown> }[]
): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === 'note') {
      if (event.data?.kind !== ACCEPTANCE_COMMAND_NOTE_KIND) continue;
      const command = event.data?.acceptanceCommand;
      if (typeof command === 'string' && command.trim()) return command.trim();
      continue;
    }
    if (event?.type !== 'task_created') continue;
    const command = event.data?.acceptanceCommand;
    if (typeof command === 'string' && command.trim()) return command.trim();
  }
  return undefined;
}

/**
 * Record a corrected oracle on the timeline (append-only: the original command
 * and the reason it was replaced stay auditable).
 */
export async function setPersistedAcceptanceCommand(
  workspaceDir: string,
  taskId: string,
  command: string
): Promise<string | undefined> {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  await appendTaskEvent(workspaceDir, taskId, 'note', {
    kind: ACCEPTANCE_COMMAND_NOTE_KIND,
    acceptanceCommand: trimmed,
  });
  return trimmed;
}

export async function persistedAcceptanceCommand(
  workspaceDir: string,
  taskId: string
): Promise<string | undefined> {
  return acceptanceCommandFromEvents(await listTaskEvents(workspaceDir, taskId));
}
