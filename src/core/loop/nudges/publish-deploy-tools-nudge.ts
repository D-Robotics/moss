/**
 * PublishDeployToolsNudge — mid-run reminder when the user asked to publish
 * a package or deploy to production, but no matching publish/deploy exec ran.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedPublishDeployCompletionGate.
 */

import { collectExecCommands } from '../nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge, TOOLS_NUDGE_MAX_ATTEMPTS } from './template.js';

export const PUBLISH_DEPLOY_TOOLS_NUDGE_MAX_ATTEMPTS = TOOLS_NUDGE_MAX_ATTEMPTS;

export type PublishDeployToolsNudgeRequest = NudgeRequest;
export type PublishDeployToolsNudgeResult = NudgeResult;

export const evaluatePublishDeployToolsNudge = defineToolsNudge({
  userRe:
    /(?:\bnpm publish\b|\bpublish (?:the )?(?:package|release)\b|\bdeploy (?:to )?(?:prod|production|staging)\b|\bship (?:to )?(?:prod|production)\b|发布到 npm|发布包|部署到|上线)/iu,
  sawEvidence: ({ messages }) => {
    for (const cmd of collectExecCommands(messages)) {
      if (
        /\b(?:npm|pnpm|yarn|bun)\s+publish\b/i.test(cmd) ||
        /\bcargo\s+publish\b/i.test(cmd) ||
        /\btwine\s+upload\b/i.test(cmd) ||
        /\b(?:kubectl|helm)\s+(?:apply|upgrade|install|rollout)\b/i.test(cmd) ||
        /\b(?:vercel|netlify|flyctl|gcloud|aws|terraform|pulumi)\b/i.test(cmd) ||
        /\b(?:deploy|gh\s+workflow\s+run)\b/i.test(cmd)
      ) {
        return true;
      }
    }
    return false;
  },
  // Conceptual "how do I publish?" without asking to do it now.
  extraUserExempt: (user) =>
    /(?:how (?:do|to)|what is|文档|原理|介绍)/iu.test(user) &&
    !/(?:please|now|go ahead|现在|请|帮我)/iu.test(user),
  correction:
    '[System] The user asked to publish a package or deploy, and tools have already run without a matching ' +
    'publish/deploy command (`npm publish`, `cargo publish`, `kubectl apply`, `vercel`, etc.). ' +
    'Run the real command via `exec` and report its output, or clearly wait for approval / say it was not published. ' +
    'Do not invent release or deployment outcomes.',
});
