/**
 * O98: no false success at the end of a headless run.
 *
 * O14 run2 ended with "All checks are green" although `format:check` never
 * ran and `npm run check` was red; kimi-k3 r2 changed zero files and still
 * exited 0. This module is the single place that decides whether a run is
 * really finished:
 *
 *  - {@link createRunCompletionTracker} / {@link noteRunCompletionEvent}
 *    record which verification commands actually ran (and whether they passed)
 *    and whether any file was written, from the agent event stream.
 *  - {@link findUnverifiedCheckClaims} lists success claims in the final
 *    answer that no run in this session backs up.
 *  - {@link assessRunCompletion} turns that into a verdict with a reason, the
 *    step it got stuck on, and the exit code.
 *  - {@link formatIncompleteLine} renders the mandatory last line
 *    (`未完成：… ；卡在：…` / `Incomplete: …; stuck at: …`).
 *
 * O99 (progress) must import the stable bilingual outcome from
 * {@link ./run-outcome.js} (`resolveRunOutcome` / `formatOutcomeLine`) rather
 * than calling these helpers directly.
 */
import type { MossAgentEvent } from '../core/index.js';
import { ExitCode } from './exit-codes.js';

export type VerificationCheck = 'format' | 'lint' | 'typecheck' | 'test' | 'check';

export interface CheckRun {
  command: string;
  passed: boolean;
}

export interface RunCompletionTracker {
  /** Latest run of each check kind in this run (later runs overwrite earlier ones). */
  checks: Map<VerificationCheck, CheckRun>;
  /** True once a file-writing tool (or a write-like exec) succeeded. */
  wroteFiles: boolean;
  /** Last failed tool step, e.g. `exec: npm run check`. */
  lastFailedStep?: string;
  /** Last tool step that started, e.g. `multi_edit: src/cli/hooks.ts`. */
  lastStep?: string;
  /** @internal pending tool_start inputs keyed by toolCallId. */
  pending: Map<string, { toolName: string; input: Record<string, unknown> }>;
}

export type RunCompletionStatus = 'complete' | 'incomplete';

export interface RunCompletionVerdict {
  status: RunCompletionStatus;
  /** Human reasons (already localized); empty when complete. */
  reasons: string[];
  /** Where the run got stuck, when known. */
  stuckAt?: string;
  /** Claims in the final answer that were not backed by a real passing run. */
  unverifiedClaims: VerificationCheck[];
  /** 0 when complete, otherwise non-zero (existing error code or {@link ExitCode.INCOMPLETE}). */
  exitCode: number;
}

export interface AssessRunCompletionInput {
  tracker: RunCompletionTracker;
  /** Final assistant answer. */
  finalText: string;
  /** Original user request; used to decide whether file changes were expected. */
  request?: string;
  /** The run already ended in error (max turns, budget, provider error …). */
  runError?: string;
  /** Exit code already chosen for that error. */
  errorExitCode?: number;
  zh?: boolean;
}

const FILE_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'move_file',
  'delete_file',
]);
const EXEC_TOOLS = new Set(['exec', 'exec_background', 'device_exec']);
const WRITE_LIKE_EXEC =
  /(?:\bnode\s+-e\b|\bsed\s+-i|\bperl\s+-[a-z]*i|>>?\s*[^\s&|]|\btee\b|\bgit\s+(?:apply|am|checkout|restore|mv|rm)\b|\bpatch\b|\b(?:mv|cp|rm|touch|mkdir)\s|\bprettier\b[^|;&]*--write|\beslint\b[^|;&]*--fix|\bnpm\s+run\s+(?:format|lint:fix)\b(?!:check))/;

/** Map a shell command to the verification checks it really runs. */
export function checksForCommand(command: string): VerificationCheck[] {
  const out = new Set<VerificationCheck>();
  if (/\bnpm\s+run\s+(?:check|verify)\b(?![:\w-])/.test(command)) {
    out.add('check');
    out.add('format');
    out.add('lint');
    out.add('typecheck');
  }
  if (/\bnpm\s+run\s+verify\b/.test(command)) out.add('test');
  if (/\bnpm\s+run\s+format:check\b|\bprettier\b[^|;&]*--check\b/.test(command)) out.add('format');
  if (/\bnpm\s+run\s+lint\b(?!:fix)|\beslint\b(?![^|;&]*--fix)/.test(command)) out.add('lint');
  if (/\bnpm\s+run\s+typecheck\b|\btsc\b[^|;&]*--noEmit\b/.test(command)) out.add('typecheck');
  if (
    /\b(?:npm\s+(?:run\s+)?test(?::\w+)?|npm\s+t|yarn\s+test|pnpm\s+test|node\s+--test|pytest|vitest|jest|mocha|go\s+test|cargo\s+test|make\s+test)\b/.test(
      command
    ) ||
    /\bnode\s+\S*\.spec\.[cm]?js\b/.test(command)
  ) {
    out.add('test');
  }
  return [...out];
}

export function createRunCompletionTracker(): RunCompletionTracker {
  return { checks: new Map(), wroteFiles: false, pending: new Map() };
}

function describeStep(toolName: string, input: Record<string, unknown>): string {
  const command = typeof input.command === 'string' ? input.command : undefined;
  const filePath = typeof input.path === 'string' ? input.path : undefined;
  const detail = (command ?? filePath ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return detail ? `${toolName}: ${detail}` : toolName;
}

function execFailed(result: string): boolean {
  return /\bexit(?:ed)?(?:\s+code)?[\s:=]+[1-9]\d*\b/i.test(result);
}

/** Feed one agent event into the tracker. Safe to call for every event. */
export function noteRunCompletionEvent(tracker: RunCompletionTracker, event: MossAgentEvent): void {
  if (event.type === 'tool_start') {
    tracker.pending.set(event.toolCallId, { toolName: event.toolName, input: event.input ?? {} });
    tracker.lastStep = describeStep(event.toolName, event.input ?? {});
    return;
  }
  if (event.type !== 'tool_end') return;
  const started = tracker.pending.get(event.toolCallId);
  tracker.pending.delete(event.toolCallId);
  const input = started?.input ?? {};
  const toolName = started?.toolName ?? event.toolName;
  const failed = event.isError || (EXEC_TOOLS.has(toolName) && execFailed(event.result));
  if (failed) tracker.lastFailedStep = describeStep(toolName, input);

  if (FILE_WRITE_TOOLS.has(toolName) && !failed) tracker.wroteFiles = true;
  if (toolName === 'run_tests')
    tracker.checks.set('test', { command: 'run_tests', passed: !failed });
  if (EXEC_TOOLS.has(toolName) && typeof input.command === 'string') {
    const command = input.command;
    if (!failed && WRITE_LIKE_EXEC.test(command)) tracker.wroteFiles = true;
    for (const check of checksForCommand(command)) {
      tracker.checks.set(check, { command, passed: !failed });
    }
  }
}

const CLAIM_PATTERNS: Array<{ re: RegExp; requires: VerificationCheck[] }> = [
  {
    re: /\ball\s+(?:the\s+)?checks?\s+(?:are\s+|is\s+)?(?:green|pass(?:ed|ing)?|clean|ok)\b|(?:全部|所有)(?:的)?检查(?:都|均|全部)?(?:已)?(?:通过|是绿的|绿了|变绿)|\bnpm\s+run\s+check\b[^.\n。]*\b(?:pass(?:es|ed)?|green|succeed(?:s|ed)?|clean)\b|npm\s+run\s+check[^。\n]*(?:通过|绿)/i,
    requires: ['check'],
  },
  {
    re: /\b(?:prettier(?:\s+--check)?|format:check|formatting)\b[^.\n。]*\b(?:pass(?:es|ed)?|green|clean|ok)\b|(?:prettier|format:check|格式检查)[^。\n]*(?:通过|绿)/i,
    requires: ['format'],
  },
  {
    re: /\b(?:eslint|lint(?:ing)?)\b[^.\n。]*\b(?:pass(?:es|ed)?|green|clean|ok)\b|(?:eslint|lint)[^。\n]*(?:通过|绿)/i,
    requires: ['lint'],
  },
  {
    re: /\b(?:typecheck|tsc|type\s*check(?:ing)?)\b[^.\n。]*\b(?:pass(?:es|ed)?|green|clean|ok)\b|(?:typecheck|tsc|类型检查)[^。\n]*(?:通过|绿)/i,
    requires: ['typecheck'],
  },
  {
    re: /\b(?:all\s+)?tests?\s+(?:are\s+|now\s+)?(?:pass(?:es|ed|ing)?|green)\b|\d+\s*\/\s*\d+\s+(?:tests?\s+)?passed\b|测试(?:都|均|全部)?(?:已)?(?:通过|绿了|变绿)/i,
    requires: ['test'],
  },
];

/**
 * Success claims in `text` that the run does not back up: the matching check
 * never ran, or its latest run failed.
 */
export function findUnverifiedCheckClaims(
  text: string,
  tracker: RunCompletionTracker
): VerificationCheck[] {
  const missing = new Set<VerificationCheck>();
  const sentences = text.split(/(?<=[.!?。！？])\s+|\n+/);
  for (const sentence of sentences) {
    for (const { re, requires } of CLAIM_PATTERNS) {
      const match = re.exec(sentence);
      if (!match) continue;
      if (/\b(?:not|n't|never)\b|未|没|尚未|无法/.test(match[0])) continue;
      for (const check of requires) {
        const run = tracker.checks.get(check);
        if (!run || !run.passed) missing.add(check);
      }
    }
  }
  return [...missing];
}

const CHECK_LABEL: Record<VerificationCheck, string> = {
  check: 'npm run check',
  format: 'format:check',
  lint: 'lint',
  typecheck: 'typecheck',
  test: 'test',
};

const EXPECTS_CHANGES =
  /(?:修复|修改|实现|改成|改为|改掉|新增|添加|增加|补上|补一|重构|删掉|删除|\bfix(?:es)?\b|\bimplement\b|\brefactor\b|\bchange\b|\bupdate\b|\bedit\b|\bwrite\s+(?:a\s+)?(?:test|file|function)|\badd\s+(?:a\s+|an\s+)?(?:test|option|flag|function|file|check|support))/i;
const QUESTION_ONLY =
  /^(?:how|why|what|which|explain|describe|can you explain|为什么|怎么|如何|解释|说明一下|是什么)|[?？]\s*$/i;

/** Heuristic: does this request expect the run to change files? */
export function requestExpectsFileChanges(request: string): boolean {
  const text = request.trim();
  if (!text || QUESTION_ONLY.test(text)) return false;
  return EXPECTS_CHANGES.test(text);
}

/** Decide whether the run is complete; never upgrades an error run to success. */
export function assessRunCompletion(input: AssessRunCompletionInput): RunCompletionVerdict {
  const zh = input.zh ?? false;
  const { tracker } = input;
  const reasons: string[] = [];
  const unverifiedClaims = findUnverifiedCheckClaims(input.finalText, tracker);

  if (input.runError) reasons.push(input.runError);
  if (unverifiedClaims.length > 0) {
    const labels = unverifiedClaims.map((c) => CHECK_LABEL[c]).join(', ');
    const failedRun = unverifiedClaims.some((c) => tracker.checks.get(c));
    reasons.push(
      zh
        ? `收尾声称检查已通过，但本次运行${failedRun ? '中这些检查未通过或' : ''}未实际跑过：${labels}`
        : `final answer claims checks passed, but this run did not actually pass: ${labels}`
    );
  }
  if (input.request && requestExpectsFileChanges(input.request) && !tracker.wroteFiles) {
    reasons.push(
      zh
        ? '任务需要改动文件，但本次运行没有修改任何文件'
        : 'the task needed file changes, but no file was modified'
    );
  }

  if (reasons.length === 0) {
    return { status: 'complete', reasons, unverifiedClaims, exitCode: ExitCode.SUCCESS };
  }
  const stuckAt =
    tracker.lastFailedStep ??
    (unverifiedClaims.length > 0
      ? zh
        ? `验证（未运行 ${unverifiedClaims.map((c) => CHECK_LABEL[c]).join(', ')}）`
        : `verification (did not run ${unverifiedClaims.map((c) => CHECK_LABEL[c]).join(', ')})`
      : tracker.lastStep);
  const exitCode =
    input.errorExitCode && input.errorExitCode !== 0 ? input.errorExitCode : ExitCode.INCOMPLETE;
  return {
    status: 'incomplete',
    reasons,
    ...(stuckAt ? { stuckAt } : {}),
    unverifiedClaims,
    exitCode,
  };
}

/** The mandatory last line for an incomplete run; '' when complete. */
export function formatIncompleteLine(
  verdict: RunCompletionVerdict,
  opts: { zh?: boolean } = {}
): string {
  if (verdict.status === 'complete') return '';
  const reason = verdict.reasons
    .join(opts.zh ? '；' : '; ')
    .replace(/\s+/g, ' ')
    .trim();
  const stuck = verdict.stuckAt ?? (opts.zh ? '未知' : 'unknown');
  return opts.zh
    ? `未完成：${reason}；卡在：${stuck}`
    : `Incomplete: ${reason}; stuck at: ${stuck}`;
}
