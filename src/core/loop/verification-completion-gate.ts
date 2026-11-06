/**
 * Cursor-style "check your own work" completion gate, generalized beyond task
 * contracts: when a run changed files but never inspected or verified the
 * result afterwards, the final answer is held once and the model must either
 * run a real check or state plainly that the change is unverified.
 *
 * Why this exists: the task acceptance gate only covers runs that defined a
 * `task_define` contract. Ordinary "implement X" runs could end with an edit
 * and a success story and nothing else. Cursor's acceptance loop is not a
 * separate mode — the agent runs tests and re-reads its output as part of its
 * normal loop, and the user is told what was and was not verified.
 *
 * Design constraints (same as the acceptance gate):
 * - fires at most once per run (bounded correction, never an infinite loop);
 * - an honest "this is unverified and here is why" answer is allowed through;
 * - a read-only probe after the last edit counts as a check, because a wrong
 *   path or a typo is exactly what reading it back catches;
 * - no task contract is required; plain chat runs are unaffected because they
 *   mutate nothing.
 */
import type { Message } from '../session/session-jsonl.js';
import type { AgentLoopExtensions } from './agent-loop-types.js';
import { readLatestReviewSummary, type ReviewLedgerSummary } from './review-ledger.js';

/** Tools that change files: a run that called any of these must verify. */
const MUTATION_TOOLS = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'device_file_write',
]);

/** Read-only checks that count as inspecting the change. */
const CHECK_TOOLS = new Set([
  'read_file',
  'list_directory',
  'grep',
  'glob',
  'task_acceptance',
  // An independent review reads the changed code; a recorded review is
  // evidence that the change was examined, so it satisfies the check rule too.
  'review_changes',
  'record_evidence',
  'device_probe',
  'device_file_read',
  'device_file_list',
]);

/** Commands that inspect or verify, not just do more work. */
const CHECK_COMMAND_RE =
  /(^|[\s;&|])(cat|head|tail|less|ls|stat|diff|git\s+(diff|status|show))\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|check|verify|build)\w*|\b(npx\s+)?(vitest|jest|tsc|eslint|prettier)\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b|\bnode\s+--test\b|\bpython3?\s+-m\s+(pytest|unittest)\b|\bmoss\s+(verify|check|bench)\b/;

/** The model admits it did not verify: allowed through (honesty over theatre). */
const UNVERIFIED_DISCLOSURE_RE =
  /(未验证|未运行验证|未做验证|没有验证|无法验证|未能验证|unverified|not\s+verified|did\s+not\s+verify|could\s+not\s+verify|cannot\s+verify)/i;

/**
 * L3 (bounded-repair input): an independent review that returned FAIL must not
 * be silently dropped. This is the Bugbot rule — unresolved findings are a
 * failure state, not a footnote — applied at the completion boundary.
 */
const REVIEW_TOOLS = new Set([
  'create_subagent',
  'fan_out',
  'subagent',
  'spawn_subagent',
  'review_changes',
]);

/** Machine-readable or structural review-fail markers (reviewer contract). */
const REVIEW_FAIL_RE =
  /VERDICT:\s*\*{0,2}\s*FAIL|"verdict"\s*:\s*"fail"|\bverdict\b:?\s*\*{0,2}\s*FAIL|\bCritical finding/i;

/** A later review that passed clears the earlier failure. */
const REVIEW_PASS_RE =
  /VERDICT:\s*\*{0,2}\s*PASS|"verdict"\s*:\s*"pass"|\bverdict\b:?\s*\*{0,2}\s*PASS/i;

/** The final answer must own the findings: fix, or list what remains open. */
const FINDINGS_ACK_RE =
  /(修复|已修|未解决|未修复|仍未|剩余|无法|blocked|unresolved|remaining|not\s+fixed|still\s+failing|FAIL|fail|fixed|addressed)/i;

interface RecordedCall {
  name: string;
  input: Record<string, unknown>;
  resultText: string;
  isError: boolean;
}

function toolResultText(block: { content?: unknown }): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''
      )
      .join('\n');
  }
  return '';
}

/** Chronological tool calls with their results (paired by tool_use_id). */
function collectCalls(messages: readonly Message[]): RecordedCall[] {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const typed = block as { type?: string; tool_use_id?: string; is_error?: boolean };
      if (typed.type !== 'tool_result' || typeof typed.tool_use_id !== 'string') continue;
      results.set(typed.tool_use_id, {
        text: toolResultText(block as { content?: unknown }),
        isError: typed.is_error === true,
      });
    }
  }
  const calls: RecordedCall[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue;
      const typed = block as {
        type?: string;
        id?: string;
        name?: string;
        input?: unknown;
      };
      if (typed.type !== 'tool_use' || typeof typed.name !== 'string') continue;
      const result = typeof typed.id === 'string' ? results.get(typed.id) : undefined;
      calls.push({
        name: typed.name,
        input:
          typed.input && typeof typed.input === 'object'
            ? (typed.input as Record<string, unknown>)
            : {},
        resultText: result?.text ?? '',
        isError: result?.isError ?? false,
      });
    }
  }
  return calls;
}

function isCheckCall(call: RecordedCall): boolean {
  if (call.isError) return false;
  if (CHECK_TOOLS.has(call.name)) return true;
  if (call.name === 'exec' || call.name === 'shell' || call.name === 'device_exec') {
    const command = call.input.command;
    return typeof command === 'string' && CHECK_COMMAND_RE.test(command);
  }
  return false;
}

export interface VerificationGateDecision {
  ok: boolean;
  reason: string;
  correction?: string;
  /** Which gate held the answer (ledger `gates[]`, B155). */
  gate?: 'verification' | 'review';
  /** Which rule fired; the wrapper bounds the two rules differently. */
  kind?: 'unverified-change' | 'review-fail' | 'missing-review';
}

function findUnresolvedReviewFailure(calls: readonly RecordedCall[]): RecordedCall | undefined {
  let failure: RecordedCall | undefined;
  for (const call of calls) {
    if (!REVIEW_TOOLS.has(call.name)) continue;
    if (REVIEW_FAIL_RE.test(call.resultText)) failure = call;
    else if (REVIEW_PASS_RE.test(call.resultText)) failure = undefined;
  }
  return failure;
}

/**
 * `review.mode: auto` — after a run that changed files, the loop requires one
 * review_changes call before the final answer. Kept separate from the evidence
 * rule: no review call means no review happened, which is the whole point.
 */
export function evaluateAutoReviewRequirement(
  request: { messages: readonly Message[] },
  mode: 'off' | 'manual' | 'auto' | undefined
): VerificationGateDecision {
  if (mode !== 'auto') return { ok: true, reason: 'auto review is not enabled' };
  const calls = collectCalls(request.messages);
  if (!calls.some((call) => MUTATION_TOOLS.has(call.name))) {
    return { ok: true, reason: 'no file mutations in this run' };
  }
  if (calls.some((call) => call.name === 'review_changes')) {
    return { ok: true, reason: 'the change was reviewed' };
  }
  return {
    ok: false,
    gate: 'verification',
    kind: 'missing-review',
    reason: 'files were changed but the change was never reviewed',
    correction:
      'This session has review.mode=auto: before finishing, call review_changes on the working-tree diff ' +
      '(pass the acceptance criteria when you have them) and address a failing verdict. If a review really ' +
      'cannot run here, say so explicitly in the final answer.',
  };
}

/**
 * The review record that belongs to this run. A record from an earlier session
 * in the same workspace must not hold this answer; a half-written line is
 * already skipped by the reader. Only when the run itself reviewed something
 * (tool call present) do we trust the ledger over the prose.
 */
function reviewInThisRun(
  calls: readonly RecordedCall[],
  latestReview: ReviewLedgerSummary | undefined,
  messages: readonly Message[]
): ReviewLedgerSummary | undefined {
  if (!latestReview) return undefined;
  if (!calls.some((call) => REVIEW_TOOLS.has(call.name))) return undefined;
  const runStart = messages.find((message) => typeof message.timestamp === 'number')?.timestamp;
  if (typeof runStart !== 'number') return latestReview;
  // The reviewer writes the record during the run; allow a little clock slack.
  return latestReview.createdAtMs >= runStart - 5_000 ? latestReview : undefined;
}

export function evaluateVerificationCompletionGate(request: {
  response: string;
  messages: readonly Message[];
  /** Latest `.moss/review.jsonl` record, when the host can provide it. */
  latestReview?: ReviewLedgerSummary;
}): VerificationGateDecision {
  const calls = collectCalls(request.messages);
  const structured = reviewInThisRun(calls, request.latestReview, request.messages);
  // Structured verdict wins when available: it is computed from the findings in
  // `review-tools.ts`, the same record `moss review check` exits on. The prose
  // scan stays for reviews that produced no ledger record (sub-agent reviews).
  const proseFailure = structured ? undefined : findUnresolvedReviewFailure(calls);
  const structuredFailure = structured?.verdict === 'fail' ? structured : undefined;
  if ((proseFailure || structuredFailure) && !FINDINGS_ACK_RE.test(request.response)) {
    if (structuredFailure) {
      const counts = structuredFailure.findings;
      return {
        ok: false,
        gate: 'verification',
        kind: 'review-fail',
        reason: `the latest review record is FAIL (${String(counts.critical)} critical, ${String(counts.important)} important) and the answer does not address it`,
        correction:
          `The independent reviewer returned FAIL: ${String(counts.critical)} critical, ` +
          `${String(counts.important)} important, ${String(counts.suggestion)} suggestion finding(s) ` +
          `(record ${structuredFailure.id}; \`moss review check\` exits 1 on it). Fix the blocking ` +
          'findings and call review_changes again so a new record passes, or report exactly which ' +
          'findings are still open and why — do not present the change as done while a critical ' +
          'finding is open.',
      };
    }
    return {
      ok: false,
      gate: 'verification',
      kind: 'review-fail',
      reason: 'an independent review returned FAIL and the answer does not address it',
      correction:
        'The independent reviewer returned FAIL. Fix the findings and re-review, or report the ' +
        'unresolved findings honestly (what is still broken and why) — do not present the change ' +
        'as done while a critical finding is open.',
    };
  }
  let lastMutation = -1;
  for (let index = 0; index < calls.length; index += 1) {
    if (MUTATION_TOOLS.has(calls[index]!.name)) lastMutation = index;
  }
  if (lastMutation < 0) return { ok: true, reason: 'no file mutations in this run' };
  const checkedAfter = calls.slice(lastMutation + 1).some(isCheckCall);
  if (checkedAfter) return { ok: true, reason: 'the change was inspected after the last edit' };
  if (UNVERIFIED_DISCLOSURE_RE.test(request.response)) {
    return { ok: true, reason: 'the answer states it is unverified' };
  }
  return {
    ok: false,
    gate: 'verification',
    kind: 'unverified-change',
    reason: 'files were changed but the result was never checked',
    correction:
      'You changed files but the last thing you did afterwards was answer your own claim. ' +
      'Before finishing, inspect the actual result: read the file back, or run the check that ' +
      'proves it (run_tests / a lint, build or verify command), and report what you observed. ' +
      'If verification is genuinely impossible here, say explicitly that the change is unverified ' +
      'and why — do not present an unchecked change as done.',
  };
}

/** Review-repair cycles allowed per run (Bugbot's autofix cap is 3). */
const REVIEW_REPAIR_LIMIT = 3;

/**
 * Per-run wrapper with two different bounds:
 * - an unverified change is asked for exactly once (after that, an honest or
 *   plainly non-compliant ending is allowed — never a nag);
 * - an unresolved review FAIL drives up to REVIEW_REPAIR_LIMIT repair cycles
 *   (fix + re-review); if the model still claims success after that, the loop's
 *   own retry ceiling turns it into a failed completion rather than a silent
 *   "done" over a critical finding.
 */
export function createVerificationCompletionGate(
  options: {
    reviewMode?: 'off' | 'manual' | 'auto';
    enabled?: boolean;
    /** Enables the structured `.moss/review.jsonl` verdict; absent = prose only. */
    workspaceDir?: string;
  } = {}
): NonNullable<AgentLoopExtensions['completionGate']> {
  if (options.enabled === false) {
    // P0-b escape valve: a host that turns the gate off gets a no-op, not a
    // silent partial gate (the review/auto rules ride on the same switch).
    return async () => ({ ok: true as const });
  }
  // The loop counts gate attempts across ALL rules; firing rule after rule with
  // retryLimit 1 would end the run after the first pair. Our internal counters
  // bound each rule (auto once, unverified once, review three times, then ok),
  // so one generous ceiling keeps the loop from throwing early.
  const GATE_RETRY_CEILING = 6;
  let verificationBlocked = false;
  let reviewBlocks = 0;
  let autoReviewBlocked = false;
  return async (request) => {
    const autoReview = evaluateAutoReviewRequirement(request, options.reviewMode);
    if (!autoReview.ok) {
      if (autoReviewBlocked) return { ok: true as const };
      autoReviewBlocked = true;
      return {
        ok: false as const,
        reason: autoReview.reason,
        ...(autoReview.correction ? { correction: autoReview.correction } : {}),
        retryLimit: GATE_RETRY_CEILING,
      };
    }
    const latestReview = options.workspaceDir
      ? readLatestReviewSummary(options.workspaceDir)
      : undefined;
    const decision = evaluateVerificationCompletionGate({
      response: request.response,
      messages: request.messages,
      ...(latestReview ? { latestReview } : {}),
    });
    if (decision.ok) return { ok: true as const };
    if (decision.kind === 'review-fail') {
      // Bounded: after the last repair cycle the run is allowed to end; the
      // honest path (acknowledging findings) passes on its own above.
      if (reviewBlocks >= REVIEW_REPAIR_LIMIT) return { ok: true as const };
      reviewBlocks += 1;
      return {
        ok: false as const,
        ...(decision.gate ? { gate: decision.gate } : {}),
        ...(decision.kind ? { kind: decision.kind } : {}),
        reason: decision.reason,
        ...(decision.correction ? { correction: decision.correction } : {}),
        retryLimit: GATE_RETRY_CEILING,
      };
    }
    if (verificationBlocked) return { ok: true as const };
    verificationBlocked = true;
    return {
      ok: false as const,
      ...(decision.gate ? { gate: decision.gate } : {}),
      ...(decision.kind ? { kind: decision.kind } : {}),
      reason: decision.reason,
      ...(decision.correction ? { correction: decision.correction } : {}),
      retryLimit: GATE_RETRY_CEILING,
    };
  };
}
