import { isZhLocale } from './cli-locale.js';

export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 16;

export function nodeVersionProblem(version: string): string | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > MIN_NODE_MAJOR) return null;
  if (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR) return null;
  const current = version.replace(/^v/, '');
  const need = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`;
  const commands = [
    '  nvm install 22',
    '  # NodeSource (Debian/Ubuntu):',
    '  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -',
    '  sudo apt-get install -y nodejs',
    '  # China mirror (npmmirror):',
    '  NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node nvm install 22',
  ].join('\n');
  const lead = isZhLocale()
    ? `Node ${current} 版本过低，Moss 需要 >= ${need}。全屏 TUI 依赖 ink（Node >= 22）。本构建在 Node >= ${need} 上验证。升级 Node 后再运行 moss：`
    : `Moss needs Node >= ${need}, but this is Node ${current}. The full-screen TUI depends on ink, which requires Node >= 22. This build is verified on Node >= ${need}. Upgrade Node, then run moss again:`;
  return `${lead}\n${commands}`;
}

export function enforceNodeVersion(): void {
  const problem = nodeVersionProblem(process.version);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
