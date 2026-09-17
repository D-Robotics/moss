/** Resolve the CLI locale from environment variables. */
export function cliLocale(): string | undefined {
  return process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
}

/** True when locale prefers Chinese (zh / zh_CN / zh-Hans / …). */
export function isZhLocale(locale: string | undefined = cliLocale()): boolean {
  return /^zh/i.test(locale ?? '');
}
