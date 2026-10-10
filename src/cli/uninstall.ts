/**
 * `moss uninstall` — print the global package and ~/.moss paths, and delete
 * the config directory only after an explicit yes. Never deletes the home
 * directory, `/`, or the current working directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfigDir } from './config.js';
import { getPackageJsonPath } from './package-info.js';

export interface UninstallPlan {
  /** Global uninstall command for this package. */
  globalPackageCommand: string;
  packageJsonPath: string;
  /** Resolved ~/.moss (printed only — not deleted). */
  mossHome: string;
  /** Resolved config directory (not deleted until the user confirms). */
  configDir: string;
}

export interface UninstallIo {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  isTTY?: boolean;
  ask?: (prompt: string) => Promise<string>;
  log?: (line: string) => void;
}

function homeDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const named = platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE;
  if (typeof named === 'string' && named.trim()) return named.trim();
  return os.homedir();
}

function packageName(packageJsonPath: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { name?: unknown };
    if (typeof parsed.name === 'string' && parsed.name.trim()) return parsed.name.trim();
  } catch {
    // Fall through to the bin name.
  }
  return 'moss';
}

function canonical(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Why `configDir` must not be deleted, or null when deletion is safe to ask about. */
export function configDirDeletionRefusal(
  configDir: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cwd: string
): string | null {
  const config = canonical(configDir);
  const home = canonical(homeDir(env, platform));
  const root = canonical(path.parse(config).root);
  const here = canonical(cwd);
  if (config === home) {
    return `Refusing to delete config: ${configDir} is the home directory.`;
  }
  if (config === root) {
    return `Refusing to delete config: ${configDir} is the filesystem root.`;
  }
  if (config === here) {
    return `Refusing to delete config: ${configDir} is the current directory.`;
  }
  return null;
}

export function uninstallPlan(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): UninstallPlan {
  const packageJsonPath = getPackageJsonPath();
  return {
    globalPackageCommand: `npm uninstall -g ${packageName(packageJsonPath)}`,
    packageJsonPath,
    mossHome: path.join(homeDir(env, platform), '.moss'),
    configDir: resolveConfigDir(env, platform),
  };
}

export function renderUninstallPlan(plan: UninstallPlan): string {
  return [
    'Moss uninstall — remove these:',
    '',
    'Global package:',
    `  ${plan.globalPackageCommand}`,
    `  package: ${plan.packageJsonPath}`,
    '',
    'Moss home (~/.moss dirs, not deleted by this command):',
    `  ${plan.mossHome}`,
    '',
    'Config directory (deleted only after you confirm):',
    `  ${plan.configDir}`,
    '',
    "Workspace data stays in each project's .moss/ directory. This command does not delete it.",
  ].join('\n');
}

export async function runUninstall(io: UninstallIo = {}): Promise<{ deletedConfig: boolean }> {
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;
  const cwd = io.cwd ?? process.cwd();
  const log = io.log ?? ((line: string) => console.log(line));
  const plan = uninstallPlan(env, platform);
  log(renderUninstallPlan(plan));

  const refusal = configDirDeletionRefusal(plan.configDir, env, platform, cwd);
  if (refusal) {
    log(refusal);
    return { deletedConfig: false };
  }

  const existed = fs.existsSync(plan.configDir);
  if (!existed) {
    log(`Config directory is not present: ${plan.configDir}`);
    return { deletedConfig: false };
  }

  const tty = io.isTTY ?? Boolean(process.stdin.isTTY);
  if (!tty) {
    log(`Kept config: ${plan.configDir} (re-run in a terminal to confirm deletion).`);
    return { deletedConfig: false };
  }

  const ask = io.ask;
  const answer = ask
    ? await ask(`Delete config at ${plan.configDir}? [y/N] `)
    : await askOnTTY(`Delete config at ${plan.configDir}? [y/N] `);
  if (!/^y(es)?$/i.test(answer.trim())) {
    log(`Kept config: ${plan.configDir}`);
    return { deletedConfig: false };
  }

  fs.rmSync(plan.configDir, { recursive: true, force: true });
  if (fs.existsSync(plan.configDir)) {
    log(`Could not delete config: ${plan.configDir}`);
    return { deletedConfig: false };
  }
  log(`Deleted config: ${plan.configDir}`);
  return { deletedConfig: true };
}

async function askOnTTY(prompt: string): Promise<string> {
  const { question } = await import('./setup-wizard.js');
  return question(prompt);
}
