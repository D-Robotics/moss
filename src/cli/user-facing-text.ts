/**
 * Model-channel hints that must not render as assistant or tool output.
 * The tool result the model reads is unchanged; only the transcript is.
 */

const MODEL_HINT_LINE = 'Verify with tests instead of re-reading every file.';

/** Phase-prompt marks the engine injects. A model line that merely starts with the prefix stays. */
const INJECTED_PHASE_MARKS = new Set([
  '[task-phase:planning]',
  '[task-phase:executing]',
  '[task-phase:repairing]',
]);

/**
 * Drop the multi_edit hint line, and rewrite only exec_background's own
 * `exec_stop("…") to terminate` hint. File contents from read_file stay intact.
 */
export function userFacingToolResult(result: string, toolName?: string): string {
  const lines =
    toolName === 'multi_edit'
      ? result.split('\n').filter((line) => line.trim() !== MODEL_HINT_LINE)
      : result.split('\n');
  let text = lines.join('\n');
  if (toolName === 'exec_background') {
    text = text.replace(/exec_stop\((['"])[^'"]+\1\)(?= to terminate)/g, '/stop');
  }
  return text;
}

/** Strip lines the harness injected. Model prose that quotes those prefixes stays. */
export function userFacingAssistantText(text: string): string {
  const kept = text.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (trimmed === MODEL_HINT_LINE) return false;
    if (INJECTED_PHASE_MARKS.has(trimmed)) return false;
    return true;
  });
  return kept.join('\n').replace(/^\n+|\n+$/g, '');
}
