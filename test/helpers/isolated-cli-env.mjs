import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Build a hermetic environment for specs that launch the real Moss CLI.
 * Host device targets and user-level config must never change test behavior.
 */
export function isolatedCliEnv({
  inherited = process.env,
  overrides = {},
  prefix = 'moss-cli-spec-',
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

  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configHome = path.join(home, '.config');
  const isolated = {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    MOSS_CONFIG_DIR: path.join(configHome, 'moss'),
    MOSS_NO_RDK_DOCS: '1',
    ...overrides,
  };
  for (const key of Object.keys(isolated)) {
    if (key.startsWith('MOSS_DEVICE_')) delete isolated[key];
  }
  isolated.MOSS_NO_RDK_DOCS = '1';
  return isolated;
}
