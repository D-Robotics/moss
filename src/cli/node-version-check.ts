export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 16;

export function nodeVersionProblem(version: string): string | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > MIN_NODE_MAJOR) return null;
  if (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR) return null;
  return [
    `Moss needs Node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}, but this is Node ${version.replace(/^v/, '')}.`,
    'Upgrade Node (https://nodejs.org or `nvm install 22`), then run moss again.',
    '(This is also why `npm install` printed EBADENGINE warnings.)',
  ].join('\n');
}

export function enforceNodeVersion(): void {
  const problem = nodeVersionProblem(process.version);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
