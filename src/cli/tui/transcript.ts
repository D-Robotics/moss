/**
 * Transcript grammar — the CLI shell renders like Claude Code / codex: ONE
 * column that grows downward into the terminal's own scrollback, with the
 * conversation rendered inline and only the composer pinned at the bottom.
 *
 * Marks (kept deliberately in one place so the whole product reads the same):
 *   ❯  what the user said            (the only "input" echo)
 *   ⏺  what moss says or is about to do (answer, tool call, notice)
 *   ⎿  what a tool/hook returned
 *   ✢  the run in flight (spinner + elapsed + tokens), finalized as ✻
 *
 * Pure projections: no ink imports, so specs can drive them directly.
 */
import { describeToolCall } from '../../core/task-runtime/runtime.js';
import {
  CLI_APPROVAL_FOOTER,
  CLI_APPROVAL_OPTIONS,
  type CliApprovalOption,
  type CliApprovalView,
} from '../approval-view.js';
import { formatCliInteractionModeLabel, type CliInteractionMode } from '../interaction-mode.js';
import { COMPOSER_MAX_ROWS, createComposer, renderComposerEditor, takeCells } from './composer.js';
import { highlightCodeLine, normalizeCodeLang } from './code-style.js';
import { isTuiZh, localizeApprovalText, tui } from './copy.js';
import { renderMarkdown, renderStreamingMarkdown, type MarkdownLine } from './markdown.js';
import type { TranscriptRow } from './render-bridge.js';
import {
  clip,
  displayWidth,
  line,
  padStartTo,
  rule,
  wrap,
  type TuiColor,
  type TuiLine,
} from './text.js';

export const USER_MARK = '❯';
export const ANSWER_MARK = '⏺';
export const RESULT_MARK = '⎿';
export const SPINNER_FRAMES = ['✢', '✳', '✶', '✻', '✽'];

const CONTINUATION = '  ';
const RESULT_INDENT = '     '; // 2 + width of "⎿  "

/**
 * `!` shell mode accent (`claude-code-surface.md` §5): the reference paints the
 * prompt glyph, both rules and the hint `#fd5db1`; `magenta` is the nearest
 * colour in the ink palette `TuiColor` names.
 */
export const SHELL_MODE_TONE: TuiColor = 'magenta';

/**
 * One distinct colour per interaction mode (R1 §6.6: manual `#999999`,
 * accept edits `#af87ff`, plan `#48968c`; v0.26 adds full yellow per CC
 * #ffc107). The hint row carries the whole tint because a `TuiLine` has
 * exactly one colour.
 */
export const INTERACTION_MODE_TONES: Record<CliInteractionMode, TuiColor> = {
  manual: 'gray',
  acceptEdits: 'magenta',
  plan: 'cyan',
  // Resting mode stays quiet. A yellow wash on the whole hint row reads as an error.
  full: 'gray',
};

/**
 * Hint-row wording for the active interaction mode (A7/F10). Only a
 * non-default mode appends `(shift+tab to cycle)`, exactly like the reference;
 * the label vocabulary stays moss's own (`/mode manual`, `/mode plan`,
 * `/mode accept-edits`, `/mode full`) so the hint and the command agree.
 * v0.26 default mode is `full`, so full drops the suffix and the others
 * carry it (PRD decision 4).
 */
export function interactionModeHint(mode: CliInteractionMode): string {
  // The label vocabulary is already locale-aware; zh also shortens the
  // surrounding sentence ("mode on" → "已开启").
  const label = formatCliInteractionModeLabel(mode, isTuiZh());
  if (mode === 'full') return tui('⏵⏵ {label} mode on', { label });
  return tui('{glyph} {label} mode on (shift+tab to cycle)', {
    glyph: mode === 'plan' ? '⏸' : '⏵⏵',
    label,
  });
}

/** A user row that echoes a `!`-mode shell command rather than a goal. */
export function isShellCommandRow(text: string): boolean {
  return /^!\s?\S/.test(text);
}

/**
 * Compact tool results are a preview, not a dump — the reference CLI collapses
 * long output and expands it with ctrl+o (`claude-code-surface.md` §9). Verbose
 * shows the whole thing; compact keeps the first few lines plus a marker
 * pointing at the key that reveals the rest.
 */
export const RESULT_PREVIEW_LINES = 3;
/** Source dumps (writes, patches) stay readable without ctrl+o. */
const CODE_PREVIEW_LINES = 24;
/** Diff blocks get a larger window: a hunk with its context is one thought. */
export const DIFF_PREVIEW_LINES = 14;

/**
 * Read-only observation tools whose results fold to the headline by default
 * (the summary already says what came back: "Read 14 lines · 0.3s"). ctrl+o
 * (verbose) expands them; errors never fold.
 */
export const READONLY_PREVIEW_TOOLS = new Set<string>([
  'read_file',
  'list_directory',
  'search_code',
  'search_files',
  'repo_outline',
  'code_diagnostics',
  'web_fetch',
  'web_search',
  'skill',
  'subagent_status',
  'exec_logs',
  'device_info',
  'device_file_list',
  'device_file_read',
  'device_processes',
  'device_resources',
  'device_temperature',
  'device_network',
  'device_cameras',
  'device_robotics_status',
]);

/** Verbs rotate slowly so a long run still looks alive without being cute. */
const VERBS = ['Working', 'Thinking', 'Probing', 'Checking', 'Wiring', 'Verifying'];

export function runVerb(seed: number): string {
  return tui(VERBS[Math.abs(Math.trunc(seed / 3)) % VERBS.length] ?? 'Working');
}

export function spinnerFrame(elapsedMs: number): string {
  return SPINNER_FRAMES[Math.floor(elapsedMs / 120) % SPINNER_FRAMES.length] ?? '✢';
}

function formatCompactCount(value: number): string {
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

/** Claude-style tool labels: `Write(hello.txt)` rather than prose. */
export function toolLabel(toolName: string, input: Record<string, unknown> = {}): string {
  const display = toolName
    .replace(/_(file|command)$/, '')
    .split('_')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ');
  const primary =
    pick(input, ['file_path', 'path', 'command', 'pattern', 'query', 'goal', 'url', 'metric']) ??
    '';
  if (primary) return `${display}(${clip(primary.replace(/\s+/g, ' ').trim(), 70)})`;
  const summary = describeToolCall(toolName, input).trim();
  // "running" / "reading" with no object says nothing (`Exec(running )`), so a
  // bare label is more honest than empty parens.
  const trivial =
    !summary ||
    summary.toLowerCase() === toolName.replace(/_/g, ' ').toLowerCase() ||
    /^(running|reading|writing|editing|listing|deploying)\s*$/.test(summary);
  return trivial ? display : `${display}(${clip(summary, 70)})`;
}

function pick(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/**
 * Diff lines carry meaning through their sign (`+ ` added, `- ` removed — the
 * same convention the REPL renderer uses, note the space). Everything else in a
 * preview stays dim so the change pops without shouting.
 */
export function diffTone(text: string): { color?: TuiColor; dim?: boolean } {
  if (text.startsWith('+ ')) return { color: 'green' };
  if (text.startsWith('- ')) return { color: 'red' };
  if (text.startsWith('@@')) return { color: 'cyan', dim: true };
  return { dim: true };
}

// ─── diff gutter ─────────────────────────────────────────────────────────

/** Tool-call duration: dim under a second, yellow past the 3s "slow" line. */
export function formatToolDuration(durationMs: number): { text: string; slow: boolean } {
  const text =
    durationMs >= 1000
      ? `${Math.round(durationMs / 100) / 10}s`
      : `${Math.max(0, Math.round(durationMs))}ms`;
  return { text, slow: durationMs > 3000 };
}

/**
 * The `⎿` headline for a completed tool call: human summary (`Read 14 lines`)
 * plus the call's duration. Returns [] when the row carries no tool meta
 * (slash-command blocks, `!` output, approvals) so those keep their old shape.
 */
function renderToolHeadline(row: TranscriptRow, width: number): TuiLine[] {
  const tool = row.tool;
  if (!tool || (tool.summary === undefined && tool.durationMs === undefined)) return [];
  const prefix = `${CONTINUATION}${RESULT_MARK}  `;
  const summary = tool.summary ?? tui(tool.isError ? 'failed' : 'ok');
  const duration = tool.durationMs !== undefined ? formatToolDuration(tool.durationMs) : undefined;
  const text = `${prefix}${summary}${duration ? ` · ${duration.text}` : ''}`;
  if (displayWidth(text) > width) {
    // A clipped line cannot keep its runs (they must concatenate back to text).
    return [line(clip(text, width), toolHeadlineTone(tool))];
  }
  return [
    {
      text,
      ...toolHeadlineTone(tool),
      runs: [
        { text: `${prefix}${summary}` },
        ...(duration
          ? [
              {
                text: ` · ${duration.text}`,
                ...(duration.slow ? { color: 'yellow' as const } : {}),
              },
            ]
          : []),
      ],
    },
  ];
}

function toolHeadlineTone(tool: NonNullable<TranscriptRow['tool']>): {
  color?: TuiColor;
  dim?: boolean;
} {
  if (tool.isError) return { color: 'red' };
  if (tool.abortedBy) return { color: 'yellow' };
  return { dim: true };
}

const FILE_HEADER = /^(?:---|\+\+\+)\s/;
const ADDED_FILE_HEADER = /^\+\+\+\s/;
const REMOVED_FILE_HEADER = /^---\s/;
const HUNK_HEADER = /^@@/;
const ADDED_LINE = /^\+(?!\+\+)/;
const REMOVED_LINE = /^-(?!--)/;
const CONTEXT_ELISION = /^\s*…\s*\(/;

/**
 * A `result` row that carries unified-diff lines (`+ `, `- `, `@@`) is rendered
 * as a gutter block instead of a plain preview: right-aligned line number, then
 * the marker column (` ` context, `+` added, `-` removed).
 *
 * `diffLinesForApproval` (`src/cli/approval-detail.ts`) is the producer, and it
 * uses the `+ `/`- ` spelling, so both that and a bare `+added` (real `diff`
 * output) are accepted.
 *
 * D-11: a LONE `+`/`-`-leading line is ordinary output — `! printf '+x\n'`,
 * `! echo -n`, a `-`-prefixed log line — and classifying it as a diff made the
 * transcript fabricate a gutter number for it. A diff needs real evidence: a
 * `@@` hunk header, a `---`/`+++` file-header pair, or a RUN of at least two
 * sign-prefixed lines.
 */
export function hasDiffLines(text: string): boolean {
  const lines = resultLines(text);
  if (lines.some((raw) => HUNK_HEADER.test(raw))) return true;
  if (
    lines.some((raw) => ADDED_FILE_HEADER.test(raw)) &&
    lines.some((raw) => REMOVED_FILE_HEADER.test(raw))
  ) {
    return true;
  }
  return lines.filter((raw) => ADDED_LINE.test(raw) || REMOVED_LINE.test(raw)).length >= 2;
}

interface DiffRow {
  sign: ' ' | '+' | '-';
  body: string;
  /** Line number; absent for hunk/file headers and context elisions. */
  no?: number;
  header?: boolean;
  elision?: boolean;
  /**
   * D-11: a row may only show a number when a `@@` anchor was seen AT OR ABOVE
   * it. A block-wide flag is not enough: a large diff whose head was truncated
   * still contains a `@@` further down, which would number the retained rows
   * above it with invented 1/2/3… counters.
   */
  anchored?: boolean;
}

function parseDiffLines(lines: string[]): { rows: DiffRow[]; digits: number } {
  const rows: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  let largest = 1;
  let sawHunk = false;
  for (const raw of lines) {
    if (HUNK_HEADER.test(raw) || FILE_HEADER.test(raw)) {
      const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/.exec(raw);
      if (hunk) {
        oldNo = Number(hunk[1]);
        newNo = Number(hunk[2]);
        sawHunk = true;
      }
      rows.push({ sign: ' ', body: raw, header: true, anchored: sawHunk });
      continue;
    }
    if (CONTEXT_ELISION.test(raw)) {
      rows.push({ sign: ' ', body: raw, elision: true, anchored: sawHunk });
      continue;
    }
    if (ADDED_LINE.test(raw)) {
      rows.push({ sign: '+', body: raw.slice(1), no: newNo, anchored: sawHunk });
      largest = Math.max(largest, newNo);
      newNo += 1;
      continue;
    }
    if (REMOVED_LINE.test(raw)) {
      rows.push({ sign: '-', body: raw.slice(1), no: oldNo, anchored: sawHunk });
      largest = Math.max(largest, oldNo);
      oldNo += 1;
      continue;
    }
    rows.push({
      sign: ' ',
      body: raw.startsWith(' ') ? raw.slice(1) : raw,
      no: newNo,
      anchored: sawHunk,
    });
    largest = Math.max(largest, newNo);
    oldNo += 1;
    newNo += 1;
  }
  return { rows, digits: String(largest).length };
}

/**
 * Gutter block for a diff result row. The first row carries the `⎿` mark (which
 * occupies exactly the same 5 cells as the continuation indent, so the number
 * column stays aligned); wrapped continuations are indented past the gutter so
 * they line up under the code, not under the line numbers.
 *
 * The reference paints added/removed rows with a dark background AND colours the
 * marker (`claude-code-surface.md` §8). ink applies `backgroundColor` per
 * `<Text>`, and `TuiLine` carries no background, so moss colours the whole row
 * (`+` green, `-` red) and keeps context dim — the marker still reads first
 * because the sign column is its own cell.
 */
/** Language for syntax colour inside a diff body. The sign colour stays on the row. */
function diffCodeLang(text: string): string {
  const header = /(?:\+\+\+|---)\s+\S*?\.([A-Za-z0-9]+)\b/.exec(text);
  if (header) {
    const lang = normalizeCodeLang(header[1] ?? '');
    if (lang) return lang;
  }
  if (/#include\b|\bnamespace\b|\btemplate\b/.test(text)) return 'cpp';
  if (/\b(?:def|elif|lambda)\b/.test(text)) return 'py';
  if (/\b(?:const|function|import|export|interface)\b/.test(text)) return 'ts';
  return '';
}

export function renderDiffGutter(
  text: string,
  width: number,
  options: { markFirst?: boolean } = {}
): TuiLine[] {
  const markFirst = options.markFirst !== false;
  const lang = diffCodeLang(text);
  const lines = resultLines(text);
  if (lines.length === 0) return [];
  const { rows, digits } = parseDiffLines(lines);
  const gutterWidth = Math.max(2, digits);
  const out: TuiLine[] = [];
  let first = true;
  for (const row of rows) {
    // `markFirst: false` — the row's ⎿ lives on a headline above (tool
    // completion summary), so every gutter line takes the continuation indent.
    const prefix = first && markFirst ? `${CONTINUATION}${RESULT_MARK}  ` : RESULT_INDENT;
    first = false;
    if (row.header) {
      // `@@ -a,b +c,d @@` and `--- / +++` file headers sit at the text column,
      // but the first rendered line still carries the ⎿ block mark.
      out.push(
        line(clip(`${prefix}${' '.repeat(gutterWidth + 2)}${row.body}`, width), {
          color: 'cyan',
          dim: true,
        })
      );
      continue;
    }
    const gutter = row.elision
      ? padStartTo('⋯', gutterWidth)
      : row.anchored
        ? padStartTo(String(row.no ?? ''), gutterWidth)
        : // No hunk anchor at or above this row: a number here would be
          // fabricated (D-11, including the truncated-head case).
          padStartTo('', gutterWidth);
    const lead = `${gutter} ${row.sign}`;
    const pad = row.body.startsWith(' ') ? ' ' : '';
    const body = row.body.replace(/^ /, '');
    // The sign drives the colour (a real `diff` writes `+added` with no space,
    // which `diffTone` — kept for the approval preview — does not cover).
    const tone =
      row.sign === '+'
        ? { color: 'green' as const }
        : row.sign === '-'
          ? { color: 'red' as const }
          : { dim: true };
    const available = Math.max(4, width - displayWidth(prefix) - displayWidth(lead) - pad.length);
    const chunks = wrap(body, available);
    // An empty body (a bare `+`) still owns its gutter row.
    if (chunks.length === 0) chunks.push('');
    chunks.forEach((chunk, lineIndex) => {
      // The ⎿ mark belongs to the row, not to every wrapped line: continuations
      // are plain spaces, so they align under the code and not under the gutter.
      const head =
        lineIndex === 0
          ? `${prefix}${lead}${pad}`
          : `${RESULT_INDENT}${' '.repeat(displayWidth(lead) + pad.length)}`;
      const full = `${head}${chunk}`;
      const clipped = clip(full, width);
      const painted = lang && clipped === full ? highlightCodeLine(chunk, lang) : undefined;
      if (painted) {
        out.push({ text: full, ...tone, runs: [{ text: head }, ...painted] });
      } else {
        out.push(line(clipped, tone));
      }
    });
  }
  return out;
}

/**
 * Reasoning lines (`· …`). The compact live region keeps the last two; the
 * detailed transcript (ctrl+o) shows the stream, exactly like the reference's
 * hidden-reasoning line (`claude-code-surface.md` §9).
 */
export function renderReasoning(text: string, width: number): TuiLine[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return wrap(trimmed, Math.max(4, width - 2)).map((chunk) =>
    line(clip(`· ${chunk}`, width), { dim: true })
  );
}

/** Result rows may hide their reasoning; verbose-only, optional by design. */
function rowReasoning(row: TranscriptRow): string | undefined {
  const value = (row as { reasoning?: unknown }).reasoning;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** SGR color sequences. Slash output from the REPL helpers bakes these in. */
const SGR = /\x1b\[[0-9;]*m/g;

/** Drop baked-in SGR so the transcript styler owns the color. */
export function stripSgr(text: string): string {
  return text.replace(SGR, '');
}

/** Result text → display lines, with a replayed `⎿ ` prefix stripped once. */
function resultLines(text: string): string[] {
  return text
    .split('\n')
    .map((raw) => raw.replace(/^\s*⎿\s?/, '').replace(/\s+$/, ''))
    .filter((raw) => raw.trim() !== '');
}

// ─── committed transcript rows ────────────────────────────────────────────

/**
 * One committed row → lines. Every block starts with a blank line so entries
 * stay readable as they scroll past, exactly like the reference CLI.
 *
 * `verbose` is the detailed-transcript toggle (ctrl+o in the reference): it
 * renders every tool-output line instead of the compact preview, and reveals
 * the reasoning a row carries. Default false, so existing callers are unchanged.
 */
export function renderTranscriptRow(row: TranscriptRow, width: number, verbose = false): TuiLine[] {
  const out: TuiLine[] = [line('')];
  switch (row.kind) {
    case 'user': {
      // A `! <cmd>` submission is shell mode, not a goal: the reference swaps
      // the `❯` mark for the shell prefix and keeps the command at column 0
      // (`claude-code-surface.md` §5). Normal rows keep the exact old wrapping.
      //
      // D-10: a multi-line paste/draft keeps its own line breaks. `wrap()` alone
      // collapses ALL whitespace, so `paste-line-one\npaste-line-two` was
      // committed as one squashed row even though the model received the break.
      const shell = isShellCommandRow(row.text);
      const tone = shell ? { color: SHELL_MODE_TONE } : {};
      let first = true;
      for (const logical of row.text.split('\n')) {
        const chunks = wrap(logical, width - 2);
        if (chunks.length === 0) chunks.push('');
        for (const chunk of chunks) {
          const prefix = first ? (shell ? '' : `${USER_MARK} `) : CONTINUATION;
          out.push(line(clip(`${prefix}${chunk}`, width), tone));
          first = false;
        }
      }
      return out;
    }
    case 'assistant': {
      // Answers are markdown: headings/code/lists get their own projection while
      // the ⏺ + 2-space continuation grammar stays exactly as it was.
      // A continuation row is a later block of the same answer (stream commit).
      const reasoning = verbose ? rowReasoning(row) : undefined;
      if (reasoning) out.push(...renderReasoning(reasoning, width));
      const body: MarkdownLine[] = renderMarkdown(row.text, Math.max(4, width - 2));
      body.forEach((entry, index) => {
        const prefix = index === 0 && !row.continuation ? `${ANSWER_MARK} ` : CONTINUATION;
        const text = `${prefix}${entry.text}`;
        const clipped = clip(text, width);
        // D-12: inline runs are the source of truth for emphasis, so a mixed
        // prose line keeps its inline-code colour instead of being painted as
        // one uniform row. The prefix becomes its own run; a CLIPPED line drops
        // the runs (they must concatenate back to `text`).
        out.push(
          clipped === text
            ? { ...entry, text, ...(entry.runs ? { runs: [{ text: prefix }, ...entry.runs] } : {}) }
            : { ...entry, text: clipped, runs: undefined }
        );
      });
      return out;
    }
    case 'tool': {
      const body = wrap(`${ANSWER_MARK} ${row.text}`, width);
      return [line(''), ...body.map((text) => line(clip(text, width), { color: 'cyan' }))];
    }
    case 'result':
    case 'system': {
      // The mark is owned here: some producers (resume replay) already bake a
      // "⎿ " prefix into the row text, which used to render it twice.
      const source = resultLines(row.text);
      // A tool completion row leads with its summary headline (`Read 14 lines
      // · 0.3s`); the ⎿ mark lives on that headline, so the body below takes
      // the plain continuation indent instead of repeating it.
      const headline = renderToolHeadline(row, width);
      if (source.length === 0) {
        out.push(...headline);
        return out;
      }
      const markBody = headline.length === 0;
      if (hasDiffLines(row.text)) {
        out.push(...headline);
        const diff = renderDiffGutter(row.text, width, { markFirst: markBody });
        const shown = verbose ? diff : diff.slice(0, DIFF_PREVIEW_LINES);
        out.push(...shown);
        if (shown.length < diff.length) {
          out.push(
            line(
              clip(
                `${RESULT_INDENT}${tui('… {count} more lines · ctrl+o', { count: diff.length - shown.length })}`,
                width
              ),
              { dim: true }
            )
          );
        }
        return out;
      }
      // Compact is a preview (first few lines + a pointer at ctrl+o); verbose
      // is the whole output — the reference's collapsing behaviour (§9).
      // Read-only observations fold to the headline: the summary already says
      // what came back, so the preview lines are pure scrollback noise.
      const foldsQuiet =
        !verbose &&
        !row.tool?.isError &&
        row.tool?.name !== undefined &&
        READONLY_PREVIEW_TOOLS.has(row.tool.name);
      if (foldsQuiet && source.length > 0) {
        out.push(
          ...headline,
          line(
            clip(
              `${RESULT_INDENT}${tui('… {count} lines · ctrl+o', { count: source.length })}`,
              width
            ),
            { dim: true }
          )
        );
        return out;
      }
      const codeLike = source.some((raw) =>
        /^\s*(\+\s|-\s)?(#include|\/\/|\/\*|\*|template\b|namespace\b)/.test(raw)
      );
      const shown = verbose
        ? source
        : source.slice(0, codeLike ? CODE_PREVIEW_LINES : RESULT_PREVIEW_LINES);
      out.push(...headline);
      shown.forEach((raw, index) => {
        const tone = diffTone(raw);
        const body = wrap(raw, width - 5);
        body.forEach((text, lineIndex) => {
          const prefix =
            markBody && index === 0 && lineIndex === 0
              ? `${CONTINUATION}${RESULT_MARK}  `
              : RESULT_INDENT;
          const painted = highlightCodeLine(text.replace(/^[+-]\s/, ''), 'cpp');
          const full = `${prefix}${text}`;
          const clipped = clip(full, width);
          if (painted && clipped === full) {
            const sign = text.startsWith('+ ') ? '+ ' : text.startsWith('- ') ? '- ' : '';
            out.push({
              text: full,
              runs: [
                {
                  text: `${prefix}${sign}`,
                  ...(sign === '+ '
                    ? { color: 'green' as const }
                    : sign === '- '
                      ? { color: 'red' as const }
                      : {}),
                },
                ...painted.map((run) => ({ ...run, text: run.text })),
              ],
            });
            return;
          }
          out.push(line(clipped, codeLike ? {} : tone));
        });
      });
      if (shown.length < source.length) {
        out.push(
          line(
            clip(
              `${RESULT_INDENT}${tui('… {count} more lines · ctrl+o', { count: source.length - shown.length })}`,
              width
            ),
            { dim: true }
          )
        );
      }
      return out;
    }
    case 'detail': {
      // Slash-command output. A heading is bold; `label: value` keeps the
      // value in the normal colour so the block is not one wash of gray.
      // Producers such as /permissions bake REPL SGR into the string; that
      // defeats the label/value split and paints the whole row gray.
      const raw = stripSgr(row.text);
      const trimmed = raw.trim();
      if (!trimmed) return [line(' ')];
      const field = /^([^:]{1,32}):\s+(\S.*)$/.exec(trimmed);
      const indented = raw.startsWith(' ') && !raw.startsWith('    ');
      if (field && indented) {
        const label = `    ${field[1]}: `;
        const value = field[2] ?? '';
        const text = `${label}${value}`;
        const clipped = clip(text, width);
        if (clipped !== text) return [line(clipped, { dim: true })];
        return [
          {
            text,
            runs: [{ text: label, color: 'gray' }, { text: value }],
          },
        ];
      }
      const heading = !raw.startsWith(' ') && trimmed.length < 48;
      const indent = /^(\s*)/.exec(raw)?.[1] ?? '';
      const body = wrap(trimmed, Math.max(8, width - 4 - indent.length));
      if (body.length === 0) return [line(' ')];
      return body.map((text) =>
        line(
          clip(`${' '.repeat(4)}${text}`, width),
          heading ? { bold: true, color: 'cyan' } : { dim: true }
        )
      );
    }
    case 'summary': {
      // Finalizing status (`✻ Worked for 5s`): sits at the same 2-space column
      // as an answer continuation, not in the 4-space block body.
      out.push(line(clip(`  ${row.text}`, width), { dim: true }));
      return out;
    }
    case 'error': {
      const body = wrap(row.text, width - 2);
      out.push(line(clip(`${ANSWER_MARK} ${body[0] ?? ''}`, width), { color: 'red', bold: true }));
      for (const extra of body.slice(1)) {
        out.push(line(clip(`${CONTINUATION}${extra}`, width), { color: 'red' }));
      }
      return out;
    }
    case 'banner': {
      // Boot banner: name line loud, the rest quiet (model · device · cwd).
      const rows = row.text.split('\n');
      out.push(line(clip(rows[0] ?? '', width), { bold: true, color: 'cyan' }));
      for (const extra of rows.slice(1)) out.push(line(clip(extra, width), { dim: true }));
      return out;
    }
    default: {
      for (const raw of row.text.split('\n')) out.push(line(clip(raw, width)));
      return out;
    }
  }
}

export function renderTranscriptRows(
  rows: TranscriptRow[],
  width: number,
  verbose = false
): TuiLine[] {
  return rows.flatMap((row) => renderTranscriptRow(row, width, verbose));
}

// ─── boot banner ─────────────────────────────────────────────────────────

export interface BannerInfo {
  version: string;
  model?: string;
  cwd: string;
  device?: string;
}

export function renderBanner(info: BannerInfo, width: number): TuiLine[] {
  const meta = [info.model, info.device].filter(Boolean).join(' · ');
  return [
    line(clip(` moss v${info.version} — ${info.cwd}`, width), { bold: true, color: 'cyan' }),
    line(clip(` ${meta}`, width), { dim: true }),
  ];
}

// ─── live region (in flight) ─────────────────────────────────────────────

export interface LiveView {
  running: boolean;
  startedAt?: number;
  toolLine?: string;
  streaming: string;
  thinking: string;
  tokensOut: number;
  queued: number;
  /** First queued message (preview), so the count is not anonymous. */
  queuePreview?: string;
  /** Active provider retry (`retry` event) — the spinner alone would lie. */
  retry?: { attempt: number; error: string };
  /** Last time ANY event arrived; a quiet stream past STALL_HINT_S is flagged. */
  lastEventAt?: number;
  /** Waiting on the user (approval): the spinner must not keep pretending. */
  blocked?: boolean;
}

/** Seconds of stream silence before the live region says so out loud. */
export const STALL_HINT_S = 15;

export function renderLive(view: LiveView, width: number, verbose = false): TuiLine[] {
  if (!view.running) return [];
  const elapsedMs = view.startedAt !== undefined ? Date.now() - view.startedAt : 0;
  const out: TuiLine[] = [];
  // Compact keeps the most recent reasoning (two lines) and the streaming tail;
  // the detailed transcript shows both in full (ctrl+o in the reference).
  const reasoning = renderReasoning(view.thinking, width);
  for (const entry of verbose ? reasoning : reasoning.slice(-2)) out.push(entry);
  if (view.retry) {
    out.push(
      line(
        clip(
          tui('  ↻ provider retry {attempt} — {error}', {
            attempt: view.retry.attempt,
            error: view.retry.error.replace(/\s+/g, ' ').trim(),
          }),
          width
        ),
        { color: 'yellow' }
      )
    );
  }
  // Streaming text is deliberately rendered as plain wrapped text. Markdown
  // syntax is often incomplete between deltas (fences, tables, emphasis), so
  // reparsing it on every token makes long answers jump and reorder. The
  // committed transcript performs the full markdown projection once the turn
  // ends.
  const streamingLines = renderStreamingMarkdown(view.streaming, Math.max(4, width - 2)).map(
    (entry) => {
      const clippedText = clip(`  ${entry.text}`, width);
      return clippedText === `  ${entry.text}`
        ? { ...entry, text: clippedText, runs: entry.runs?.map((run) => ({ ...run })) }
        : line(clippedText, { dim: true });
    }
  );
  for (const entry of verbose ? streamingLines : streamingLines.slice(-8)) out.push(entry);
  if (view.blocked) return out;
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  const tokens =
    view.tokensOut > 0 ? tui(' · {count} out', { count: formatCompactCount(view.tokensOut) }) : '';
  const queued = view.queued > 0 ? tui(' · {count} queued', { count: view.queued }) : '';
  out.push(
    line(
      clip(`${spinnerFrame(elapsedMs)} ${runVerb(seconds)}… ${seconds}s${tokens}${queued}`, width),
      { color: 'yellow' }
    )
  );
  // Silence is information too: past the hint threshold the spinner stops
  // pretending the model is thinking and says the stream has gone quiet (a
  // stuck upstream gateway reads exactly like this until the watchdog aborts).
  if (view.lastEventAt !== undefined) {
    const quietS = Math.floor((Date.now() - view.lastEventAt) / 1000);
    if (quietS >= STALL_HINT_S) {
      out.push(
        line(
          clip(
            tui('  … stream quiet for {seconds}s — the gateway may be stuck', { seconds: quietS }),
            width
          ),
          { color: 'yellow' }
        )
      );
    }
  }
  if (view.queuePreview) {
    const preview = view.queuePreview.replace(/\s+/g, ' ').trim();
    out.push(line(clip(tui('  ❯ {preview}', { preview }), width), { dim: true }));
    out.push(line(clip(`  ${tui('ctrl+x ctrl+s to send now')}`, width), { dim: true }));
  }
  return out;
}

/** The line a finished run leaves behind, Claude-style: `✻ Worked for 5s · done 1:23 AM`.
 * Token telemetry lives in /usage — the run line is for the human watching. */
export function renderRunSummary(
  elapsedMs: number,
  halted: boolean,
  width: number,
  _tokens?: { input: number; output: number },
  now: Date = new Date()
): TuiLine[] {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  const verb = runVerb(seconds);
  // The local wall-clock stamp (`done 1:23 AM`) is how the reference answers
  // "when did this actually finish" for a run the user watched scroll away.
  const doneAt = tui(' · done {time}', {
    time: now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  });
  const text = halted
    ? tui('✻ {verb} for {seconds}s · interrupted', { verb, seconds })
    : tui('✻ worked for {seconds}s{doneAt}', { seconds, doneAt });
  return [line(''), line(clip(text, width), { dim: true })];
}

// ─── inline information blocks (slash commands, `?`) ─────────────────────

export function infoBlock(title: string, lines: string[], width: number): TuiLine[] {
  const out: TuiLine[] = [line(''), line(clip(`${ANSWER_MARK} ${title}`, width), { bold: true })];
  for (const raw of lines) {
    for (const text of wrap(raw, width - 5)) {
      out.push(line(clip(`${RESULT_INDENT}${text}`, width), { dim: true }));
    }
  }
  return out;
}

// ─── live todo checklist ────────────────────────────────────────────────

const TODO_GLYPH: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '✓',
};

export const TODO_PANEL_MAX_ROWS = 6;

/**
 * The agent's todo list, rendered above the composer while it works — the same
 * place the reference CLI puts its plan. Completed items go dim-green, the
 * in-flight one is the only loud row.
 */
export function renderTodoPanel(
  todos: ReadonlyArray<{ content: string; status: string }>,
  width: number,
  maxRows = TODO_PANEL_MAX_ROWS
): TuiLine[] {
  if (todos.length === 0) return [];
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const out: TuiLine[] = [
    line(
      clip(`  ${ANSWER_MARK} ${tui('{done}/{total} done', { done, total: todos.length })}`, width),
      { dim: true }
    ),
  ];
  const capacity = Math.max(1, maxRows - 1);
  for (const todo of todos.slice(0, capacity)) {
    const glyph = TODO_GLYPH[todo.status] ?? '○';
    const active = todo.status === 'in_progress';
    out.push(
      line(clip(`   ${glyph} ${todo.content}`, width), {
        ...(active ? { color: 'cyan' as const, bold: true } : {}),
        ...(todo.status === 'completed' ? { dim: true, color: 'green' as const } : {}),
        ...(todo.status === 'pending' ? { dim: true } : {}),
      })
    );
  }
  if (todos.length > capacity) {
    out.push(
      line(clip(`   … ${tui('{count} more', { count: todos.length - capacity })}`, width), {
        dim: true,
      })
    );
  }
  return out;
}

// ─── approval prompt ────────────────────────────────────────────────────

/**
 * The frozen structured approval payload (N1) plus the UI-only `cursor`. The
 * option list and the footer are read FROM the payload (N2): this renderer must
 * never invent its own, because a second hard-coded copy is exactly the drift
 * that left `setCliApprovalViewAsker` dead (SI-2).
 */
export interface ApprovalView extends Partial<CliApprovalView> {
  question: string;
  title: string;
  cursor: number;
  /**
   * Tab-to-amend armed (A6.54): option 1 becomes "Yes, and tell moss what to
   * do next" and Enter answers `amend` — the tool runs, and the user's next
   * composer message steers it.
   */
  amend?: boolean;
}

/** The frozen option list, re-exported for callers that have no payload. */
export const APPROVAL_OPTIONS: readonly CliApprovalOption[] = CLI_APPROVAL_OPTIONS;

/** The frozen footer, re-exported for callers that have no payload. */
export const APPROVAL_FOOTER = CLI_APPROVAL_FOOTER;

export const APPROVAL_FALLBACK_QUESTION = 'Do you want to proceed?';

export interface ApprovalRenderOptions {
  /**
   * Rows the dialog may occupy. The shell passes the terminal height minus the
   * rest of the pinned chrome, so a short terminal cannot push the question of a
   * security prompt off screen (D-13). Default: unbounded (unchanged rendering
   * for pure callers and specs).
   */
  maxHeight?: number;
}

export function renderApproval(
  view: ApprovalView,
  width: number,
  renderOptions: ApprovalRenderOptions = {}
): TuiLine[] {
  const maxHeight =
    renderOptions.maxHeight === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(1, renderOptions.maxHeight);
  // Verbatim from the payload (N2): the footer advertises only keys that work.
  // An EXPLICIT empty list means "this dialog has no options" (a free-text
  // `ask_user_question`); only an absent list falls back to the frozen defaults.
  const options = view.options ?? APPROVAL_OPTIONS;
  // The host owns the wording (`Do you want to create beta.txt?`); the generic
  // sentence is only the fallback for a caller with no question of its own.
  const question = view.question.split('\n').find((text) => text.trim() !== '') ?? '';
  const questionLine = line(
    clip(` ${localizeApprovalText(question.trim() || APPROVAL_FALLBACK_QUESTION)}`, width)
  );
  const amendLabel =
    view.amend && options[0]?.answer === 'y'
      ? tui('Yes, and tell moss what to do next')
      : undefined;
  const optionLines = options.map((option, index) =>
    line(
      clip(
        ` ${index === view.cursor ? '❯' : ' '} ${option.key}. ${localizeApprovalText(
          index === 0 ? (amendLabel ?? option.label) : option.label
        )}`,
        width
      ),
      {
        bold: index === view.cursor,
        ...(index === view.cursor ? {} : { dim: true }),
      }
    )
  );
  const footerLine = line(
    clip(
      ` ${view.amend ? tui('Esc to cancel · Tab to amend') : tui(view.footer ?? APPROVAL_FOOTER)}`,
      width
    ),
    { dim: true }
  );
  const headLines: TuiLine[] = [
    line(rule(width)),
    line(clip(` ${view.title}`, width), { bold: true }),
    ...(view.subject ? [line(clip(` ${view.subject}`, width), { color: 'cyan' })] : []),
  ];

  // The preview is the only unbounded part of the dialog, so it is capped by the
  // budget BEFORE anything is dropped: 2 frame rules + head + question + options
  // + footer are the fixed cost.
  const fixedCost = 2 + headLines.length + 1 + optionLines.length + 1;
  const previewCap = Number.isFinite(maxHeight)
    ? Math.max(0, Math.min(12, maxHeight - fixedCost))
    : 12;
  const previewLines: TuiLine[] = [];
  for (const raw of (view.preview ?? []).slice(0, previewCap)) {
    const tone = diffTone(raw);
    for (const text of wrap(raw, width - 3))
      previewLines.push(line(clip(`  ${text}`, width), tone));
  }
  const previewBlock: TuiLine[] =
    previewLines.length > 0
      ? [line(rule(width, '╌')), ...previewLines, line(rule(width, '╌'))]
      : [];

  const full = [...headLines, ...previewBlock, questionLine, ...optionLines, footerLine];
  if (full.length <= maxHeight) return full;
  // Degrade in priority order: preview, then the title/subject frame, then the
  // one-row-per-option list. The QUESTION is the last thing to go.
  const withoutPreview = [...headLines, questionLine, ...optionLines, footerLine];
  if (withoutPreview.length <= maxHeight) return withoutPreview;
  const tailOnly = [questionLine, ...optionLines, footerLine];
  if (tailOnly.length <= maxHeight) return tailOnly;
  const compactOptions = line(
    clip(
      ` ${options.map((option, index) => `${index === view.cursor ? '❯ ' : ''}${option.key}. ${tui(option.label)}`).join(' · ')}`,
      width
    ),
    { bold: true }
  );
  const compact = [questionLine, compactOptions, footerLine];
  if (compact.length <= maxHeight) return compact;
  // A 1–2 row pane: the question outranks the key hints.
  return [questionLine, compactOptions].slice(0, Math.max(1, maxHeight));
}

// ─── composer + bottom chrome ───────────────────────────────────────────

export { COMPOSER_MAX_ROWS } from './composer.js';

/**
 * Plain-text composer projection (the shape specs and previews assert on):
 * `❯ ` prefix, `▌` block caret, `…` elision — same wrapping engine as the
 * interactive shell, so the two can never disagree about how a goal wraps.
 */
export function renderComposer(input: string, width: number, placeholder: boolean): TuiLine[] {
  const view = renderComposerEditor(createComposer(input), {
    width,
    maxRows: COMPOSER_MAX_ROWS,
    placeholder: placeholder ? tui(PLACEHOLDER_TEXT) : undefined,
    firstPrefix: `${USER_MARK} `,
    restPrefix: '  ',
    markElision: true,
  });
  return view.lines.map((runs, index) => {
    const text = runs.map((run) => run.text).join('');
    if (view.placeholder || index !== view.caretRow) return line(text);
    // Plain previews still mark the caret. The interactive shell uses the
    // hardware cursor and must not insert this glyph.
    const body = displayWidth(text) + 1 <= width ? text : takeCells(text, Math.max(0, width - 1));
    return line(`${body}▌`);
  });
}

export const PLACEHOLDER_TEXT = 'Try "stream the camera at 30 fps and verify it"';

export interface StatusView {
  running: boolean;
  blocked?: boolean;
  model?: string;
  tokens: number;
  taskCount: number;
  queueLength: number;
  /** Context-window fill, when the provider reports one. */
  contextUsed?: number;
  contextTotal?: number;
  /**
   * Active interaction mode, straight from the policy layer
   * (`getCliInteractionMode`). Defaults to the factory-default mode (`full`,
   * v0.26) so a caller with no mode still renders the A7 hint row.
   */
  mode?: CliInteractionMode;
  /** The composer is in `!` shell mode for the current draft (R1 §5). */
  shellMode?: boolean;
  /** Pending interaction kind, so hints describe question input honestly. */
  dialogKind?: 'approval' | 'question';
  dialogHasOptions?: boolean;
  /** Numbered keys the open dialog actually offers, e.g. `1/2`. */
  answerKeys?: string;
  /** ctrl+o detailed-transcript state — the chrome must not hide it (A9.72). */
  verbose?: boolean;
  /** A stashed draft exists (Ctrl+S); composes with other badges (A2.24). */
  stashed?: boolean;
}

/** Context fill at/above which the status row turns the percentage yellow. */
export const CONTEXT_WARN_PCT = 80;
/** …and red past this line. The live warning row uses CONTEXT_WARN_PCT. */
export const CONTEXT_CRIT_PCT = 95;

export function renderStatusRight(view: StatusView, width: number): TuiLine {
  const parts: string[] = [];
  if (view.blocked) parts.push(tui('● waiting for you'));
  else if (view.running) parts.push(tui('● running'));
  if (view.verbose) parts.push(tui('verbose'));
  if (view.stashed) parts.push(tui('› stashed'));
  if (view.model) parts.push(view.model);
  let ctxPart: string | undefined;
  if (view.contextUsed !== undefined && view.contextTotal) {
    const pct = Math.min(100, Math.round((view.contextUsed / view.contextTotal) * 100));
    // Keep the idle chrome quiet like Claude Code: normal context and token
    // accounting belong in /usage and the completed run summary. Surface the
    // context percentage here only when it needs the user's attention.
    if (pct >= CONTEXT_WARN_PCT) {
      ctxPart = tui('{pct}% ctx', { pct });
      parts.push(ctxPart);
    }
  }
  if (view.running && view.tokens > 0)
    parts.push(
      tui('{count} out', {
        count: view.tokens >= 1000 ? `${Math.round(view.tokens / 100) / 10}k` : view.tokens,
      })
    );
  const text = parts.join(' · ');
  const pad = ' '.repeat(Math.max(0, width - displayWidth(text)));
  const full = `${pad}${text}`;
  // A hot context window is the one part of this row that can demand action:
  // paint just that segment (yellow → red) and keep the rest of the row dim.
  if (
    ctxPart &&
    view.contextUsed !== undefined &&
    view.contextTotal &&
    displayWidth(full) <= width
  ) {
    const pct = Math.min(100, Math.round((view.contextUsed / view.contextTotal) * 100));
    if (pct >= CONTEXT_WARN_PCT) {
      const idx = full.lastIndexOf(ctxPart);
      const color: TuiColor = pct >= CONTEXT_CRIT_PCT ? 'red' : 'yellow';
      return {
        text: clip(full, width),
        dim: true,
        runs: [
          { text: full.slice(0, idx) },
          { text: ctxPart, color, bold: true },
          { text: full.slice(idx + ctxPart.length) },
        ],
      };
    }
  }
  return line(clip(full, width), { dim: true });
}

/**
 * The 2-space-indented hint row under the rule (A7): the active interaction
 * mode is always present, and only the keys that work in the current state are
 * advertised. In `!` shell mode the whole row takes the shell accent and says
 * `! for shell mode` (E3), while still naming the mode so A7 cannot regress.
 */
export function renderHint(view: StatusView, width: number): TuiLine {
  const mode = view.mode ?? 'full';
  const modeLabel = interactionModeHint(mode);
  if (view.shellMode) {
    return line(
      clip(`  ${[tui('! for shell mode'), tui('Esc to cancel'), modeLabel].join(' · ')}`, width),
      {
        color: SHELL_MODE_TONE,
        bold: true,
      }
    );
  }
  const parts = [modeLabel, tui('? for shortcuts')];
  if (view.blocked) {
    if (view.dialogKind === 'question') {
      parts.push(
        view.dialogHasOptions
          ? tui('{keys} to answer', { keys: view.answerKeys ?? '1/2/3' })
          : tui('type answer · Enter to send'),
        tui('Esc to skip')
      );
    } else {
      parts.push(
        tui('{keys} to answer', { keys: view.answerKeys ?? '1/2/3' }),
        tui('Tab to amend')
      );
    }
  } else if (view.running) parts.push(tui('Esc to interrupt'));
  if (view.verbose) parts.push(tui('verbose transcript · ctrl+o to exit'));
  if (view.queueLength > 0) parts.push(tui('{count} queued', { count: view.queueLength }));
  if (view.taskCount > 0)
    parts.push(
      tui(view.taskCount === 1 ? '{count} task' : '{count} tasks', { count: view.taskCount })
    );
  return line(clip(`  ${parts.join(' · ')}`, width), {
    color: INTERACTION_MODE_TONES[mode],
    // full is the resting mode: dim gray, not a yellow bar across the footer.
    ...(mode === 'full' || mode === 'manual' ? { dim: true } : {}),
  });
}

/**
 * Collapse a run of read-only tool calls into one summary line. Verbose mode
 * keeps every row. The store itself is unchanged; this is a projection.
 */
export function foldReadonlyRows(
  rows: readonly TranscriptRow[],
  verbose: boolean
): TranscriptRow[] {
  if (verbose) return [...rows];
  const out: TranscriptRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (row.kind === 'tool' && row.tool?.name && READONLY_PREVIEW_TOOLS.has(row.tool.name)) {
      let reads = 0;
      let lists = 0;
      let cursor = index;
      while (cursor < rows.length) {
        const current = rows[cursor]!;
        if (
          current.kind !== 'tool' ||
          !current.tool?.name ||
          !READONLY_PREVIEW_TOOLS.has(current.tool.name)
        ) {
          break;
        }
        if (current.tool.name.includes('list') || current.tool.name === 'search_files') lists += 1;
        else reads += 1;
        cursor += 1;
        if (rows[cursor]?.kind === 'result') cursor += 1;
      }
      if (reads + lists > 1) {
        const parts = [
          reads > 0 ? `read ${reads} file${reads === 1 ? '' : 's'}` : '',
          lists > 0 ? `listed ${lists} director${lists === 1 ? 'y' : 'ies'}` : '',
        ].filter(Boolean);
        out.push({ id: row.id, kind: 'summary', text: parts.join(', ') });
        index = cursor;
        continue;
      }
    }
    out.push(row);
    index += 1;
  }
  return out;
}

export { displayWidth };
