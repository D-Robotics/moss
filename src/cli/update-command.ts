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
export const OLD_MOSS_UNINSTALL_COMMAND = 'npm uninstall -g moss';

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
 * Working global install while the package is private: clone, `npm ci`, `npm run build`,
 * then `npm install -g --install-links .` so the prefix holds its own copy.
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
  return [
    `git clone ${cloneUrl}`,
    `cd ${repoName}`,
    'npm ci',
    'npm run build',
    'npm install -g --install-links .',
  ];
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

export function gitUpgradeCommand(root: string): string {
  const quoted = shellSingleQuote(root);
  return `git -C ${quoted} pull && npm --prefix ${quoted} run build`;
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

export function adviseMossUpdate(input: {
  packageRoot: string;
  pkg: MossPackageMeta;
  exists?: (target: string) => boolean;
}): MossUpdateAdvice {
  const exists = input.exists ?? fs.existsSync;
  const root = input.packageRoot;
  if (exists(path.join(root, '.git'))) {
    return { kind: 'git-clone', root, commands: [gitUpgradeCommand(root)] };
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
    commands: [gitUpgradeCommand(root), ...globalInstallCommands(input.pkg)],
  };
}

function oldBinConflictNote(zh: boolean): string {
  return zh
    ? [
        '如果 npm 报 moss 这个 bin 已存在（EEXIST），先卸掉旧的未加 scope 的包：',
        '',
        `  ${OLD_MOSS_UNINSTALL_COMMAND}`,
      ].join('\n')
    : [
        'If npm reports EEXIST for the moss bin, uninstall the older unscoped package first:',
        '',
        `  ${OLD_MOSS_UNINSTALL_COMMAND}`,
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
  if (commands.some((command) => command.startsWith('npm install -g'))) {
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
    return finishUpdateAdvice([head, '', run, '', commandBlock], advice.commands, zh);
  }
  const head = zh
    ? `看不出这个 Moss 是 git 克隆还是 npm 安装（${advice.root}）。`
    : `Could not tell whether this Moss is a git clone or an npm install (${advice.root}).`;
  const choose = zh ? '可以选用：' : 'One of these matches the install:';
  return finishUpdateAdvice([head, '', choose, '', commandBlock], advice.commands, zh);
}

export function renderUpdateHelp(zh: boolean, pkg: MossPackageMeta = { private: true }): string {
  const globalCommands =
    pkg.private === false
      ? globalInstallCommands({ ...pkg, private: false })
      : sourceInstallCommands(pkg.repository);
  const examples = [
    '  moss update',
    ...globalCommands.map((command) => `  ${command}`),
    `  ${OLD_MOSS_UNINSTALL_COMMAND}`,
    '  git -C <clone> pull && npm --prefix <clone> run build',
  ];
  if (zh) {
    return [
      '用法：',
      '  moss update',
      '',
      '按安装方式打印升级命令。git 克隆打印 git pull 和重新构建；',
      '全局安装打印从源码安装的命令（npm install -g --install-links）。',
      'moss update 不会执行这些命令。',
      '',
      '选项：',
      '  （无）  不接受 flag，也不会拉取、安装或构建',
      '',
      '示例：',
      ...examples,
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss update',
    '',
    'Print the upgrade command for this install. A git clone prints git pull',
    'and a rebuild. A global install prints the source-install commands',
    '(npm install -g --install-links). moss update does not run those commands.',
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
  const advice = adviseMossUpdate({ packageRoot: root, pkg });
  process.stdout.write(`${renderUpdateAdvice(advice, isZhLocale(locale))}\n`);
}
