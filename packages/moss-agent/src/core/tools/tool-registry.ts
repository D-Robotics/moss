










import type { Tool } from './tool-types.js';

export interface ToolGroup {
  id: string;
  displayName: string;
  tools: Tool[];
}

export interface ToolRegistryOptions {
  onToolRegistered?: (tool: Tool, groupId?: string) => void;
  onToolRemoved?: (toolName: string, groupId?: string) => void;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private groups = new Map<string, ToolGroup>();
  private toolToGroup = new Map<string, string>();
  private opts: ToolRegistryOptions;

  constructor(opts?: ToolRegistryOptions) {
    this.opts = opts ?? {};
  }

  
  register(tool: Tool, groupId?: string): void {
    this.tools.set(tool.name, tool);
    if (groupId) {
      this.toolToGroup.set(tool.name, groupId);
      const group = this.groups.get(groupId);
      if (group) {
        const idx = group.tools.findIndex((t) => t.name === tool.name);
        if (idx === -1) group.tools.push(tool);
        else group.tools[idx] = tool;
      }
    }
    this.opts.onToolRegistered?.(tool, groupId);
  }

  
  registerGroup(group: ToolGroup): void {
    this.groups.set(group.id, { ...group, tools: [...group.tools] });
    for (const tool of group.tools) {
      this.tools.set(tool.name, tool);
      this.toolToGroup.set(tool.name, group.id);
      this.opts.onToolRegistered?.(tool, group.id);
    }
  }

  
  remove(toolName: string): boolean {
    const existed = this.tools.delete(toolName);
    const groupId = this.toolToGroup.get(toolName);
    if (groupId) {
      const group = this.groups.get(groupId);
      if (group) {
        group.tools = group.tools.filter((t) => t.name !== toolName);
      }
      this.toolToGroup.delete(toolName);
    }
    if (existed) {
      this.opts.onToolRemoved?.(toolName, groupId);
    }
    return existed;
  }

  
  removeGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    for (const tool of group.tools) {
      this.tools.delete(tool.name);
      this.toolToGroup.delete(tool.name);
      this.opts.onToolRemoved?.(tool.name, groupId);
    }
    this.groups.delete(groupId);
  }

  
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  
  has(name: string): boolean {
    return this.tools.has(name);
  }

  
  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  
  getNames(): string[] {
    return [...this.tools.keys()];
  }

  
  getGroups(): ToolGroup[] {
    return [...this.groups.values()];
  }

  
  getGroupForTool(toolName: string): string | undefined {
    return this.toolToGroup.get(toolName);
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
