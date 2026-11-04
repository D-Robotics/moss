/**
 * Independent change review — the Cursor "Agent Review" / Claude Code review
 * sub-agent idea, as a tool the loop can call.
 *
 * The agent can review its own diff, but that review shares the context that
 * produced the bug: it already believes the change is right. This tool gives
 * the review a clean context by construction:
 *
 * 1. the diff is collected deterministically (git / gh), not from the model's
 *    memory of what it changed;
 * 2. the read-only `reviewer` expert runs as a sub-agent that cannot edit;
 * 3. the free-form review is parsed into structured findings and appended to
 *    `.moss/review.jsonl`, so later runs (repair loops, `/review` listings)
 *    read data instead of prose.
 *
 * The reviewer proposes fixes; applying them stays with the calling agent, so
 * review and repair never collapse into one self-approving step.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { ensureMossRuntimeGitignore } from '../utils/workspace-paths.js';
import { runProcess } from '../utils/run-process.js';
import { runGit } from '../utils/git-spawn.js';

export const REVIEW_TOOL_NAME = 'review_changes';

/** Cap the diff handed to the reviewer; a truncated review says so. */
const MAX_DIFF_CHARS = 400_000;
const MAX_FINDINGS = 50;
const MAX_CHECKS = 20;
const MAX_REVIEWER_SUMMARY_CHARS = 4_000;
const REVIEW_LOG_NAME = 'review.jsonl';

export type ReviewSeverity = 'critical' | 'important' | 'suggestion';
export type ReviewVerdict = 'pass' | 'fail' | 'unknown';
export type ReviewDepth = 'quick' | 'deep';

export interface ReviewFinding {
  severity: ReviewSeverity;
  /** Workspace-relative path as the reviewer reported it. */
  file: string;
  line?: number;
  summary: string;
  fixHint?: string;
}

export interface ReviewRecord {
  id: string;
  createdAt: string;
  /** What was reviewed: `working tree + staged changes` or `GitHub PR #12`. */
  scope: string;
  depth: ReviewDepth;
  /** Computed from the findings, not copied from the reviewer's claim alone. */
  verdict: ReviewVerdict;
  /** The reviewer's own verdict line, kept to expose inconsistency. */
  statedVerdict?: 'pass' | 'fail';
  findings: ReviewFinding[];
  checks: string[];
  diffLines: number;
  truncated: boolean;
  reviewerRunId?: string;
  reviewerTurns?: number;
  reviewerSuccess: boolean;
  /** First lines of the reviewer's own summary (when it did not follow the contract). */
  reviewerSummary?: string;
}

export interface ReviewDiff {
  diff: string;
  scopeLabel: string;
  totalLines: number;
  truncated: boolean;
}

const VERDICT_LINE_RE = /^\s*VERDICT\s*:\s*(PASS|FAIL)\s*\.?\s*$/i;
const FINDING_RE =
  /^\s*(?:[-*]\s+)?\[?\s*(critical|important|suggestion)\s*\]?\s*(?:[:\-–—]\s*)?(.+)$/i;
/** `path/to/file.ts:42 — …` (the first token that has a real line number). */
const LOCATION_WITH_LINE_RE = /^(\S+?):(\d+)(?:-\d+)?\s*(?:[—–]|--|-)?\s*(.*)$/;
/** Suggestion lines may omit the line number: `path/to/file.ts — …`. */
const LOCATION_NO_LINE_RE = /^(\S*\.[A-Za-z0-9]+)\s+(?:[—–]|--|-)\s*(.+)$/;
const DASH_SPLIT_RE = /\s+(?:—|–|--| - )\s+/;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Parse the reviewer's output contract:
 *
 * ```
 * VERDICT: PASS|FAIL
 * FINDINGS:
 * [Critical|Important|Suggestion] path/to/file:line — what breaks — fix: …
 * CHECKS: one line per inspected file or command
 * ```
 *
 * Lenient by design (models drift), but it never turns unparseable prose into
 * a PASS: without a verdict line the verdict is `unknown`.
 */
export function parseReviewerOutput(text: string): {
  statedVerdict?: 'pass' | 'fail';
  findings: ReviewFinding[];
  checks: string[];
  summary: string;
} {
  const lines = text.split('\n');
  let statedVerdict: 'pass' | 'fail' | undefined;
  const findings: ReviewFinding[] = [];
  const checks: string[] = [];
  let inChecks = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (/^\s*CHECKS\s*:\s*/i.test(line)) {
      inChecks = true;
      const rest = line.replace(/^\s*CHECKS\s*:\s*/i, '').trim();
      if (rest) checks.push(rest);
      continue;
    }
    if (/^\s*(?:#{1,6}\s*)?(?:VERDICT|FINDINGS)\b/i.test(line)) {
      inChecks = false;
      const verdict = line.match(VERDICT_LINE_RE);
      if (verdict) statedVerdict = verdict[1]!.toLowerCase() as 'pass' | 'fail';
      continue;
    }
    if (inChecks) {
      if (line.trim() === '') continue;
      // A finding after CHECKS still counts: drop out of the checks section.
      if (FINDING_RE.test(line) && LOCATION_WITH_LINE_RE.test(line.match(FINDING_RE)?.[2] ?? '')) {
        inChecks = false;
      } else {
        if (checks.length < MAX_CHECKS) checks.push(line.trim());
        continue;
      }
    }
    const finding = parseFindingLine(line);
    if (finding && findings.length < MAX_FINDINGS) findings.push(finding);
  }

  return {
    ...(statedVerdict ? { statedVerdict } : {}),
    findings,
    checks,
    summary: text.trim(),
  };
}

function parseFindingLine(line: string): ReviewFinding | undefined {
  if (line.trim() === '') return undefined;
  const match = line.match(FINDING_RE);
  if (!match) return undefined;
  const severity = match[1]!.toLowerCase() as ReviewSeverity;
  const rest = match[2]!.trim();
  // The prompt's own template line has no real location; skip it.
  let file = '';
  let lineNumber: number | undefined;
  let body = rest;
  const withLine = rest.match(LOCATION_WITH_LINE_RE);
  if (withLine) {
    file = withLine[1]!;
    lineNumber = Number(withLine[2]);
    body = withLine[3] ?? '';
  } else {
    const noLine = rest.match(LOCATION_NO_LINE_RE);
    if (!noLine) return undefined;
    file = noLine[1]!;
    body = noLine[2] ?? '';
  }
  const parts = body.split(DASH_SPLIT_RE).filter((part) => part.trim() !== '');
  const fixPart = parts.find((part) => /^fix\s*:/i.test(part.trim()));
  const summary = (
    fixPart && parts.length === 1 ? parts[0]! : (parts.find((part) => part !== fixPart) ?? body)
  ).trim();
  if (!file || !summary) return undefined;
  return {
    severity,
    file,
    ...(lineNumber !== undefined && Number.isFinite(lineNumber) ? { line: lineNumber } : {}),
    summary: clip(summary, 400),
    ...(fixPart ? { fixHint: clip(fixPart.replace(/^fix\s*:\s*/i, '').trim(), 400) } : {}),
  };
}

/** The reviewer verdict counts only when the findings do not contradict it. */
export function computeReviewVerdict(parsed: {
  statedVerdict?: 'pass' | 'fail';
  findings: readonly ReviewFinding[];
}): ReviewVerdict {
  const blocking = parsed.findings.some((finding) => finding.severity !== 'suggestion');
  if (blocking) return 'fail';
  if (parsed.statedVerdict === 'fail') return 'fail';
  if (parsed.statedVerdict === 'pass') return 'pass';
  return 'unknown';
}

export interface CollectDiffOptions {
  /** GitHub PR number; omitted means the local working tree + index. */
  prNumber?: string;
  /** Restrict the review to these paths. */
  paths?: readonly string[];
}

/**
 * A new file is invisible to `git diff HEAD` until it is staged, yet it is
 * often the entire change ("created notes.txt") — an untracked-only review used
 * to answer "nothing to review" and silently skip the work. Render untracked
 * text files as synthetic add-diffs so the reviewer sees them too.
 */
async function collectUntrackedDiff(
  workspaceDir: string,
  paths: readonly string[] | undefined,
  budget: number
): Promise<string> {
  let listed: { exitCode: number; stdout: string };
  try {
    listed = await runGit(['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: workspaceDir,
      timeout: 15_000,
    });
  } catch {
    return '';
  }
  if (listed.exitCode !== 0) return '';
  const files = listed.stdout.split('\0').filter((entry) => entry !== '');
  const wanted =
    paths && paths.length > 0 ? files.filter((f) => paths.some((p) => f.startsWith(p))) : files;
  const blocks: string[] = [];
  let used = 0;
  for (const file of wanted) {
    if (used >= budget) {
      blocks.push(`[untracked files omitted: review budget of ${budget} characters reached]`);
      break;
    }
    const absolute = path.join(workspaceDir, file);
    let content: Buffer;
    try {
      content = await fs.readFile(absolute);
    } catch {
      continue;
    }
    if (content.includes(0)) {
      blocks.push(`[untracked binary file: ${file} (not shown)]`);
      continue;
    }
    const text = content.toString('utf8');
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const body = lines.map((line) => `+${line}`).join('\n');
    const block = [
      `diff --git a/${file} b/${file}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${file}`,
      `@@ -0,0 +1,${lines.length} @@`,
      body,
    ].join('\n');
    if (used + block.length > budget) {
      blocks.push(`[untracked file ${file} omitted: review budget reached]`);
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  return blocks.join('\n');
}

export async function collectReviewDiff(
  workspaceDir: string,
  options: CollectDiffOptions = {}
): Promise<ReviewDiff> {
  let diff: string;
  let scopeLabel: string;
  if (options.prNumber) {
    const result = await runProcess('gh', {
      args: ['pr', 'diff', options.prNumber],
      cwd: workspaceDir,
      timeout: 30_000,
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `gh pr diff ${options.prNumber} failed: ${detail}. Authenticate with \`gh auth login\` and run inside the repository.`
      );
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `gh pr diff ${options.prNumber} failed (exit ${result.exitCode}): ${clip(
          result.stderr.trim(),
          300
        )}`
      );
    }
    diff = result.stdout;
    scopeLabel = `GitHub PR #${options.prNumber}`;
  } else {
    // A repository with no commit yet has no HEAD to diff against; fall back to
    // the worktree-vs-index diff so a first change is still reviewable.
    const headProbe = await runGit(['rev-parse', '--verify', 'HEAD'], {
      cwd: workspaceDir,
      timeout: 10_000,
    }).catch(() => undefined);
    const args =
      headProbe && headProbe.exitCode === 0
        ? ['--no-pager', 'diff', 'HEAD']
        : ['--no-pager', 'diff'];
    if (options.paths && options.paths.length > 0) args.push('--', ...options.paths);
    let result: { exitCode: number; stdout: string; stderr: string };
    try {
      result = await runGit(args, { cwd: workspaceDir, timeout: 30_000 });
    } catch (error: unknown) {
      // git exits 128/129 outside a repository and runProcess rejects there.
      const procError = error as { stderr?: string; message?: string };
      const stderr = procError.stderr ?? procError.message ?? String(error);
      if (/not a git repository/i.test(stderr)) {
        throw new Error(
          `Not a git repository: ${workspaceDir}. review_changes needs a git workspace; pass pr=<number> to review a GitHub PR instead.`
        );
      }
      throw new Error(`git diff HEAD failed: ${clip(stderr.trim(), 300)}`);
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      if (/not a git repository/i.test(stderr)) {
        throw new Error(
          `Not a git repository: ${workspaceDir}. review_changes needs a git workspace; pass pr=<number> to review a GitHub PR instead.`
        );
      }
      throw new Error(`git diff HEAD failed (exit ${result.exitCode}): ${clip(stderr, 300)}`);
    }
    diff = result.stdout;
    const untracked = await collectUntrackedDiff(workspaceDir, options.paths, MAX_DIFF_CHARS);
    scopeLabel = 'working tree + staged changes';
    if (untracked !== '') {
      diff = diff === '' ? untracked : `${diff}\n${untracked}`;
      scopeLabel = 'working tree + staged changes (including untracked files)';
    }
  }
  const totalLines = diff.split('\n').length;
  const truncated = diff.length > MAX_DIFF_CHARS;
  return {
    diff: truncated
      ? `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated: showing ${MAX_DIFF_CHARS} of ${diff.length} characters (${totalLines} lines). Narrow the review with paths=<...> or review a subset, then re-run.]`
      : diff,
    scopeLabel,
    totalLines,
    truncated,
  };
}

function buildReviewerTask(params: {
  diff: ReviewDiff;
  depth: ReviewDepth;
  criteria?: string;
}): string {
  const deep = params.depth === 'deep';
  const lines = [
    'Review the change below. The harness collected this diff from git; do not try to re-derive it',
    'from memory and do not edit any file.',
    '',
    `Scope: ${params.diff.scopeLabel}${params.diff.truncated ? ' (diff truncated — say so in CHECKS)' : ''}`,
    '',
    params.criteria
      ? `Acceptance criteria for this change:\n${params.criteria}\n`
      : 'No acceptance criteria were supplied; review against correctness, security, and the repository rules (AGENTS.md) when one ships with the workspace.',
    '',
    '--- BEGIN DIFF ---',
    params.diff.diff,
    '--- END DIFF ---',
    '',
    'Verify every claim by reading the files around the change — a diff alone hides the context that',
    'makes it wrong. Report high-signal findings only: correctness bugs, security holes, and',
    'simplification or type-design problems that are real. Skip style a linter would catch.',
    deep
      ? 'You may run read-only checks (tests, typecheck) when a claim can only be settled by executing. Never run anything that writes.'
      : 'Do not run commands that write; reading files is enough for this depth.',
    'Map every unmet acceptance criterion to a finding. If the change holds up, PASS with no findings.',
    '',
    'Return exactly this format and nothing else:',
    'VERDICT: PASS or FAIL',
    'FINDINGS:',
    '[Critical|Important|Suggestion] path/to/file:line — what breaks and why — fix: the smallest change',
    'CHECKS: one line per file or command you inspected',
  ];
  return lines.join('\n');
}

/** Append one review record; exported so the deterministic probe needs no model. */
export async function recordReview(workspaceDir: string, record: ReviewRecord): Promise<string> {
  const runtimeDir = path.join(workspaceDir, '.moss');
  await fs.mkdir(runtimeDir, { recursive: true });
  ensureMossRuntimeGitignore(workspaceDir);
  const file = path.join(runtimeDir, REVIEW_LOG_NAME);
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  return path.relative(workspaceDir, file) || REVIEW_LOG_NAME;
}

/** Read the review log (oldest first). Used by `/review` listings and repair loops. */
export async function listReviewRecords(workspaceDir: string, limit = 20): Promise<ReviewRecord[]> {
  const file = path.join(workspaceDir, '.moss', REVIEW_LOG_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: ReviewRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line) as ReviewRecord);
    } catch {
      // A torn trailing line must not hide earlier reviews.
    }
  }
  return limit > 0 ? records.slice(-limit) : records;
}

function findingLine(finding: ReviewFinding): string {
  const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  return `  [${finding.severity}] ${location} — ${finding.summary}${
    finding.fixHint ? `\n      fix: ${finding.fixHint}` : ''
  }`;
}

function formatReviewResult(record: ReviewRecord, logPath: string): string {
  const counts = { critical: 0, important: 0, suggestion: 0 };
  for (const finding of record.findings) counts[finding.severity] += 1;
  const header =
    `Independent review (${record.scope}, ${record.depth}) — verdict: ${record.verdict.toUpperCase()}` +
    `\n${record.findings.length} finding(s): ${counts.critical} critical, ${counts.important} important, ${counts.suggestion} suggestion`;
  const findingLines = record.findings.map(findingLine);
  const checkLines = record.checks.length
    ? ['', 'CHECKS:', ...record.checks.map((check) => `  - ${check}`)]
    : [];
  const tail =
    record.verdict === 'fail'
      ? 'The reviewer is read-only. Fix the blocking findings, then call review_changes again to confirm.'
      : record.verdict === 'pass'
        ? 'The reviewer is read-only and found nothing blocking. Do not claim a fix you did not verify.'
        : 'The reviewer output had no parseable VERDICT line, so this change is NOT reviewed. Re-run with a narrower scope.';
  return [header, ...findingLines, ...checkLines, '', `Review log: ${logPath}`, tail].join('\n');
}

export interface ReviewChangesInput {
  pr?: number;
  depth?: ReviewDepth;
  paths?: string[];
  criteria?: string;
}

export const reviewChangesTool: Tool<ReviewChangesInput> = {
  name: REVIEW_TOOL_NAME,
  description: [
    'Run an independent review of the current change (working-tree diff, or a GitHub PR) with a clean-context read-only reviewer sub-agent, and return structured findings (severity, file:line, fix) saved to .moss/review.jsonl.',
    'Use it after implementing non-trivial changes, before claiming a large change is done, or when the user asks for a review (the /review command runs this same pipeline).',
    'The reviewer cannot edit: apply the fixes yourself, then re-run review_changes to confirm.',
    'At most once per change; a clean tree reports "nothing to review" without spending a sub-agent.',
  ].join(' '),
  metadata: {
    leanDescription:
      'Clean-context read-only review of the current change (working-tree diff or GitHub PR): structured findings saved to .moss/review.jsonl. Use after non-trivial changes or when asked (same pipeline as /review). The reviewer cannot edit — apply fixes yourself and re-run. At most once per change; a clean tree reports nothing to review.',
    sideEffectClass: 'subagent',
    planMode: 'allow',
    requiresApproval: false,
    retainResult: true,
    maxResultTokens: 3_000,
    truncationHint:
      'Findings are capped; read `.moss/review.jsonl` for the full record, or re-review narrowed paths.',
  },
  inputSchema: {
    type: 'object',
    properties: {
      pr: {
        type: 'number',
        description:
          'Review a GitHub pull request by number (uses `gh pr diff`). Omit to review local changes.',
      },
      depth: {
        type: 'string',
        enum: ['quick', 'deep'],
        description:
          'quick (default) reviews the diff by reading the files around it; deep may also run read-only checks (tests, typecheck) to settle a claim.',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict a local review to these workspace-relative paths (optional).',
      },
      criteria: {
        type: 'string',
        description:
          'Acceptance criteria the change must meet (for example from task_define); each unmet criterion must become a finding.',
      },
    },
  },
  async execute(input: ReviewChangesInput, ctx: ToolContext) {
    if (!ctx.spawnSubagent) {
      ctx.markResultError?.();
      return 'Error: sub-agent spawning is not available in this context, so an independent review cannot run.';
    }
    if (
      ctx.maxSpawnDepth !== undefined &&
      ctx.currentSpawnDepth !== undefined &&
      ctx.currentSpawnDepth >= ctx.maxSpawnDepth
    ) {
      ctx.markResultError?.();
      return `Error: maximum spawn depth (${ctx.maxSpawnDepth}) reached; the reviewer cannot run here.`;
    }
    const depth: ReviewDepth = input.depth === 'deep' ? 'deep' : 'quick';
    const paths = input.paths?.filter((entry) => entry.trim() !== '');

    let collected: ReviewDiff;
    try {
      collected = await collectReviewDiff(ctx.workspaceDir, {
        ...(typeof input.pr === 'number' ? { prNumber: String(input.pr) } : {}),
        ...(paths && paths.length > 0 ? { paths } : {}),
      });
    } catch (error) {
      ctx.markResultError?.();
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!collected.diff.trim()) {
      return input.pr
        ? `Nothing to review: PR #${input.pr} has no changes.`
        : 'Nothing to review: the working tree and index are clean. Make the change first, then review.';
    }

    const expert = ctx.resolveSubagentExpert?.('reviewer');
    const reviewerTurns = depth === 'deep' ? 24 : (expert?.maxTurns ?? 12);
    const result = await ctx.spawnSubagent({
      task: buildReviewerTask({
        diff: collected,
        depth,
        ...(input.criteria?.trim() ? { criteria: input.criteria.trim() } : {}),
      }),
      scope: depth === 'deep' ? 'verify' : 'read-only',
      maxTurns: reviewerTurns,
      timeoutMs: depth === 'deep' ? 900_000 : 600_000,
      label: 'review',
      ...(expert?.instructions ? { expertPrompt: expert.instructions } : {}),
      ...(expert?.allowedTools ? { allowedTools: expert.allowedTools } : {}),
      ...(expert?.deniedTools?.length ? { deniedTools: expert.deniedTools } : {}),
      ...(expert?.model ? { model: expert.model } : {}),
      ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    });
    if (!result) {
      ctx.markResultError?.();
      return 'Error: sub-agent spawning is no longer available; no review ran.';
    }

    const parsed = parseReviewerOutput(result.summary ?? '');
    const verdict = computeReviewVerdict(parsed);
    const record: ReviewRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      scope: collected.scopeLabel,
      depth,
      verdict,
      ...(parsed.statedVerdict ? { statedVerdict: parsed.statedVerdict } : {}),
      findings: parsed.findings,
      checks: parsed.checks,
      diffLines: collected.totalLines,
      truncated: collected.truncated,
      reviewerSuccess: result.success,
      ...(result.runId ? { reviewerRunId: result.runId } : {}),
      ...(typeof result.turns === 'number' ? { reviewerTurns: result.turns } : {}),
      ...(parsed.summary
        ? { reviewerSummary: clip(parsed.summary, MAX_REVIEWER_SUMMARY_CHARS) }
        : {}),
    };
    let logPath = path.join('.moss', REVIEW_LOG_NAME);
    try {
      logPath = await recordReview(ctx.workspaceDir, record);
    } catch (error) {
      ctx.markResultError?.();
      return `Review ran but its record could not be written: ${
        error instanceof Error ? error.message : String(error)
      }\n\n${formatReviewResult(record, '(not written)')}`;
    }
    if (verdict === 'unknown' || !result.success) ctx.markResultError?.();
    return formatReviewResult(record, logPath);
  },
};
