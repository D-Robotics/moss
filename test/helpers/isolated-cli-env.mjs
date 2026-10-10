import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { trackTempDir } from './temp-home.mjs';

/**
 * Build a hermetic environment for specs that launch the real Moss CLI.
 * Host device targets and user-level config must never change test behavior.
 */
export function isolatedCliEnv({
  inherited = process.env,
  overrides = {},
  prefix = 'moss-cli-spec-',
  isolateHome = true,
} = {}) {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('MOSS_DEVICE_') ||
      key === 'MOSS_CONFIG_DIR' ||
      key === 'MOSS_CONFIG_FILE' ||
      key === 'MOSS_CONFIG_PATH' ||
      key === 'XDG_CONFIG_HOME' ||
      key === 'APPDATA'
    ) {
      delete env[key];
    }
  }
  // A host with two official keys would exit 3 before the spec's scenario.
  for (const key of [
    'DEEPSEEK_API_KEY',
    'DASHSCOPE_API_KEY',
    'ALIYUN_API_KEY',
    'QWEN_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
  ]) {
    if (!(key in overrides)) delete env[key];
  }

  const isolated = {
    ...env,
    MOSS_NO_RDK_DOCS: '1',
    ...(isolateHome
      ? (() => {
          const home = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
          const configHome = path.join(home, '.config');
          return {
            HOME: home,
            XDG_CONFIG_HOME: configHome,
            MOSS_CONFIG_DIR: path.join(configHome, 'moss'),
          };
        })()
      : {}),
    ...overrides,
  };
  for (const key of Object.keys(isolated)) {
    if (key.startsWith('MOSS_DEVICE_')) delete isolated[key];
  }
  isolated.MOSS_NO_RDK_DOCS = '1';
  return isolated;
}
