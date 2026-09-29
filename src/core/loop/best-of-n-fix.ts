/**
 * Best-of-n fix engine (v0.10 W2): verification-gated candidate retries.
 *
 * When the main loop has failed the SAME verification twice, further naive
 * retries in the contaminated parent context rarely help. This engine runs n
 * independent fixer sub-agents (fresh sessions, minimal context: the failing
 * command + its output + the instruction to fix and re-verify), checking the
 * recorded verification command after each candidate. The first candidate
 * whose verification passes wins and its summary is injected into the parent
 * conversation; a wrecked candidate just fails verification and the next one
 * starts from the wrecked-but-failing state (sequential on shared state —
 * candidates never run concurrently, so workspace files never race).
 *
 * Honest scope: the engine only fires when the loop has a RECORDED failing
 * verification command (a failed run_tests/verify-shaped exec). Without a
 * machine-checkable verification there is nothing to gate candidates on, and
 * the engine stays off.
 */

export interface BestOfNCandidate {
  index: number;
  pass: boolean;
  summary: string;
  verifyOutputTail: string;
}

export interface BestOfNFixParams {
  n: number;
  failingCommand: string;
  failingOutputTail: string;
  /** Spawn one fixer sub-agent (the host's spawnSubagent). */
  spawnCandidate: (task: string) => Promise<{ success: boolean; summary: string }>;
  /** Re-run the recorded verification; returns exit-ok + output tail. */
  runVerify: () => Promise<{ pass: boolean; outputTail: string }>;
  abortSignal?: AbortSignal;
  onCandidateStart?: (index: number) => void;
}

export interface BestOfNFixResult {
  attempted: number;
  fixed: boolean;
  candidates: BestOfNCandidate[];
  winningSummary?: string;
}

const MAX_FAILING_OUTPUT_CHARS = 1_500;

export function buildCandidateTask(params: {
  n: number;
  index: number;
  failingCommand: string;
  failingOutputTail: string;
}): string {
  const { failingCommand, failingOutputTail } = params;
  return [
    `A coding task is stuck: the verification command \`${failingCommand}\` fails. Fix it.`,
    '',
    'Failed verification output (tail):',
    '```',
    failingOutputTail.slice(-MAX_FAILING_OUTPUT_CHARS),
    '```',
    '',
    'Requirements:',
    '1. Reproduce first: run the verification command yourself and observe the failure.',
    '2. Find the root cause; make the MINIMAL change that fixes it (do not delete or weaken tests).',
    '3. Re-run the verification command; iterate until it passes.',
    '4. If you cannot fix it within your turn budget, leave the workspace runnable and summarize exactly what you tried and why it failed.',
    '',
    'This is fix attempt ' +
      `${params.index + 1} of ${params.n}` +
      ' — previous attempts (if any) did not pass; take a different angle rather than repeating them.',
  ].join('\n');
}

export async function runBestOfNFix(params: BestOfNFixParams): Promise<BestOfNFixResult> {
  const n = Math.max(1, Math.floor(params.n));
  const candidates: BestOfNCandidate[] = [];
  for (let index = 0; index < n; index++) {
    if (params.abortSignal?.aborted) break;
    params.onCandidateStart?.(index);
    const task = buildCandidateTask({
      n,
      index,
      failingCommand: params.failingCommand,
      failingOutputTail: params.failingOutputTail,
    });
    let summary = '';
    try {
      const spawned = await params.spawnCandidate(task);
      summary = spawned.summary ?? '';
    } catch (err) {
      summary = `candidate ${index + 1} crashed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const verify = await params.runVerify();
    candidates.push({
      index,
      pass: verify.pass,
      summary,
      verifyOutputTail: verify.outputTail,
    });
    if (verify.pass) {
      return { attempted: index + 1, fixed: true, candidates, winningSummary: summary };
    }
  }
  return { attempted: candidates.length, fixed: false, candidates };
}

export function describeBestOfNOutcome(result: BestOfNFixResult): string {
  if (result.fixed) {
    const winner = result.candidates[result.candidates.length - 1];
    return [
      `[System] best-of-n fix engine: verification now PASSES after ${result.attempted} candidate(s).`,
      `Winning candidate summary: ${winner?.summary?.slice(0, 800) ?? '(no summary)'}`,
      'Continue the task from this fixed state; do not undo the fix.',
    ].join('\n');
  }
  const tails = result.candidates
    .map((c) => `candidate ${c.index + 1}: ${c.verifyOutputTail.slice(-200)}`)
    .join('\n');
  return [
    `[System] best-of-n fix engine: ${result.attempted} candidate(s) all FAILED verification.`,
    'Verification tails:',
    tails,
    'The verification is still red. Report the failure honestly with what was tried; do not claim success.',
  ].join('\n');
}
