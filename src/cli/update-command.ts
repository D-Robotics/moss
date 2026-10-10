/**
 * `moss update` prints the upgrade command for this install.
 * It never runs git or npm.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isZhLocale } from './cli-locale.js';
import { ExitCode } from './exit-codes.js';

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
  /** `--dir` / `MOSS_SOURCE_DIR` was set and is not a moss git checkout. */
  missingSource?: boolean;
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

export type UpdateArgError = 'dir-missing' | 'unknown';

/** `--dir <clone>` / `--dir=<clone>`. Anything else is a usage error. */
export function parseUpdateArgs(args: readonly string[]): {
  dir?: string;
  error?: { code: UpdateArgError; token?: string };
} {
  let dir: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--dir') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) return { error: { code: 'dir-missing' } };
      dir = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--dir=')) {
      const value = arg.slice('--dir='.length);
      if (!value) return { error: { code: 'dir-missing' } };
      dir = value;
      continue;
    }
    return { error: { code: 'unknown', token: arg } };
  }
  return dir ? { dir } : {};
}

export function adviseMossUpdate(input: {
  packageRoot: string;
  pkg: MossPackageMeta;
  /** Working directory. Used to find an existing checkout when this install has no `.git`. */
  cwd?: string;
  /** `--dir` or `MOSS_SOURCE_DIR`. Wins over cwd and `./moss`. */
  sourceDir?: string;
  exists?: (target: string) => boolean;
  readPackage?: (dir: string) => MossPackageMeta;
}): MossUpdateAdvice {
  const exists = input.exists ?? fs.existsSync;
  const readPackage = input.readPackage ?? readMossPackage;
  const root = input.packageRoot;
  const requested = input.sourceDir?.trim();
  if (requested) {
    const dir = path.resolve(requested);
    if (isMossGitCheckout(dir, exists, readPackage)) {
      return { kind: 'git-clone', root: dir, commands: [upgradeCommand(dir)] };
    }
    return { kind: 'unknown', root: dir, commands: [], missingSource: true };
  }
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
        '旧的未加 scope 的安装（包括 npm link）也会 EEXIST，即使这时 moss --version 看起来已经是新的。',
        '不要加 --force。--force 会同时留下旧包和新包，之后再执行 npm uninstall -g moss 会把 moss 命令一起删掉。',
      ].join('\n')
    : [
        'If npm reports EEXIST for the moss bin, uninstall the older unscoped package first:',
        '',
        `  ${LEGACY_PACKAGE_UNINSTALL}`,
        '',
        'An old unscoped install, including `npm link`, hits the same EEXIST even when moss --version already looks new.',
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
  if (advice.missingSource) {
    const head = zh
      ? `这里不是 moss 的 git 克隆：${advice.root}`
      : `Not a moss git checkout: ${advice.root}`;
    return finishUpdateAdvice([head], advice.commands, zh);
  }
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
    '  moss update --dir <clone>',
    ...(published ? [] : [`  ${UPGRADE_IN_CLONE}`]),
    ...fresh.map((command) => `  ${command}`),
    `  ${LEGACY_PACKAGE_UNINSTALL}`,
  ];
  if (zh) {
    return [
      '用法：',
      '  moss update [--dir <克隆>]',
      '',
      '按安装方式打印升级命令。已有克隆时打印：',
      `  ${UPGRADE_IN_CLONE}`,
      '还没有 moss 目录时才打印 git clone。npm ci 会通过 prepare 构建，',
      '不需要再跑 npm run build。moss update 不会执行这些命令。',
      '',
      '全局安装只在当前目录和 ./moss 里找克隆。--dir <克隆> 或 MOSS_SOURCE_DIR',
      '可以指定别的目录。--dir 优先于 MOSS_SOURCE_DIR。这个 moss 自己就是',
      'git 克隆、且没有设置这两项时，用它所在的目录。',
      '',
      '如果 moss 命令来自旧的未加 scope 的包（包括 npm link），先执行',
      'npm uninstall -g moss。否则会 EEXIST，即使 moss --version 看起来已经是新的。',
      '不要加 --force。--force 会同时留下两个包，之后再 npm uninstall -g moss',
      '会把 moss 命令删掉。',
      '',
      '选项：',
      '  --dir <克隆>  要升级的检出目录（覆盖 MOSS_SOURCE_DIR）',
      '',
      '示例：',
      ...examples,
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss update [--dir <clone>]',
    '',
    'Print the upgrade command for this install. An existing clone prints:',
    `  ${UPGRADE_IN_CLONE}`,
    'git clone is printed only when no checkout is found. npm ci builds',
    'through prepare, so there is no separate npm run build. moss update does',
    'not run those commands.',
    '',
    'A global install only looks for a checkout in the current directory or in',
    './moss. --dir <clone> or MOSS_SOURCE_DIR selects a checkout elsewhere.',
    '--dir wins. If this copy of moss is itself a git checkout, that directory',
    'is used when neither is set.',
    '',
    'If the moss command comes from an older unscoped package, including',
    'npm link, run npm uninstall -g moss first. Otherwise npm reports EEXIST',
    'even when moss --version already looks new. Do not pass --force.',
    '--force leaves both packages, and a later npm uninstall -g moss removes',
    'the moss command.',
    '',
    'Options:',
    '  --dir <clone>  checkout to upgrade (overrides MOSS_SOURCE_DIR)',
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

function updateArgMessage(error: { code: UpdateArgError; token?: string }, zh: boolean): string {
  if (error.code === 'dir-missing') return zh ? '--dir 需要一个路径' : '--dir requires a path';
  const token = error.token ?? '';
  return zh ? `未知参数：${token}` : `unknown argument: ${token}`;
}

export function runUpdateCommand(
  locale?: string,
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env
): void {
  const zh = isZhLocale(locale);
  const parsed = parseUpdateArgs(args);
  if (parsed.error) {
    process.stderr.write(`${updateArgMessage(parsed.error, zh)}\n`);
    process.exitCode = ExitCode.USAGE;
    return;
  }
  const fromEnv = typeof env.MOSS_SOURCE_DIR === 'string' ? env.MOSS_SOURCE_DIR.trim() : '';
  const sourceDir = parsed.dir ?? (fromEnv || undefined);
  const root = findMossPackageRoot(fileURLToPath(import.meta.url));
  const pkg = readMossPackage(root);
  const advice = adviseMossUpdate({
    packageRoot: root,
    pkg,
    cwd: process.cwd(),
    ...(sourceDir ? { sourceDir } : {}),
  });
  process.stdout.write(`${renderUpdateAdvice(advice, zh)}\n`);
  if (advice.missingSource) process.exitCode = ExitCode.USAGE;
}
