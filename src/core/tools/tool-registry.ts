import type { Tool } from './tool-types.js';
import { installToolOutputDeclarations } from './tool-output-declarations.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      this.replace(tool);
      return;
    }
    this.tools.set(tool.name, tool);
    // A tool registered after startup (MCP, skills, host extensions) must still
    // install its own output budget; otherwise it silently runs on the 4k default.
    installToolOutputDeclarations([tool]);
  }

  /** Explicitly replace a tool while transferring its lifecycle ownership. @beta */
  replace(tool: Tool): void {
    if (this.tools.has(tool.name)) this.remove(tool.name);
    this.tools.set(tool.name, tool);
    installToolOutputDeclarations([tool]);
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
