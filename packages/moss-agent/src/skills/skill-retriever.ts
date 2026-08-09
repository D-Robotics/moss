import { deriveSkillStableId } from './registry.js';
import type { SkillCandidateScore, SkillEnvironmentContext } from './composer-types.js';
import type { SkillMeta } from './types.js';

export interface RetrievedSkillCandidate extends SkillCandidateScore {
  skill: SkillMeta;
}

interface RetrievalDocument {
  skill: SkillMeta;
  terms: Map<string, number>;
}

interface RetrievalIndex {
  documents: RetrievalDocument[];
  idf: Map<string, number>;
}

const INDEX_CACHE = new Map<string, RetrievalIndex>();
const MAX_INDEX_CACHE_ENTRIES = 8;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'use',
  'with',
  'please',
  'help',
  'task',
  'skill',
]);

export function buildSkillCandidateDocument(skill: SkillMeta): string {
  return [
    skill.name.replace(/[-_]+/g, ' '),
    skill.description,
    skill.summary ?? '',
    skill.tags.join(' '),
    skill.trigger.join(' '),
    (skill.inputs ?? []).join(' '),
    (skill.outputs ?? []).join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function wordTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9_.+-]+/i)
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
  const terms = [...words];
  for (let index = 0; index + 1 < words.length; index++) {
    terms.push(`${words[index]}::${words[index + 1]}`);
  }
  return terms;
}

function cjkTerms(text: string): string[] {
  const compact = [...text.toLowerCase()].filter((char) =>
    /[\p{Script=Han}\p{L}\p{N}]/u.test(char)
  );
  const terms: string[] = [];
  for (const width of [2, 3]) {
    for (let index = 0; index + width <= compact.length; index++) {
      const gram = compact.slice(index, index + width).join('');
      if (/\p{Script=Han}/u.test(gram)) terms.push(`cjk:${gram}`);
    }
  }
  return terms;
}

function termCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of [...wordTerms(text), ...cjkTerms(text)]) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

function buildIndex(skills: SkillMeta[]): RetrievalIndex {
  const documents = skills.map((skill) => ({
    skill,
    terms: termCounts(buildSkillCandidateDocument(skill)),
  }));
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of document.terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, frequency] of documentFrequency) {
    idf.set(term, Math.log((documents.length + 1) / (frequency + 1)) + 1);
  }
  return { documents, idf };
}

function indexFor(skills: SkillMeta[], digest?: string): RetrievalIndex {
  if (!digest) return buildIndex(skills);
  // Eligibility is request/environment dependent. Reusing a host-built index
  // for a later connected-board request silently drops board-only skills even
  // though the registry digest is unchanged.
  const eligibilityDigest = skills
    .map((skill) => skill.stableId ?? deriveSkillStableId(skill))
    .sort()
    .join('|');
  const cacheKey = `${digest}:${eligibilityDigest}`;
  const cached = INDEX_CACHE.get(cacheKey);
  if (cached) return cached;
  const index = buildIndex(skills);
  INDEX_CACHE.set(cacheKey, index);
  while (INDEX_CACHE.size > MAX_INDEX_CACHE_ENTRIES) {
    const oldest = INDEX_CACHE.keys().next().value as string | undefined;
    if (!oldest) break;
    INDEX_CACHE.delete(oldest);
  }
  return index;
}

function cosineTfidf(
  query: Map<string, number>,
  document: Map<string, number>,
  idf: Map<string, number>
): number {
  let dot = 0;
  let queryNorm = 0;
  let documentNorm = 0;
  for (const [term, count] of query) {
    const weight = count * (idf.get(term) ?? 0);
    queryNorm += weight * weight;
    const documentCount = document.get(term) ?? 0;
    if (documentCount > 0) dot += weight * documentCount * (idf.get(term) ?? 0);
  }
  for (const [term, count] of document) {
    const weight = count * (idf.get(term) ?? 0);
    documentNorm += weight * weight;
  }
  if (queryNorm === 0 || documentNorm === 0) return 0;
  return dot / (Math.sqrt(queryNorm) * Math.sqrt(documentNorm));
}

function requiredPermissionNames(skill: SkillMeta): string[] {
  const permissions: string[] = [];
  if (skill.permissions.workspaceRead) permissions.push('workspace_read');
  if (skill.permissions.workspaceWrite) permissions.push('workspace_write');
  if (skill.permissions.deviceExec) permissions.push('device_exec');
  if (skill.permissions.network) permissions.push('network');
  return permissions;
}

export function skillEligibilityReason(
  skill: SkillMeta,
  environment: SkillEnvironmentContext
): string | undefined {
  if (skill.enabled === false) return 'disabled';
  if (skill.runtimePolicy?.requiresBoard && !environment.hasBoard) return 'requires-board';
  if (skill.permissions.deviceExec && !environment.hasBoard) return 'requires-device-exec';
  if (skill.permissions.network && environment.networkAllowed === false) return 'network-disabled';
  if (environment.availablePermissions) {
    const available = new Set(environment.availablePermissions);
    const missing = requiredPermissionNames(skill).filter(
      (permission) => !available.has(permission as never)
    );
    if (missing.length > 0) return `missing-permission:${missing.join(',')}`;
  }
  return undefined;
}

const STRONG_SINGLE_WORD_TRIGGERS = new Set([
  'audit',
  'commit',
  'debug',
  'deploy',
  'document',
  'docs',
  'plan',
  'presentation',
  'refactor',
  'research',
  'review',
  'slides',
  'tdd',
  'verify',
]);

function isInformationalLookup(task: string): boolean {
  const query = task.toLowerCase().trim();
  const interrogative =
    /^(?:what|which|where|when|who|how many|list\b)/.test(query) ||
    /(?:是什么|是什麼|哪一|哪里|哪裡|几个|幾個|多少|几点|幾點)/u.test(query);
  if (!interrogative) return false;
  return !/(?:audit|debug|deploy|implement|plan|refactor|research|review|verify|修复|修復|实现|實現|调试|調試|重构|重構|审查|審查|调研|調研|验证|驗證|部署)/u.test(
    query
  );
}

function containsLatinPhrase(query: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(query);
}

function cjkTriggerRecall(query: string, trigger: string): number {
  const compact = [...trigger].filter((char) => /[\p{Script=Han}\p{L}\p{N}]/u.test(char));
  if (compact.length < 3 || !compact.some((char) => /\p{Script=Han}/u.test(char))) return 0;
  const grams: string[] = [];
  for (let index = 0; index + 1 < compact.length; index++)
    grams.push(compact.slice(index, index + 2).join(''));
  return grams.filter((gram) => query.includes(gram)).length / grams.length;
}

function exactSignals(task: string, skill: SkillMeta): { score: number; reasons: string[] } {
  const query = task.toLowerCase().trim();
  const informationalLookup = isInformationalLookup(query);
  const reasons: string[] = [];
  let score = 0;
  const name = skill.name.toLowerCase();
  const spaced = name.replace(/[-_]+/g, ' ');
  if (query === name || query === spaced) {
    score = 1;
    reasons.push('exact-name');
  } else if (query.includes(name) || query.includes(spaced)) {
    score = Math.max(score, 0.88);
    reasons.push('name-phrase');
  }
  // Tags are useful lexical evidence, but treating generic tags such as
  // "review", "codebase", or "html" as exact aliases causes severe
  // over-selection. Only the stable name receives the name-phrase boost.
  for (const triggerValue of skill.trigger) {
    const trigger = triggerValue.toLowerCase().trim();
    if (!trigger || informationalLookup) continue;
    const hasCjk = /\p{Script=Han}/u.test(trigger);
    const matched = hasCjk ? query.includes(trigger) : containsLatinPhrase(query, trigger);
    if (matched) {
      const singleWord = !hasCjk && !/\s/.test(trigger);
      const strong = !singleWord || STRONG_SINGLE_WORD_TRIGGERS.has(trigger);
      score = Math.max(score, strong ? 0.9 : 0.4);
      reasons.push(strong ? 'trigger' : 'weak-trigger');
      continue;
    }
    if (hasCjk && cjkTriggerRecall(query, trigger) >= 0.6) {
      score = Math.max(score, 0.72);
      reasons.push('fuzzy-trigger');
    }
  }
  return { score, reasons: [...new Set(reasons)] };
}

function lexicalMultiplier(task: string): number {
  // Simple factual lookups should normally stay on the cheap direct-tool path.
  // Keep a little lexical signal for ranking diagnostics, but below the normal
  // composition threshold unless a name is explicitly requested.
  return isInformationalLookup(task) ? 0.3 : 0.82;
}

export function retrieveSkillCandidates(params: {
  task: string;
  skills: SkillMeta[];
  environment?: SkillEnvironmentContext;
  registryDigest?: string;
  limit?: number;
}): { candidates: RetrievedSkillCandidate[]; excluded: Array<{ name: string; reason: string }> } {
  const environment = params.environment ?? {};
  const excluded: Array<{ name: string; reason: string }> = [];
  const eligible = params.skills.filter((skill) => {
    const reason = skillEligibilityReason(skill, environment);
    if (reason) excluded.push({ name: skill.name, reason });
    return !reason;
  });
  const index = indexFor(eligible, params.registryDigest);
  const queryTerms = termCounts(params.task);
  const candidates = index.documents
    .map((document): RetrievedSkillCandidate => {
      const lexical = cosineTfidf(queryTerms, document.terms, index.idf);
      const exact = exactSignals(params.task, document.skill);
      const score = Math.min(
        1,
        Math.max(exact.score, lexical * lexicalMultiplier(params.task) + exact.score * 0.35)
      );
      const reasons = [...exact.reasons];
      if (lexical > 0) reasons.push('tfidf');
      return {
        stableId: document.skill.stableId ?? deriveSkillStableId(document.skill),
        name: document.skill.name,
        score,
        reasonCodes: [...new Set(reasons)],
        skill: document.skill,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  return {
    candidates: candidates.slice(0, Math.max(1, params.limit ?? 12)),
    excluded,
  };
}

export function clearSkillRetrievalCache(): void {
  INDEX_CACHE.clear();
}
