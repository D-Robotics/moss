/**
 * `/tasks` (aliases `/ps`, `/bashes`; retired `/jobs` `/bg` `/subs`) — the
 * current session's background shell processes and sub-agents. Task OS
 * contracts stay on `/task view`.
 */
import type { BackgroundProcSnapshot } from '../../core/tools/background-process-registry.js';
import { tui } from '../tui/copy.js';

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
  const lines = ['background shell:', ...shell, '', 'sub-agents:', ...subs];
  if (running.length === 0 && input.subagents.length === 0) {
    // B339: an empty panel should teach the two ways to fill it.
    lines.push(
      '',
      tui('start: !<command> runs it in the background of this session'),
      tui('or ask Moss to launch a subagent for parallel work')
    );
  }
  return lines;
}
