/**
 * D11: restrictive, run-scoped tool scope from a skill's `allowed-tools` /
 * `disallowed-tools`. Loading a skill that declares either narrows which tools
 * the rest of the run can call; it can never widen access or auto-approve
 * anything (approval still runs for every call).
 *
 * Scopes live per runId: a new run starts unrestricted, and a run that ends
 * is cleared by the agent.
 */
export interface SkillToolScope {
  /** Empty means "no positive list"; otherwise only these names are offered. */
  allowed: ReadonlySet<string>;
  disallowed: ReadonlySet<string>;
  skillName: string;
}

const scopes = new Map<string, SkillToolScope>();

function matches(patterns: readonly string[], toolName: string): boolean {
  return patterns.some((pattern) => {
    const trimmed = pattern.trim();
    if (!trimmed) return false;
    if (trimmed === '*') return true;
    if (trimmed.endsWith('*')) return toolName.startsWith(trimmed.slice(0, -1));
    return trimmed === toolName;
  });
}

/**
 * Record a skill's restriction for the run. Returns false when the skill
 * declares no restriction (nothing to apply). Later activations in the same
 * run are intersected, so two skills can only narrow each other.
 */
export function applySkillToolScope(
  runId: string,
  skill: {
    name: string;
    allowedTools?: readonly string[];
    disallowedTools?: readonly string[];
  }
): boolean {
  const declaredAllowed = skill.allowedTools ?? [];
  const declaredDisallowed = skill.disallowedTools ?? [];
  const hasAllowed = declaredAllowed.length > 0;
  const hasDisallowed = declaredDisallowed.length > 0;
  if (!hasAllowed && !hasDisallowed) return false;
  const previous = scopes.get(runId);
  const allowed: Set<string> = new Set(hasAllowed ? skill.allowedTools : (previous?.allowed ?? []));
  if (previous && previous.allowed.size > 0) {
    for (const name of [...allowed]) {
      if (!matches([...previous.allowed], name)) allowed.delete(name);
    }
  }
  const disallowed = new Set([...(previous?.disallowed ?? []), ...declaredDisallowed]);
  scopes.set(runId, { allowed, disallowed, skillName: skill.name });
  // Bounded store: runs are not explicitly torn down here, so evict the oldest
  // scope rather than growing forever in a long-lived TUI session.
  if (scopes.size > 64) {
    const oldest = scopes.keys().next().value;
    if (oldest !== undefined) scopes.delete(oldest);
  }
  return true;
}

/** True when the tool may still be offered for this run. Unknown run = allowed. */
export function skillScopeAllowsTool(runId: string | undefined, toolName: string): boolean {
  if (!runId) return true;
  const scope = scopes.get(runId);
  if (!scope) return true;
  if (scope.allowed.size > 0 && !matches([...scope.allowed], toolName)) return false;
  return !matches([...scope.disallowed], toolName);
}

/** Human-readable restriction for the skill tool result. */
export function describeSkillToolScope(runId: string | undefined): string | undefined {
  if (!runId) return undefined;
  const scope = scopes.get(runId);
  if (!scope) return undefined;
  const parts: string[] = [];
  if (scope.allowed.size > 0) parts.push(`only ${[...scope.allowed].join(', ')}`);
  if (scope.disallowed.size > 0) parts.push(`not ${[...scope.disallowed].join(', ')}`);
  return parts.length > 0
    ? `Tool scope for this run (from skill "${scope.skillName}"): ${parts.join('; ')}.`
    : undefined;
}

export function clearSkillToolScope(runId: string | undefined): void {
  if (runId) scopes.delete(runId);
}
