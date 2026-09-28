/**
 * GitToolsNudge — mid-run reminder when the user asked to commit/push/open a PR/
 * review/approve/tag/release/file an issue but no git/gh exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedGitCompletionGate.
 */

import { collectExecCommands } from '../nudge-helpers.js';
import { defineToolsNudge } from './template.js';

export const evaluateGitToolsNudge = defineToolsNudge({
  userRe:
    /(?:\bgit\s+commit\b|\bcommit (?:and )?push\b|\bpush (?:to )?(?:origin|remote)\b|\bopen (?:a )?PR\b|\bcreate (?:a )?pull request\b|\breview (?:the )?PR\b|\bapprove (?:the )?PR\b|\bgh\s+pr\b|\bgit\s+tag\b|\btag (?:a )?release\b|\bcreate (?:a )?release\b|\bgh\s+release\b|\bopen (?:a )?GitHub issue\b|\bfile (?:an? )?issue\b|\bgh\s+issue\b|提交代码|推送到|创建 PR|commit 一下|打 tag|发 release|创建 issue|审查 PR|批准 PR)/iu,
  sawEvidence: ({ messages, toolCallsByName }) => {
    if ((toolCallsByName.git_commit ?? 0) > 0 || (toolCallsByName.git_push ?? 0) > 0) return true;
    for (const cmd of collectExecCommands(messages)) {
      if (/\bgit\b|\bgh\s+(?:pr|release|issue)\b/i.test(cmd)) return true;
    }
    return false;
  },
  // User only asked status / history, not to perform VCS.
  extraUserExempt: (user) =>
    /(?:git status|git log|what(?:'s| is) (?:the )?status|有没有提交)/iu.test(user) &&
    !/(?:commit|push|PR|tag|release|issue|review|approve|提交代码|推送)/iu.test(user),
  correction:
    '[System] The user asked for a git/gh VCS action (commit/push/PR/review/approve/tag/release/issue), and tools have already run without a matching `git` / `gh pr|release|issue` command. ' +
    'If VCS action is required: run the real command via `exec` and report its output. ' +
    'If you are waiting for approval, say so — do not invent commits, reviews, tags, releases, or issues.',
});
