/**
 * Acceptance-command proposals for `/goal <condition>` when the user did not
 * pass `--accept`. Candidates come only from files that are actually in the
 * workspace. An empty list is reported honestly — moss does not invent a command.
 */
import fs from 'node:fs';
import path from 'node:path';

import { appendTaskEvent, findLatestLiveTaskSnapshot } from '../../core/task/task-store.js';
import {
  pythonBin,
  pythonTestLayout,
  pytestCommand,
  unittestDiscoverArgs,
} from '../../utils/python-test-layout.js';
import { isZhLocale } from '../cli-locale.js';
import { quoteCommandArg } from '../task-run.js';

const CLEAR_WORDS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);

const EMPTY_NOTICE_EN =
  'No acceptance command found in this workspace (no package.json test script, Makefile test target, pytest project, unittest modules, or go.mod). Only the contract verdict will apply — moss will not invent a command.';

const EMPTY_NOTICE_ZH =
  '这个工作区里没有找到验收命令（没有 package.json 的 test 脚本、Makefile 的 test 目标、pytest 工程、unittest 模块或 go.mod）。只会使用契约裁决 — moss 不会编造命令。';

export function emptyAcceptanceNotice(locale?: string): string {
  return isZhLocale(locale) ? EMPTY_NOTICE_ZH : EMPTY_NOTICE_EN;
}

export interface AcceptanceProposal {
  candidates: string[];
  emptyNotice: string;
}

function pushCandidate(candidates: string[], command: string): void {
  if (candidates.length >= 3) return;
  if (!candidates.includes(command)) candidates.push(command);
}

function packageTestScript(workspace: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(workspace, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: { test?: unknown } };
    const test = parsed.scripts?.test;
    if (typeof test !== 'string' || test.trim() === '') return false;
    if (/no test specified/i.test(test)) return false;
    return true;
  } catch {
    return false;
  }
}

function makefileHasTest(workspace: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(workspace, 'Makefile'), 'utf8');
    return /^test\s*:/m.test(raw);
  } catch {
    return false;
  }
}

export function proposeAcceptanceCommands(workspace: string): AcceptanceProposal {
  const candidates: string[] = [];
  if (packageTestScript(workspace)) pushCandidate(candidates, 'npm test');
  if (makefileHasTest(workspace)) pushCandidate(candidates, 'make test');
  const python = pythonTestLayout(workspace);
  const py = pythonBin();
  if (python === 'unittest') {
    pushCandidate(candidates, `${py} -m unittest discover ${unittestDiscoverArgs(workspace)}`);
  } else if (
    python === 'pytest' ||
    python === 'loose' ||
    fs.existsSync(path.join(workspace, 'pyproject.toml')) ||
    fs.existsSync(path.join(workspace, 'pytest.ini')) ||
    fs.existsSync(path.join(workspace, 'setup.cfg'))
  ) {
    pushCandidate(candidates, pytestCommand());
  }
  if (fs.existsSync(path.join(workspace, 'go.mod'))) pushCandidate(candidates, 'go test ./...');
  return { candidates, emptyNotice: emptyAcceptanceNotice() };
}

export interface ParsedGoalCommand {
  goal: string;
  acceptance?: { command: string };
}

/**
 * Parse a `/goal <goal text> [--accept "<verification command>"]` line.
 * Returns null for a malformed line (empty goal, or --accept without a
 * command).
 */
export function parseGoalCommandLine(line: string): ParsedGoalCommand | null {
  const raw = line.trim();
  if (!raw) return null;
  const idx = raw.search(/(^|\s)--accept(\s+|=|$)/);
  if (idx === -1) return { goal: raw };
  const goal = raw.slice(0, idx).trim();
  if (!goal) return null;
  let rest = raw
    .slice(idx)
    .replace(/^\s*--accept(\s+|=|$)/, '')
    .trim();
  if (!rest) return null;
  if (
    (rest.startsWith('"') && rest.endsWith('"')) ||
    (rest.startsWith("'") && rest.endsWith("'"))
  ) {
    rest = rest.slice(1, -1);
  }
  rest = rest.trim();
  if (!rest) return null;
  return { goal, acceptance: { command: rest } };
}

export type GoalInvocation =
  | { kind: 'usage' }
  | { kind: 'clear' }
  | {
      kind: 'resume';
      taskId?: string;
      acceptance?: string;
      maxRepairs?: number;
      maxTurns?: number;
    }
  | { kind: 'run'; goal: string; acceptance?: string; notice?: string }
  | { kind: 'propose'; goal: string; candidates: string[] };

/** The parsed `/goal resume` plan, before the task id is resolved. */
export type GoalResumeInvocation = Extract<GoalInvocation, { kind: 'resume' }>;

/** Flags `/goal resume` shares with `moss task resume` (B114 / B117 parity). */
const RESUME_FLAG_NAMES: readonly string[] = ['--accept', '--max-repairs', '--max-turns'];

function resumeFlagName(token: string): string {
  const eq = token.indexOf('=');
  return token.startsWith('--') && eq > 0 ? token.slice(0, eq) : token;
}

/**
 * Split a `/goal resume` tail into tokens, honoring both quote styles (a quoted
 * run is one token even when it contains spaces) and `--flag=<value>` tails
 * whose value may itself be quoted. Returns null for an unterminated quote or a
 * quote glued to a bare word — those are usage errors, not commands we should
 * silently re-interpret.
 */
function tokenizeResumeArgs(raw: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);
  while (i < raw.length) {
    if (isSpace(raw[i])) {
      i += 1;
      continue;
    }
    let value = '';
    while (!isSpace(raw[i])) {
      const ch = raw[i] ?? '';
      if (ch === '"' || ch === "'") {
        const close = raw.indexOf(ch, i + 1);
        if (close === -1) return null;
        value += raw.slice(i + 1, close);
        i = close + 1;
        // A quote must end the token; `"a"b` is ambiguous, so it is a usage error.
        if (!isSpace(raw[i])) return null;
        break;
      }
      value += ch;
      i += 1;
    }
    tokens.push(value);
  }
  return tokens;
}

/** Budget values are non-negative safe integers; `-1`, `1.5` and `abc` are usage errors. */
function parseResumeBudget(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * `/goal resume [<task_id>] [--accept "<cmd>"] [--max-repairs N] [--max-turns N]`
 * — the interactive twin of `moss task resume <id> …` (B98 for the oracle,
 * B117 for the retry budget). Flags may appear in any order. Without a task id
 * the newest resumable task is used, exactly as before.
 */
function parseResumeArgs(rest: string): {
  taskId?: string;
  acceptance?: string;
  maxRepairs?: number;
  maxTurns?: number;
} | null {
  const tokens = tokenizeResumeArgs(rest.trim());
  if (!tokens) return null;
  const out: { taskId?: string; acceptance?: string; maxRepairs?: number; maxTurns?: number } = {};
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    const eq = token.indexOf('=');
    const name = resumeFlagName(token);
    if (RESUME_FLAG_NAMES.includes(name)) {
      if (seen.has(name)) return null;
      seen.add(name);
      const inline = token.startsWith('--') && eq > 0 ? token.slice(eq + 1) : undefined;
      const value = inline ?? tokens[++i];
      if (name === '--accept') {
        let command = value;
        if (inline === undefined) {
          // Backward compatibility: `--accept npm test` (unquoted) consumes the
          // rest of the line up to the next known flag.
          if (command === undefined || RESUME_FLAG_NAMES.includes(resumeFlagName(command))) {
            return null;
          }
          const parts = [command];
          while (i + 1 < tokens.length) {
            const next = tokens[i + 1] ?? '';
            if (RESUME_FLAG_NAMES.includes(resumeFlagName(next))) break;
            i += 1;
            parts.push(next);
          }
          command = parts.join(' ');
        }
        if (!command) return null;
        out.acceptance = command;
        continue;
      }
      const budget = parseResumeBudget(value);
      if (budget === null) return null;
      if (name === '--max-repairs') out.maxRepairs = budget;
      else out.maxTurns = budget;
      continue;
    }
    // Unknown flags and stray negative numbers are usage errors, not task ids.
    if (token.startsWith('-')) return null;
    if (out.taskId !== undefined) return null;
    out.taskId = token;
  }
  return out;
}

/** How `/goal` should behave for this argument line. `/loop` does not call this. */
export function planGoalInvocation(rest: string, workspace: string): GoalInvocation {
  const token = rest.trim();
  if (!token) return { kind: 'usage' };
  const first = token.split(/\s+/, 1)[0] ?? token;
  if (CLEAR_WORDS.has(first) && token === first) return { kind: 'clear' };
  if (first === 'resume') {
    const resume = parseResumeArgs(token.slice('resume'.length));
    if (!resume) return { kind: 'usage' };
    return { kind: 'resume', ...resume };
  }
  const parsed = parseGoalCommandLine(token);
  if (!parsed) return { kind: 'usage' };
  if (parsed.acceptance)
    return { kind: 'run', goal: parsed.goal, acceptance: parsed.acceptance.command };
  const proposal = proposeAcceptanceCommands(workspace);
  if (proposal.candidates.length === 0) {
    return { kind: 'run', goal: parsed.goal, notice: proposal.emptyNotice };
  }
  return { kind: 'propose', goal: parsed.goal, candidates: proposal.candidates };
}

export const GOAL_USAGE =
  'Usage: /goal <condition> [--accept "<verification command>"] | /goal resume [task_id] [--accept "<verification command>"] [--max-repairs N] [--max-turns N] | /goal clear';

export function acceptanceProposalLines(
  goal: string,
  candidates: readonly string[],
  locale?: string
): string[] {
  const numbered = candidates.map((candidate, index) => `${index + 1}. ${candidate}`);
  if (isZhLocale(locale)) {
    return [
      `验收命令，对应目标：${goal}`,
      ...numbered,
      'Enter 接受第一条（想改就先编辑）。输入 n 则跳过，只走契约裁决。',
    ];
  }
  return [
    `Acceptance command for: ${goal}`,
    ...numbered,
    'Enter accepts the first (edit it first if you want). n skips — only the contract verdict will apply.',
  ];
}

export function skippedAcceptanceNotice(locale?: string): string {
  return isZhLocale(locale)
    ? '已跳过验收命令。只会使用契约裁决。'
    : 'Skipped the acceptance command. Only the contract verdict will apply.';
}

/** `/goal clear` (and the clear-words) abandons the latest live task, if any. */
export async function abandonLiveGoal(workspace: string, locale?: string): Promise<string> {
  const zh = isZhLocale(locale);
  const snapshot = await findLatestLiveTaskSnapshot(workspace);
  if (!snapshot) return zh ? '没有可清除的进行中目标。' : 'No live goal to clear.';
  await appendTaskEvent(workspace, snapshot.taskId, 'task_abandoned', { reason: '/goal clear' });
  return zh ? `已清除目标 ${snapshot.taskId}。` : `Cleared goal ${snapshot.taskId}.`;
}

/**
 * Turn cap for `/goal`. `MOSS_GOAL_AUTO_MAX_RUNS` wins for a goal run;
 * `MOSS_LOOP_MAX` is the fallback. Missing or invalid values mean no cap (0).
 */
export function resolveLoopMaxIterations(
  env: Record<string, string | undefined>,
  goal = false
): number {
  const value = goal ? (env.MOSS_GOAL_AUTO_MAX_RUNS ?? env.MOSS_LOOP_MAX) : env.MOSS_LOOP_MAX;
  if (value === undefined || value.trim() === '') return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Arguments for `/task resume` — optionally correcting the oracle (B98) and
 * narrowing that retry's budget (B117). Flag order is fixed so the hand-off
 * string is stable: taskId, --accept, --max-repairs, --max-turns.
 */
export function goalResumeArgs(
  options: {
    taskId?: string;
    acceptance?: string;
    maxRepairs?: number;
    maxTurns?: number;
  } = {}
): string {
  const parts = ['resume'];
  if (options.taskId) parts.push(options.taskId);
  if (options.acceptance) parts.push('--accept', quoteCommandArg(options.acceptance));
  for (const [flag, value] of [
    ['--max-repairs', options.maxRepairs],
    ['--max-turns', options.maxTurns],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) continue;
    parts.push(flag, String(value));
  }
  return parts.join(' ');
}

/**
 * One line before an interactive resume starts: which task the id-less form
 * resolved to, and the retry budget the user typed. Headless `task resume` prints
 * the same facts in its summary; the REPL/TUI run silently until the verdict, so
 * a long wrong-target resume would otherwise be invisible until it finished.
 */
export function resumeEchoLine(
  taskId: string,
  plan: { acceptance?: string; maxRepairs?: number; maxTurns?: number },
  zh: boolean
): string {
  const parts: string[] = [];
  if (plan.maxRepairs !== undefined)
    parts.push(zh ? `修复预算 ${plan.maxRepairs}` : `repair budget ${plan.maxRepairs}`);
  if (plan.maxTurns !== undefined)
    parts.push(zh ? `回合预算 ${plan.maxTurns}` : `turn budget ${plan.maxTurns}`);
  if (plan.acceptance) parts.push(zh ? '已改正验收命令' : 'corrected acceptance command');
  const head = zh ? `继续 ${taskId}` : `Resuming ${taskId}`;
  return parts.length > 0 ? `${head} — ${parts.join(zh ? '、' : ', ')}` : head;
}

/**
 * Translate a parsed `/goal resume` plan into the `/task resume ...` line that
 * the REPL and the full-screen TUI dispatch (B98 oracle + B117 budget). The
 * caller's resolved task id wins over the one the user typed: the REPL picks
 * the newest resumable task when the line has no id, and the flags must land on
 * that same task.
 */
export function goalResumeDispatchArgs(
  plan: GoalResumeInvocation,
  resolvedTaskId?: string
): string {
  const taskId = resolvedTaskId ?? plan.taskId;
  return goalResumeArgs({
    ...(taskId ? { taskId } : {}),
    ...(plan.acceptance ? { acceptance: plan.acceptance } : {}),
    ...(plan.maxRepairs !== undefined ? { maxRepairs: plan.maxRepairs } : {}),
    ...(plan.maxTurns !== undefined ? { maxTurns: plan.maxTurns } : {}),
  });
}

/** Arguments for `runTaskCommand` (`run <goal> [--accept "…"]`). */
export function goalRunArgs(
  goal: string,
  options: { acceptance?: string; maxTurns?: number } = {}
): string {
  const flags: string[] = [];
  if (options.acceptance) flags.push('--accept', quoteCommandArg(options.acceptance));
  if (options.maxTurns && options.maxTurns > 0) {
    flags.push('--max-turns', String(options.maxTurns));
  }
  const goalToken = quoteCommandArg(goal);
  // A goal whose text is itself a flag (`--accept`) must sit after `--`,
  // or the flag parser consumes it. Flags stay in front of that marker.
  if (goal.startsWith('-')) return ['run', ...flags, '--', goalToken].join(' ');
  return ['run', goalToken, ...flags].join(' ');
}
