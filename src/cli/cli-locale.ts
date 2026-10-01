/** Resolve the CLI locale from environment variables. */
export function cliLocale(): string | undefined {
  return process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
}

/** True when locale prefers Chinese (zh / zh_CN / zh-Hans / …). */
export function isZhLocale(locale: string | undefined = cliLocale()): boolean {
  return /^zh/i.test(locale ?? '');
}

/**
 * Answer-language prompt layer. Chinese-locale users got English answers often
 * enough to be a recorded UX finding; the layer pins the default reply
 * language to the user's locale while leaving code, identifiers and command
 * output untouched. Empty for non-zh locales (the model default already
 * matches, and an unnecessary layer only burns tokens).
 */
export function buildAnswerLanguageLayer(locale: string | undefined = cliLocale()): string {
  if (!isZhLocale(locale)) return '';
  return [
    '[Answer language]',
    '默认用简体中文回答；仅当用户改用其他语言提问或明确要求时才切换。代码、标识符、命令与路径保持原样，不要翻译。',
  ].join('\n');
}
