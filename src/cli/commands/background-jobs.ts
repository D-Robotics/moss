/**
 * `/tasks` (aliases `/ps`, `/bashes`; retired `/jobs` `/bg` `/subs`) — the
 * current session's background shell processes and sub-agents. Task OS
 * contracts stay on `/task view`.
 */
import type { BackgroundProcSnapshot } from '../../core/tools/background-process-registry.js';

export function formatBackgroundJobLines(input: {
  processes: readonly BackgroundProcSnapshot[];
  subagents: readonly { taskId: string; status: string }[];
}): string[] {
  const running = input.processes.filter((proc) => proc.status === 'running');
  const shell =
    running.length === 0
      ? ['  (none)']
      : running.map(
          (proc) => `  #${proc.id} ${proc.command}${proc.label ? ` (${proc.label})` : ''}`
        );
  const subs =
    input.subagents.length === 0
      ? ['  (none)']
      : input.subagents.map((task) => `  #${task.taskId} ${task.status}`);
  return ['background shell:', ...shell, '', 'sub-agents:', ...subs];
}
