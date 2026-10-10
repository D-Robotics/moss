/**
 * `moss uninstall` — print the global package and ~/.moss paths, and delete
 * known Moss config files only after an explicit yes. Refuses HOME, every
 * ancestor of HOME and of the working directory, the filesystem root, and any
 * directory that is not a Moss config directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupCopy } from './cli-locale.js';
import { resolveConfigDir } from './config.js';
import { getPackageJsonPath } from './package-info.js';
import { preferredLocale } from '../utils/locale-preference.js';

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

/** Top-level names Moss writes in the user config directory. */
const MOSS_CONFIG_ENTRY_NAMES = new Set([
  '.apikey-key',
  '.env',
  '.moss_onboarding_shown',
  'SOUL.md',
  'agents',
  'claude-compat.json',
  'commands',
  'config.json',
  'git-builtin-diff',
  'keybindings.json',
  'mcp.json',
  'preferred-model.json',
  'real-model-cache.json',
  'skills',
  'soul.md',
  'tools',
  'workspace-trust.json',
]);

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

function copy(env: NodeJS.ProcessEnv, en: string, vars?: Record<string, string | number>): string {
  return setupCopy(preferredLocale(env) ?? 'en', en, vars);
}

/** True when `dir` strictly contains `child` (a parent, not the same path). */
function isStrictAncestor(dir: string, child: string): boolean {
  const rel = path.relative(dir, child);
  if (!rel || rel === '.') return false;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/** Why `configDir` must not be deleted, or null when the path itself is safe to inspect. */
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
    return copy(env, 'Refusing to delete config: {path} is the home directory.', {
      path: configDir,
    });
  }
  if (config === root) {
    return copy(env, 'Refusing to delete config: {path} is the filesystem root.', {
      path: configDir,
    });
  }
  if (config === here) {
    return copy(env, 'Refusing to delete config: {path} is the current directory.', {
      path: configDir,
    });
  }
  if (isStrictAncestor(config, home)) {
    return copy(env, 'Refusing to delete config: {path} is a parent of the home directory.', {
      path: configDir,
    });
  }
  if (isStrictAncestor(config, here)) {
    return copy(env, 'Refusing to delete config: {path} is a parent of the current directory.', {
      path: configDir,
    });
  }
  return null;
}

/**
 * Absolute paths of the known Moss entries that would be deleted, or a refusal
 * when the directory has unexpected names or no Moss config files.
 */
export function mossConfigDeletionList(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env
): { paths: string[] } | { refusal: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(configDir);
  } catch {
    return {
      refusal: copy(env, 'Refusing to delete config: {path} is not a directory.', {
        path: configDir,
      }),
    };
  }
  if (!stat.isDirectory()) {
    return {
      refusal: copy(env, 'Refusing to delete config: {path} is not a directory.', {
        path: configDir,
      }),
    };
  }
  let names: string[];
  try {
    names = fs.readdirSync(configDir);
  } catch {
    return {
      refusal: copy(env, 'Refusing to delete config: {path} is not a Moss config directory.', {
        path: configDir,
      }),
    };
  }
  const known = names.filter((name) => MOSS_CONFIG_ENTRY_NAMES.has(name));
  const unexpected = names.filter((name) => !MOSS_CONFIG_ENTRY_NAMES.has(name));
  if (unexpected.length > 0) {
    const shown = unexpected.slice(0, 5);
    const extra = unexpected.length - shown.length;
    const list = extra > 0 ? `${shown.join(', ')}, +${extra}` : shown.join(', ');
    return {
      refusal: copy(
        env,
        'Refusing to delete config: {path} is not a Moss config directory (unexpected: {names}).',
        { path: configDir, names: list }
      ),
    };
  }
  if (known.length === 0) {
    return {
      refusal: copy(
        env,
        'Refusing to delete config: {path} is not a Moss config directory (no Moss config files).',
        { path: configDir }
      ),
    };
  }
  const root = canonical(configDir);
  return { paths: known.map((name) => path.join(root, name)).sort() };
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
    log(copy(env, 'Config directory is not present: {path}', { path: plan.configDir }));
    return { deletedConfig: false };
  }

  const listed = mossConfigDeletionList(plan.configDir, env);
  if ('refusal' in listed) {
    log(listed.refusal);
    return { deletedConfig: false };
  }

  log(`${copy(env, 'Will delete:')}\n${listed.paths.map((entry) => `  ${entry}`).join('\n')}`);

  const tty = io.isTTY ?? Boolean(process.stdin.isTTY);
  if (!tty) {
    log(
      copy(env, 'Kept config: {path} (re-run in a terminal to confirm deletion).', {
        path: plan.configDir,
      })
    );
    return { deletedConfig: false };
  }

  const prompt = copy(env, 'Delete these files in {path}? [y/N] ', { path: plan.configDir });
  const ask = io.ask;
  const answer = ask ? await ask(prompt) : await askOnTTY(prompt);
  if (!/^y(es)?$/i.test(answer.trim())) {
    log(copy(env, 'Kept config: {path}', { path: plan.configDir }));
    return { deletedConfig: false };
  }

  for (const entry of listed.paths) {
    fs.rmSync(entry, { recursive: true, force: true });
  }
  try {
    fs.rmdirSync(plan.configDir);
  } catch {
    // A file appeared after the listing, or the directory was already gone.
  }
  if (fs.existsSync(plan.configDir)) {
    log(copy(env, 'Could not delete config: {path}', { path: plan.configDir }));
    return { deletedConfig: false };
  }
  log(copy(env, 'Deleted config: {path}', { path: plan.configDir }));
  return { deletedConfig: true };
}

async function askOnTTY(prompt: string): Promise<string> {
  const { question } = await import('./setup-wizard.js');
  return question(prompt);
}
