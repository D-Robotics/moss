#!/usr/bin/env node
/**
 * UI language resolution only: flag > env > user config > system locale.
 * Per-surface Chinese/English census used to live here and dominated verify
 * without locking a second decision. Help and TUI copy stay in
 * cli-locale-help and tui-locale.
 */
import assert from 'node:assert/strict';

import { mergeConfigFiles } from '../dist/cli/config.js';
import {
  buildAnswerLanguageLayer,
  clearUiLanguage,
  resolveUiLanguage,
  shouldOfferEnglishUi,
} from '../dist/cli/cli-locale.js';
import { installUiLanguage } from '../dist/utils/ui-language.js';

{
  assert.equal(resolveUiLanguage({ systemLocale: 'C' }).language, 'en');
  assert.equal(resolveUiLanguage({ systemLocale: 'POSIX' }).language, 'en');
  assert.equal(resolveUiLanguage({ systemLocale: 'C.UTF-8' }).language, 'en');
  assert.equal(resolveUiLanguage({}).language, 'en');
  assert.equal(resolveUiLanguage({ systemLocale: 'zh_CN.UTF-8' }).language, 'zh');
  const flagged = resolveUiLanguage({
    flag: 'en',
    envLang: 'zh',
    configLanguage: 'zh',
    systemLocale: 'zh_CN.UTF-8',
  });
  assert.equal(flagged.language, 'en');
  assert.equal(flagged.source, 'flag');
  assert.equal(
    resolveUiLanguage({ envLang: 'zh', configLanguage: 'en', systemLocale: 'C' }).source,
    'env'
  );
  assert.equal(resolveUiLanguage({ configLanguage: 'zh', systemLocale: 'C' }).source, 'config');
  assert.throws(() => resolveUiLanguage({ flag: 'fr' }), /--lang must be en\|zh/);
  assert.throws(() => resolveUiLanguage({ envLang: 'chinese' }), /MOSS_LANG must be auto\|en\|zh/);
  assert.equal(
    resolveUiLanguage({ envLang: 'auto', configLanguage: 'zh', systemLocale: 'C' }).source,
    'config'
  );
  assert.equal(resolveUiLanguage({ envLang: 'AUTO', systemLocale: 'zh_CN.UTF-8' }).language, 'zh');
  assert.equal(
    mergeConfigFiles({ language: 'zh', model: 'from-project' }, { language: 'en' }).language,
    'en'
  );
  assert.equal(mergeConfigFiles({ language: 'zh' }, {}).language, undefined);
  assert.equal(
    shouldOfferEnglishUi({
      tty: true,
      systemLocale: 'zh_CN.UTF-8',
      configLanguage: undefined,
      source: 'locale',
    }),
    true
  );
  assert.equal(
    shouldOfferEnglishUi({
      tty: true,
      systemLocale: 'en_US.UTF-8',
      configLanguage: undefined,
      source: 'locale',
    }),
    false
  );
  assert.equal(
    shouldOfferEnglishUi({
      tty: false,
      systemLocale: 'zh_CN.UTF-8',
      configLanguage: undefined,
      source: 'locale',
    }),
    false
  );
  assert.equal(
    shouldOfferEnglishUi({
      tty: true,
      systemLocale: 'zh_CN.UTF-8',
      configLanguage: 'auto',
      source: 'locale',
    }),
    false
  );
}

{
  const saved = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LC_MESSAGES: process.env.LC_MESSAGES,
  };
  process.env.LANG = 'zh_CN.UTF-8';
  process.env.LC_ALL = 'zh_CN.UTF-8';
  process.env.LC_MESSAGES = 'zh_CN.UTF-8';
  clearUiLanguage();
  installUiLanguage({ language: 'en', source: 'flag', setting: 'auto' });
  try {
    const layer = buildAnswerLanguageLayer();
    assert.match(
      layer,
      /简体中文/,
      'answer language follows the system locale, not the UI language'
    );
  } finally {
    clearUiLanguage();
    process.env.LANG = 'C';
    process.env.LC_ALL = 'C';
    process.env.LC_MESSAGES = 'C';
    assert.equal(buildAnswerLanguageLayer(), '');
    for (const key of ['LANG', 'LC_ALL', 'LC_MESSAGES']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

console.log('[PASS] cli ui language');
