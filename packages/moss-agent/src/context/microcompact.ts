





















import type { Message, ContentBlock } from '../core/session/session-jsonl.js';
import { estimateTokensForText } from './tokens.js';

export interface MicroCompactConfig {
  
  keepRecentResults: number;
  
  minContentLength: number;
  
  placeholder: string;
}

export const DEFAULT_MICRO_COMPACT_CONFIG: MicroCompactConfig = {
  keepRecentResults: 6,
  minContentLength: 200,
  placeholder: '[内容已压缩 — 此工具结果已被 Agent 处理，原文已省略以节省上下文空间]',
};

export interface MicroCompactResult {
  messages: Message[];
  compressedCount: number;
  
  savedChars: number;
  
  savedTokens: number;
}






export function microcompact(
  messages: Message[],
  config: Partial<MicroCompactConfig> = {}
): MicroCompactResult {
  const cfg = { ...DEFAULT_MICRO_COMPACT_CONFIG, ...config };

  
  const allToolResults: Array<{
    msgIdx: number;
    blockIdx: number;
    content: string;
  }> = [];

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (typeof msg.content === 'string') continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi];
      if (block.type !== 'tool_result') continue;
      if (typeof block.content === 'string') {
        if (block.content.length >= cfg.minContentLength && block.content !== cfg.placeholder) {
          allToolResults.push({ msgIdx: mi, blockIdx: bi, content: block.content });
        }
      } else if (Array.isArray(block.content as unknown)) {
        
        const arr = block.content as unknown as Array<{ type?: string; text?: string }>;
        const combined = arr
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text!)
          .join('\n');
        if (combined.length >= cfg.minContentLength && combined !== cfg.placeholder) {
          allToolResults.push({ msgIdx: mi, blockIdx: bi, content: combined });
        }
      }
    }
  }

  if (allToolResults.length === 0) {
    return { messages, compressedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  
  const compressible = allToolResults.slice(
    0,
    Math.max(0, allToolResults.length - cfg.keepRecentResults)
  );

  if (compressible.length === 0) {
    return { messages, compressedCount: 0, savedChars: 0, savedTokens: 0 };
  }

  
  const compressSet = new Set(compressible.map((c) => `${c.msgIdx}:${c.blockIdx}`));
  
  const placeholderTokens = estimateTokensForText(cfg.placeholder);
  let savedChars = 0;
  let savedTokens = 0;
  let compressedCount = 0;

  const result: Message[] = messages.map((msg, mi) => {
    if (typeof msg.content === 'string') return msg;

    let modified = false;
    const newContent: ContentBlock[] = msg.content.map((block, bi) => {
      const key = `${mi}:${bi}`;
      if (compressSet.has(key)) {
        modified = true;
        compressedCount++;
        let originalText = '';
        if (typeof block.content === 'string') {
          originalText = block.content;
        } else if (Array.isArray(block.content as unknown)) {
          
          const arr = block.content as unknown as Array<{ type?: string; text?: string }>;
          originalText = (arr as Array<{ type?: string; text?: string }>)
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text!)
            .join('\n');
        }
        savedChars += originalText.length - cfg.placeholder.length;
        savedTokens += Math.max(0, estimateTokensForText(originalText) - placeholderTokens);
        return { ...block, content: cfg.placeholder };
      }
      return block;
    });

    return modified ? { ...msg, content: newContent } : msg;
  });

  return { messages: result, compressedCount, savedChars, savedTokens };
}
