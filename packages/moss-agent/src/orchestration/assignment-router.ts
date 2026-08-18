import { ErrorCode, MossError } from '../errors.js';
import { cloneAgentRoleSnapshot, type AgentRoleRegistry } from './agent-role-registry.js';
import type { AgentRoleDefinition, AssignmentSpec, RoutedAssignment } from './agent-role-types.js';

function satisfies(role: AgentRoleDefinition, assignment: AssignmentSpec): boolean {
  return (
    role.kind === assignment.requiredRoleKind &&
    assignment.requiredCapabilities.every((capability) => role.capabilities.includes(capability)) &&
    (assignment.writePaths.length === 0 || role.workspaceMode === 'isolated-write')
  );
}

/** Capability- and permission-constrained assignment router. @beta */
export class AssignmentRouter {
  constructor(private readonly registry: AgentRoleRegistry) {}

  route(assignment: AssignmentSpec, preferredRoleId?: string): RoutedAssignment {
    if (preferredRoleId) {
      const preferred = this.registry.get(preferredRoleId);
      if (!preferred || !satisfies(preferred, assignment)) {
        throw new MossError({
          code: ErrorCode.TOOL_NOT_ALLOWED,
          message: `preferred role "${preferredRoleId}" does not satisfy assignment "${assignment.id}"`,
        });
      }
      return { assignment, role: cloneAgentRoleSnapshot(preferred) };
    }
    const candidates = this.registry
      .list()
      .filter((role) => satisfies(role, assignment))
      .sort((left, right) => {
        const leftExtra = left.capabilities.length - assignment.requiredCapabilities.length;
        const rightExtra = right.capabilities.length - assignment.requiredCapabilities.length;
        return leftExtra - rightExtra || left.id.localeCompare(right.id);
      });
    const role = candidates[0];
    if (!role) {
      throw new MossError({
        code: ErrorCode.TOOL_NOT_ALLOWED,
        message: `no authorized agent role satisfies assignment "${assignment.id}"`,
      });
    }
    return { assignment, role: cloneAgentRoleSnapshot(role) };
  }
}
