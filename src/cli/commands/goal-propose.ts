/**
 * Acceptance-command proposals for `/goal <condition>` when the user did not
 * pass `--accept`. Candidates come only from files that are actually in the
 * workspace. An empty list is reported honestly — moss does not invent a command.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parseGoalCommandLine } from '../../core/loop/goal-loop.js';
import { appendTaskEvent, findLatestLiveTaskSnapshot } from '../../core/task/task-store.js';
import { isZhLocale } from '../cli-locale.js';
import { quoteCommandArg } from '../task-run.js';

const CLEAR_WORDS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);

const EMPTY_NOTICE_EN =
  'No acceptance command found in this workspace (no package.json test script, Makefile test target, pytest project, or go.mod). Only the contract verdict will apply — moss will not invent a command.';

const EMPTY_NOTICE_ZH =
  '这个工作区里没有找到验收命令（没有 package.json 的 test 脚本、Makefile 的 test 目标、pytest 工程或 go.mod）。只会使用契约裁决 — moss 不会编造命令。';

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
  if (
    fs.existsSync(path.join(workspace, 'pyproject.toml')) ||
    fs.existsSync(path.join(workspace, 'pytest.ini')) ||
    fs.existsSync(path.join(workspace, 'setup.cfg'))
  ) {
    pushCandidate(candidates, 'pytest');
  }
  if (fs.existsSync(path.join(workspace, 'go.mod'))) pushCandidate(candidates, 'go test ./...');
  return { candidates, emptyNotice: emptyAcceptanceNotice() };
}

export type GoalInvocation =
  | { kind: 'usage' }
  | { kind: 'clear' }
  | { kind: 'resume' }
  | { kind: 'run'; goal: string; acceptance?: string; notice?: string }
  | { kind: 'propose'; goal: string; candidates: string[] };

/** How `/goal` (and a rewritten `/loop`) should behave for this argument line. */
export function planGoalInvocation(rest: string, workspace: string): GoalInvocation {
  const token = rest.trim();
  if (!token) return { kind: 'usage' };
  const first = token.split(/\s+/, 1)[0] ?? token;
  if (CLEAR_WORDS.has(first) && token === first) return { kind: 'clear' };
  if (first === 'resume' && token === 'resume') return { kind: 'resume' };
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
  'Usage: /goal <condition> [--accept "<verification command>"] | /goal clear';

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
