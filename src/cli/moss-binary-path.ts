/**
 * Which `moss` is on PATH, and which file this process actually is.
 * Stat and realpath only — never spawn another moss. A scan error is an
 * empty result so `moss doctor` still prints.
 */
import path from 'node:path';
import { uiText } from '../utils/ui-language.js';

/** Enough of `node:fs` for the PATH walk. Tests pass a fake. */
export interface MossBinaryPathFs {
  statSync(filePath: string): { isFile(): boolean; mode: number };
  realpathSync(filePath: string): string;
}

export interface MossBinaryHit {
  /** File joined onto a PATH directory, in PATH order. */
  listed: string;
  /** Distinct identity: realpath of `listed`. */
  realPath: string;
}

export interface MossBinaryScan {
  /** First occurrence of each real path, in PATH order. */
  binaries: MossBinaryHit[];
  /** First PATH entry, or null when nothing named moss is executable. */
  winner: MossBinaryHit | null;
  /** True when `winner` resolves to the same file as `runningPath`. */
  winnerIsRunning: boolean;
  /**
   * Set only when more than one distinct real path is on PATH.
   * Names every hit in PATH order, says which one wins, and whether that
   * winner is the process that is running.
   */
  warning: string | null;
}

export interface MossBinaryScanInput {
  pathEnv: string | undefined;
  /** Windows `PATHEXT`. Ignored elsewhere. Unset includes `.exe`, `.cmd`, and `.ps1`. */
  pathExt?: string | undefined;
  platform: NodeJS.Platform;
  fs: MossBinaryPathFs;
  /** realpath of this process's entry (`process.argv[1]`), when known. */
  runningPath?: string;
}

export interface MossRuntimeFacts {
  /** realpath of the running entry, or a localized "unknown". */
  entryPath: string;
  /** Directory of the running package.json, realpath'd when the file exists. */
  packageRoot: string;
  scan: MossBinaryScan;
}

const DEFAULT_WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD;.PS1';

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** One separator in the report. Windows realpath uses `\`; `/` still opens the file. */
export function displayMossPath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function sameFile(platform: NodeJS.Platform, left: string, right: string): boolean {
  const a = displayMossPath(left);
  const b = displayMossPath(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function fileKey(platform: NodeJS.Platform, filePath: string): string {
  const slashed = displayMossPath(filePath);
  return platform === 'win32' ? slashed.toLowerCase() : slashed;
}

function splitPath(pathEnv: string | undefined, platform: NodeJS.Platform): string[] {
  if (!pathEnv) return [];
  const delimiter = platform === 'win32' ? ';' : ':';
  const dirs: string[] = [];
  for (const part of pathEnv.split(delimiter)) {
    const trimmed = part.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed) continue;
    dirs.push(trimmed);
  }
  return dirs;
}

/**
 * Extensions PATHEXT contributes, lowercased, in listed order.
 * An unset variable uses the Windows default plus `.PS1` (moss.ps1).
 * An empty variable contributes none — only the bare `moss` name is probed.
 */
function windowsExtensions(pathExt: string | undefined): string[] {
  const raw = pathExt === undefined ? DEFAULT_WINDOWS_PATHEXT : pathExt;
  const seen = new Set<string>();
  const exts: string[] = [];
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const withDot = (trimmed.startsWith('.') ? trimmed : `.${trimmed}`).toLowerCase();
    if (seen.has(withDot)) continue;
    seen.add(withDot);
    exts.push(withDot);
  }
  return exts;
}

/** Unix: `moss`. Windows: bare `moss`, then `moss` + each PATHEXT extension (`.exe`, `.cmd`, `.ps1`, …). */
function candidateNames(platform: NodeJS.Platform, pathExt: string | undefined): string[] {
  if (platform !== 'win32') return ['moss'];
  const names = ['moss'];
  for (const ext of windowsExtensions(pathExt)) names.push(`moss${ext}`);
  return names;
}

function isExecutable(
  platform: NodeJS.Platform,
  stat: { isFile(): boolean; mode: number }
): boolean {
  if (!stat.isFile()) return false;
  if (platform === 'win32') return true;
  return (stat.mode & 0o111) !== 0;
}

function displayHit(platform: NodeJS.Platform, hit: MossBinaryHit): string {
  const listed = displayMossPath(hit.listed);
  const real = displayMossPath(hit.realPath);
  if (sameFile(platform, listed, real)) return real;
  return `${listed} -> ${real}`;
}

function warningText(
  platform: NodeJS.Platform,
  binaries: MossBinaryHit[],
  runningPath: string | undefined
): string | null {
  if (binaries.length < 2) return null;
  const winner = binaries[0];
  if (!winner) return null;
  const winnerLabel = displayHit(platform, winner);
  const shown = binaries.map((hit) => displayHit(platform, hit));
  const list = shown.join('; ');
  const zhList = shown.join('、');
  const winnerIsRunning =
    runningPath !== undefined &&
    runningPath !== '' &&
    (sameFile(platform, winner.realPath, runningPath) ||
      sameFile(platform, winner.listed, runningPath));
  if (runningPath === undefined || runningPath === '') {
    return uiText(
      `${binaries.length} moss executables on PATH: ${list}. ${winnerLabel} wins (first on PATH).`,
      `PATH 上有 ${binaries.length} 个不同的 moss：${zhList}。先出现的会生效：${winnerLabel}。`
    );
  }
  if (winnerIsRunning) {
    return uiText(
      `${binaries.length} moss executables on PATH: ${list}. ${winnerLabel} wins (first on PATH) and is the one currently running.`,
      `PATH 上有 ${binaries.length} 个不同的 moss：${zhList}。先出现的会生效：${winnerLabel}。它就是当前正在运行的这个。`
    );
  }
  const running = displayMossPath(runningPath);
  return uiText(
    `${binaries.length} moss executables on PATH: ${list}. ${winnerLabel} wins (first on PATH) and is not the one currently running (${running}).`,
    `PATH 上有 ${binaries.length} 个不同的 moss：${zhList}。先出现的会生效：${winnerLabel}。它不是当前正在运行的（${running}）。`
  );
}

function emptyScan(): MossBinaryScan {
  return { binaries: [], winner: null, winnerIsRunning: false, warning: null };
}

/**
 * Every executable `moss` on PATH. Symlinks that share a realpath count once
 * (the earlier PATH entry). Does not spawn. Returns an empty scan if the
 * walk itself throws.
 */
export function scanMossBinariesOnPath(input: MossBinaryScanInput): MossBinaryScan {
  try {
    const platform = input.platform;
    const api = pathApi(platform);
    const names = candidateNames(platform, input.pathExt);
    const binaries: MossBinaryHit[] = [];
    const seen = new Set<string>();
    for (const dir of splitPath(input.pathEnv, platform)) {
      for (const name of names) {
        const listed = api.join(dir, name);
        let stat: { isFile(): boolean; mode: number };
        try {
          stat = input.fs.statSync(listed);
        } catch {
          continue;
        }
        if (!isExecutable(platform, stat)) continue;
        let realPath: string;
        try {
          realPath = input.fs.realpathSync(listed);
        } catch {
          realPath = api.resolve(listed);
        }
        const key = fileKey(platform, realPath);
        if (seen.has(key)) continue;
        seen.add(key);
        binaries.push({ listed, realPath });
      }
    }
    const winner = binaries[0] ?? null;
    const running = input.runningPath;
    const winnerIsRunning =
      winner !== null &&
      running !== undefined &&
      running !== '' &&
      (sameFile(platform, winner.realPath, running) || sameFile(platform, winner.listed, running));
    return {
      binaries,
      winner,
      winnerIsRunning,
      warning: warningText(platform, binaries, running),
    };
  } catch {
    return emptyScan();
  }
}

function resolveEntry(
  argv1: string | undefined,
  fs: MossBinaryPathFs,
  platform: NodeJS.Platform
): string {
  if (!argv1 || !argv1.trim()) return uiText('unknown', '未知');
  const api = pathApi(platform);
  try {
    return fs.realpathSync(argv1);
  } catch {
    try {
      return api.resolve(argv1);
    } catch {
      return argv1;
    }
  }
}

function resolvePackageRoot(
  packageJsonPath: string,
  fs: MossBinaryPathFs,
  platform: NodeJS.Platform
): string {
  const api = pathApi(platform);
  try {
    return api.dirname(fs.realpathSync(packageJsonPath));
  } catch {
    try {
      return fs.realpathSync(api.dirname(packageJsonPath));
    } catch {
      return api.dirname(packageJsonPath);
    }
  }
}

/** Entry path, package root, and the PATH scan. Never throws. */
export function collectMossRuntimeFacts(input: {
  pathEnv: string | undefined;
  pathExt?: string | undefined;
  platform: NodeJS.Platform;
  fs: MossBinaryPathFs;
  argv1: string | undefined;
  packageJsonPath: string;
}): MossRuntimeFacts {
  try {
    const entryPath = resolveEntry(input.argv1, input.fs, input.platform);
    const packageRoot = resolvePackageRoot(input.packageJsonPath, input.fs, input.platform);
    const scan = scanMossBinariesOnPath({
      pathEnv: input.pathEnv,
      pathExt: input.pathExt,
      platform: input.platform,
      fs: input.fs,
      runningPath: entryPath,
    });
    return { entryPath, packageRoot, scan };
  } catch {
    return {
      entryPath: uiText('unknown', '未知'),
      packageRoot: uiText('unknown', '未知'),
      scan: emptyScan(),
    };
  }
}
