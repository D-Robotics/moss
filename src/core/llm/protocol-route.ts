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
