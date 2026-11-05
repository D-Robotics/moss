/**
 * D4 parity: `@server:uri` mentions attach an MCP resource to the turn, the
 * way Claude Code turns `@server:protocol://path` into content before the model
 * runs. This is a prompt-level mechanism, not a tool call: the model gets the
 * text on its first turn and never has to guess which server to ask.
 *
 * The mention stays in the user's text (people can see what they referenced);
 * the resource body rides along as extra context, truncated to a per-resource
 * and total budget so one huge resource cannot crowd out the conversation.
 */

/** One `@server:uri` token found in a prompt. */
export interface McpResourceMention {
  server: string;
  uri: string;
  /** The exact text the user typed, including the leading `@`. */
  token: string;
}

export interface McpResourceReader {
  read(server: string, uri: string): Promise<{ text: string; mimeType?: string }>;
}

export interface McpResourceMentionExpansion {
  /** Blocks to pass as `extraContext`; undefined when nothing was attached. */
  extraContext?: string;
  /** Human-readable lines the host shows (attached / not attached / truncated). */
  notes: string[];
}

export interface McpResourceMentionOptions {
  /** Undefined when no MCP session exists; mentions then explain themselves. */
  read?: McpResourceReader['read'];
  maxResources?: number;
  maxCharsPerResource?: number;
  maxTotalChars?: number;
}

const DEFAULT_MAX_RESOURCES = 3;
const DEFAULT_MAX_CHARS_PER_RESOURCE = 8_000;
const DEFAULT_MAX_TOTAL_CHARS = 16_000;

/**
 * `@server:scheme://rest` — a colon immediately after the server name plus a
 * URI scheme. Plain file mentions (`@src/app.ts`), Windows paths (`@C:\x`) and
 * `@agent-name` do not match, so this stays out of their way.
 */
const MENTION_PATTERN =
  /@([A-Za-z0-9][A-Za-z0-9_.-]*):([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`<>)\]]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

export function findMcpResourceMentions(message: string): McpResourceMention[] {
  if (!message.includes('@')) return [];
  const seen = new Set<string>();
  const found: McpResourceMention[] = [];
  for (const match of message.matchAll(MENTION_PATTERN)) {
    const server = match[1] ?? '';
    const rawUri = (match[2] ?? '').replace(TRAILING_PUNCTUATION, '');
    if (!server || !rawUri) continue;
    const key = `${server}\u0000${rawUri}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ server, uri: rawUri, token: `@${server}:${rawUri}` });
  }
  return found;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() || text.trim() || 'unknown error';
}

function truncateBody(text: string, maxChars: number): { body: string; omitted: number } {
  if (text.length <= maxChars) return { body: text, omitted: 0 };
  const omitted = text.length - maxChars;
  return {
    body: `${text.slice(0, maxChars)}\n…(${String(omitted)} more chars truncated)`,
    omitted,
  };
}

/**
 * Resolve every mention and render the context blocks. One failing resource
 * never hides the others: failures become notes the user can act on.
 */
export async function expandMcpResourceMentions(
  message: string,
  options: McpResourceMentionOptions = {}
): Promise<McpResourceMentionExpansion> {
  const mentions = findMcpResourceMentions(message);
  if (mentions.length === 0) return { notes: [] };
  const read = options.read;
  if (!read) {
    return {
      notes: [
        `[mcp] ${String(mentions.length)} resource mention(s) not attached: no MCP session is available in this run.`,
      ],
    };
  }
  const maxResources = options.maxResources ?? DEFAULT_MAX_RESOURCES;
  const maxCharsPerResource = options.maxCharsPerResource ?? DEFAULT_MAX_CHARS_PER_RESOURCE;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const selected = mentions.slice(0, maxResources);
  const notes: string[] = [];
  if (mentions.length > selected.length) {
    notes.push(
      `[mcp] attached the first ${String(selected.length)} of ${String(mentions.length)} resource mentions.`
    );
  }
  const blocks: string[] = [];
  let totalChars = 0;
  const results = await Promise.allSettled(
    selected.map((mention) => read(mention.server, mention.uri))
  );
  for (let index = 0; index < selected.length; index += 1) {
    const mention = selected[index];
    const result = results[index];
    const label = `${mention.server}:${mention.uri}`;
    if (result?.status === 'rejected') {
      notes.push(
        `[mcp] ${label} not attached: ${firstLine(
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        )} — check the server with /mcp.`
      );
      continue;
    }
    const text = result.value.text;
    if (totalChars >= maxTotalChars) {
      notes.push(
        `[mcp] ${label} not attached: the prompt already has ${String(totalChars)} resource chars.`
      );
      continue;
    }
    const room = Math.min(maxCharsPerResource, maxTotalChars - totalChars);
    const { body, omitted } = truncateBody(text, room);
    totalChars += body.length;
    blocks.push(
      `[mcp resource ${label} — attached by the user's @ mention; the text below is already in context, no tool call needed]\n${body}`
    );
    notes.push(
      omitted > 0
        ? `[mcp] attached ${label} (${String(body.length)} chars, ${String(omitted)} truncated)`
        : `[mcp] attached ${label} (${String(body.length)} chars)`
    );
  }
  return {
    ...(blocks.length > 0 ? { extraContext: blocks.join('\n\n') } : {}),
    notes,
  };
}
