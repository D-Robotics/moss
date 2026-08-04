import { posix as pathPosix } from 'node:path';

/** Paths that must never be exposed through verifier-initiated device reads. */
export const DEVICE_READ_SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /^\/etc\/(?:passwd|shadow|sudoers)(?:\/|$)/,
  /^\/etc\/ssh(?:\/|$)/,
  /^\/root(?:\/|$)/,
  /^\/proc(?:\/|$)/,
  /^\/sys\/firmware(?:\/|$)/,
  /^\/dev\/(?:sd|hd)/,
  /^\/home\/[^/]+\/\.ssh(?:\/|$)/,
];

const ABSOLUTE_PATH_RE = /\/[^\s'";|><&]+/g;
const PREDICATE_TELEMETRY_PATH_PREFIXES = ['/sys/'] as const;

export function extractAbsoluteDeviceReadPaths(command: string): string[] {
  return command.match(ABSOLUTE_PATH_RE) ?? [];
}

export function hasParentPathTraversal(value: string): boolean {
  return /(?:^|[/\s'"])\.\.(?:[/\s'"]|$)/.test(value);
}

export function isSensitiveDeviceReadPath(path: string): boolean {
  const normalizedPath = pathPosix.normalize(path);
  return DEVICE_READ_SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

export function isBlockedDeviceReadPath(path: string): boolean {
  return hasParentPathTraversal(path) || isSensitiveDeviceReadPath(path);
}

export function commandContainsBlockedDeviceReadPath(command: string): boolean {
  return (
    hasParentPathTraversal(command) ||
    extractAbsoluteDeviceReadPaths(command).some(isSensitiveDeviceReadPath)
  );
}

export function isAllowedPredicateTelemetryPath(path: string): boolean {
  if (isBlockedDeviceReadPath(path)) return false;
  const normalizedPath = pathPosix.normalize(path);
  return PREDICATE_TELEMETRY_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix));
}
