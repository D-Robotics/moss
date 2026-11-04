/**
 * InstallToolsNudge — mid-run reminder when the user asked to install
 * dependencies but no package-manager install exec has run yet.
 *
 * Soft: max 1 fire. Pairs with evaluateInventedInstallCompletionGate.
 */

import { stripNegatedActionClauses } from '../../../utils/request-intent.js';
import { collectExecCommands } from '../nudge-helpers.js';
import type { NudgeRequest, NudgeResult } from '../nudge-helpers.js';
import { defineToolsNudge } from './template.js';

/** Remove complete unconditional denials only; unknown/conditional syntax stays conservative. */
function affirmativeInstallText(text: string): string {
  const command = '(?:npm\\s+install|pnpm\\s+i(?:nstall)?|yarn\\s+install|bun\\s+install)';
  const chineseAction = `(?:安装依赖|装依赖|(?:运行|执行)\\s*${command}|(?:运行|执行)(?:任何)?命令|联网|(?:访问|连接)(?:板卡|设备|外网)|(?:修改|创建|读写)(?:任何)?文件)`;
  const englishAction = `(?:install (?:the )?dependencies|install deps|(?:(?:run|execute)\\s+)?${command}|(?:run|execute)\\s+(?:any\\s+)?commands?|access\\s+(?:the\\s+)?device)`;
  const chineseNegation = '(?:(?:请|本轮|本次|也)\\s*)*(?:不要|禁止|请勿|不得|不)\\s*';
  const englishNegation = "(?:please\\s+)?(?:do not|don't|never)\\s+";
  // Lists may share one negation or repeat it before each action.
  const chineseDenial = new RegExp(
    `^${chineseNegation}${chineseAction}(?:\\s*(?:、|和|或)\\s*(?:${chineseNegation})?${chineseAction})*$`,
    'iu'
  );
  const englishDenial = new RegExp(
    `^${englishNegation}${englishAction}(?:(?:\\s*,\\s*(?:(?:or|and)\\s+)?|\\s+(?:or|and)\\s+)(?:${englishNegation})?${englishAction})*$`,
    'iu'
  );
  return text
    .split(/(?:[。！？!?；;\n]|\.(?=\s|$))+/u)
    .map((sentence) => {
      // Conditions, sequencing and repeated negation can carry affirmative intent.
      if (
        /除非|如果|只有|否则|必要|但|不过|然而|然后|\b(?:unless|if|except|but|then)\b/iu.test(
          sentence
        ) ||
        /\b(?:do\s+not|don't|never)\s+(?:not|never|do\s+not|don't)\b/iu.test(sentence)
      )
        return sentence;
      if (englishDenial.test(sentence.trim())) return '';
      return sentence
        .split(/[，,]/u)
        .map((clause) =>
          chineseDenial.test(clause.trim()) || englishDenial.test(clause.trim())
            ? ''
            : stripNegatedActionClauses(clause)
        )
        .join(' ');
    })
    .join(' ');
}

const evaluateInstallRequest = defineToolsNudge({
  userRe:
    /(?:\bnpm\s+install\b|\bpnpm\s+i(?:nstall)?\b|\byarn\s+install\b|\bbun\s+install\b|install (?:the )?dependencies|install deps|装依赖|安装依赖)/iu,
  sawEvidence: ({ messages }) => {
    for (const cmd of collectExecCommands(messages)) {
      if (
        /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add)\b/i.test(cmd) ||
        /\bpip(?:3)?\s+install\b/i.test(cmd)
      ) {
        return true;
      }
    }
    return false;
  },
  correction:
    '[System] The user asked to install dependencies, and tools have already run without an install command ' +
    '(`npm`/`pnpm`/`yarn`/`bun` install/ci/add, or `pip install`). ' +
    'Run the real package-manager install via `exec` and report the output, or clearly say install was skipped. ' +
    'Do not invent install success.',
});

export function evaluateInstallToolsNudge(request: NudgeRequest): NudgeResult {
  return evaluateInstallRequest({
    ...request,
    userText: affirmativeInstallText(request.userText || ''),
  });
}
