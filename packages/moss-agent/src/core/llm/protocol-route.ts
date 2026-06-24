/**
 * LLM protocol routing.
 *
 * Decouples the **wire protocol** (how a request body is encoded and a response
 * stream is parsed) from **deployment** (which baseURL / credentials are used).
 * Adding a new wire protocol (e.g. a native Gemini or Bedrock shape) means
 * registering one handler here instead of editing dispatch branches inside the
 * provider's `stream()`.
 *
 * moss speaks two built-in wire protocols today:
 *   - `anthropic-messages` — Anthropic `/v1/messages`.
 *   - `openai-chat`        — OpenAI-compatible `/v1/chat/completions`, shared by
 *                            OpenAI, DeepSeek, Qwen, and any OpenAI-compatible
 *                            gateway. The deployment (baseURL) varies; the wire
 *                            protocol does not.
 */
import type { LLMRequestOptions, LLMResponse, LLMStreamEvent } from './llm-provider.js';

export type LLMProtocolId = 'anthropic-messages' | 'openai-chat';

export type LLMProtocolHandler<Config> = (
  config: Config,
  opts: LLMRequestOptions,
  onEvent: (e: LLMStreamEvent) => void,
) => Promise<LLMResponse>;

export interface LLMProtocol<Config> {
  readonly id: LLMProtocolId;
  readonly handle: LLMProtocolHandler<Config>;
}

/**
 * Which wire protocol a provider preset speaks. Anthropic uses its Messages API;
 * every other preset is treated as OpenAI-compatible Chat Completions.
 */
export function protocolIdForProvider(provider: string): LLMProtocolId {
  return provider === 'anthropic' ? 'anthropic-messages' : 'openai-chat';
}

export interface LLMProtocolRouter<Config> {
  /** Resolve the wire protocol a provider preset should use. */
  readonly resolve: (provider: string) => LLMProtocol<Config>;
  /** Ids of every registered protocol. */
  readonly ids: () => LLMProtocolId[];
}

/** Build a protocol router from registered handlers; resolves one by provider preset. */
export function createProtocolRouter<Config>(
  protocols: ReadonlyArray<LLMProtocol<Config>>,
): LLMProtocolRouter<Config> {
  const byId = new Map<LLMProtocolId, LLMProtocol<Config>>();
  for (const protocol of protocols) byId.set(protocol.id, protocol);
  return {
    resolve(provider: string): LLMProtocol<Config> {
      const id = protocolIdForProvider(provider);
      const protocol = byId.get(id);
      if (!protocol) throw new Error(`No LLM protocol registered for "${id}" (provider "${provider}")`);
      return protocol;
    },
    ids: () => [...byId.keys()],
  };
}
