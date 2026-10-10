import { createRequire } from 'node:module';

/**
 * Shared with bin/moss.cjs. The CJS file is the message: an old Node has to
 * print it before this ESM module can load.
 */
interface NodeVersionMessageModule {
  MIN_NODE_MAJOR: number;
  MIN_NODE_MINOR: number;
  nodeVersionProblem(version: string, env?: NodeJS.ProcessEnv): string | null;
}

const nodeVersionMessage = createRequire(import.meta.url)(
  '../../bin/node-version-message.cjs'
) as NodeVersionMessageModule;

export const MIN_NODE_MAJOR = nodeVersionMessage.MIN_NODE_MAJOR;
export const MIN_NODE_MINOR = nodeVersionMessage.MIN_NODE_MINOR;

export function nodeVersionProblem(
  version: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  return nodeVersionMessage.nodeVersionProblem(version, env);
}

export function enforceNodeVersion(): void {
  const problem = nodeVersionProblem(process.version);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}
