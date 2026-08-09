import type { MossAgent } from '../core/agent/moss-agent.js';
import { MossError, ErrorCode } from '../errors.js';
import { getRootLogger } from '../logger.js';

const log = getRootLogger().child('channels');

export interface ChannelMessage {
  id: string;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: number;
  attachments?: Array<{
    type: 'image' | 'video' | 'file';
    url?: string;
    localPath?: string;
  }>;
}

export interface ChannelResponse {
  text: string;
  mediaFiles?: string[];
}

export interface MessageChannel {
  readonly id: string;
  readonly displayName: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  onMessage(handler: (msg: ChannelMessage) => Promise<ChannelResponse>): void;
}

export interface BridgeAgentToChannelOptions {
  chatTimeoutMs?: number;

  maxSessionQueues?: number;

  onQueueOverflow?: (event: {
    channelId: string;
    sessionKey: string;
    queueSize: number;
    maxSessionQueues: number;
  }) => void;
}

const DEFAULT_CHAT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_SESSION_QUEUES = 1000;

async function chatWithTimeout(
  agent: MossAgent,
  sessionKey: string,
  text: string,
  timeoutMs: number
) {
  if (timeoutMs <= 0) {
    return agent.chat(sessionKey, text);
  }

  const controller = new AbortController();
  const timeoutError = new MossError({
    code: ErrorCode.TOOL_EXECUTION_TIMEOUT,
    message: `channel message timed out after ${timeoutMs}ms`,
    hint: 'The upstream model or a tool did not finish before the channel timeout.',
    recoverable: true,
    context: { sessionKey, timeoutMs },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const chatPromise = agent.chat(sessionKey, text, { abortSignal: controller.signal });
  chatPromise.catch(() => {});

  try {
    return await Promise.race([chatPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function bridgeAgentToChannel(
  agent: MossAgent,
  channel: MessageChannel,
  options?: BridgeAgentToChannelOptions
): void {
  const sessionQueues = new Map<string, Promise<void>>();
  const chatTimeoutMs = options?.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
  const maxSessionQueues = Math.max(
    1,
    Math.floor(options?.maxSessionQueues ?? DEFAULT_MAX_SESSION_QUEUES)
  );

  const enqueue = (sessionKey: string, fn: () => Promise<void>): void => {
    if (!sessionQueues.has(sessionKey) && sessionQueues.size >= maxSessionQueues) {
      const event = {
        channelId: channel.id,
        sessionKey,
        queueSize: sessionQueues.size,
        maxSessionQueues,
      };
      log.warn('channel session queue cap reached; rejecting new sender queue', event);
      options?.onQueueOverflow?.(event);
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `channel session queue cap reached (${sessionQueues.size}/${maxSessionQueues})`,
        hint: 'A previous channel agent call may be hung. Check provider/tool abort handling.',
        recoverable: true,
        context: event,
      });
    }
    const prev = sessionQueues.get(sessionKey) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    sessionQueues.set(sessionKey, next);

    const cleanup = () => {
      if (sessionQueues.get(sessionKey) === next) {
        sessionQueues.delete(sessionKey);
      }
    };
    next.then(cleanup, cleanup);
  };

  channel.onMessage((msg) => {
    const sessionKey = `${channel.id}-${msg.senderId}`;
    return new Promise<ChannelResponse>((resolve, reject) => {
      enqueue(sessionKey, async () => {
        try {
          const result = await chatWithTimeout(agent, sessionKey, msg.text, chatTimeoutMs);
          resolve({
            text: result.response || '(no response)',
          });
        } catch (err) {
          reject(err);
        }
      });
    });
  });
}
