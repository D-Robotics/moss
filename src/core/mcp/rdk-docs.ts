/**
 * Built-in rdk-docs MCP server — the default source for RDK board facts.
 *
 * The default package is pinned to the version audited in
 * docs/superpowers/plans/2026-10-09-rdk-knowledge-via-mcp.md. It can be
 * overridden by the user config or the real process env while an unpublished
 * server build is being tested. A project config cannot set `package`.
 * A loaded mcp.json entry named `rdk-docs` replaces this definition entirely
 * (command, args, and timeouts). Project files are loaded only after workspace
 * trust; this builtin is what Moss injects when they are not.
 *
 * There is no disk cache and no bundled manual. A failed connect is a failed
 * connect.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envBeforeDotenv, isStartupEnvCaptured } from '../../utils/startup-env.js';
import type { McpServerConfig } from './types.js';

export const RDK_DOCS_SERVER_NAME = 'rdk-docs';

/** Audited default. Keep this as the single bump point; never use `@latest`. */
export const DEFAULT_RDK_DOCS_MCP_PACKAGE = 'rdk-docs-mcp@0.2.0';

/**
 * Cold `npx` measured ~3.4s; 20s was tight. 45s covers a cold start.
 * A single search or get_page is well under 20s; 120s would stall a turn.
 */
export const RDK_DOCS_CONNECT_TIMEOUT_MS = 45_000;
export const RDK_DOCS_REQUEST_TIMEOUT_MS = 20_000;

let npxCwd: string | undefined;

/**
 * Home from the pre-`.env` snapshot. `os.tmpdir()` follows `TMPDIR`, which a
 * project `.env` could point at the workspace.
 */
function mossCacheHome(): string {
  const env = isStartupEnvCaptured() ? envBeforeDotenv : process.env;
  const named =
    process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE;
  if (typeof named === 'string' && named.trim()) return named.trim();
  return os.homedir();
}

/**
 * Empty directory under the Moss cache, not the process temp dir. npm loads a
 * project `.npmrc` by walking up from the child cwd when it finds a
 * `package.json`. This directory has neither, so the user's `~/.npmrc` and
 * pre-`.env` `npm_config_registry` stay in effect.
 */
export function rdkDocsNpxCwd(): string {
  if (npxCwd && fs.existsSync(npxCwd)) return npxCwd;
  const root = path.join(mossCacheHome(), '.moss', 'cache', 'npx');
  fs.mkdirSync(root, { recursive: true });
  npxCwd = fs.mkdtempSync(path.join(root, 'run-'));
  return npxCwd;
}

export function builtinRdkDocsServerConfig(
  packageSpec = DEFAULT_RDK_DOCS_MCP_PACKAGE
): McpServerConfig {
  return {
    name: RDK_DOCS_SERVER_NAME,
    transport: 'stdio',
    command: 'npx',
    cwd: rdkDocsNpxCwd(),
    // --package=<value> keeps a user-supplied spec/path in one argv token.
    // --ignore-scripts prevents package lifecycle hooks; the selected MCP bin
    // still executes, so package overrides must be treated as executable code.
    // No --registry: a mirror in the user's ~/.npmrc (or pre-.env
    // npm_config_registry) must still be used. The cwd above has no project
    // .npmrc, so a workspace registry is not consulted.
    args: ['--yes', '--ignore-scripts', `--package=${packageSpec}`, '--', 'rdk-docs-mcp'],
    // Project `.env` must not reach this child. It starts with no trust prompt.
    startupEnvOnly: true,
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
  'Call `mcp__rdk-docs__search` first; it registers and returns the exact names of the server tools to call (skill `rdk-docs`).',
  "Use the user's words and, if the returned search schema supports it, a board/manual filter; do not answer from another board's page.",
  'Judge the snippet: prefer role=official-start; forum is unofficial and loses to the manual.',
  'Treat noGoodMatch, ranked fusion, and section reads as optional server capabilities; follow the returned schema and degrade to ordinary search/page reads.',
  'Cite each page URL you used from search or get_page. Call record_evidence only when a task contract is already open.',
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
  // Connecting is not connected: the usage guide appears on the next model
  // call after the handshake, not while npx is still starting.
  if (status.state === 'connected') return RDK_DOCS_CONNECTED_LAYER;
  if (status.state === 'failed') return RDK_DOCS_UNAVAILABLE_LAYER;
  return '';
}
