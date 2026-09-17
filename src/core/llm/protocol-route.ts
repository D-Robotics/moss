import type { LLMRequestOptions, LLMResponse, LLMStreamEvent } from './llm-provider.js';

export type LLMProtocolId = 'anthropic-messages' | 'openai-chat';

export type LLMProtocolHandler<Config> = (
  config: Config,
  opts: LLMRequestOptions,
  onEvent: (e: LLMStreamEvent) => void
) => Promise<LLMResponse>;

export interface LLMProtocol<Config> {
  readonly id: LLMProtocolId;
  readonly handle: LLMProtocolHandler<Config>;
}

export function protocolIdForProvider(provider: string): LLMProtocolId {
  return provider === 'anthropic' ? 'anthropic-messages' : 'openai-chat';
}

export interface LLMProtocolRouter<Config> {
  readonly resolve: (provider: string) => LLMProtocol<Config>;

  readonly ids: () => LLMProtocolId[];
}

export function createProtocolRouter<Config>(
  protocols: ReadonlyArray<LLMProtocol<Config>>
): LLMProtocolRouter<Config> {
  const byId = new Map<LLMProtocolId, LLMProtocol<Config>>();
  for (const protocol of protocols) byId.set(protocol.id, protocol);
  return {
    resolve(provider: string): LLMProtocol<Config> {
      const id = protocolIdForProvider(provider);
      const protocol = byId.get(id);
      if (!protocol)
        throw new Error(`No LLM protocol registered for "${id}" (provider "${provider}")`);
      return protocol;
    },
    ids: () => [...byId.keys()],
  };
}
