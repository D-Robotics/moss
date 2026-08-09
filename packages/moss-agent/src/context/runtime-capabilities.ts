import type { Tool } from '../core/tools/tool-types.js';

export interface RuntimeCapabilityTool {
  name: string;
}

export interface RuntimeCapabilitiesPromptOptions {
  tools: readonly RuntimeCapabilityTool[] | readonly Tool[];
  mcpEnabled?: boolean;
  mcpServerNames?: readonly string[];
  /**
   * Unused after de-duplication — kept on the options type for source
   * compatibility. The tool list is no longer rendered into the prompt
   * (tool names already appear in the tool definitions sent to the model).
   * @deprecated Tool names are already sent to the model in tool definitions.
   */
  maxToolNames?: number;
}

export function isCodeGraphToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return (
    name.startsWith('codegraph_') ||
    name.startsWith('codegraph__') ||
    name.includes('__codegraph_') ||
    name.includes('__codegraph__')
  );
}

function uniqueSortedToolNames(tools: RuntimeCapabilitiesPromptOptions['tools']): string[] {
  return [...new Set(tools.map((tool) => tool.name).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

const CODE_FALLBACK_TOOL_NAMES = ['search_code', 'search_files', 'list_directory', 'read_file'];

function formatCodeNavigationFallback(toolNames: readonly string[]): string {
  const fallbackToolNames = CODE_FALLBACK_TOOL_NAMES.filter((toolName) =>
    toolNames.includes(toolName)
  );
  if (fallbackToolNames.length > 0) {
    return `- Do not claim CodeGraph evidence for this run. For code navigation, fall back to available tools such as ${fallbackToolNames.join(', ')}.`;
  }
  return '- Do not claim CodeGraph evidence for this run. For code navigation, use only the listed non-CodeGraph tools available in this run.';
}

/**
 * Build the runtime-capabilities layer of the system prompt. This deliberately
 * does NOT list every registered tool name — the model already receives the
 * full tool definitions (name + description + schema) as part of the request,
 * so echoing the names here would be pure duplication that bloats the prompt
 * without adding information. We surface only what the tool definitions
 * cannot tell the model: the MCP connection state, whether CodeGraph tools are
 * available (and the fallback discipline when they are not), and the
 * non-negotiable "do not invent tool names" contract.
 */
export function buildRuntimeCapabilitiesPrompt(options: RuntimeCapabilitiesPromptOptions): string {
  const toolNames = uniqueSortedToolNames(options.tools);
  const codeGraphToolNames = toolNames.filter(isCodeGraphToolName);
  const mcpServerNames = [...new Set(options.mcpServerNames ?? [])].sort((a, b) =>
    a.localeCompare(b)
  );
  const codeGraphAvailable = codeGraphToolNames.length > 0;
  const codeGraphStatus = codeGraphAvailable
    ? `available via ${codeGraphToolNames.join(', ')}`
    : 'unavailable';
  const mcpStatus = options.mcpEnabled
    ? mcpServerNames.length > 0
      ? `enabled; connected servers: ${mcpServerNames.join(', ')}`
      : 'enabled; no servers connected or no tools registered'
    : 'disabled';

  return [
    '## Runtime Capabilities',
    '',
    '- Use only the tools that are actually registered for this run (visible in the tool definitions). Do not invent tool names; if a desired capability is not available, say it is unavailable and use the closest registered fallback.',
    `- MCP: ${mcpStatus}.`,
    `- CodeGraph: ${codeGraphStatus}.`,
    codeGraphAvailable
      ? '- For structural code questions, prefer the registered CodeGraph tools before literal text search.'
      : formatCodeNavigationFallback(toolNames),
  ].join('\n');
}
