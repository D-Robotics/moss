/**
 * Acceptance-command proposals for `/goal <condition>` when the user did not
 * pass `--accept`. Candidates come only from files that are actually in the
 * workspace. An empty list is reported honestly — moss does not invent a command.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parseGoalCommandLine } from '../../core/loop/goal-loop.js';
import { appendTaskEvent, findLatestLiveTaskSnapshot } from '../../core/task/task-store.js';

const CLEAR_WORDS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);

const EMPTY_NOTICE =
  'No acceptance command found in this workspace (no package.json test script, Makefile test target, pytest project, or go.mod). Only the contract verdict will apply — moss will not invent a command.';

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
  return { candidates, emptyNotice: EMPTY_NOTICE };
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
  if (parsed.acceptance) return { kind: 'run', goal: parsed.goal, acceptance: parsed.acceptance.command };
  const proposal = proposeAcceptanceCommands(workspace);
  if (proposal.candidates.length === 0) {
    return { kind: 'run', goal: parsed.goal, notice: proposal.emptyNotice };
  }
  return { kind: 'propose', goal: parsed.goal, candidates: proposal.candidates };
}

export const GOAL_USAGE =
  'Usage: /goal <condition> [--accept "<verification command>"] | /goal clear';

/** `/goal clear` (and the clear-words) abandons the latest live task, if any. */
export async function abandonLiveGoal(workspace: string): Promise<string> {
  const snapshot = await findLatestLiveTaskSnapshot(workspace);
  if (!snapshot) return 'No live goal to clear.';
  await appendTaskEvent(workspace, snapshot.taskId, 'task_abandoned', { reason: '/goal clear' });
  return `Cleared goal ${snapshot.taskId}.`;
}

/** Arguments for `runTaskCommand` (`run <goal> [--accept "…"]`). */
export function goalRunArgs(
  goal: string,
  options: { acceptance?: string; maxTurns?: number } = {}
): string {
  const parts = ['run', goal];
  if (options.acceptance) parts.push('--accept', JSON.stringify(options.acceptance));
  if (options.maxTurns && options.maxTurns > 0) {
    parts.push('--max-turns', String(options.maxTurns));
  }
  return parts.join(' ');
}
