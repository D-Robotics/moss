/**
 * File tools resolve paths against the project workspace by default.
 * A path outside the workspace is still read; secret-like values are removed
 * from tool output before the model sees them. Moss credential files are not
 * blocked, but their values are withheld from that output.
 */
import os from 'node:os';
import path from 'node:path';

function homeDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = (env.HOME || env.USERPROFILE || '').trim();
  if (fromEnv) return fromEnv;
  return os.homedir();
}

export function isUnderPath(child: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function credentialDirs(env: NodeJS.ProcessEnv): string[] {
  const home = homeDir(env);
  const dirs = [path.join(home, '.config', 'moss'), path.join(home, '.moss')];
  const xdg = (env.XDG_CONFIG_HOME || '').trim();
  if (xdg) dirs.push(path.join(xdg, 'moss'));
  const explicit = (env.MOSS_CONFIG_DIR || '').trim();
  if (explicit) dirs.push(path.resolve(explicit));
  if (process.platform === 'win32') {
    const appdata = (env.APPDATA || path.join(home, 'AppData', 'Roaming')).trim();
    dirs.push(path.join(appdata, 'moss'));
  }
  return dirs;
}

/** User credential store, project `.moss/config.json`, and `.apikey-key`. */
export function isMossCredentialPath(
  resolved: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const abs = path.resolve(resolved);
  for (const dir of credentialDirs(env)) {
    if (isUnderPath(abs, dir)) return true;
  }
  if (path.basename(abs) === '.apikey-key') return true;
  const parent = path.basename(path.dirname(abs));
  return parent === '.moss' && path.basename(abs) === 'config.json';
}

export function expandUserPath(raw: string, env: NodeJS.ProcessEnv, cwd: string): string {
  let text = raw.trim();
  const home = homeDir(env);
  if (text === '~' || text === '$HOME' || text === '${HOME}') text = home;
  else if (text.startsWith('~/')) text = path.join(home, text.slice(2));
  else if (text.startsWith('$HOME/')) text = path.join(home, text.slice('$HOME/'.length));
  else if (text.startsWith('${HOME}/')) text = path.join(home, text.slice('${HOME}/'.length));
  else if (text === '.' || text === './') text = cwd;
  if (!path.isAbsolute(text)) text = path.resolve(cwd, text);
  return path.resolve(text);
}

/** Resolve a file-tool path. Relative paths use the workspace. Nothing is denied. */
export function resolveReadPath(
  raw: string,
  workspaceDir: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const base = path.resolve(workspaceDir || process.cwd());
  const text = raw.trim() ? raw : '.';
  return expandUserPath(text, env, base);
}

const CREDENTIAL_COMMAND =
  /\.apikey-key\b|\.moss\/config\.json\b|\.config\/moss\b|(?:^|[\s"'`=])~\/\.moss\b/;

/** True when a shell command names Moss's own config or key file. */
export function commandMentionsMossCredential(command: string): boolean {
  return CREDENTIAL_COMMAND.test(command);
}
