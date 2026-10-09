/**
 * Suggestion for a project `.gitignore`. Moss also writes `.moss/.gitignore`
 * for runtime artifacts only (sessions, tasks, logs); that file does not hide
 * shared config, skills, or agents. This suggestion is unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isZhLocale } from './cli-locale.js';

export const GITIGNORE_SUGGESTION = ['.moss/', '!.moss/skills/'].join('\n');

/** True when the ignore file already keeps `.moss/` out of git. */
export function gitignoreCoversMoss(text: string): boolean {
  return /(^|\n)\s*\.moss\/?\s*(\n|$)/.test(text) || text.includes('.moss/*');
}

/**
 * The notice to print when a git workspace does not ignore `.moss/`.
 * Undefined when there is nothing to suggest.
 */
export function gitignoreNoticeForWorkspace(
  workspace: string,
  locale?: string
): string | undefined {
  if (!fs.existsSync(path.join(workspace, '.git'))) return undefined;
  let text = '';
  try {
    text = fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8');
  } catch {
    text = '';
  }
  if (gitignoreCoversMoss(text)) return undefined;
  const lead = isZhLocale(locale)
    ? '[moss] 会话日志在 .moss/。建议写入 .gitignore，避免被提交：'
    : '[moss] Session logs live in .moss/. Add this to .gitignore so they are not committed:';
  return `${lead}\n${GITIGNORE_SUGGESTION}`;
}
