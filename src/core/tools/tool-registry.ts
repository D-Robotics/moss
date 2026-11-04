import type { Tool } from './tool-types.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      this.replace(tool);
      return;
    }
    this.tools.set(tool.name, tool);
  }

  /** Explicitly replace a tool while transferring its lifecycle ownership. @beta */
  replace(tool: Tool): void {
    if (this.tools.has(tool.name)) this.remove(tool.name);
    this.tools.set(tool.name, tool);
  }

  remove(toolName: string): boolean {
    return this.tools.delete(toolName);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  getNames(): string[] {
    return [...this.tools.keys()];
  }

  get size(): number {
    return this.tools.size;
  }

  buildToolDeclarations(): Array<{
    name: string;
    description: string;
    input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  }> {
    return this.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
}
