/**
 * Model-channel hints that must not render as assistant or tool output.
 * The tool result the model reads is unchanged; only the transcript is.
 * Assistant prose is passed through the shared egress redactor before it is shown.
 */
import {
  holdOpenSecretSuffix,
  redactEgress,
  visibleStreamPrefix,
} from '../safety/tool-output-redact.js';

const MODEL_HINT_LINE = 'Verify with tests instead of re-reading every file.';

/** Phase-prompt marks the engine injects. A model line that merely starts with the prefix stays. */
const INJECTED_PHASE_MARKS = new Set([
  '[task-phase:planning]',
  '[task-phase:executing]',
  '[task-phase:repairing]',
]);

/**
 * The harness hint background exec returns to the model. The transcript shows
 * `/stop` (the user command); the tool result the model reads is unchanged.
 */
const BACKGROUND_STOP_HINT =
  /use exec_logs\((['"])[^'"]+\1\) to monitor and exec_stop\((['"])[^'"]+\2\) to terminate/g;

function rewriteBackgroundStopHint(text: string): string {
  return text.replace(BACKGROUND_STOP_HINT, (clause) =>
    clause.replace(/exec_stop\((['"])[^'"]+\1\)/, '/stop')
  );
}

/**
 * Drop the multi_edit hint line, and rewrite the background-exec stop hint
 * (`exec` with run_in_background, or `exec_background`) to `/stop`. Other
 * tools, including read_file source that mentions exec_stop, stay intact.
 */
export function userFacingToolResult(result: string, toolName?: string): string {
  const lines =
    toolName === 'multi_edit'
      ? result.split('\n').filter((line) => line.trim() !== MODEL_HINT_LINE)
      : result.split('\n');
  let text = lines.join('\n');
  if (toolName === 'exec' || toolName === 'exec_background') {
    text = rewriteBackgroundStopHint(text).replaceAll(
      'Stop one with exec_stop first.',
      'Stop one with /stop first.'
    );
  }
  return text;
}

/**
 * Live TUI tail. Finished lines go through the same redactor as a committed
 * row. On the open line, only a still-growing secret is held back, so ordinary
 * tokens stay visible and a secret split across chunks cannot flash.
 */
export function liveAssistantText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const prefix = visibleStreamPrefix(normalized, false);
  const partial = normalized.slice(prefix.length);
  const finished = prefix ? userFacingAssistantText(prefix) : '';
  const open = holdOpenSecretSuffix(partial);
  if (!finished) return open;
  if (!open) return finished;
  return `${finished}\n${open}`;
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
  return redactEgress(kept.join('\n').replace(/^\n+|\n+$/g, ''));
}
