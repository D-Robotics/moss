/**
 * Built-in rdk-docs MCP server — the default source for RDK board facts.
 *
 * The package is pinned to the version audited in
 * docs/superpowers/plans/2026-10-09-rdk-knowledge-via-mcp.md. Bumping it is a
 * separate change that re-runs list_manuals. A user's mcp.json entry named
 * `rdk-docs` replaces this definition entirely (command, args, and timeouts).
 *
 * There is no disk cache and no bundled manual. A failed connect is a failed
 * connect.
 */
import type { McpServerConfig } from './types.js';

export const RDK_DOCS_SERVER_NAME = 'rdk-docs';

/** Audited package. Not `@latest`. */
export const RDK_DOCS_MCP_PACKAGE = 'rdk-docs-mcp@0.1.12';

/**
 * Cold `npx` measured ~3.4s; 20s was tight. 45s covers a cold start.
 * A single search or get_page is well under 20s; 120s would stall a turn.
 */
export const RDK_DOCS_CONNECT_TIMEOUT_MS = 45_000;
export const RDK_DOCS_REQUEST_TIMEOUT_MS = 20_000;

export function builtinRdkDocsServerConfig(): McpServerConfig {
  return {
    name: RDK_DOCS_SERVER_NAME,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', RDK_DOCS_MCP_PACKAGE],
    connectTimeoutMs: RDK_DOCS_CONNECT_TIMEOUT_MS,
    requestTimeoutMs: RDK_DOCS_REQUEST_TIMEOUT_MS,
  };
}

/**
 * Usage pointer injected only when `rdk-docs` is connected. The skill body
 * holds the longer procedure; this stays a short system-prompt line.
 */
export const RDK_DOCS_CONNECTED_LAYER = [
  '### RDK manuals',
  'Board facts (flashing, BPU/hobot_dnn, cameras, TROS, apt, network, GPIO, specs) come from rdk-docs.',
  'Call `mcp__rdk_docs__search`, then `mcp__rdk_docs__search_docs` and `mcp__rdk_docs__get_page` (skill `rdk-docs`).',
  "Use the user's words and a manual filter for the named board; do not answer from another board's page.",
  'Judge the snippet: prefer role=official-start; forum is unofficial and loses to the manual.',
  'Cite the page URL, and copy it into observed when it supports record_evidence.',
  'Do not invent pin tables or figures. Connection, probes, and approval do not wait on docs.',
].join(' ');

/** Injected when the server was configured but the connect failed. No usage guide. */
export const RDK_DOCS_UNAVAILABLE_LAYER =
  'RDK manual server is unavailable this session. Do not invent board procedures from memory; say the manual could not be checked.';

export function rdkDocsKnowledgeLayer(
  statuses: readonly { name: string; state: string }[]
): string {
  const status = statuses.find((entry) => entry.name === RDK_DOCS_SERVER_NAME);
  if (!status) return '';
  if (status.state === 'connected') return RDK_DOCS_CONNECTED_LAYER;
  if (status.state === 'failed') return RDK_DOCS_UNAVAILABLE_LAYER;
  return '';
}
