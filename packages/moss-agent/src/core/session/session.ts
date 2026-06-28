






import type { LLMMessage } from '../llm/llm-provider.js';

export interface SessionMeta {
  sessionKey: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  messageCount: number;
}





export interface SessionStore {
  
  loadMessages(sessionKey: string): Promise<LLMMessage[]>;

  
  appendMessage(sessionKey: string, message: LLMMessage): Promise<void>;

  
  replaceMessages(sessionKey: string, messages: LLMMessage[]): Promise<void>;

  
  listSessions(): Promise<SessionMeta[]>;

  
  deleteSession(sessionKey: string): Promise<void>;

  
  exists(sessionKey: string): Promise<boolean>;
}




export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, { messages: LLMMessage[]; meta: SessionMeta }>();

  async loadMessages(sessionKey: string): Promise<LLMMessage[]> {
    return [...(this.sessions.get(sessionKey)?.messages ?? [])];
  }

  async appendMessage(sessionKey: string, message: LLMMessage): Promise<void> {
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

  async replaceMessages(sessionKey: string, messages: LLMMessage[]): Promise<void> {
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
  }

  async listSessions(): Promise<SessionMeta[]> {
    return [...this.sessions.values()].map((s) => ({ ...s.meta }));
  }

  async deleteSession(sessionKey: string): Promise<void> {
    this.sessions.delete(sessionKey);
  }

  async exists(sessionKey: string): Promise<boolean> {
    return this.sessions.has(sessionKey);
  }
}
