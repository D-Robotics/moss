import {
  envBeforeDotenv,
  loadConfigFile,
  resolveConfigPath,
  saveConfigFileAtPath,
} from './config.js';
import {
  clearUiLanguage,
  effectiveUiLanguage,
  effectiveUiLanguageSource,
  hasSessionUiOverride,
  installUiLanguage,
  isEffectiveUiZh,
  parseExplicitUiLanguage,
  parseLanguageSetting,
  resolveUiLanguage,
  setSessionUiLanguage,
  systemLocale,
  uiLanguageFromSystemLocale,
  uiLanguageResolution,
  type LanguageSetting,
  type UiLanguage,
  type UiLanguageResolution,
  type UiLanguageSource,
} from '../utils/ui-language.js';

export {
  clearUiLanguage,
  effectiveUiLanguage,
  effectiveUiLanguageSource,
  hasSessionUiOverride,
  parseExplicitUiLanguage,
  parseLanguageSetting,
  resolveUiLanguage,
  setSessionUiLanguage,
  systemLocale,
  uiLanguageFromSystemLocale,
  uiLanguageResolution,
};
export type { LanguageSetting, UiLanguage, UiLanguageResolution, UiLanguageSource };

/**
 * Locale the UI layer consults. After startup installation this is the
 * resolved UI language (`en` or `zh`). Before that, and for callers that
 * never install, it is still `LC_ALL` / `LC_MESSAGES` / `LANG`.
 */
export function cliLocale(): string | undefined {
  if (hasSessionUiOverride() || uiLanguageResolution()) {
    return effectiveUiLanguage() === 'zh' ? 'zh' : 'en';
  }
  return systemLocale();
}

/** True when the UI language is Chinese. An explicit locale argument wins. */
export function isZhLocale(locale: string | undefined = cliLocale()): boolean {
  if (locale !== undefined) return /^zh/i.test(locale);
  return isEffectiveUiZh();
}

/**
 * One string from the UI locale. English is the default; Chinese is the
 * optional UI language. Assistant prose does not go through here.
 */
export function uiText(en: string, zh: string): string {
  return isZhLocale() ? zh : en;
}

/**
 * Install UI language for this process.
 * Precedence: `--lang` > `MOSS_LANG` > user config `language` > system locale.
 * `MOSS_LANG` and the system locale are read from the environment captured
 * before a project `.env` is applied. Returns an error message when
 * `MOSS_LANG` is set to something other than `en` or `zh`.
 */
export function installCliUiLanguage(options: { flag?: string } = {}): string | undefined {
  const env = envBeforeDotenv;
  const envLang = env.MOSS_LANG;
  if (envLang !== undefined && envLang.trim() !== '' && !parseExplicitUiLanguage(envLang)) {
    const systemIsZh = uiLanguageFromSystemLocale(systemLocale(env)) === 'zh';
    return systemIsZh
      ? `MOSS_LANG 只能是 en 或 zh，收到「${envLang}」。`
      : `MOSS_LANG must be en|zh, got "${envLang}".`;
  }
  let configLanguage: string | undefined;
  try {
    const stored = loadConfigFile(resolveConfigPath(undefined, env));
    if (typeof stored.language === 'string') configLanguage = stored.language;
  } catch {
    configLanguage = undefined;
  }
  try {
    installUiLanguage(
      resolveUiLanguage({
        flag: options.flag,
        envLang,
        configLanguage,
        systemLocale: systemLocale(env),
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message;
  }
  return undefined;
}

/**
 * Fallback named by the language policy when the latest user message has no
 * language of its own. This follows the system locale, not the UI language:
 * the reply still matches the user's message, and Chinese locales only pin
 * the no-signal fallback to Simplified Chinese.
 */
export function buildAnswerLanguageLayer(locale: string | undefined = systemLocale()): string {
  if (!/^zh/i.test(locale ?? '')) return '';
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

const SOURCE_ZH: Record<UiLanguageSource, string> = {
  flag: '命令行',
  env: '环境变量',
  config: '用户配置',
  locale: '系统区域',
  session: '本会话',
};

export function uiLanguageSourceLabel(
  source: UiLanguageSource = effectiveUiLanguageSource()
): string {
  return uiText(source, SOURCE_ZH[source]);
}

/** Persist `language` in the user config. A project config cannot store it. */
export function writeUserLanguageSetting(setting: LanguageSetting): void {
  const configPath = resolveConfigPath();
  const current = loadConfigFile(configPath);
  saveConfigFileAtPath({ ...current, language: setting }, configPath);
}

/**
 * First-run setup offers English only when the system locale is Chinese and
 * the user has not chosen a UI language yet. Flag, env, and an explicit
 * config value skip the offer. Not a TTY skips it so piped setup stays stable.
 */
export function shouldOfferEnglishUi(input: {
  tty: boolean;
  systemLocale: string | undefined;
  configLanguage: string | undefined;
  source: UiLanguageSource | undefined;
}): boolean {
  if (!input.tty) return false;
  if (uiLanguageFromSystemLocale(input.systemLocale) !== 'zh') return false;
  if (input.configLanguage !== undefined && input.configLanguage.trim() !== '') return false;
  if (input.source && input.source !== 'locale') return false;
  return true;
}

/** One config-show line for the resolved UI language. */
export function formatUiLanguageLine(): string {
  const language = effectiveUiLanguage();
  const resolution = uiLanguageResolution();
  const setting = resolution?.setting ?? 'auto';
  const source = effectiveUiLanguageSource();
  return uiText(
    `  language: ${language} (setting ${setting}, source ${source})`,
    `  界面语言：${language === 'zh' ? '中文' : 'English'}（设置 ${setting}，来源 ${SOURCE_ZH[source]}）`
  );
}
