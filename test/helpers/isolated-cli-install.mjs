import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTempDir } from './temp-home.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let cachedCliPath;

/**
 * A temp install of the built CLI with no repository `.env` above it. The CLI
 * loads `.env` files above its install directory, so specs that assert folder
 * trust, dotenv routing, or device credentials must not run `dist/cli.js`
 * directly from a developer checkout that may contain one.
 */
export function getIsolatedCliPath() {
  if (cachedCliPath) return cachedCliPath;
  const root = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-isolated-cli-')));
  const install = path.join(root, 'install');
  fs.mkdirSync(install);
  fs.cpSync(path.join(repoRoot, 'dist'), path.join(install, 'dist'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'bin'), path.join(install, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(install, 'package.json'));
  fs.symlinkSync(
    path.join(repoRoot, 'node_modules'),
    path.join(install, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  cachedCliPath = path.join(install, 'dist', 'cli.js');
  return cachedCliPath;
}
