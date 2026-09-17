export { sanitizeSecrets, containsSecrets } from './secret-sanitizer.js';
export { redactSecretsInText, MEMORY_SECRET_PATTERNS } from './secret-redact.js';
export {
  isCommandDangerous,
  isPathProtected,
  registerProtectedPaths,
  matchTextApproval,
  classifyFileKind,
  stripShellPrefixBeforeHeredoc,
} from './channel-safety.js';
export type { ChannelSource, ChannelSafetyResult, TextApprovalResult } from './channel-safety.js';

export { resolveSandboxPath, assertSandboxPath } from './sandbox-paths.js';

export {
  SHELL_SOFT_FAILURE_TOOL_NAMES,
  shouldAppendShellContinueHint,
  appendShellContinueHint,
} from './shell-soft-failure-hint.js';
