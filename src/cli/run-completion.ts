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
 *    (`未完成：…`[+`；卡在：…` when known] / `Incomplete: …`[+`; stuck at: …`]).
 *
 * O99 (progress) must import the stable bilingual outcome from
 * {@link ./run-outcome.js} (`resolveRunOutcome` / `formatOutcomeLine`) rather
 * than calling these helpers directly.
 */
import type { MossAgentEvent } from '../core/index.js';
import { listBackgroundProcessSnapshots } from '../core/tools/background-process-registry.js';
import { parseProtectedPathModMarker } from '../safety/protected-path-snapshot.js';
import { ExitCode } from './exit-codes.js';

export type VerificationCheck = 'format' | 'lint' | 'typecheck' | 'test' | 'check';

export interface CheckRun {
  command: string;
  passed: boolean;
}

export interface GoalVerifyResult {
  command: string;
  passed: boolean;
  exitCode?: number;
  /** Short error / stdout+stderr tail for the outcome line. */
  error?: string;
  timedOut?: boolean;
  spawnFailed?: boolean;
}

export interface RunCompletionTracker {
  /** Latest run of each check kind in this run (later runs overwrite earlier ones). */
  checks: Map<VerificationCheck, CheckRun>;
  /** True once a file-writing tool (or a write-like exec) succeeded. */
  wroteFiles: boolean;
  /** Last failed tool step, e.g. `exec: npm run check`. */
  lastFailedStep?: string;
  /**
   * O113: last tool step blocked by safety / approval (not a normal tool fail).
   * When set, the incomplete last line uses 「被拦：…」 / `Blocked by: …`.
   */
  lastBlockedStep?: string;
  /** Last tool step that started, e.g. `multi_edit: src/cli/hooks.ts`. */
  lastStep?: string;
  /** Latest MOSS_GOAL_VERIFY_CMD result (O98 — must feed the tracker). */
  goalVerify?: GoalVerifyResult;
  /**
   * O101 layer 3: protected paths modified by a shell command (post-run
   * detection). When set, the run is incomplete regardless of model claims.
   */
  protectedPathChanges?: Array<{ path: string; kind: string; command?: string }>;
  /**
   * O103: protected-path writes the approval gate refused before they ran
   * (`-p` deny or user said no). Drives the outcome on its own — a run with a
   * refused protected write is never「完成」, whatever the final answer says.
   */
  protectedPathBlocks?: Array<{ step: string; what: string }>;
  /**
   * O121: every safety / approval refusal of this run (dangerous command,
   * protected path, partial-read edit, hook, loop-guard, -p approval deny …),
   * in order. Any entry makes the run 「未完成」 exit 9, whatever the final
   * answer claims. User-approved actions never land here (they were not
   * refused). `en`/`zh` name what was refused for the last line.
   */
  safetyBlocks?: SafetyBlock[];
  /**
   * O121 (PM ruling): loop-guard short-circuits are NOT safety blocks. They
   * still end the run 「未完成」 exit 9, but as 「卡在」/`stuck at`, never 被拦.
   */
  loopGuardStops?: Array<{ step: string; en: string; zh: string }>;
  /** @internal pending tool_start inputs keyed by toolCallId. */
  pending: Map<string, { toolName: string; input: Record<string, unknown> }>;
}

export type SafetyBlockKind =
  | 'dangerous'
  | 'protected'
  | 'partial-read'
  | 'hook'
  | 'loop-guard'
  | 'approval'
  | 'denied'
  | 'policy'
  | 'sandbox'
  | 'other';

export interface SafetyBlock {
  kind: SafetyBlockKind;
  /** Tool step, e.g. `exec: rm -rf /`. */
  step: string;
  /** What was refused, user-readable (UX): e.g. dangerous command `rm -rf /`. */
  en: string;
  zh: string;
  /** partial-read only: the path, so a later successful edit clears it. */
  path?: string;
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

/**
 * O113: true when a tool_end result is a safety / approval / policy block
 * (not a normal tool failure like exit 1 or missing file).
 */
export function isSafetyOrApprovalBlockResult(result: string | undefined): boolean {
  if (!result) return false;
  const head = result.slice(0, 600);
  return (
    /^\s*Command blocked:/i.test(head) ||
    /^\s*Blocked dangerous command:/i.test(head) ||
    /^\s*已拦截/u.test(head) ||
    /^\s*Blocked\b/i.test(head) ||
    /^\s*Tool execution denied\b/i.test(head) ||
    /^\s*Operation blocked by workspace policy\b/i.test(head)
  );
}

/** O103: the block came from the protected-path gate (O94 copy). */
const PROTECTED_BLOCK_TEXT =
  /受保护路径|protected path|会改 git 钩子目录|would redirect git hooks|下载目标由变量\/命令替换拼出|download target built from a variable/i;

/** Short "what was refused" from a protected-path block result. */
export function protectedBlockSummary(result: string): string | undefined {
  if (!isSafetyOrApprovalBlockResult(result)) return undefined;
  const head = result.slice(0, 600);
  if (!PROTECTED_BLOCK_TEXT.test(head)) return undefined;
  const body = head
    .replace(/^\s*(?:已拦截[：:]|Blocked:|Tool execution denied:)\s*/i, '')
    .split(/，非交互|; Moss is running|。|\.\s/)[0]!
    .replace(/\s+/g, ' ')
    .trim();
  return body.slice(0, 160) || undefined;
}

const BLOCK_LABEL: Record<SafetyBlockKind, { en: string; zh: string }> = {
  dangerous: { en: 'dangerous command', zh: '危险命令' },
  protected: { en: 'protected path', zh: '受保护路径' },
  'partial-read': { en: 'edit after partial read', zh: '局部读后编辑' },
  hook: { en: 'hook blocked', zh: '钩子拦下' },
  'loop-guard': { en: 'loop guard', zh: '重复失败保护' },
  approval: { en: 'needs approval (could not ask)', zh: '需要确认但无法询问' },
  denied: { en: 'denied by user', zh: '用户拒绝' },
  policy: { en: 'workspace policy', zh: '工作区策略' },
  sandbox: { en: 'write outside the workspace', zh: '写到工作区外' },
  other: { en: 'safety check', zh: '安全检查' },
};

/**
 * O121: classify a finished tool call as a safety / approval refusal.
 * Gate is structural first: the loop's `outcome` ('denied' | 'blocked') or the
 * tool's own refusal prefix (`Command blocked:` / `Blocked dangerous command:`,
 * which the exec tools return before running anything). Text is only used to
 * pick the label and to drop non-safety guards (tool budget, read dedupe).
 */
export function classifySafetyBlock(
  toolName: string,
  input: Record<string, unknown>,
  result: string | undefined,
  outcome: string | undefined
): SafetyBlock | undefined {
  const text = result ?? '';
  const head = text.slice(0, 600);
  const step = describeStep(toolName, input);
  const command =
    typeof input.command === 'string'
      ? input.command.replace(/\s+/g, ' ').trim().slice(0, 120)
      : undefined;
  const filePath = typeof input.path === 'string' ? input.path : undefined;
  const make = (kind: SafetyBlockKind, subject: string, extra: Partial<SafetyBlock> = {}) => ({
    kind,
    step,
    en: `${BLOCK_LABEL[kind].en} \`${subject}\``,
    zh: `${BLOCK_LABEL[kind].zh} \`${subject}\``,
    ...extra,
  });
  // O97: edit refused because only a partial window was read (edit tools
  // return this as a plain error; the file is untouched).
  if (
    FILE_WRITE_TOOLS.has(toolName) &&
    /^\s*(?:Error:\s*)?You only read a partial window of /.test(head)
  ) {
    return make('partial-read', filePath ?? step, filePath ? { path: filePath } : {});
  }
  const structural = outcome === 'denied' || outcome === 'blocked';
  const refusalPrefix =
    /^\s*(?:已拦截[：:]\s*)?(?:Command blocked:|Blocked dangerous command:)/i.test(head);
  if (!structural && !refusalPrefix && !isSafetyOrApprovalBlockResult(text)) return undefined;
  // Not safety: tool budget (run-budget class, O111) and loop-guard dedupe of
  // redundant calls (`[moss-agent] Tool loop guard stopped …`).
  if (/^\s*Tool budget reached/i.test(head)) return undefined;
  if (/^\s*(?:已停止重试：|Stopped retrying:)/i.test(head)) return make('loop-guard', step);
  if (/^\s*\[moss-agent\] Tool loop guard stopped/i.test(head)) return undefined;
  if (!structural && !refusalPrefix) {
    // Text-only matches (no structural outcome): keep the O113 set but only
    // for explicit refusal copy.
    if (
      !/^\s*(?:已停止重试：|Stopped retrying:|已拦截|Blocked\b|Tool execution denied\b|Operation blocked by workspace policy\b)/i.test(
        head
      )
    )
      return undefined;
  }
  const what = protectedBlockSummary(text);
  if (what) return { kind: 'protected', step, en: what, zh: what };
  const subject = command ?? filePath ?? step;
  if (/shell write escapes the workspace sandbox/i.test(head)) return make('sandbox', subject);
  if (/^\s*(?:已拦截[：:]\s*)?(?:Command blocked:|Blocked dangerous command:)/i.test(head))
    return make('dangerous', subject);
  if (/^\s*Operation blocked by workspace policy\b/i.test(head)) return make('policy', subject);
  if (/\bhook\b|钩子/i.test(head)) return make('hook', step);
  if (
    /failed to start \d+ time|timed out \d+ time|was killed \d+ time|returned unusable (?:results|output)|edit-locked|which the edit tools just refused|未能启动|连续(?:超时|被信号|返回)/i.test(
      head
    )
  )
    return make('loop-guard', step);
  if (/requires approval|needs approval|non-interactively|cannot ask|无法询问|非交互/i.test(head))
    return make('approval', step);
  if (/denied by user|用户拒绝/i.test(head)) return make('denied', step);
  return make('other', step);
}

/** O121: 「exec 未能启动（找不到命令 `X`）」 / `exec failed to start (command `X` not found)`. */
function loopGuardStuck(toolName: string, text: string, step: string): { en: string; zh: string } {
  const missing = /\(missing command: ([^\s)]+)\)/.exec(text)?.[1];
  if (missing)
    return {
      en: `${toolName} failed to start (command \`${missing}\` not found)`,
      zh: `${toolName} 未能启动（找不到命令 \`${missing}\`）`,
    };
  if (/failed to start \d+ time/i.test(text))
    return { en: `${toolName} failed to start`, zh: `${toolName} 未能启动` };
  if (/timed out \d+ time/i.test(text))
    return { en: `${toolName} timed out repeatedly`, zh: `${toolName} 连续超时` };
  if (/was killed \d+ time/i.test(text))
    return { en: `${toolName} was killed repeatedly`, zh: `${toolName} 连续被信号杀掉` };
  return { en: step, zh: step };
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
  // O121: every safety / approval refusal goes into the block record.
  const block = classifySafetyBlock(toolName, input, event.result, event.outcome);
  if (block?.kind === 'loop-guard') {
    tracker.loopGuardStops = [
      ...(tracker.loopGuardStops ?? []),
      { step: block.step, ...loopGuardStuck(toolName, event.result ?? '', block.step) },
    ];
  } else if (block) {
    tracker.safetyBlocks = [...(tracker.safetyBlocks ?? []), block];
    tracker.lastBlockedStep = block.step;
  }
  // A partial-read refusal is recovered once the same path is edited for real.
  if (!failed && !block && FILE_WRITE_TOOLS.has(toolName) && typeof input.path === 'string') {
    const p = input.path;
    if (tracker.safetyBlocks?.some((b) => b.kind === 'partial-read' && b.path === p)) {
      tracker.safetyBlocks = tracker.safetyBlocks.filter(
        (b) => !(b.kind === 'partial-read' && b.path === p)
      );
    }
  }
  if (failed || block) {
    const step = describeStep(toolName, input);
    tracker.lastFailedStep = step;
    // O113: remember safety/approval blocks separately so the last line can say 被拦.
    if (block?.kind !== 'loop-guard' && isSafetyOrApprovalBlockResult(event.result)) {
      tracker.lastBlockedStep = step;
      const what = protectedBlockSummary(event.result);
      if (what) {
        tracker.protectedPathBlocks = [...(tracker.protectedPathBlocks ?? []), { step, what }];
      }
    }
  }

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

  // O101 layer 3: post-run protected-path modifications → incomplete.
  if (typeof event.result === 'string') {
    const mods = parseProtectedPathModMarker(event.result);
    if (mods && mods.length > 0) {
      const command = typeof input.command === 'string' ? input.command : toolName;
      mergeProtectedPathChanges(
        tracker,
        mods.map((m) => ({ ...m, command })),
        describeStep(toolName, input)
      );
    }
  }
}

/**
 * O108: fold layer-3 hits from finished `exec_background` processes into the
 * tracker. Call before {@link resolveRunOutcome} so late exits (after the tool
 * returned a job id) still mark the run incomplete. Dedupes by path+kind.
 */
export function noteBackgroundProtectedPathMods(tracker: RunCompletionTracker): void {
  for (const snap of listBackgroundProcessSnapshots()) {
    if (snap.status === 'running') continue;
    const changes = snap.protectedPathChanges;
    if (!changes || changes.length === 0) continue;
    mergeProtectedPathChanges(
      tracker,
      changes.map((c) => ({ path: c.path, kind: c.kind, command: snap.command })),
      `exec_background: ${snap.command.replace(/\s+/g, ' ').trim().slice(0, 120)}`
    );
  }
}

function mergeProtectedPathChanges(
  tracker: RunCompletionTracker,
  additions: Array<{ path: string; kind: string; command?: string }>,
  failedStep?: string
): void {
  if (additions.length === 0) return;
  const existing = tracker.protectedPathChanges ?? [];
  const seen = new Set(existing.map((c) => `${c.path}\0${c.kind}`));
  const extra = additions.filter((a) => !seen.has(`${a.path}\0${a.kind}`));
  if (extra.length === 0) return;
  tracker.protectedPathChanges = [...existing, ...extra];
  if (failedStep) tracker.lastFailedStep = failedStep;
}

/**
 * Record a MOSS_GOAL_VERIFY_CMD result on the tracker and mirror it into the
 * check map so claim detection sees the real verification outcome.
 */
export function noteGoalVerifyResult(
  tracker: RunCompletionTracker,
  result: GoalVerifyResult
): void {
  tracker.goalVerify = result;
  const step = `VERIFY_CMD: ${result.command.replace(/\s+/g, ' ').trim().slice(0, 120)}`;
  tracker.lastStep = step;
  if (!result.passed) tracker.lastFailedStep = step;
  for (const check of checksForCommand(result.command)) {
    tracker.checks.set(check, { command: result.command, passed: result.passed });
  }
  // A bare `npm run check`-style verify still covers the umbrella "check" claim
  // even when checksForCommand finds nothing (e.g. custom scripts).
  if (!checksForCommand(result.command).length) {
    tracker.checks.set('check', { command: result.command, passed: result.passed });
  }
}

const CLAIM_PATTERNS: Array<{ re: RegExp; requires: VerificationCheck[] }> = [
  {
    re: /\ball\s+(?:the\s+)?checks?\s+(?:are\s+|is\s+)?(?:green|pass(?:ed|ing)?|clean|ok)\b|(?:全部|所有)(?:的)?检查(?:都|均|全部)?(?:已)?(?:通过|是绿的|绿了|变绿)|检查(?:都|均|全部)(?:已)?(?:通过|是绿的|绿了|变绿)|检查(?:都|均)?全绿|\bnpm\s+run\s+check\b[^.\n。]*\b(?:pass(?:es|ed)?|green|succeed(?:s|ed)?|clean)\b|npm\s+run\s+check[^。\n]*(?:通过|绿)/i,
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
    re: /\b(?:all\s+)?tests?\s+(?:are\s+|now\s+)?(?:pass(?:es|ed|ing)?|green)\b|\d+\s*\/\s*\d+\s+(?:tests?\s+)?passed\b|测试(?:都|均|全部)?(?:已)?(?:通过|绿了|变绿)|\bnpm\s+(?:run\s+)?test\b[^。\n]*(?:通过|绿)/i,
    requires: ['test'],
  },
];

/**
 * Success claims in `text` that the run does not back up: the matching check
 * never ran, or its latest run failed.
 */
/** Explanatory / conditional framing — not a success claim (O110). */
const CLAIM_NON_ASSERTIVE =
  /才算|表示|意味着|说明(?:了|着)?|等.{0,16}后再|等.{0,16}后|如果|的话|\bmeans?\b|\bmust\b[\s\S]{0,40}?\bbefore\b|\bwait\s+until\b|\bbefore\s+(?:it\s+)?counts\b|\bthen\s+merge\b/i;

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
      // Questions / explanations / conditionals are not claims that checks passed.
      if (CLAIM_NON_ASSERTIVE.test(sentence)) continue;
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
  /(?:修复|修好|修一下|修掉|改好|修改|实现|改成|改为|改掉|新增|添加|增加|补上|补一|重构|删掉|删除|\bfix(?:es)?\b|\bimplement\b|\brefactor\b|\bchange\b|\bupdate\b|\bedit\b|\bwrite\s+(?:a\s+)?(?:test|file|function)|\badd\s+(?:a\s+|an\s+)?(?:test|option|flag|function|file|check|support))/i;
const QUESTION_ONLY =
  /^(?:how|why|what|which|explain|describe|can you explain|为什么|怎么|如何|解释|说明一下|是什么)|[?？]\s*$/i;

/**
 * Soft ZH change verbs (修好/改好/修一下/修掉) only count in imperative use.
 * Strip question / hypothetical frames (能不能/是否/之后…) before matching (O110).
 */
const SOFT_ZH_CHANGE_NON_IMPERATIVE =
  /(?:能不能|可不可以|是否|能否)[^。！？\n?]{0,24}?(?:修好|改好|修一下|修掉)|(?:修好|改好|修一下|修掉)(?:之后|了没有|了吗|了没)/g;

/** Heuristic: does this request expect the run to change files? */
export function requestExpectsFileChanges(request: string): boolean {
  const text = request.trim();
  if (!text || QUESTION_ONLY.test(text)) return false;
  if (!EXPECTS_CHANGES.test(text)) return false;
  // If the only hits were soft ZH verbs in Q/hypothetical frames, do not expect writes.
  const scrubbed = text.replace(SOFT_ZH_CHANGE_NON_IMPERATIVE, ' ');
  return EXPECTS_CHANGES.test(scrubbed);
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
    reasons.push(zh ? '没有改动任何文件' : 'no files were modified');
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
  // O111: omit 「卡在：…」 when stuckAt is not set — no placeholder.
  const stuck = verdict.stuckAt?.replace(/\s+/g, ' ').trim() || undefined;
  const base = opts.zh ? `未完成：${reason}` : `Incomplete: ${reason}`;
  if (!stuck) return base;
  return opts.zh ? `${base}；卡在：${stuck}` : `${base}; stuck at: ${stuck}`;
}
