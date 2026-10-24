import type { LLMMessage } from '../llm/llm-provider.js';

export interface SessionMeta {
  sessionKey: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  messageCount: number;
}

export interface SessionDeliverySnapshot {
  messages: LLMMessage[];
  deliveryIds: string[];
}

export interface SessionStore {
  loadMessages(sessionKey: string): Promise<LLMMessage[]>;

  /** One coherent history and receipt image, for a canonical store handoff. */
  loadDeliverySnapshot?(sessionKey: string): Promise<SessionDeliverySnapshot>;

  appendMessage(sessionKey: string, message: LLMMessage): Promise<void>;

  /**
   * Atomically adopt a delivery and its message. Returns false for an already
   * adopted ID, including after replacement/compaction. The caller must reuse
   * an ID only for the same logical message. Durability follows the store:
   * an in-memory implementation only deduplicates for its own lifetime.
   * Custom stores may omit this method; appendMessage alone cannot provide a
   * crash-safe acknowledgement boundary.
   */
  appendMessageOnce?(sessionKey: string, deliveryId: string, message: LLMMessage): Promise<boolean>;

  /**
   * Optional one-way adoption into durable canonical storage, invoked before
   * automatic deferred delivery. Capture the current history atomically, then
   * route all later reads and mutations to that same durable history. Do not
   * restore messages from a separate delivery journal after compaction.
   */
  ensureDurableSession?(sessionKey: string): Promise<void>;

  replaceMessages(
    sessionKey: string,
    messages: LLMMessage[],
    options?: { deliveryIds?: readonly string[] }
  ): Promise<void>;

  listSessions(): Promise<SessionMeta[]>;

  deleteSession(sessionKey: string): Promise<void>;

  exists(sessionKey: string): Promise<boolean>;
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, { messages: LLMMessage[]; meta: SessionMeta }>();
  private readonly deliveries = new Map<string, Set<string>>();

  async loadMessages(sessionKey: string): Promise<LLMMessage[]> {
    return [...(this.sessions.get(sessionKey)?.messages ?? [])];
  }

  async loadDeliverySnapshot(sessionKey: string): Promise<SessionDeliverySnapshot> {
    // Both reads happen synchronously, before yielding to another mutation.
    return {
      messages: [...(this.sessions.get(sessionKey)?.messages ?? [])],
      deliveryIds: [...(this.deliveries.get(sessionKey) ?? [])],
    };
  }

  async appendMessage(sessionKey: string, message: LLMMessage): Promise<void> {
    this.appendToSession(sessionKey, message);
  }

  private appendToSession(sessionKey: string, message: LLMMessage): void {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = {
        messages: [],
        meta: { sessionKey, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
      };
      this.sessions.set(sessionKey, session);
    }
    session.messages.push(message);
    session.meta.updatedAt = Date.now();
    session.meta.messageCount = session.messages.length;
  }

  async appendMessageOnce(
    sessionKey: string,
    deliveryId: string,
    message: LLMMessage
  ): Promise<boolean> {
    if (!deliveryId) throw new Error('A non-empty deliveryId is required');
    const deliveries = this.deliveries.get(sessionKey) ?? new Set<string>();
    if (deliveries.has(deliveryId)) return false;
    this.appendToSession(sessionKey, message);
    deliveries.add(deliveryId);
    this.deliveries.set(sessionKey, deliveries);
    return true;
  }

  async replaceMessages(
    sessionKey: string,
    messages: LLMMessage[],
    options?: { deliveryIds?: readonly string[] }
  ): Promise<void> {
    if (options?.deliveryIds?.some((id) => typeof id !== 'string' || !id)) {
      throw new Error('Delivery snapshot contains an invalid deliveryId');
    }
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = {
        messages: [],
        meta: { sessionKey, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 },
      };
      this.sessions.set(sessionKey, session);
    }
    session.messages = [...messages];
    session.meta.updatedAt = Date.now();
    session.meta.messageCount = messages.length;
    if (options?.deliveryIds) {
      this.deliveries.set(
        sessionKey,
        new Set([...(this.deliveries.get(sessionKey) ?? []), ...options.deliveryIds])
      );
    }
  }

  async listSessions(): Promise<SessionMeta[]> {
    return [...this.sessions.values()].map((s) => ({ ...s.meta }));
  }

  async deleteSession(sessionKey: string): Promise<void> {
    this.sessions.delete(sessionKey);
    this.deliveries.delete(sessionKey);
  }

  async exists(sessionKey: string): Promise<boolean> {
    return this.sessions.has(sessionKey);
  }
}
