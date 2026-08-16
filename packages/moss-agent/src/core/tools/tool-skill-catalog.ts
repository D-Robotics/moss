import type { SkillRegistry } from '../../skills/registry.js';
import type { ToolContext } from './tool-types.js';

const skillRegistryKey: unique symbol = Symbol('moss.tool-skill-registry');
type ContextWithSkillRegistry = ToolContext & { [skillRegistryKey]?: SkillRegistry };

/** Attach an instance catalog without expanding the public ToolContext contract. @internal */
export function attachToolSkillRegistry(context: ToolContext, registry: SkillRegistry): void {
  Object.defineProperty(context, skillRegistryKey, {
    value: registry,
    configurable: false,
    // Tool execution derives attempt contexts with object spread; enumerable
    // symbol ownership follows those same-instance clones without entering JSON.
    enumerable: true,
    writable: false,
  });
}

/** Read the instance catalog installed by the owning MossAgent. @internal */
export function getToolSkillRegistry(context: ToolContext): SkillRegistry | undefined {
  return (context as ContextWithSkillRegistry)[skillRegistryKey];
}
