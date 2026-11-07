import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

for (const locale of ['zh_CN.UTF-8', 'en_US.UTF-8']) {
  test(`CLI module initializes with one environment provider in ${locale}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-env-locale-'));
    try {
      const env = { ...process.env };
      for (const name of Object.keys(env)) {
        if (
          name.startsWith('MOSS_') ||
          /(?:API_KEY|API_TOKEN|ACCESS_TOKEN|BASE_URL)$/.test(name) ||
          /^(?:MOSS_LANG|MOSS_LOCALE|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy)$/.test(
            name
          )
        )
          delete env[name];
      }
      Object.assign(env, {
        MOSS_CONFIG_DIR: dir,
        LANG: locale,
        LC_ALL: locale,
        DEEPSEEK_API_KEY: 'fixture-key-never-send',
      });
      const target = new URL('../dist/cli/oneshot.js', import.meta.url).href;
      const configModule = new URL('../dist/cli/config.js', import.meta.url).href;
      const code = `globalThis.fetch = () => { throw new Error('Unexpected fetch during module initialization'); }; await import(${JSON.stringify(target)}); const {resolveCliConfig} = await import(${JSON.stringify(configModule)}); console.log(JSON.stringify({notice:resolveCliConfig(process.env,{},{}).autoEnvNotice}));`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: dir,
        env,
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
      const { notice } = JSON.parse(result.stdout);
      assert.match(
        notice,
        locale.startsWith('zh') ? /使用 DEEPSEEK_API_KEY/ : /Using DEEPSEEK_API_KEY/
      );
      assert.doesNotMatch(result.stdout + result.stderr, /fixture-key-never-send/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
