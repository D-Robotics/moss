/**
 * D11 run-scoped skill policy: a skill can change *how the run continues*, not
 * only what text the model reads.
 *
 * The skill tool executes inside the tool pipeline, which has no handle on the
 * agent's model configuration. Rather than mutating agent config (which would
 * leak past the run and race with `/model`), the tool records a policy keyed by
 * run id and the agent loop consults it when it builds the next request. The
 * policy is inert once the run ends; the map is bounded so a long REPL session
 * cannot grow it without limit.
 */

export type SkillEffort = 'low' | 'medium' | 'high';

export interface SkillRunPolicy {
  /** Model id for the remaining calls of this run. */
  model?: string;
  /** Reasoning level for the remaining calls of this run. */
  effort?: SkillEffort;
}

const MAX_TRACKED_RUNS = 256;
const policies = new Map<string, SkillRunPolicy>();

/** Record (or merge) the policy a loaded skill asks for. Empty policy is a no-op. */
export function setSkillRunPolicy(runId: string, policy: SkillRunPolicy): void {
  const next: SkillRunPolicy = { ...policies.get(runId), ...compact(policy) };
  if (next.model === undefined && next.effort === undefined) return;
  policies.delete(runId);
  policies.set(runId, next);
  while (policies.size > MAX_TRACKED_RUNS) {
    const oldest = policies.keys().next();
    if (oldest.done) break;
    policies.delete(oldest.value);
  }
}

export function getSkillRunPolicy(runId: string): SkillRunPolicy | undefined {
  return policies.get(runId);
}

/** Test/CLI hook: forget everything (a new run id is cheap, but probes reset). */
export function clearSkillRunPolicies(): void {
  policies.clear();
}

/** One line telling the model the run now continues under a different policy. */
export function describeSkillRunPolicy(policy: SkillRunPolicy): string {
  const parts: string[] = [];
  if (policy.model) parts.push(`model ${policy.model}`);
  if (policy.effort) parts.push(`effort ${policy.effort}`);
  return `Skill policy active for the rest of this run: ${parts.join(', ')}.`;
}

function compact(policy: SkillRunPolicy): SkillRunPolicy {
  const model = policy.model?.trim();
  const effort = policy.effort;
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}
