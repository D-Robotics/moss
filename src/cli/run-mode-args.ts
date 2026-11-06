/**
 * `moss goal` is one verb with three modifiers (B140):
 *
 *   moss goal "<intent>" [--accept "<cmd>"]   verified task run
 *   moss goal --resume [<task_id>]            continue a task
 *   moss goal "<intent>" --until "<cmd>"      closed loop (loop engine)
 *   moss goal --workflow <plan.json>              declarative workflow engine
 *
 * The point of the audit's N1: six engines should be one verb plus a modifier,
 * not six verbs. This module classifies argv before any engine starts, so the
 * dispatcher routes to the existing engines without changing them.
 */
export type RunMode =
  | { mode: 'run' }
  | { mode: 'until'; until: string; rest: string[] }
  | { mode: 'workflow'; target: string; rest: string[] }
  | { mode: 'error'; message: string };

function takeValue(
  args: readonly string[],
  index: number,
  flag: string
): { value?: string; consumed: number } | { error: string } {
  const arg = args[index] as string;
  if (arg.startsWith(`${flag}=`)) {
    const value = arg.slice(flag.length + 1);
    if (!value) return { error: `${flag} needs a value` };
    return { value, consumed: 1 };
  }
  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) return { error: `${flag} needs a value` };
  return { value: next, consumed: 2 };
}

/** Classify the modifiers; `--resume` itself is handled by the resume path. */
export function classifyRunMode(args: readonly string[]): RunMode {
  const untilIndex = args.findIndex((arg) => arg === '--until' || arg.startsWith('--until='));
  const workflowIndex = args.findIndex(
    (arg) => arg === '--workflow' || arg.startsWith('--workflow=')
  );
  if (untilIndex !== -1 && workflowIndex !== -1) {
    return {
      mode: 'error',
      message: '--until and --workflow are different run modes; pass only one',
    };
  }
  if (workflowIndex !== -1) {
    const taken = takeValue(args, workflowIndex, '--workflow');
    if ('error' in taken) return { mode: 'error', message: taken.error };
    const rest = args.filter(
      (_, position) =>
        position !== workflowIndex && position !== workflowIndex + (taken.consumed - 1)
    );
    if (rest.some((arg) => arg === '--accept' || arg.startsWith('--accept='))) {
      return {
        mode: 'error',
        message:
          '--workflow runs a workflow plan; its steps define their own checks, so --accept does not apply',
      };
    }
    return { mode: 'workflow', target: taken.value as string, rest };
  }
  if (untilIndex !== -1) {
    const taken = takeValue(args, untilIndex, '--until');
    if ('error' in taken) return { mode: 'error', message: taken.error };
    const rest = args.filter(
      (_, position) => position !== untilIndex && position !== untilIndex + (taken.consumed - 1)
    );
    if (rest.some((arg) => arg === '--accept' || arg.startsWith('--accept='))) {
      return {
        mode: 'error',
        message: '--until already decides success by that command; --accept does not apply',
      };
    }
    if (rest.length === 0) {
      return {
        mode: 'error',
        message: '--until needs the intent to loop on: moss goal "<intent>" --until "<cmd>"',
      };
    }
    return { mode: 'until', until: taken.value as string, rest };
  }
  return { mode: 'run' };
}
