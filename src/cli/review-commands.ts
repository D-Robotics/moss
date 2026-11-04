/**
 * `moss review` — the read/verify side of the independent review pipeline.
 *
 * The review tool records structured results in `.moss/review.jsonl`; CI and a
 * repair loop need a machine-readable status rather than prose. `list` shows
 * recent reviews, `check` maps the latest review to exit codes so a pipeline
 * can gate on it (Bugbot's success/neutral/failure semantics, locally):
 *   0 = latest review passed, 1 = unresolved findings, 2 = nothing reviewed or
 *   the reviewer produced no parseable verdict (unknown is never a pass).
 */
import { isZhLocale } from './cli-locale.js';
import {
  buildReviewState,
  listReviewRecords,
  readReviewState,
  type ReviewRecord,
} from '../tools/review-tools.js';
import type { ReviewFinding } from '../tools/review-tools.js';

export interface ReviewCommandContext {
  workspaceDir: string;
}

export function renderReviewUsage(zh: boolean = isZhLocale()): string {
  if (zh) {
    return [
      '用法：',
      '  moss review list [--limit N] [--json]   最近的独立评审记录',
      '  moss review check                        最新评审作为门禁：0 通过 / 1 有未解决问题 / 2 无评审或 verdict 未知',
      '',
      '评审记录来自 .moss/review.jsonl（由 review_changes 工具或 /review 写入）。',
      '`check` 不启动模型，只读取最后一条记录，适合放进 CI 或循环脚本。',
      '',
      '示例：',
      '  moss review check && echo reviewed-and-clean',
      '  moss review list --limit 3 --json',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss review list [--limit N] [--json]   recent independent review records',
    '  moss review check                       latest review as a gate: 0 pass / 1 unresolved findings / 2 none or unknown verdict',
    '',
    'Records live in .moss/review.jsonl (written by the review_changes tool or /review).',
    '`check` starts no model: it reads the last record, so it is safe in CI or a loop script.',
    '',
    'Examples:',
    '  moss review check && echo reviewed-and-clean',
    '  moss review list --limit 3 --json',
  ].join('\n');
}

function severityCounts(findings: readonly ReviewFinding[]): string {
  const count = (severity: ReviewFinding['severity']): number =>
    findings.filter((finding) => finding.severity === severity).length;
  return `critical ${count('critical')}, important ${count('important')}, suggestion ${count('suggestion')}`;
}

function printFindings(record: ReviewRecord, out: (line: string) => void): void {
  for (const finding of record.findings) {
    const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
    out(`  [${finding.severity}] ${location} — ${finding.summary}`);
    if (finding.fixHint) out(`      fix: ${finding.fixHint}`);
  }
}

/**
 * `ReviewState.nextAction` is the model-facing English sentence; the CLI prints a
 * localized rendering of the same three states instead of mixing locales.
 */
function nextActionText(
  state: { nextAction: string; attemptsExhausted: boolean },
  zh: boolean
): string {
  if (!zh) return state.nextAction;
  if (state.attemptsExhausted) {
    return '停止重试：连续的若干个不同 diff 都未通过评审；报告阻塞项并询问用户下一步';
  }
  if (state.nextAction.startsWith('proceed')) return '可以继续：改动已通过独立评审';
  return '按 findings 修复后，对新的 diff 重新运行 review_changes';
}

function verdictLine(record: ReviewRecord, zh: boolean): string {
  const label = zh ? '结论' : 'verdict';
  return `${label}: ${record.verdict.toUpperCase()} (${record.scope}, ${record.depth}, ${severityCounts(
    record.findings
  )})`;
}

export async function runReviewCommand(
  argv: readonly string[],
  ctx: ReviewCommandContext
): Promise<number> {
  const zh = isZhLocale();
  const out = (line: string): void => console.log(line);
  const sub = argv[0] ?? 'list';

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    out(renderReviewUsage(zh));
    return 0;
  }

  if (sub === 'list') {
    const json = argv.includes('--json');
    const limitIndex = argv.indexOf('--limit');
    let limit = 5;
    if (limitIndex >= 0) {
      const parsed = Number(argv[limitIndex + 1]);
      if (Number.isInteger(parsed) && parsed > 0) limit = parsed;
    }
    const records = await listReviewRecords(ctx.workspaceDir, limit);
    if (json) {
      out(JSON.stringify(records, null, 2));
      return 0;
    }
    if (records.length === 0) {
      out(
        zh
          ? '还没有评审记录——运行 /review 或让模型调用 review_changes。'
          : 'No reviews recorded yet — run /review or let the model call review_changes.'
      );
      return 2;
    }
    for (const record of records) {
      out(`${record.createdAt}  ${verdictLine(record, zh)}`);
      printFindings(record, out);
    }
    // The list is history; one line states where the fix loop stands now.
    const [latest] = records.slice(-1);
    if (latest) {
      const state = buildReviewState(latest);
      out(
        zh
          ? `当前修复尝试：第 ${state.attempt} / ${state.maxAttempts} 次${state.attemptsExhausted ? '（已用尽）' : ''} — ${nextActionText(state, zh)}`
          : `repair attempt: ${state.attempt} of ${state.maxAttempts}${state.attemptsExhausted ? ' (exhausted)' : ''} — ${state.nextAction}`
      );
    }
    return 0;
  }

  if (sub === 'check') {
    const [latest] = await listReviewRecords(ctx.workspaceDir, 1);
    if (!latest) {
      out(
        zh
          ? '没有评审记录：未评审不等于通过（exit 2）。先跑 /review 或 review_changes。'
          : 'No review recorded: unreviewed is not a pass (exit 2). Run /review or review_changes first.'
      );
      return 2;
    }
    if (latest.verdict === 'pass') {
      out(`${zh ? '通过' : 'PASS'} — ${verdictLine(latest, zh)}`);
      return 0;
    }
    if (latest.verdict === 'unknown') {
      out(
        zh
          ? `verdict 未知（评审没有给出可解析结论）— 不能当作通过。${verdictLine(latest, zh)}`
          : `Unknown verdict (the reviewer gave no parseable conclusion) — not a pass. ${verdictLine(
              latest,
              zh
            )}`
      );
      printFindings(latest, out);
      return 2;
    }
    out(`${zh ? '失败' : 'FAIL'} — ${verdictLine(latest, zh)}`);
    printFindings(latest, out);
    // The loop state (attempt / budget / next action) comes from the projection,
    // falling back to deriving it so a log written before the projection existed
    // still answers "what now?".
    const state = (await readReviewState(ctx.workspaceDir)) ?? buildReviewState(latest);
    out(
      zh
        ? `修复尝试：第 ${state.attempt} / ${state.maxAttempts} 次${state.attemptsExhausted ? '（已用尽）' : ''}`
        : `repair attempt: ${state.attempt} of ${state.maxAttempts}${state.attemptsExhausted ? ' (exhausted)' : ''}`
    );
    out(`${zh ? '下一步' : 'next'}: ${nextActionText(state, zh)}`);
    return 1;
  }

  console.error(`moss review: unknown subcommand '${sub}'`);
  console.error(renderReviewUsage(zh));
  return 2;
}
