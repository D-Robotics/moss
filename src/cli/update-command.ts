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

const GITHUB_INSTALL_FALLBACK = 'github:D-Robotics/moss';

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

/**
 * Registry installs upgrade with `<name>@latest`. While `"private": true`,
 * the working one-command install is the GitHub spec.
 */
export function npmInstallSpec(pkg: MossPackageMeta): string {
  if (pkg.private === true) {
    return githubInstallSpec(pkg.repository) ?? GITHUB_INSTALL_FALLBACK;
  }
  const name = pkg.name?.trim() || '@rdk-moss/agent';
  return `${name}@latest`;
}

export function gitUpgradeCommand(root: string): string {
  const quoted = shellSingleQuote(root);
  return `git -C ${quoted} pull && npm --prefix ${quoted} run build`;
}

export function npmUpgradeCommand(pkg: MossPackageMeta, globalInstall: boolean): string {
  const spec = npmInstallSpec(pkg);
  return globalInstall ? `npm install -g ${spec}` : `npm install ${spec}`;
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
      commands: [npmUpgradeCommand(input.pkg, globalInstall)],
    };
  }
  return {
    kind: 'unknown',
    root,
    commands: [gitUpgradeCommand(root), npmUpgradeCommand(input.pkg, true)],
  };
}

export function renderUpdateAdvice(advice: MossUpdateAdvice, zh: boolean): string {
  const commandBlock = advice.commands.map((command) => `  ${command}`).join('\n');
  const tail = zh
    ? 'moss update 只打印命令，不会执行。'
    : 'moss update prints the command and does not run it.';
  const run = zh ? '升级请运行：' : 'Upgrade by running:';
  if (advice.kind === 'git-clone') {
    const head = zh
      ? `这个 Moss 是 git 克隆（${advice.root}）。`
      : `This Moss is a git clone (${advice.root}).`;
    return [head, '', run, '', commandBlock, '', tail].join('\n');
  }
  if (advice.kind === 'npm-global' || advice.kind === 'npm-local') {
    const head = zh
      ? advice.kind === 'npm-global'
        ? `这个 Moss 是 npm 全局安装（${advice.root}）。`
        : `这个 Moss 装在项目的 node_modules 里（${advice.root}）。`
      : advice.kind === 'npm-global'
        ? `This Moss is an npm global install (${advice.root}).`
        : `This Moss is installed in a project's node_modules (${advice.root}).`;
    return [head, '', run, '', commandBlock, '', tail].join('\n');
  }
  const head = zh
    ? `看不出这个 Moss 是 git 克隆还是 npm 安装（${advice.root}）。`
    : `Could not tell whether this Moss is a git clone or an npm install (${advice.root}).`;
  const choose = zh ? '可以选用：' : 'One of these matches the install:';
  return [head, '', choose, '', commandBlock, '', tail].join('\n');
}

export function renderUpdateHelp(zh: boolean, pkg: MossPackageMeta = {}): string {
  const spec = npmInstallSpec({ ...pkg, private: pkg.private ?? true });
  if (zh) {
    return [
      '用法：',
      '  moss update',
      '',
      '按安装方式打印升级命令。git 克隆打印 `git pull` 和重新构建；',
      'npm 全局安装打印 `npm install -g`。moss update 不会执行这条命令。',
      '',
      '选项：',
      '  （无）  不接受其它参数，也不会拉取、安装或构建',
      '',
      '示例：',
      '  moss update',
      `  npm install -g ${spec}`,
      '  git -C <clone> pull && npm --prefix <clone> run build',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss update',
    '',
    'Print the upgrade command for this install. A git clone prints git pull',
    'and a rebuild. An npm global install prints npm install -g.',
    'moss update does not run that command.',
    '',
    'Options:',
    '  (none)  no flags; nothing is pulled, installed, or built',
    '',
    'Examples:',
    '  moss update',
    `  npm install -g ${spec}`,
    '  git -C <clone> pull && npm --prefix <clone> run build',
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
