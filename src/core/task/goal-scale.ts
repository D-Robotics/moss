/**
 * Small-goal vs full-goal scale for /goal.
 *
 * A small change should not spend a model turn per acceptance item. The
 * light path is a short plan plus one test/build run. A large goal (many
 * files, a device loop, or a plan longer than three steps) keeps the full
 * per-metric evidence path.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export type GoalScale = 'light' | 'full';

/** At or above this many files, an underspecified goal stays on the full path. */
export const LARGE_REPO_FILES = 200;

const FILE_CAP = 250;
const SMALL_GOAL_CHARS = 280;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.moss',
  'coverage',
  '.codegraph',
  'build',
  '__pycache__',
]);

const LARGE_TEXT =
  /\b(refactor|migrate|rewrite|redesign|architect\w*|unify|robot\w*|deploy\w*|camera|gpio|firmware|end[- ]to[- ]end)\b|\bfps\b|重构|迁移|架构|部署|相机|机器人|烧录/iu;

const SMALL_TEXT =
  /\b(\d{1,2}\s*-?\s*lines?|twenty[- ]lines?|typo|rename|one[- ]liner|small change|minimal change|single (?:file|function|helper))\b/iu;

const SOURCE_FILE = /\b[\w./-]+\.(?:js|mjs|cjs|ts|tsx|py|go|rs)\b/g;

export function sourceFileMentions(goal: string): number {
  return new Set(goal.match(SOURCE_FILE) ?? []).size;
}

export function isLargeGoalText(goal: string): boolean {
  if (LARGE_TEXT.test(goal)) return true;
  if (sourceFileMentions(goal) >= 4) return true;
  return goal.length > 700;
}

export function isSmallGoalText(goal: string): boolean {
  if (isLargeGoalText(goal)) return false;
  if (SMALL_TEXT.test(goal)) return true;
  return goal.trim().length > 0 && goal.trim().length <= SMALL_GOAL_CHARS;
}

/**
 * Light when the plan is 1–3 steps, or the goal text is a small change in a
 * small repo. A long plan does not by itself force the full path: a small
 * goal stays light. A large goal with no short plan stays full.
 */
export function classifyGoalScale(input: {
  goal: string;
  repoFileCount: number;
  planSteps?: number;
}): GoalScale {
  if (input.planSteps !== undefined && input.planSteps > 0 && input.planSteps <= 3) {
    return 'light';
  }
  if (isLargeGoalText(input.goal)) return 'full';
  if (isSmallGoalText(input.goal)) return 'light';
  if (input.repoFileCount >= LARGE_REPO_FILES) return 'full';
  return 'light';
}

/** Bounded file count. Stops at {@link FILE_CAP} so a huge tree stays cheap. */
export async function countRepoFiles(root: string): Promise<number> {
  let count = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (count >= FILE_CAP || depth > 6) return;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (count >= FILE_CAP) return;
      if (SKIP_DIRS.has(name)) continue;
      const abs = path.join(dir, name);
      let stat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        stat = await fs.lstat(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await walk(abs, depth + 1);
      else count += 1;
    }
  }
  await walk(root, 0);
  return count;
}
