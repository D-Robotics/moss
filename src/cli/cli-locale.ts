/** Resolve the CLI locale from environment variables. */
export function cliLocale(): string | undefined {
  return process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
}

/** True when locale prefers Chinese (zh / zh_CN / zh-Hans / …). */
export function isZhLocale(locale: string | undefined = cliLocale()): boolean {
  return /^zh/i.test(locale ?? '');
}

/**
 * Fallback named by the language policy when the latest user message has no
 * language of its own. Chinese locales pin that fallback to Simplified Chinese.
 * Empty for every other locale: the policy already matches the user's language,
 * and an extra English layer only burns tokens.
 */
export function buildAnswerLanguageLayer(locale: string | undefined = cliLocale()): string {
  if (!isZhLocale(locale)) return '';
  return [
    '[Answer language]',
    '如果最新的用户消息没有明确的语言信号（只有代码、路径、URL、数字、命令或符号），用简体中文回答。',
    '代码、标识符、命令与路径保持原样，不要翻译。',
  ].join('\n');
}

/** Startup line for the resolved interaction mode. */
export function formatInteractionModeNotice(mode: string, locale?: string): string {
  const zh = isZhLocale(locale);
  const labels: Record<string, string> = zh
    ? {
        plan: 'plan（只读演练）',
        acceptEdits: 'accept-edits（自动接受编辑）',
        manual: 'manual（逐项确认）',
        full: 'full（默认 — 用 /permissions 添加拒绝规则）',
      }
    : {
        plan: 'plan (dry-run)',
        acceptEdits: 'accept-edits',
        manual: 'manual',
        full: 'full (v0.26 default — add deny rules with /permissions)',
      };
  const label = labels[mode] ?? mode;
  return zh ? `[moss] 交互模式：${label}` : `[moss] Interaction mode: ${label}`;
}

/** One-shot notice when full mode has no deny rules. */
export function formatFullModeNotice(locale?: string): string {
  return isZhLocale(locale)
    ? '[moss] 默认 full 模式没有拒绝规则；用 /permissions 添加（例如 deny read_file(./.env)）以继续拦截敏感工具。此提示只显示一次。'
    : '[moss] Default full mode has no deny rules; add them with /permissions ' +
        '(e.g. deny read_file(./.env)) to keep sensitive tools gated. This notice shows once.';
}
