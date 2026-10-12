import { listTaskEvents } from './task-store.js';

/** The persisted external oracle survives resume and agent-driven acceptance. */
export function acceptanceCommandFromEvents(
  events: readonly { type: string; data?: Record<string, unknown> }[]
): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type !== 'task_created') continue;
    const command = events[i]?.data?.acceptanceCommand;
    if (typeof command === 'string' && command.trim()) return command.trim();
  }
  return undefined;
}

export async function persistedAcceptanceCommand(
  workspaceDir: string,
  taskId: string
): Promise<string | undefined> {
  return acceptanceCommandFromEvents(await listTaskEvents(workspaceDir, taskId));
}
