/**
 * One-line human summaries for completed tool calls — the transcript's answer
 * to the reference CLI's collapsed tool rows (`Read 14 lines`,
 * `Added 3 · removed 1`, `exit 1 · <stderr tail>`). The REPL renderer has had
 * these for a while (src/cli/output.ts); this module gives the shell the same
 * information as a PURE projection so specs can drive it directly.
 *
 * A summary is only produced when it adds information the compact preview
 * (first 3 lines of the raw result) does not already show: structural facts
 * (line counts, diff gain, test verdicts) or the TAIL of a long output. Short
 * results that fit the preview verbatim get no headline — otherwise every tool
 * row would say the same thing twice.
 */
import { diffLinesForApproval } from '../approval-detail.js';
import { tui } from './copy.js';
import {
  extractCommandFailurePreview,
  extractCommandOutputPreview,
} from '../../tools/tool-helpers.js';
import { summarizeVerificationResult } from '../../tools/harness-tools.js';

export interface ToolCompletion {
  /** Headline for the `⎿` row, e.g. `Read 14 lines`. Undefined when redundant. */
  summary?: string;
  /**
   * When the result is best shown as a diff gutter (edit/write/patch), the
   * unified-diff body that REPLACES the raw result text in the transcript row.
   */
  diff?: string;
  /**
   * Drop the result body entirely: the answer was already shown by the dialog
   * that produced it (ask_user_question's synthetic wrapper adds nothing).
   */
  dropBody?: boolean;
}

const EXEC_TOOLS = new Set(['exec', 'device_exec', 'docker_exec', 'exec_background']);
const READ_TOOLS = new Set(['read_file', 'device_file_read']);
const WRITE_TOOLS = new Set(['write_file', 'device_file_write']);
const LIST_TOOLS = new Set(['list_directory', 'device_file_list']);
const SEARCH_TOOLS = new Set(['search_code', 'search_files']);
const FETCH_TOOLS = new Set(['web_fetch']);
/** The transcript's compact preview shows 3 lines; summaries exist beyond that. */
const PREVIEW_LINES = 3;
/** A write's `+`-prefixed content is capped so a large file cannot flood the row. */
const WRITE_DIFF_MAX_LINES = 120;
/** Words that make an output line a verdict rather than data. */
const EXEC_CONCLUSION =
  /\b(pass(ed|es)?|fail(ed|s|ure)?|succe(ss|eded)|error|errors|warning|warnings|built|build|done|ok|complete[d]?|finish(ed)?|exit|total|tests?|lint|typecheck|found|no matches)\b|\d+\s*(passed|failed|errors?|warnings?)/i;

function countContentLines(text: string): number {
  return text.split('\n').filter((l) => l.trim() !== '').length;
}

/**
 * Lines a file has: every line counts (a blank line is still a line), and the
 * trailing newline of a well-formed file does not invent an extra one.
 */
function countFileLines(text: string): number {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function firstLine(text: string, max = 72): string {
  const found = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!found) return '';
  return found.length > max ? `${found.slice(0, max - 1)}…` : found;
}

function counted(count: number, one: string, many: string): string {
  return tui(count === 1 ? one : many, { count });
}

/** New-file body as a pseudo-diff (`+ ` per line) so the gutter renders it. */
function writeDiff(content: string): string {
  const lines = content.split('\n');
  // A file's trailing newline is not a phantom extra line of content.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const shown = lines.slice(0, WRITE_DIFF_MAX_LINES).map((l) => `+ ${l}`);
  if (lines.length > WRITE_DIFF_MAX_LINES) {
    shown.push(`  … (${lines.length - WRITE_DIFF_MAX_LINES} more lines)`);
  }
  return shown.join('\n');
}

export function summarizeToolCompletion(
  toolName: string,
  input: Record<string, unknown>,
  result: string,
  isError: boolean
): ToolCompletion {
  const body = String(result ?? '');

  if (isError) {
    const lines = EXEC_TOOLS.has(toolName) ? extractCommandFailurePreview(body, 1) : [];
    const detail = lines[0] ?? firstLine(body.replace(/^Execution error:\s*/i, ''));
    return { summary: detail ? tui('failed — {detail}', { detail }) : tui('failed') };
  }

  // run_tests / verify_fix / code_diagnostics carry a structured verdict —
  // that verdict is the single most useful line of the whole result.
  const verification = summarizeVerificationResult(toolName, body);
  if (verification) return { summary: verification };

  if (READ_TOOLS.has(toolName)) {
    // The read tool's own framing is the most honest summary: a ranged read
    // leads with `[lines 10-40 of 200]`, and a re-read of an unchanged window
    // returns a stub (which "Read 1 line" would misdescribe).
    const range = /^\[lines (\d+)-(\d+) of (\d+)\]/.exec(body.trim());
    if (range && range[1] && range[2] && range[3]) {
      return {
        summary: tui('Read lines {start}-{end} of {total}', {
          start: range[1],
          end: range[2],
          total: range[3],
        }),
      };
    }
    if (/unchanged/i.test(body) && countContentLines(body) <= 3) {
      return { summary: firstLine(body, 60) || tui('Read (unchanged)') };
    }
    const lines = countFileLines(body);
    return { summary: counted(lines, 'Read {count} line', 'Read {count} lines') };
  }

  if (WRITE_TOOLS.has(toolName)) {
    // No content in the input means we cannot know the write's size — saying
    // "Wrote 0 lines" would be a lie, so the row falls back to the preview.
    if (typeof input.content !== 'string') return {};
    const content = input.content;
    const lines = countFileLines(content);
    return {
      summary: counted(lines, 'Wrote {count} line', 'Wrote {count} lines'),
      ...(content ? { diff: writeDiff(content) } : {}),
    };
  }

  if (toolName === 'edit_file') {
    const oldString = typeof input.old_string === 'string' ? input.old_string : undefined;
    const newString = typeof input.new_string === 'string' ? input.new_string : undefined;
    if (oldString === undefined || newString === undefined) return {};
    const diff = diffLinesForApproval(oldString, newString);
    if (!diff) return { summary: tui('Edited (too large for inline diff)') };
    const added = diff.filter((l) => l.startsWith('+ ')).length;
    const removed = diff.filter((l) => l.startsWith('- ')).length;
    const parts: string[] = [];
    if (added > 0) parts.push(counted(added, 'Added {count} line', 'Added {count} lines'));
    if (removed > 0) parts.push(counted(removed, 'removed {count} line', 'removed {count} lines'));
    return {
      summary: parts.length > 0 ? parts.join(' · ') : tui('Edited (no line changes)'),
      diff: diff.join('\n'),
    };
  }

  if (toolName === 'apply_patch') {
    const patch = typeof input.patch === 'string' ? input.patch : '';
    const signLines = patch.split('\n').filter((l) => /^[+-](?![+-])/.test(l));
    if (signLines.length >= 2) {
      const added = signLines.filter((l) => l.startsWith('+')).length;
      const removed = signLines.length - added;
      return {
        summary: `${tui('Patched')} · ${counted(added, 'Added {count} line', 'Added {count} lines')} · ${counted(removed, 'removed {count} line', 'removed {count} lines')}`,
        diff: signLines.join('\n'),
      };
    }
    return { summary: tui('Patched') };
  }

  if (EXEC_TOOLS.has(toolName)) {
    // Success: the tail carries the conclusion (build OK, N passed) — but only
    // when the output is long enough that the compact preview hides it. A bare
    // `exit=0` line the COMMAND printed (`; echo exit=$?` idioms) is noise, so
    // the window is widened past it instead of letting it be the conclusion.
    const tail = extractCommandOutputPreview(body, { maxLines: 4, minLines: 4, minChars: 160 });
    const candidates = tail.filter(
      (l) => !l.startsWith('…') && !/^exit[=:]\s*\d+$/i.test(l.trim())
    );
    const last = candidates.at(-1);
    // A last line is a conclusion only when it reads like one (a verdict, a
    // result, an error). Otherwise it is just the end of some output, and the
    // honest headline is how much came back.
    if (last && EXEC_CONCLUSION.test(last)) return { summary: last };
    const lines = countContentLines(body);
    if (lines > PREVIEW_LINES) return { summary: counted(lines, '{count} line', '{count} lines') };
    return {};
  }

  // Observation tools name what came back. A count is a fact the result proves;
  // an empty result is said out loud rather than shown as a blank row.
  if (LIST_TOOLS.has(toolName)) {
    const entries = countContentLines(body);
    return { summary: counted(entries, 'Listed {count} entry', 'Listed {count} entries') };
  }
  if (SEARCH_TOOLS.has(toolName)) {
    const matches = countContentLines(body);
    if (matches === 0) return { summary: tui('No matches') };
    return { summary: counted(matches, 'Found {count} match', 'Found {count} matches') };
  }
  if (FETCH_TOOLS.has(toolName)) {
    const url = typeof input.url === 'string' ? input.url : '';
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      host = '';
    }
    if (host) return { summary: `Fetched ${host}` };
  }

  if (toolName === 'ask_user_question') {
    // The dialog already committed each `answer: …` row; the tool result is a
    // synthetic "User has answered your questions: …" wrapper that would dump
    // the same choices a second time as one unreadable line.
    if (/^User has answered your questions:/.test(body.trim())) {
      return { summary: 'answered', dropBody: true };
    }
    return { summary: firstLine(body, 60) || 'answered' };
  }

  // Everything else gets a headline only when the preview cannot show the
  // whole result (a clipped result with no pointer is the failure mode).
  if (countContentLines(body) > PREVIEW_LINES || body.length > 240) {
    const head = firstLine(body);
    if (head) return { summary: head };
  }
  return {};
}
