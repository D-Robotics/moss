/** Buffered host notices, with pre-screen notices replayed only on fullscreen. */
export function createTuiNoticeSource(fullscreenNotices: readonly string[] = []) {
  const pendingFullscreen = [...fullscreenNotices];
  const pending: string[] = [];
  const listeners = new Set<(message: string) => void>();
  return {
    subscribe(listener: (message: string) => void, fullscreen?: boolean): () => void {
      listeners.add(listener);
      if (fullscreen) {
        for (const message of pendingFullscreen) listener(message);
      }
      pendingFullscreen.length = 0;
      for (const message of pending.splice(0)) listener(message);
      return () => listeners.delete(listener);
    },
    emit(message: string): void {
      if (listeners.size === 0) {
        pending.push(message);
        return;
      }
      for (const listener of listeners) listener(message);
    },
  };
}
