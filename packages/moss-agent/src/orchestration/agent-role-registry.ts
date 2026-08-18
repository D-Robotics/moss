import { ErrorCode, MossError } from '../errors.js';
import type { AgentRoleDefinition } from './agent-role-types.js';

/** Role-registry authorization options owned by one MossAgent instance. @beta */
export interface AgentRoleRegistryOptions {
  readonly allowIsolatedWrite?: boolean;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new MossError({
      code: ErrorCode.USER_INPUT_INVALID,
      message: `${field} must not be empty`,
    });
  }
  return normalized;
}

function snapshotRole(definition: AgentRoleDefinition): Readonly<AgentRoleDefinition> {
  return Object.freeze({
    ...definition,
    id: required(definition.id, 'agent role id'),
    displayName: required(definition.displayName, 'agent role displayName'),
    instructions: required(definition.instructions, 'agent role instructions'),
    capabilities: Object.freeze([...new Set(definition.capabilities)]),
    ...(definition.allowedTools
      ? { allowedTools: Object.freeze([...new Set(definition.allowedTools)]) }
      : {}),
    ...(definition.budget ? { budget: Object.freeze({ ...definition.budget }) } : {}),
  });
}

/** Instance-owned, atomically disposable registry for trusted agent roles. @beta */
export class AgentRoleRegistry {
  private readonly roles = new Map<string, Readonly<AgentRoleDefinition>>();
  private readonly allowIsolatedWrite: boolean;

  constructor(options: AgentRoleRegistryOptions = {}) {
    this.allowIsolatedWrite = options.allowIsolatedWrite === true;
  }

  register(definition: AgentRoleDefinition): () => void {
    const role = snapshotRole(definition);
    if (this.roles.has(role.id)) {
      throw new MossError({
        code: ErrorCode.USER_INPUT_INVALID,
        message: `agent role already registered: ${role.id}`,
      });
    }
    if (role.kind === 'implementer' && role.workspaceMode !== 'isolated-write') {
      throw new MossError({
        code: ErrorCode.USER_INPUT_INVALID,
        message: `implementer role "${role.id}" must use isolated-write`,
      });
    }
    if (
      (role.kind === 'advisor' || role.kind === 'verifier') &&
      role.workspaceMode !== 'shared-readonly'
    ) {
      throw new MossError({
        code: ErrorCode.USER_INPUT_INVALID,
        message: `${role.kind} role "${role.id}" must use shared-readonly`,
      });
    }
    if (role.workspaceMode === 'isolated-write' && !this.allowIsolatedWrite) {
      throw new MossError({
        code: ErrorCode.TOOL_NOT_ALLOWED,
        message: `isolated-write role authorization is required for "${role.id}"`,
      });
    }
    this.roles.set(role.id, role);
    return () => {
      if (this.roles.get(role.id) === role) this.roles.delete(role.id);
    };
  }

  get(id: string): Readonly<AgentRoleDefinition> | undefined {
    return this.roles.get(id);
  }

  list(): readonly Readonly<AgentRoleDefinition>[] {
    return [...this.roles.values()];
  }
}

export function cloneAgentRoleSnapshot(
  definition: AgentRoleDefinition
): Readonly<AgentRoleDefinition> {
  return snapshotRole(definition);
}
