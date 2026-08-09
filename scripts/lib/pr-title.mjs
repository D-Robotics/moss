export const PR_TITLE_TYPES = new Set([
  'feat',
  'fix',
  'docs',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
  'security',
]);

export const PR_TITLE_SCOPES = new Set([
  'core',
  'agent',
  'cli',
  'provider',
  'tools',
  'context',
  'memory',
  'skills',
  'teaching',
  'mesh',
  'mcp',
  'observability',
  'create-moss-app',
  'docs',
  'ci',
  'deps',
  'release',
]);

export function validatePrTitle(title) {
  const value = String(title ?? '').trim();
  if (!value) return ['PR title is empty'];
  if (value.length > 120) return ['PR title must be 120 characters or fewer'];

  const match = /^([a-z]+)(?:\(([a-z0-9-]+)\))?(!)?: (\S.*)$/.exec(value);
  if (!match) {
    return ['expected Conventional Commit form: type(scope): concise imperative summary'];
  }

  const [, type, scope, , summary] = match;
  const findings = [];
  if (!PR_TITLE_TYPES.has(type)) {
    findings.push(`unsupported type "${type}"; allowed: ${[...PR_TITLE_TYPES].join(', ')}`);
  }
  if (scope && !PR_TITLE_SCOPES.has(scope)) {
    findings.push(`unsupported scope "${scope}"; allowed: ${[...PR_TITLE_SCOPES].join(', ')}`);
  }
  if (summary.endsWith('.')) findings.push('summary must not end with a period');
  return findings;
}
