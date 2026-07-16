import type { Tool } from './tool-types.js';

export type ToolFilter = (tool: Tool) => boolean;

export function filterToolsForRun(tools: Tool[], filter?: ToolFilter): Tool[] {
  return filter ? tools.filter(filter) : tools;
}
