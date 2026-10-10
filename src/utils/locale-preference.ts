/**
 * Locale the user actually asked for.
 *
 * `LC_ALL=C` and `LC_ALL=C.UTF-8` (the usual Docker/CI setting) name a
 * character encoding, not a language. Those fall through to `LC_MESSAGES`
 * and then `LANG`. A real language in `LC_ALL`, such as `en_US.UTF-8`,
 * still wins.
 */
export function preferredLocale(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const value of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const text = value?.trim();
    if (!text || isNeutralLocale(text)) continue;
    return text;
  }
  return undefined;
}

function isNeutralLocale(value: string): boolean {
  return /^(?:c|posix)(?:\.[^@]+)?(?:@.*)?$/i.test(value);
}
