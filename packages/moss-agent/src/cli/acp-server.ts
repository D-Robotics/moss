/**
 * ACP (Agent Client Protocol) stdio server — host-neutral wire protocol.
 *
 * Exposes a MossAgent over newline-delimited JSON-RPC 2.0 on stdin/stdout so
 * IDEs, editors, and custom clients can drive moss the same way the TUI does.
 * This is the host-neutral bridge moss previously lacked (it was embeddable
 * only as a library via `@rdk-moss/agent` subpath exports, with no wire
 * protocol — so IDEs could not drive it).
 *
 * Supported methods (ACP core):
 * - initialize          → capabilities + server info
 * - session/new         → fresh sessionId
 * - session/load        → resume an existing sessionId
 * - session/prompt      → run streamChat, streaming notifications (session/delta
 *                         for text/thought, session/toolCall for tool calls),
 *                         return final result
 * - session/cancel      → abort the active prompt
 *
 * stderr is reserved for logs; stdout carries only NDJSON protocol messages.
 * @public
 */
import readline from 'node:readline';
import type { MossAgent } from '../core/agent/moss-agent.js';
import { createCliSessionKey } from './session.js';
import { getPackageVersion } from './package-info.js';

const ACP_PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown> | null;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

const PARSE_ERROR: JsonRpcError = { code: -32700, message: 'Parse error' };
const METHOD_NOT_FOUND: JsonRpcError = { code: -32601, message: 'Method not found' };
const INVALID_PARAMS: JsonRpcError = { code: -32602, message: 'Invalid params' };

function err(code: number, message: string, data?: unknown): JsonRpcError {
  return data !== undefined ? { code, message, data } : { code, message };
}

/** Map of sessionId → AbortController for the active `session/prompt` on it. */
type ActiveMap = Map<string, AbortController>;

export interface AcpServerOptions {
  abortSignal?: AbortSignal;
  /** Override stdin (tests). Defaults to process.stdin. */
  input?: NodeJS.ReadableStream;
  /** Override stdout (tests). Defaults to process.stdout. */
  output?: NodeJS.WritableStream;
}

/**
 * Run the ACP stdio server. Reads NDJSON JSON-RPC requests from stdin until
 * EOF or abort; writes responses + notifications as NDJSON to stdout.
 */
export async function runAcpStdioServer(
  agent: MossAgent,
  opts: AcpServerOptions = {},
): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const active: ActiveMap = new Map();
  const send = (obj: unknown) => {
    output.write(JSON.stringify(obj) + '\n');
  };
  const notify = (method: string, params: Record<string, unknown>) =>
    send({ jsonrpc: '2.0', method, params });

  const rl = readline.createInterface({ input: input as NodeJS.ReadableStream, terminal: false, crlfDelay: Infinity });

  // In-flight request handlers (for graceful shutdown on EOF/abort).
  const inflight = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => { inflight.add(p); p.finally(() => inflight.delete(p)); return p; };

  const handleRequest = (req: JsonRpcRequest) => {
    track((async () => {
      try {
        const result = await dispatch(req, agent, active, notify);
        if (req.id !== undefined && req.id !== null) {
          send({ jsonrpc: '2.0', id: req.id, result: result ?? null });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const ae = e as { code?: number; acpError?: boolean };
        // Surface the actual error message (not a static "Internal error") so
        // clients can see what failed; ACP-typed errors keep their code.
        const error: JsonRpcError = ae.acpError && typeof ae.code === 'number'
          ? err(ae.code, message)
          : err(-32603, message);
        if (req.id !== undefined && req.id !== null) {
          send({ jsonrpc: '2.0', id: req.id, error });
        }
      }
    })());
  };

  for await (const line of rl) {
    if (opts.abortSignal?.aborted) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: PARSE_ERROR });
      continue;
    }
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      if (req.id !== undefined && req.id !== null) {
        send({ jsonrpc: '2.0', id: req.id, error: INVALID_PARAMS });
      }
      continue;
    }
    // Dispatch concurrently — a long-running session/prompt must not block
    // reading the next line, otherwise session/cancel (sent while the prompt
    // streams) could never be read (deadlock). JSON-RPC responses may arrive
    // out of order; clients correlate by id.
    handleRequest(req);
  }
  // EOF / abort: cancel any still-active prompts and let them settle.
  for (const controller of active.values()) controller.abort();
  await Promise.allSettled([...inflight]);
}

async function dispatch(
  req: JsonRpcRequest,
  agent: MossAgent,
  active: ActiveMap,
  notify: (method: string, params: Record<string, unknown>) => void,
): Promise<unknown | null> {
  switch (req.method) {
    case 'initialize':
      return handleInitialize();
    case 'session/new':
      return handleSessionNew(agent);
    case 'session/load':
      return handleSessionLoad(agent, req.params);
    case 'session/prompt':
      return handleSessionPrompt(agent, active, notify, req.params);
    case 'session/cancel':
      return handleSessionCancel(active, req.params);
    default:
      throw { code: METHOD_NOT_FOUND.code, message: `Method not found: ${req.method}`, acpError: true };
  }
}

function handleInitialize() {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    serverInfo: { name: 'moss', version: getPackageVersion() },
    capabilities: {
      streaming: true,
      sessionLoad: true,
      sessionCancel: true,
      toolStream: true,
      thoughtStream: true,
    },
  };
}

function handleSessionNew(agent: MossAgent) {
  // A new session is created implicitly by writing to its key; reserve one
  // so session/prompt can append. Use the same key shape as the CLI.
  const sessionKey = createCliSessionKey();
  const store = agent.config.sessionStore;
  // Init an empty message list so exists() reports true before the first turn.
  store.replaceMessages(sessionKey, []).catch(() => {});
  return { sessionId: sessionKey };
}

async function handleSessionLoad(agent: MossAgent, params: Record<string, unknown> | null | undefined) {
  const sessionId = String(params?.sessionId ?? '').trim();
  if (!sessionId) throw { code: INVALID_PARAMS.code, message: 'session/load requires sessionId', acpError: true };
  const exists = await agent.config.sessionStore.exists(sessionId).catch(() => false);
  if (!exists) throw { code: -32001, message: `Session not found: ${sessionId}`, acpError: true };
  return { sessionId };
}

async function handleSessionPrompt(
  agent: MossAgent,
  active: ActiveMap,
  notify: (method: string, params: Record<string, unknown>) => void,
  params: Record<string, unknown> | null | undefined,
): Promise<Record<string, unknown>> {
  const sessionId = String(params?.sessionId ?? '').trim();
  const prompt = String(params?.prompt ?? '');
  if (!sessionId || !prompt) {
    throw { code: INVALID_PARAMS.code, message: 'session/prompt requires sessionId + prompt', acpError: true };
  }
  const controller = new AbortController();
  // If a previous prompt is still active on this session, cancel it first.
  active.get(sessionId)?.abort();
  active.set(sessionId, controller);
  try {
    let text = '';
    let stopReason = 'end_turn';
    for await (const event of agent.streamChat(sessionId, prompt, { abortSignal: controller.signal })) {
      switch (event.type) {
        case 'text_delta':
          text += event.delta;
          notify('session/delta', { sessionId, type: 'text', delta: event.delta });
          break;
        case 'thinking_delta':
          notify('session/delta', { sessionId, type: 'thought', delta: event.delta });
          break;
        case 'tool_start':
          notify('session/toolCall', {
            sessionId,
            toolCallId: event.toolCallId,
            name: event.toolName,
            input: event.input,
            state: 'start',
          });
          break;
        case 'tool_end':
          notify('session/toolCall', {
            sessionId,
            toolCallId: event.toolCallId,
            name: event.toolName,
            state: 'end',
            result: event.result,
            isError: event.isError,
          });
          break;
        case 'turn_end':
          stopReason = event.stopReason;
          break;
        // turn_start / retry / error: not surfaced as notifications here.
      }
    }
    return { sessionId, stopReason, text };
  } finally {
    if (active.get(sessionId) === controller) active.delete(sessionId);
  }
}

function handleSessionCancel(active: ActiveMap, params: Record<string, unknown> | null | undefined) {
  const sessionId = String(params?.sessionId ?? '').trim();
  if (!sessionId) throw { code: INVALID_PARAMS.code, message: 'session/cancel requires sessionId', acpError: true };
  const controller = active.get(sessionId);
  if (controller) {
    controller.abort();
    active.delete(sessionId);
    return { sessionId, cancelled: true };
  }
  return { sessionId, cancelled: false };
}
