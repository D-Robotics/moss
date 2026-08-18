import { ApiError } from './api-client.js';

/** Consume one newline-delimited JSON response without dropping a split chunk. @internal */
export async function consumeNdjsonStream<T>(
  response: Response,
  onEvent: (event: T) => void
): Promise<void> {
  if (!response.ok || !response.body) {
    throw new ApiError(response.status, `HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    pending += decoder.decode(chunk.value, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) if (line) onEvent(JSON.parse(line) as T);
  }
  pending += decoder.decode();
  if (pending.trim()) onEvent(JSON.parse(pending) as T);
}
