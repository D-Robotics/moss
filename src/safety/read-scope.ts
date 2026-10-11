/**
 * File tools resolve paths against the project workspace by default.
 * A path outside the workspace is still read; secret-like values are removed
 * from tool output before the model sees them. Moss credential files are not
 * blocked, but their values are withheld from that output.
 *
 * O107: classify via lexical resolve and via realpath of the file (or nearest
 * existing ancestor), same spirit as protected-paths / canonicalPath — a
 * workspace symlink into a Moss credential target must still gate.
 */
import fs from 'node:fs';
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

/** Realpath of `abs`, or of the nearest existing ancestor with the missing tail rejoined. */
function realpathOfNearestAncestor(abs: string): string | undefined {
  let current = abs;
  const rest: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = fs.realpathSync.native(current);
      return rest.length ? path.join(real, ...[...rest].reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      rest.push(path.basename(current));
      current = parent;
    }
  }
  return undefined;
}

/**
 * Lexical path plus symlink follow candidates (realpath when possible; otherwise
 * readlink target). Used by credential gates so a workspace link into
 * `.moss/config.json` / `.apikey-key` cannot bypass O105.
 */
export function credentialPathFollowCandidates(resolved: string): string[] {
  const abs = path.resolve(resolved);
  const out: string[] = [abs];
  try {
    out.push(path.resolve(fs.realpathSync.native(abs)));
  } catch {
    try {
      if (fs.lstatSync(abs).isSymbolicLink()) {
        const target = path.resolve(path.dirname(abs), fs.readlinkSync(abs));
        out.push(target);
        const viaTarget = realpathOfNearestAncestor(target);
        if (viaTarget) out.push(path.resolve(viaTarget));
      } else {
        const real = realpathOfNearestAncestor(abs);
        if (real) out.push(path.resolve(real));
      }
    } catch {
      const real = realpathOfNearestAncestor(abs);
      if (real) out.push(path.resolve(real));
    }
  }
  return [...new Set(out)];
}

/** Lexical credential classification (no symlink follow). */
function lexicalMossCredentialPath(abs: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of credentialDirs(env)) {
    if (isUnderPath(abs, dir)) return true;
    const realDir = realpathOfNearestAncestor(path.resolve(dir));
    if (realDir && isUnderPath(abs, realDir)) return true;
  }
  if (path.basename(abs) === '.apikey-key') return true;
  const parent = path.basename(path.dirname(abs));
  if (parent !== '.moss') return false;
  const base = path.basename(abs);
  // Project credential docs under `.moss/` (same set known-secrets scans).
  return base === 'config.json' || base === 'devices.json';
}

/**
 * User credential store, project `.moss/config.json` / `devices.json`, and `.apikey-key`.
 * Follows symlinks: a path whose realpath / readlink target lands on a
 * credential path is treated as credential (tighten-only, O107).
 */
export function isMossCredentialPath(
  resolved: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  for (const candidate of credentialPathFollowCandidates(resolved)) {
    if (lexicalMossCredentialPath(candidate, env)) return true;
  }
  return false;
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
