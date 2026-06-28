







import type { LLMResponse, LLMStreamEvent, LLMContentBlock } from '../core/llm/llm-provider.js';
import { getRootLogger } from '../logger.js';
import { classifyProviderError } from './error-classify.js';
import { isContextOverflowError } from './errors.js';
import {
  appendToolUseBlock,
  buildProviderRuntimeErrorMessage,
  extractAssistantBlockThinking,
  hasProviderRuntimeErrorSignal,
  isPiAssistantToolCallBlockType,
  normalizeToolCallArgumentsFromAssistantBlock,
  resolvePiStreamErrorPayload,
  type PiAiStreamEvent,
  type PiErrAssistantBlock,
} from './pi-ai-wire-format.js';

const log = getRootLogger().child('provider:pi-ai');










function mapPiUsage(evtUsage: { input?: number; output?: number } | undefined):
  | {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    }
  | undefined {
  if (!evtUsage) return undefined;
  const raw = evtUsage as Record<string, unknown>;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = raw[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const cacheReadTokens = num('cacheRead', 'cacheReadTokens', 'cache_read_input_tokens');
  const cacheCreationTokens = num(
    'cacheWrite',
    'cacheCreationTokens',
    'cache_creation_input_tokens'
  );
  return {
    inputTokens: evtUsage.input ?? 0,
    outputTokens: evtUsage.output ?? 0,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  };
}

class PiAiProviderRuntimeError extends Error {
  readonly surface: import('./error-classify.js').ProviderErrorSurface;

  constructor(params: {
    message: string;
    surface: import('./error-classify.js').ProviderErrorSurface;
  }) {
    super(params.message || params.surface.userMessage || 'Provider runtime error');
    this.name = 'PiAiProviderRuntimeError';
    this.surface = params.surface;
  }
}






export function processEvent(
  event: PiAiStreamEvent,
  content: LLMContentBlock[],
  repairToolCallUrl: (url: string) => string,
  thinkingChunks?: string[]
): {
  stopReason?: LLMResponse['stopReason'];
  usage?: NonNullable<LLMResponse['usage']>;
} {
  const t = event.type;

  if (t === 'text' || t === 'text_delta') {
    const delta = event.delta ?? event.text ?? '';
    if (!delta) return {};
    const last = content[content.length - 1];
    if (last && last.type === 'text') {
      (last as { text: string }).text += delta;
    } else {
      content.push({ type: 'text', text: delta });
    }
  } else if (t === 'text_end') {
    
  } else if (t === 'thinking' || t === 'thinking_delta') {
    const delta = event.delta ?? event.thinking ?? '';
    if (delta && thinkingChunks) {
      thinkingChunks.push(delta);
    }
    








  } else if (t === 'thinking_end') {
    
  } else if ((t === 'toolCall' || t === 'toolcall_end') && event.toolCall) {
    const tc = event.toolCall;
    appendToolUseBlock(content, {
      id: tc.id,
      name: tc.name,
      arguments: normalizeToolCallArgumentsFromAssistantBlock(
        {
          arguments: tc.arguments,
          partialArgs: tc.partialArgs,
        },
        repairToolCallUrl
      ),
    });
  } else if (t === 'result' || t === 'done') {
    const sr = event.stopReason ?? event.reason;
    const mapped: LLMResponse['stopReason'] =
      sr === 'toolCall' || sr === 'toolUse'
        ? 'tool_use'
        : sr === 'stop'
          ? 'end_turn'
          : sr === 'length'
            ? 'max_tokens'
            : 'end_turn';
    const msg = event.message;
    const evtUsage = event.usage !== undefined && event.usage !== null ? event.usage : msg?.usage;

    if (msg?.content && Array.isArray(msg.content)) {
      const hasTextInContent = content.some(
        (b) => b.type === 'text' && 'text' in b && (b as { text: string }).text?.trim()
      );
      for (const block of msg.content) {
        const thinking = extractAssistantBlockThinking(block as PiErrAssistantBlock);
        if (thinking && thinkingChunks) thinkingChunks.push(thinking);
      }
      if (!hasTextInContent) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text?.trim()) {
            content.push({ type: 'text', text: block.text });
          } else if (isPiAssistantToolCallBlockType(block.type) && block.id && block.name) {
            appendToolUseBlock(content, {
              id: block.id,
              name: block.name,
              arguments: normalizeToolCallArgumentsFromAssistantBlock(
                block as PiErrAssistantBlock,
                repairToolCallUrl
              ),
            });
          }
        }
      } else {
        for (const block of msg.content) {
          if (isPiAssistantToolCallBlockType(block.type) && block.id && block.name) {
            appendToolUseBlock(content, {
              id: block.id,
              name: block.name,
              arguments: normalizeToolCallArgumentsFromAssistantBlock(
                block as PiErrAssistantBlock,
                repairToolCallUrl
              ),
            });
          }
        }
      }
    }

    const hasToolUse = content.some((b) => b.type === 'tool_use');
    const stopReasonOut: LLMResponse['stopReason'] = hasToolUse ? 'tool_use' : mapped;

    return {
      stopReason: stopReasonOut,
      usage: mapPiUsage(evtUsage),
    };
  } else if (
    t === 'start' ||
    t === 'text_start' ||
    t === 'thinking_start' ||
    t === 'toolcall_start' ||
    t === 'toolcall_delta'
  ) {
    
  } else if (t === 'error') {
    const errPayload = resolvePiStreamErrorPayload(event);
    const reason = event.reason ?? 'unknown';
    log.warn('stream error event', {
      reason,
      errPayloadPreview: errPayload ? JSON.stringify(errPayload).slice(0, 500) : 'unknown',
    });
    const overflowProbe = [errPayload?.code, errPayload?.errorMessage].filter(Boolean).join(' ');
    if (overflowProbe && isContextOverflowError(overflowProbe)) {
      throw new Error(
        String(errPayload?.errorMessage || errPayload?.code || 'context_length_exceeded')
      );
    }
    const runtimeErrorSignal = hasProviderRuntimeErrorSignal(errPayload);
    if (runtimeErrorSignal) {
      const rawErrorMessage = buildProviderRuntimeErrorMessage(errPayload);
      const surface = classifyProviderError({
        errorMessage: rawErrorMessage,
        status: typeof errPayload?.status === 'number' ? errPayload.status : undefined,
        code: typeof errPayload?.code === 'string' ? errPayload.code : undefined,
        abortReason:
          typeof errPayload?.abortReason === 'string'
            ? (errPayload.abortReason as 'user' | 'server' | 'timeout')
            : undefined,
      });
      throw new PiAiProviderRuntimeError({
        message: rawErrorMessage,
        surface,
      });
    }
    if (errPayload?.content && Array.isArray(errPayload.content)) {
      






      const hasTextInContent = content.some(
        (b) => b.type === 'text' && 'text' in b && (b as { text: string }).text?.trim()
      );
      const mergeErrBlock = (block: PiErrAssistantBlock) => {
        const bt = block.type ?? '';
        if (bt === 'text' && block.text?.trim()) {
          content.push({ type: 'text', text: block.text });
        } else if (bt === 'thinking' && block.thinking && thinkingChunks) {
          




          thinkingChunks.push(block.thinking);
        } else if (isPiAssistantToolCallBlockType(bt) && block.id && block.name) {
          appendToolUseBlock(content, {
            id: block.id,
            name: block.name,
            arguments: normalizeToolCallArgumentsFromAssistantBlock(block, repairToolCallUrl),
          });
        }
      };

      if (!hasTextInContent) {
        for (const block of errPayload.content) {
          mergeErrBlock(block);
        }
      } else {
        for (const block of errPayload.content) {
          if (isPiAssistantToolCallBlockType(block.type) && block.id && block.name) {
            mergeErrBlock(block);
          }
        }
      }
    }

    








    const errUsage = errPayload?.usage;
    const hasToolUseAfterErr = content.some((b) => b.type === 'tool_use');
    if (hasToolUseAfterErr) {
      return {
        stopReason: 'tool_use',
        usage: mapPiUsage(errUsage),
      };
    }
    if (errUsage) {
      return {
        stopReason:
          errPayload?.stopReason === 'toolCall' || errPayload?.stopReason === 'toolUse'
            ? 'tool_use'
            : 'end_turn',
        usage: mapPiUsage(errUsage),
      };
    }
  }
  return {};
}





export function convertStreamEvent(event: PiAiStreamEvent): LLMStreamEvent | null {
  const t = event.type;
  if (t === 'text' || t === 'text_delta') {
    const delta = event.delta ?? event.text;
    return delta ? { type: 'content_block_delta', text: delta, deltaRole: 'visible' } : null;
  }
  if (t === 'thinking' || t === 'thinking_delta') {
    const delta = event.delta ?? event.thinking;
    return delta ? { type: 'content_block_delta', text: delta, deltaRole: 'thinking' } : null;
  }
  if (t === 'toolCall' || t === 'toolcall_end') {
    return event.toolCall
      ? {
          type: 'content_block_start',
          toolUse: { id: event.toolCall.id, name: event.toolCall.name },
        }
      : null;
  }
  if (t === 'result' || t === 'done') {
    const sr = event.stopReason ?? event.reason;
    return {
      type: 'message_delta',
      stopReason:
        sr === 'toolCall' || sr === 'toolUse'
          ? 'tool_use'
          : sr === 'length'
            ? 'max_tokens'
            : 'end_turn',
    };
  }
  return null;
}
