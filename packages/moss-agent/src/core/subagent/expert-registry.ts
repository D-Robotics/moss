import type { SpawnToolScope } from './spawn-profile.js';

const EXPERT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A declarative, host-trusted sub-agent expert profile. @beta */
export interface SubagentExpertDefinition {
  /** Stable kebab-case identifier selected by delegation tools. */
  readonly id: string;
  /** Human-readable label for host interfaces. */
  readonly displayName: string;
  /** Short capability summary used when presenting the expert catalog. */
  readonly description: string;
  /** Trusted role instructions appended to inherited system policy. */
  readonly instructions: string;
  /** Experts are restricted to a non-mutating spawn scope. */
  readonly scope: Extract<SpawnToolScope, 'read-only' | 'device-read'>;
  /** Optional exact allowlist, intersected with scope and side-effect metadata. */
  readonly allowedTools?: readonly string[];
  /** Optional host-routable model id. */
  readonly model?: string;
  /** Optional positive turn ceiling. */
  readonly maxTurns?: number;
  /** Optional timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/** Plugin-style contributor of declarative sub-agent experts. @beta */
export interface SubagentExpertContributor {
  /** Stable contributor identity for host diagnostics. */
  readonly id: string;
  /** Return declarative experts without mutating global state. */
  contributeExperts(): readonly SubagentExpertDefinition[];
}

function validateExpert(definition: SubagentExpertDefinition): void {
  if (!EXPERT_ID_PATTERN.test(definition.id)) {
    throw new Error(`expert id must be kebab-case: ${definition.id}`);
  }
  if (!definition.displayName.trim() || !definition.description.trim()) {
    throw new Error(`expert ${definition.id} must have a display name and description`);
  }
  if (!definition.instructions.trim()) {
    throw new Error(`expert ${definition.id} must have non-empty instructions`);
  }
  if (definition.scope !== 'read-only' && definition.scope !== 'device-read') {
    throw new Error(`expert ${definition.id} must use a read-only scope`);
  }
  if (
    definition.maxTurns !== undefined &&
    (!Number.isInteger(definition.maxTurns) || definition.maxTurns < 1)
  ) {
    throw new Error(`expert ${definition.id} maxTurns must be a positive integer`);
  }
  if (
    definition.timeoutMs !== undefined &&
    (!Number.isFinite(definition.timeoutMs) || definition.timeoutMs < 100)
  ) {
    throw new Error(`expert ${definition.id} timeoutMs must be at least 100`);
  }
}

function freezeExpert(definition: SubagentExpertDefinition): SubagentExpertDefinition {
  validateExpert(definition);
  return Object.freeze({
    ...definition,
    id: definition.id.trim(),
    displayName: definition.displayName.trim(),
    description: definition.description.trim(),
    instructions: definition.instructions.trim(),
    ...(definition.allowedTools
      ? { allowedTools: Object.freeze([...new Set(definition.allowedTools)]) }
      : {}),
  });
}

/** Per-agent registry for user- or plugin-contributed sub-agent experts. @beta */
export class SubagentExpertRegistry {
  private readonly experts = new Map<string, SubagentExpertDefinition>();

  constructor(definitions: readonly SubagentExpertDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  /** Register one definition; duplicate ids fail closed. Returns an idempotent disposer. */
  register(definition: SubagentExpertDefinition): () => void {
    const expert = freezeExpert(definition);
    if (this.experts.has(expert.id)) throw new Error(`expert already registered: ${expert.id}`);
    this.experts.set(expert.id, expert);
    return () => {
      if (this.experts.get(expert.id) === expert) this.experts.delete(expert.id);
    };
  }

  /** Atomically register a contributor and return an idempotent disposer for its experts. */
  registerContributor(contributor: SubagentExpertContributor): () => void {
    const contributorId = contributor.id.trim();
    if (!contributorId) throw new Error('sub-agent expert contributor requires a non-empty id');

    const pending = contributor.contributeExperts().map(freezeExpert);
    const pendingIds = new Set<string>();
    for (const expert of pending) {
      if (pendingIds.has(expert.id)) {
        throw new Error(`expert contributor ${contributorId} contains duplicate id: ${expert.id}`);
      }
      if (this.experts.has(expert.id)) {
        throw new Error(`expert contributor ${contributorId} conflicts with: ${expert.id}`);
      }
      pendingIds.add(expert.id);
    }

    for (const expert of pending) this.experts.set(expert.id, expert);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      for (const expert of pending) {
        if (this.experts.get(expert.id) === expert) this.experts.delete(expert.id);
      }
    };
  }

  /** Resolve an expert by stable id. */
  get(id: string): SubagentExpertDefinition | undefined {
    return this.experts.get(id);
  }

  /** Return an immutable snapshot of registered definitions. */
  list(): readonly SubagentExpertDefinition[] {
    return Object.freeze([...this.experts.values()]);
  }
}

/** Build an instance registry and atomically install capability-pack experts. @internal */
export function resolveSubagentExpertRegistry(
  options: {
    subagentExpertRegistry?: SubagentExpertRegistry;
    subagentExperts?: readonly SubagentExpertDefinition[];
  },
  contributions: { subagentExperts: readonly SubagentExpertDefinition[] }
): { registry: SubagentExpertRegistry; disposePackExperts: () => void } {
  const resolved =
    options.subagentExpertRegistry ?? new SubagentExpertRegistry(options.subagentExperts);
  let disposePackExperts = () => {};
  if (contributions.subagentExperts.length > 0) {
    disposePackExperts = resolved.registerContributor({
      id: 'capability-packs',
      contributeExperts: () => contributions.subagentExperts,
    });
  }
  return { registry: resolved, disposePackExperts };
}

/** Render only catalog-safe expert fields for the lead agent. @internal */
export function buildSubagentExpertCatalog(
  definitions: readonly SubagentExpertDefinition[]
): string | undefined {
  if (definitions.length === 0) return undefined;
  return [
    '## Available sub-agent experts',
    'Select one by its `expert` id in `create_subagent` or `fan_out_subagents`.',
    ...definitions.map(
      (expert) =>
        `- ${expert.id} (${expert.scope}) — ${expert.displayName}: ${expert.description.replace(/\s+/g, ' ')}`
    ),
  ].join('\n');
}
