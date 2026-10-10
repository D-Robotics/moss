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
  const install = `nvm install ${need} && nvm use ${need} — ${isZhLocale() ? '或' : 'or'} https://nodejs.org/dist/v${need}/`;
  return isZhLocale()
    ? `Node ${current} 版本过低，Moss 需要 >= ${need}。安装：${install}`
    : `Node ${current} is too old for Moss (need >= ${need}). Install: ${install}`;
}

export function enforceNodeVersion(): void {
  const problem = nodeVersionProblem(process.version);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
