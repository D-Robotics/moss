/**
 * Registry of declared capabilities.
 *
 * One place answers "what can this session load, how does it activate, and where
 * did it come from". Before this, instruction files, skills, slash commands and
 * file-defined agents each had their own loader and their own naming rules, so a
 * capability's cost and trigger were invisible at the point it was added.
 *
 * The registry is deliberately passive: it holds descriptors and answers
 * queries; loaders stay in their own modules.
 */
import micromatch from 'micromatch';
import type {
  CapabilityDescriptor,
  CapabilityKind,
  CapabilityScope,
} from '../../contracts/capability.js';

export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityDescriptor>();

  register(descriptor: CapabilityDescriptor): void {
    this.entries.set(descriptor.id, descriptor);
  }

  registerAll(descriptors: readonly CapabilityDescriptor[]): void {
    for (const descriptor of descriptors) this.register(descriptor);
  }

  get(id: string): CapabilityDescriptor | undefined {
    return this.entries.get(id);
  }

  list(kind?: CapabilityKind): CapabilityDescriptor[] {
    const all = [...this.entries.values()];
    return kind ? all.filter((entry) => entry.kind === kind) : all;
  }

  /**
   * Capabilities whose globs match at least one touched workspace-relative path.
   * `always`/`manual` entries are not returned: `always` is already part of the
   * stable prefix, `manual` is reachable only by explicit invocation.
   */
  activeForPaths(relativePaths: readonly string[]): CapabilityDescriptor[] {
    if (relativePaths.length === 0) return [];
    return this.list().filter((entry) => {
      const activation = entry.activation;
      if (typeof activation !== 'object') return false;
      return relativePaths.some((file) =>
        micromatch.isMatch(file, activation.globs, { dot: true, nocase: true })
      );
    });
  }

  byScope(scope: CapabilityScope): CapabilityDescriptor[] {
    return this.list().filter((entry) => entry.scope === scope);
  }

  formatReport(): string {
    const entries = this.list();
    if (entries.length === 0) return '';
    return entries
      .map((entry) => {
        const activation =
          typeof entry.activation === 'string'
            ? entry.activation
            : entry.activation.globs.join(',');
        return `  ${entry.kind.padEnd(11)} ${entry.scope.padEnd(9)} ${entry.id.padEnd(28)} ${activation.padEnd(20)} ${entry.costChars ?? 0} chars`;
      })
      .join('\n');
  }
}
