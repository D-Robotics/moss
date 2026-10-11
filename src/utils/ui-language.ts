/**
 * Process-wide UI language. The provider layer can read it (utils is inward
 * of provider); the CLI installs it from flag, env, user config, and the
 * system locale. Assistant reply language does not use this module.
 */
import { preferredLocale } from './locale-preference.js';

export type UiLanguage = 'en' | 'zh';
export type LanguageSetting = 'auto' | UiLanguage;
export type UiLanguageSource = 'flag' | 'env' | 'config' | 'locale' | 'session';

export interface UiLanguageResolution {
  language: UiLanguage;
  source: Exclude<UiLanguageSource, 'session'>;
  /** User-config value that was consulted. Unset is `auto`. */
  setting: LanguageSetting;
}

/** Session pin. `system` follows the process locale and ignores flag/env/config. */
let session: UiLanguage | 'system' | undefined;
let installed: UiLanguageResolution | undefined;

/**
 * System locale for `language: auto`. Neutral tags (`C`, `POSIX`, `C.UTF-8`)
 * are an encoding, not a language, and fall through to the next variable.
 */
export function systemLocale(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return preferredLocale(env);
}

/**
 * Chinese only when the locale tag starts with `zh`. `C`, `POSIX`,
 * `C.UTF-8`, empty, and unset stay English.
 */
export function uiLanguageFromSystemLocale(locale: string | undefined): UiLanguage {
  return /^zh/i.test(locale ?? '') ? 'zh' : 'en';
}

export function parseLanguageSetting(value: string): LanguageSetting | null {
  const raw = value.trim().toLowerCase();
  if (raw === 'auto' || raw === 'en' || raw === 'zh') return raw;
  return null;
}

/** `--lang` accepts only `en` or `zh`. `MOSS_LANG=auto` is handled in `resolveUiLanguage`. */
export function parseExplicitUiLanguage(value: string): UiLanguage | null {
  const raw = value.trim().toLowerCase();
  if (raw === 'en' || raw === 'zh') return raw;
  return null;
}

export function resolveUiLanguage(input: {
  flag?: string;
  envLang?: string;
  configLanguage?: string;
  systemLocale?: string;
}): UiLanguageResolution {
  const parsedConfig =
    input.configLanguage === undefined || input.configLanguage.trim() === ''
      ? 'auto'
      : parseLanguageSetting(input.configLanguage);
  const setting: LanguageSetting = parsedConfig ?? 'auto';
  if (input.flag !== undefined && input.flag.trim() !== '') {
    const flag = parseExplicitUiLanguage(input.flag);
    if (!flag) {
      throw new Error(`--lang must be en|zh, got "${input.flag}"`);
    }
    return { language: flag, source: 'flag', setting };
  }
  if (input.envLang !== undefined && input.envLang.trim() !== '') {
    const raw = input.envLang.trim().toLowerCase();
    // `auto` is a real setting: fall through to config, then the system locale.
    if (raw !== 'auto') {
      const envLang = parseExplicitUiLanguage(input.envLang);
      if (!envLang) {
        throw new Error(`MOSS_LANG must be auto|en|zh, got "${input.envLang}"`);
      }
      return { language: envLang, source: 'env', setting };
    }
  }
  if (setting === 'en' || setting === 'zh') {
    return { language: setting, source: 'config', setting };
  }
  return {
    language: uiLanguageFromSystemLocale(input.systemLocale),
    source: 'locale',
    setting: 'auto',
  };
}

export function installUiLanguage(resolution: UiLanguageResolution): void {
  installed = resolution;
  session = undefined;
}

export function clearUiLanguage(): void {
  installed = undefined;
  session = undefined;
}

export function setSessionUiLanguage(language: UiLanguage | 'system'): void {
  session = language;
}

export function hasSessionUiOverride(): boolean {
  return session !== undefined;
}

export function uiLanguageResolution(): UiLanguageResolution | undefined {
  return installed;
}

export function effectiveUiLanguage(env: NodeJS.ProcessEnv = process.env): UiLanguage {
  if (session === 'en' || session === 'zh') return session;
  if (session === 'system') return uiLanguageFromSystemLocale(systemLocale(env));
  if (installed) return installed.language;
  return uiLanguageFromSystemLocale(systemLocale(env));
}

export function effectiveUiLanguageSource(): UiLanguageSource {
  if (session !== undefined) return 'session';
  if (installed) return installed.source;
  return 'locale';
}

export function isEffectiveUiZh(env: NodeJS.ProcessEnv = process.env): boolean {
  return effectiveUiLanguage(env) === 'zh';
}

/** UI chrome string. Assistant replies do not use this. */
export function uiText(en: string, zh: string): string {
  return isEffectiveUiZh() ? zh : en;
}
