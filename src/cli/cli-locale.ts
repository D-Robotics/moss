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
import { wrap } from './tui/text.js';
import { WORKSPACE_WRITE_LIMIT_EN, WORKSPACE_WRITE_LIMIT_ZH } from './workspace-write-copy.js';

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
 * never install, it is the system locale (`LC_ALL` / `LC_MESSAGES` / `LANG`,
 * skipping neutral `C` / `POSIX` tags).
 */
export function cliLocale(): string | undefined {
  if (hasSessionUiOverride() || uiLanguageResolution()) {
    return effectiveUiLanguage() === 'zh' ? 'zh' : 'en';
  }
  return systemLocale();
}

const SETUP_ZH: Readonly<Record<string, string>> = {
  'Moss setup': 'Moss 设置',
  ' or ': ' 或 ',
  'About a minute. A pasted key is stored in the config file (mode 0600). Set apiKeyEnv to a variable name to keep the key out of that file.':
    '大约一分钟。粘贴的 key 存在配置文件里（权限 0600）。把 apiKeyEnv 设成变量名就不会写入文件。',
  'That number is not in the list.': '序号不在列表里。',
  '"{text}" is not in the list. Closest match: {suggested}. Type its number, or press Enter to use {suggested}.':
    '「{text}」不在列表里。最接近的是 {suggested}。输入它的序号，或按 Enter 使用 {suggested}。',
  '"{text}" is not in the list. Pick one of the numbered models.':
    '「{text}」不在列表里。请选一个有序号的模型。',
  'Pick 1–6 or a provider name.': '请输入 1–6 或服务商名称。',
  'Base URL must be a full http(s) URL.': '地址必须是完整的 http(s) URL。',
  'Base URL saved as {baseUrl} (/v1 and extra paths removed).':
    '地址已规范为 {baseUrl}（已去掉 /v1 和多余路径）。',
  'An API key is required.': '需要填写 API key。',
  'Type a model name or its number.': '请输入模型名或序号。',
  'No models were listed. Type the model name.': '网关没有返回模型。请直接输入模型名。',
  'A key is already in the environment. Press Enter to use it (the value is not shown).':
    '环境里已经有 key。按 Enter 使用（不会显示内容）。',
  'A key is already in the environment. Press its number to use that host (the value is not shown). Enter chooses a provider.':
    '环境里已经有 key。按数字使用那个地址（不会显示内容）。Enter 改为选择服务商。',
  'n  choose a provider instead': 'n  改为选择服务商',
  'Choose a provider. Press its number.': '选择服务商，按数字。',
  'Gateway URL (https://host). A trailing /v1 is removed.':
    '网关地址（https://主机）。末尾的 /v1 会被去掉。',
  'Esc returns to the provider list.': 'Esc 返回选择服务商。',
  'API key (hidden): {dots}': 'API key（不显示）：{dots}',
  'Esc goes back one step.': 'Esc 返回上一步。',
  'Type the model name, then Enter.': '输入模型名，然后按 Enter。',
  'Pick a model by number or name ({count} listed).': '用序号或名字选择模型（共 {count} 个）。',
  'Fetching the model list…': '正在获取模型列表…',
  'Testing the connection (1 token)…': '正在测试连接（1 token）…',
  'Esc returns to the URL.': 'Esc 返回修改地址。',
  'Esc returns to the key.': 'Esc 返回修改 key。',
  'Esc picks a provider again.': 'Esc 重新选择服务商。',
  'Enter retries. {back} Type "save anyway" or press 1 to write this config.':
    'Enter 重试。{back}输入「仍然保存」或按 1 则写入配置。',
  '{back} Type "save anyway" or press 1 to write this config. Enter goes back.':
    '{back}输入「仍然保存」或按 1 写入配置。Enter 返回。',
  'save anyway': '仍然保存',
  'Save this config anyway? [y/N] ': '仍然保存？[y/N] ',
  'Model name: ': '模型名：',
  'The gateway returned HTTP {status} without a model reply. Check the base URL.':
    '网关返回 HTTP {status}，但没有模型回复。请检查地址。',
  'Connected — {model} replied in {latencyMs}ms.': '已连通 — {model} 在 {latencyMs}ms 内有回复。',
  'Moss model setup': 'Moss 模型配置',
  'Choose provider:': '选择提供方：',
  ' (recommended)': '（推荐）',
  'Saved. Pick a model with /model before the first prompt.':
    '已保存。第一次提问前用 /model 选一个模型。',
  'The config was saved. Fix this, then run moss.': '配置已保存。按上面的说明处理后再运行 moss。',
  'Saved {name} · model {model} → {path}': '已保存 {name} · 模型 {model} → {path}',
  'Saved {name} · model not set — pick one inside moss with /model → {path}':
    '已保存 {name} · 尚未选择模型 — 在 moss 里用 /model 选择 → {path}',
  'Security note: a pasted key is stored in the config file (mode 0600). Set apiKeyEnv to a variable name to keep the key out of that file.':
    '安全说明：粘贴的 key 存在配置文件里（权限 0600）。把 apiKeyEnv 设成变量名就不会写入文件。',
  'Avoid sharing or committing this file. Run `moss auth logout` to remove the key.':
    '不要分享或提交这个文件。运行 `moss auth logout` 可以删掉 key。',
  'Next: ask moss to look around this folder (`moss` or `moss "explain this project"`).':
    '下一步：让 moss 看看这个目录（运行 `moss`，或 `moss "介绍一下这个项目"`）。',
  [WORKSPACE_WRITE_LIMIT_EN]: WORKSPACE_WRITE_LIMIT_ZH,
  '{names} is set. Run `moss` and press Enter to use it (the value is not printed).':
    '已设置 {names}。运行 `moss` 并按 Enter 使用（不会打印内容）。',
  'Moss needs a model configuration before it can run.': 'Moss 需要先配好模型才能运行。',
  'Note: the built-in model gateway is disabled because {reason} already sets model settings — remove them (moss config unset provider|model|baseUrl) or add an API key.':
    '注意：内置模型网关已关闭，因为 {reason} 已经写了模型设置 — 删掉它们（moss config unset provider|model|baseUrl）或补上 API key。',
  '  moss                          # interactive setup, then the prompt':
    '  moss                          # 交互式设置，然后进入对话',
  '  moss setup                    # same setup, without opening the chat':
    '  moss setup                    # 同样的设置，但不进入对话',
  'Finish setup, then ask moss to look around this folder.': '完成设置后，让 moss 看看这个目录。',
  'Configure a model, then retry your command.': '配好模型后再重试这条命令。',
  'Found {label}. Press Enter to use it, or n to choose a provider. The value is not shown.':
    '发现 {label}。按 Enter 使用，或输入 n 选择服务商。不会显示内容。',
  'Use it? [Y/n] ': '使用它？[Y/n] ',
  'Saved → {path}': '已保存 → {path}',
  'That key did not connect. Starting provider setup.': '这个 key 没连上。改为选择服务商。',
  'Start setup now? [Y/n] ': '现在开始设置？[Y/n] ',
  'Setup skipped. Run `moss` when you are ready.': '已跳过设置。准备好后运行 `moss`。',
  '[moss] No model configured yet.': '[moss] 还没有配置模型。',
  '  {names} is set. Run `moss` and press Enter to use it (the value is not printed).':
    '  已设置 {names}。运行 `moss` 并按 Enter 使用（不会打印内容）。',
  '{names} is set for {host}. Run `moss` and press its number to use that host. Enter will not send the key there.':
    '{names} 已设置，地址是 {host}。运行 `moss` 并按数字使用该地址。Enter 不会把 key 发到那里。',
  '  {names} is set for {host}. Run `moss` and press its number to use that host. Enter will not send the key there.':
    '  {names} 已设置，地址是 {host}。运行 `moss` 并按数字使用该地址。Enter 不会把 key 发到那里。',
  '  (This hint appears only once.)': '  （此提示只显示一次。）',
  '  Run `moss` to set up a provider, model, and API key.':
    '  运行 `moss` 设置服务商、模型和 API key。',
  'built-in gateway (no API key needed)': '内置网关（不需要 API key）',
  'built-in, shared gateway key': '内置共享网关 key',
  'from {name} (not stored)': '来自 {name}（未写入配置）',
  'stored in config file (0600)': '已存入配置文件（0600）',
  'plain text': '明文',
  'configured ({detail})': '已配置（{detail}）',
  'missing API key. Fix: run `moss` and press Enter to use {names} (the value is not printed).':
    '缺少 API key。修复：运行 `moss` 并按 Enter 使用 {names}（不会打印内容）。',
  'missing API key. Fix: run `moss` and finish setup, or run `moss setup`.':
    '缺少 API key。修复：运行 `moss` 完成设置，或运行 `moss setup`。',
  'missing. Fix: run `moss setup`, or `moss config set baseUrl https://host`.':
    '缺少地址。修复：运行 `moss setup`，或 `moss config set baseUrl https://主机`。',
  '{names} is set and was not applied. Fix: the saved moss config is in use — run `moss setup` to switch.':
    '{names} 已设置但没有采用。修复：当前用的是已保存的 moss 配置 — 运行 `moss setup` 切换。',
  'no default model. Fix: run `/model`, highlight one, and press d to save it.':
    '没有默认模型。修复：运行 `/model`，选中一个，按 d 保存。',
  '{path} is not writable. Fix: run `moss -C <existing-dir>` or `chmod u+w {path}`.':
    '{path} 不可写。修复：运行 `moss -C <已有目录>`，或 `chmod u+w {path}`。',
  '{path} is not writable. Fix: `mkdir -p {path}` or pick another workspace with `moss -C`.':
    '{path} 不可写。修复：`mkdir -p {path}`，或用 `moss -C` 换一个工作区。',
  '{names} is not read. Fix: `moss config set provider <name>`, `moss config set model <name>`, or `moss config set baseUrl <url>`.':
    '{names} 不会被读取。修复：`moss config set provider <名称>`、`moss config set model <名称>` 或 `moss config set baseUrl <地址>`。',
  '[config] not reading {names}. Fix: `moss config set provider <name>` (these MOSS_* variables are not read). using {provider} / {model}.':
    '[config] 不读取环境变量 {names}。修复：用 moss config set 写入（例如 moss config set provider deepseek）。当前是 {provider} / {model}。',
  '[moss] No API key configured. Run `moss` to set one up (a key already in the environment is offered there; the value is not printed).':
    '[moss] 还没有 API key。运行 `moss` 进行设置（环境里已有的 key 会在那里提供，内容不会显示）。',
  '[moss] sending "{text}" to the model...': '[moss] 正在把「{text}」发给模型…',
  '[moss] --print requires a prompt argument or non-empty piped stdin':
    '[moss] --print 需要一段提示，或非空的管道输入',
  '[moss] --print requires a prompt argument or piped stdin':
    '[moss] --print 需要一段提示，或管道输入',
  '[moss] Authentication failed: {message}': '[moss] 认证失败：{message}',
  '[moss] Check your API key with `moss config show`, or re-run `moss setup`.':
    '[moss] 用 `moss config show` 核对 API key，或重新运行 `moss setup`。',
  '[moss] Rate limited: {message}': '[moss] 访问过于频繁：{message}',
  '[moss] Wait a moment and try again. Consider setting a lower model or reducing prompt size.':
    '[moss] 稍等再试。可以换一个更小的模型，或缩短提示。',
  '[moss] Provider error: {message}': '[moss] 服务商错误：{message}',
  '[moss] The upstream API returned an error. Check your network, base URL, and model name.':
    '[moss] 上游接口返回了错误。请检查网络、base URL 和模型名。',
  '[moss] Configuration error: {message}': '[moss] 配置错误：{message}',
  '[moss] Run `moss config show` to inspect settings, or `moss setup` to reconfigure.':
    '[moss] 运行 `moss config show` 查看设置，或运行 `moss setup` 重新配置。',
  '[moss] Session error: {message}': '[moss] 会话错误：{message}',
  '[moss] List saved sessions with `moss sessions`, or start a new one with `moss`.':
    '[moss] 用 `moss sessions` 查看已保存的会话，或运行 `moss` 开始新会话。',
  '[moss] Cancelled: {message}': '[moss] 已取消：{message}',
  'operation was interrupted': '操作被中断',
  'This looks like a bug. Please help us fix it:': '这看起来像是一个 bug。请帮忙修复：',
  '  1. Run `moss doctor` to check your environment': '  1. 运行 `moss doctor` 检查环境',
  '  2. If the problem persists, report it to the Moss maintainers with the details below.':
    '  2. 如果问题还在，把下面的细节发给 Moss 维护者。',
  'Technical details (for bug reports):': '技术细节（用于 bug 报告）：',
  'Refusing to delete config: {path} is the home directory.': '拒绝删除配置：{path} 是主目录。',
  'Refusing to delete config: {path} is the filesystem root.':
    '拒绝删除配置：{path} 是文件系统根目录。',
  'Refusing to delete config: {path} is the current directory.':
    '拒绝删除配置：{path} 是当前目录。',
  'Refusing to delete config: {path} is a parent of the home directory.':
    '拒绝删除配置：{path} 是主目录的上级目录。',
  'Refusing to delete config: {path} is a parent of the current directory.':
    '拒绝删除配置：{path} 是当前目录的上级目录。',
  'Refusing to delete config: {path} is not a directory.': '拒绝删除配置：{path} 不是目录。',
  'Refusing to delete config: {path} is not a Moss config directory.':
    '拒绝删除配置：{path} 不是 Moss 配置目录。',
  'Refusing to delete config: {path} is not a Moss config directory (unexpected: {names}).':
    '拒绝删除配置：{path} 不是 Moss 配置目录（有意外内容：{names}）。',
  'Refusing to delete config: {path} is not a Moss config directory (no Moss config files).':
    '拒绝删除配置：{path} 不是 Moss 配置目录（没有 Moss 配置文件）。',
  'Config directory is not present: {path}': '配置目录不存在：{path}',
  'Will delete:': '将删除：',
  'Kept config: {path} (re-run in a terminal to confirm deletion).':
    '已保留配置：{path}（在终端里重新运行以确认删除）。',
  'Delete these files in {path}? [y/N] ': '删除 {path} 里的这些文件？[y/N] ',
  'Kept config: {path}': '已保留配置：{path}',
  'Could not delete config: {path}': '无法删除配置：{path}',
  'Deleted config: {path}': '已删除配置：{path}',
};

/** Localized setup, doctor, and startup copy. English is the key. */
export function setupCopy(
  locale: string | undefined,
  en: string,
  vars?: Record<string, string | number>
): string {
  let text = isZhLocale(locale) ? (SETUP_ZH[en] ?? en) : en;
  if (!vars) return text;
  for (const [key, value] of Object.entries(vars))
    text = text.replaceAll(`{${key}}`, String(value));
  return text;
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
 * before a project `.env` is applied. An invalid `MOSS_LANG` warns once and
 * falls through to auto so it does not break every command; `--lang` still
 * wins. An invalid config `language` warns and is treated as `auto`.
 * Returns an error message only for an invalid `--lang` that reached here.
 */
export function installCliUiLanguage(options: { flag?: string } = {}): string | undefined {
  const env = envBeforeDotenv;
  let envLang = env.MOSS_LANG;
  const warnings: string[] = [];
  const systemIsZh = uiLanguageFromSystemLocale(systemLocale(env)) === 'zh';
  if (envLang !== undefined && envLang.trim() !== '' && !parseExplicitUiLanguage(envLang)) {
    warnings.push(
      systemIsZh
        ? `[moss] MOSS_LANG 只能是 en 或 zh，收到「${envLang}」，已按 auto 处理。`
        : `[moss] MOSS_LANG must be en|zh, got "${envLang}"; using auto.`
    );
    envLang = undefined;
  }
  let configLanguage: string | undefined;
  try {
    const stored = loadConfigFile(resolveConfigPath(undefined, env));
    if (typeof stored.language === 'string') configLanguage = stored.language;
  } catch {
    configLanguage = undefined;
  }
  if (
    configLanguage !== undefined &&
    configLanguage.trim() !== '' &&
    !parseLanguageSetting(configLanguage)
  ) {
    warnings.push(
      systemIsZh
        ? `[moss] 配置 language「${configLanguage}」不是 auto、en 或 zh，已按 auto 处理。`
        : `[moss] config language "${configLanguage}" is not auto|en|zh; using auto.`
    );
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
  for (const warning of warnings) console.error(warning);
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

/** Wrap a startup notice to the terminal width so a 60-column screen does not clip it. */
export function wrapNoticeLines(text: string, columns = 80): string[] {
  return wrap(text, Math.max(20, columns));
}

/** One-shot notice when full mode has no deny rules. */
export function formatFullModeNotice(locale?: string): string {
  const zh = isZhLocale(locale);
  const limit = setupCopy(locale, WORKSPACE_WRITE_LIMIT_EN);
  return zh
    ? `[moss] 默认 full 模式没有拒绝规则；用 /permissions 添加（例如 deny read_file(./.env)）以继续拦截敏感工具。${limit}此提示只显示一次。`
    : '[moss] Default full mode has no deny rules; add them with /permissions ' +
        '(e.g. deny read_file(./.env)) to keep sensitive tools gated. ' +
        `${limit} This notice shows once.`;
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

/** True when plain `moss` / `moss setup` should offer the one-key English switch. */
export function englishUiOfferPending(tty = true): boolean {
  let configLanguage: string | undefined;
  try {
    const stored = loadConfigFile();
    if (typeof stored.language === 'string') configLanguage = stored.language;
  } catch {
    configLanguage = undefined;
  }
  return shouldOfferEnglishUi({
    tty,
    systemLocale: systemLocale(envBeforeDotenv),
    configLanguage,
    source: uiLanguageResolution()?.source,
  });
}

export const ENGLISH_UI_OFFER = '界面语言：中文。按 e 切换为 English，其他键继续。';

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
