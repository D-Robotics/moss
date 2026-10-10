/**
 * `moss update` prints the upgrade command for this install.
 * It never runs git or npm.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isZhLocale } from './cli-locale.js';

export interface MossPackageMeta {
  name?: string;
  private?: boolean;
  bin?: string | { moss?: string };
  repository?: string | { url?: string };
}

export type MossInstallKind = 'git-clone' | 'npm-global' | 'npm-local' | 'unknown';

export interface MossUpdateAdvice {
  kind: MossInstallKind;
  root: string;
  /** Shell commands to show the user. Never executed. */
  commands: readonly string[];
}

const DEFAULT_CLONE_URL = 'https://github.com/D-Robotics/moss.git';

/** Removes the unscoped package named moss. Leaves `@rdk-moss/agent` in place. */
export const LEGACY_PACKAGE_UNINSTALL = 'npm uninstall -g moss';

/**
 * Upgrade an existing checkout and reinstall the global copy.
 * `npm ci` runs `prepare`, which already builds, so this does not call `npm run build`.
 */
export const UPGRADE_IN_CLONE = 'cd moss && git pull && npm ci && npm install -g --install-links .';

export function shellSingleQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `github:owner/repo` from a package.json repository field, or null. */
export function githubInstallSpec(repository: MossPackageMeta['repository']): string | null {
  const url =
    typeof repository === 'string'
      ? repository
      : repository && typeof repository.url === 'string'
        ? repository.url
        : '';
  const match = url.match(/github\.com[:/]([^/]+)\/([^/#.\s]+)/i);
  if (!match?.[1] || !match[2]) return null;
  return `github:${match[1]}/${match[2]}`;
}

/** `https://github.com/owner/repo.git` from package.json, or the public Moss repo. */
export function gitCloneUrl(repository: MossPackageMeta['repository']): string {
  const spec = githubInstallSpec(repository);
  if (!spec) return DEFAULT_CLONE_URL;
  return `https://github.com/${spec.slice('github:'.length)}.git`;
}

/**
 * First install while the package is private. `npm ci` runs `prepare` (`npm run build`).
 * `npm install -g --install-links .` then copies that build into the prefix.
 * Verified on npm 10.9.2 and 11.21.0.
 */
export function sourceInstallCommands(
  repository?: MossPackageMeta['repository']
): readonly string[] {
  const cloneUrl = gitCloneUrl(repository);
  const repoName =
    cloneUrl
      .split('/')
      .pop()
      ?.replace(/\.git$/, '') || 'moss';
  return [`git clone ${cloneUrl}`, `cd ${repoName}`, 'npm ci', 'npm install -g --install-links .'];
}

/**
 * Registry installs upgrade with `<name>@latest`.
 * While `"private": true`, there is no published spec; use {@link sourceInstallCommands}.
 */
export function npmInstallSpec(pkg: MossPackageMeta): string | null {
  if (pkg.private === true) return null;
  const name = pkg.name?.trim() || '@rdk-moss/agent';
  return `${name}@latest`;
}

/** Same steps as {@link UPGRADE_IN_CLONE}, from a specific checkout directory. */
export function upgradeCommand(repoDir: string): string {
  return `cd ${shellSingleQuote(repoDir)} && git pull && npm ci && npm install -g --install-links .`;
}

export function globalInstallCommands(pkg: MossPackageMeta): readonly string[] {
  const spec = npmInstallSpec(pkg);
  if (!spec) return sourceInstallCommands(pkg.repository);
  return [`npm install -g ${spec}`];
}

export function localInstallCommands(pkg: MossPackageMeta): readonly string[] {
  const spec = npmInstallSpec(pkg);
  if (!spec) return sourceInstallCommands(pkg.repository);
  return [`npm install ${spec}`];
}

function hasMossIdentity(pkg: MossPackageMeta): boolean {
  const bin = pkg.bin;
  const hasMossBin =
    bin === 'dist/cli.js' ||
    (typeof bin === 'object' && bin !== null && typeof bin.moss === 'string');
  return pkg.name === '@rdk-moss/agent' || pkg.name === 'moss' || hasMossBin;
}

function isMossGitCheckout(
  dir: string,
  exists: (target: string) => boolean,
  readPackage: (dir: string) => MossPackageMeta
): boolean {
  return exists(path.join(dir, '.git')) && hasMossIdentity(readPackage(dir));
}

export function adviseMossUpdate(input: {
  packageRoot: string;
  pkg: MossPackageMeta;
  /** Working directory. Used to find an existing checkout when this install has no `.git`. */
  cwd?: string;
  exists?: (target: string) => boolean;
  readPackage?: (dir: string) => MossPackageMeta;
}): MossUpdateAdvice {
  const exists = input.exists ?? fs.existsSync;
  const readPackage = input.readPackage ?? readMossPackage;
  const root = input.packageRoot;
  // This root is already the moss package. A `.git` entry here is the checkout,
  // including when a test double does not re-read package.json.
  if (exists(path.join(root, '.git'))) {
    return { kind: 'git-clone', root, commands: [upgradeCommand(root)] };
  }

  // A published package upgrades with npm. A private global install upgrades
  // the checkout next to the user when one is there, and clones only otherwise.
  if (input.pkg.private === true && input.cwd) {
    for (const dir of [input.cwd, path.join(input.cwd, 'moss')]) {
      if (path.resolve(dir) === path.resolve(root)) continue;
      if (isMossGitCheckout(dir, exists, readPackage)) {
        return { kind: 'git-clone', root: dir, commands: [upgradeCommand(dir)] };
      }
    }
  }

  const parts = root.split(path.sep);
  const nm = parts.lastIndexOf('node_modules');
  if (nm >= 0) {
    const parent = parts.slice(0, nm).join(path.sep) || path.parse(root).root;
    const globalInstall = !exists(path.join(parent, 'package.json'));
    return {
      kind: globalInstall ? 'npm-global' : 'npm-local',
      root,
      commands: globalInstall ? globalInstallCommands(input.pkg) : localInstallCommands(input.pkg),
    };
  }
  return {
    kind: 'unknown',
    root,
    commands: globalInstallCommands(input.pkg),
  };
}

function oldBinConflictNote(zh: boolean): string {
  return zh
    ? [
        '如果 npm 报 moss 这个 bin 已存在（EEXIST），先卸掉旧的未加 scope 的包：',
        '',
        `  ${LEGACY_PACKAGE_UNINSTALL}`,
        '',
        '不要加 --force。--force 会同时留下旧包和新包，之后再执行 npm uninstall -g moss 会把 moss 命令一起删掉。',
      ].join('\n')
    : [
        'If npm reports EEXIST for the moss bin, uninstall the older unscoped package first:',
        '',
        `  ${LEGACY_PACKAGE_UNINSTALL}`,
        '',
        'Do not pass --force. It leaves both packages installed, and a later npm uninstall -g moss removes the moss command.',
      ].join('\n');
}

function finishUpdateAdvice(
  lines: readonly string[],
  commands: readonly string[],
  zh: boolean
): string {
  const tail = zh
    ? 'moss update 只打印命令，不会执行。'
    : 'moss update prints the command and does not run it.';
  const body = [...lines];
  if (commands.some((command) => command.includes('npm install -g'))) {
    body.push('', oldBinConflictNote(zh));
  }
  body.push('', tail);
  return body.join('\n');
}

export function renderUpdateAdvice(advice: MossUpdateAdvice, zh: boolean): string {
  const commandBlock = advice.commands.map((command) => `  ${command}`).join('\n');
  const run = zh ? '升级请运行：' : 'Upgrade by running:';
  if (advice.kind === 'git-clone') {
    const head = zh
      ? `这个 Moss 是 git 克隆（${advice.root}）。`
      : `This Moss is a git clone (${advice.root}).`;
    return finishUpdateAdvice([head, '', run, '', commandBlock], advice.commands, zh);
  }
  if (advice.kind === 'npm-global' || advice.kind === 'npm-local') {
    const head = zh
      ? advice.kind === 'npm-global'
        ? `这个 Moss 是 npm 全局安装（${advice.root}）。`
        : `这个 Moss 装在项目的 node_modules 里（${advice.root}）。`
      : advice.kind === 'npm-global'
        ? `This Moss is an npm global install (${advice.root}).`
        : `This Moss is installed in a project's node_modules (${advice.root}).`;
    const missing = zh
      ? '当前目录下没有 moss 克隆，所以上面从 git clone 开始。'
      : 'No moss clone is in the current directory, so the commands above start with git clone.';
    const lines = advice.commands.some((command) => command.startsWith('git clone '))
      ? [head, '', missing, '', run, '', commandBlock]
      : [head, '', run, '', commandBlock];
    return finishUpdateAdvice(lines, advice.commands, zh);
  }
  const head = zh
    ? `看不出这个 Moss 是 git 克隆还是 npm 安装（${advice.root}）。`
    : `Could not tell whether this Moss is a git clone or an npm install (${advice.root}).`;
  const choose = zh ? '可以选用：' : 'One of these matches the install:';
  return finishUpdateAdvice([head, '', choose, '', commandBlock], advice.commands, zh);
}

export function renderUpdateHelp(zh: boolean, pkg: MossPackageMeta = { private: true }): string {
  const published = pkg.private === false;
  const fresh = published
    ? globalInstallCommands({ ...pkg, private: false })
    : sourceInstallCommands(pkg.repository);
  const examples = [
    '  moss update',
    ...(published ? [] : [`  ${UPGRADE_IN_CLONE}`]),
    ...fresh.map((command) => `  ${command}`),
    `  ${LEGACY_PACKAGE_UNINSTALL}`,
  ];
  if (zh) {
    return [
      '用法：',
      '  moss update',
      '',
      '按安装方式打印升级命令。已有克隆时打印：',
      `  ${UPGRADE_IN_CLONE}`,
      '还没有 moss 目录时才打印 git clone。npm ci 会通过 prepare 构建，',
      '不需要再跑 npm run build。moss update 不会执行这些命令。',
      '',
      '如果 npm 报 EEXIST，不要加 --force。先卸掉旧的未加 scope 的包。',
      '--force 会同时留下两个包，之后再 npm uninstall -g moss 会把 moss 命令删掉。',
      '',
      '选项：',
      '  （无）  不接受其它参数，也不会拉取、安装或构建',
      '',
      '示例：',
      ...examples,
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss update',
    '',
    'Print the upgrade command for this install. An existing clone prints:',
    `  ${UPGRADE_IN_CLONE}`,
    'git clone is printed only when no moss directory exists yet. npm ci builds',
    'through prepare, so there is no separate npm run build. moss update does',
    'not run those commands.',
    '',
    'If npm reports EEXIST, do not pass --force. Uninstall the old unscoped',
    'package first. --force leaves both packages, and a later',
    'npm uninstall -g moss removes the moss command.',
    '',
    'Options:',
    '  (none)  no flags; nothing is pulled, installed, or built',
    '',
    'Examples:',
    ...examples,
  ].join('\n');
}

export function readMossPackage(packageRoot: string): MossPackageMeta {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
    );
    if (typeof parsed === 'object' && parsed !== null) return parsed as MossPackageMeta;
  } catch {
    /* missing or unreadable package.json → empty meta */
  }
  return {};
}

/** Walk up from a compiled module to the moss package root. */
export function findMossPackageRoot(modulePath: string): string {
  let dir = path.dirname(modulePath);
  for (let hop = 0; hop < 8; hop++) {
    const pkg = readMossPackage(dir);
    const bin = pkg.bin;
    const hasMossBin =
      bin === 'dist/cli.js' ||
      (typeof bin === 'object' && bin !== null && typeof bin.moss === 'string');
    if (hasMossBin || pkg.name === '@rdk-moss/agent' || pkg.name === 'moss') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(modulePath), '..', '..');
}

export function runUpdateCommand(locale?: string): void {
  const root = findMossPackageRoot(fileURLToPath(import.meta.url));
  const pkg = readMossPackage(root);
  const advice = adviseMossUpdate({ packageRoot: root, pkg, cwd: process.cwd() });
  process.stdout.write(`${renderUpdateAdvice(advice, isZhLocale(locale))}\n`);
}
