import { runProcessSync } from '../utils/run-process.js';
import { checkForCliUpdate, formatUpdateNotice } from './update-check.js';

const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

export async function runCliUpdate(options: {
  configDir: string;
  currentVersion: string;
  packageName?: string;
  npmBin?: string;
}): Promise<number> {
  const packageName = options.packageName ?? '@rdk-moss/agent';
  if (!NPM_PACKAGE_NAME_RE.test(packageName)) {
    process.stderr.write(`[update] invalid npm package name: ${packageName}\n`);
    return 1;
  }
  const notice = await checkForCliUpdate({
    configDir: options.configDir,
    currentVersion: options.currentVersion,
    timeoutMs: 2500,
    forceRefresh: true,
  });

  if (notice) {
    process.stderr.write(`${formatUpdateNotice(notice)}\n`);
  } else {
    process.stderr.write(
      `[update] Installing latest ${packageName}. Current version: ${options.currentVersion}\n`
    );
  }

  const usingDefaultNpm = options.npmBin === undefined;
  const result = runProcessSync(options.npmBin ?? 'npm', ['i', '-g', `${packageName}@latest`], {
    stdio: 'inherit',
    // Windows installs npm as a .cmd shim, which child_process cannot execute
    // directly. Only the fixed default command uses the shell; injected test
    // executables still run directly, and packageName is validated above.
    shell: process.platform === 'win32' && usingDefaultNpm,
    timeout: 10 * 60_000,
  });
  if (result.error) {
    process.stderr.write(`[update] failed to run npm: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 0;
}
