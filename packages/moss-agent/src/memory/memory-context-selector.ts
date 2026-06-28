











import type { MemoryEntry, MemoryManager, MemoryScope } from './memory-manager.js';

export interface SelectMemoryForContextParams {
  memoryManager: MemoryManager;
  deviceId?: string;
  projectHash?: string;
  query: string;
  
  deviceTopN?: number;
  
  workspaceTopN?: number;
  
  userTopN?: number;
  




  maxTotal?: number;
  



  minScore?: number;
}

export interface MemoryContextPick {
  entry: MemoryEntry;
  score: number;
  snippet: string;
  
  scope: MemoryScope;
}










export async function selectMemoriesForContext(
  params: SelectMemoryForContextParams
): Promise<MemoryContextPick[]> {
  const {
    memoryManager,
    deviceId,
    projectHash,
    query,
    deviceTopN = 2,
    workspaceTopN = 1,
    userTopN = 1,
    maxTotal = 3,
    minScore = 0.3,
  } = params;

  const picks: MemoryContextPick[] = [];
  const seenIds = new Set<string>();
  const passesScore = (score: number): boolean => minScore <= 0 || score >= minScore;

  if (deviceId) {
    const ranked = await memoryManager.search(query, deviceTopN, {
      scope: 'device',
      scopeRef: deviceId,
    });
    for (const r of ranked) {
      if (!passesScore(r.score)) continue;
      if (seenIds.has(r.entry.id)) continue;
      seenIds.add(r.entry.id);
      picks.push({ entry: r.entry, score: r.score, snippet: r.snippet, scope: 'device' });
      if (picks.length >= maxTotal) break;
    }
  }

  if (picks.length < maxTotal) {
    const ranked = await memoryManager.search(query, workspaceTopN, {
      scope: 'workspace',
      scopeRef: projectHash,
    });
    for (const r of ranked) {
      if (!passesScore(r.score)) continue;
      if (seenIds.has(r.entry.id)) continue;
      seenIds.add(r.entry.id);
      picks.push({ entry: r.entry, score: r.score, snippet: r.snippet, scope: 'workspace' });
      if (picks.length >= maxTotal) break;
    }
  }

  if (picks.length < maxTotal) {
    const ranked = await memoryManager.search(query, userTopN, { scope: 'user' });
    for (const r of ranked) {
      if (!passesScore(r.score)) continue;
      if (seenIds.has(r.entry.id)) continue;
      seenIds.add(r.entry.id);
      picks.push({ entry: r.entry, score: r.score, snippet: r.snippet, scope: 'user' });
      if (picks.length >= maxTotal) break;
    }
  }

  return picks;
}
















export function renderMemoryPicksForSystemPrompt(
  picks: MemoryContextPick[],
  sanitizeFn?: (text: string) => string
): string {
  if (picks.length === 0) return '';
  const lines: string[] = ['## 已有记忆（按 scope 优先级注入）', ''];
  for (const p of picks) {
    const raw = p.snippet ?? p.entry.content.slice(0, 200);
    const content = sanitizeFn ? sanitizeFn(raw) : raw;
    lines.push(`[${p.scope} · #${p.entry.id}] ${content}`);
  }
  return lines.join('\n');
}
