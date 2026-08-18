import { useState } from 'react';

import { api } from './api-client.js';

export const useSessionCreator = ({
  workspaceId,
  onCreated,
  onError,
}: {
  workspaceId?: string;
  onCreated(sessionId: string): Promise<void>;
  onError(message: string): void;
}) => {
  const [creatingSession, setCreatingSession] = useState(false);
  const createSession = async () => {
    if (creatingSession) return;
    setCreatingSession(true);
    onError('');
    try {
      const created = await api.createSession(workspaceId);
      await onCreated(created.sessionId);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingSession(false);
    }
  };
  return { createSession, creatingSession };
};
