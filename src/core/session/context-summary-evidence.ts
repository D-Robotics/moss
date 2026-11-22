import type {
  ContextSourceMessage,
  ContextSummaryEntry,
} from '../../contracts/versioned-context.js';
import { estimateTokensForText } from '../../context/tokens.js';
import { ErrorCode, MossError } from '../../errors.js';

const MAX_EVIDENCE_TOKENS = 9_000;
const MAX_SUMMARY_ENTRIES = 64;
const SUMMARY_KINDS = new Set(['observation', 'user_decision', 'proposal', 'unverified']);

type Evidence = {
  sourceId: string;
  origin: ContextSourceMessage['origin'];
  text: string;
  ordinal: number;
  completeReply: boolean;
};
type AliasedEvidence = Evidence & { id: string };

function quotedExcerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.floor(max / 3);
  return `${text.slice(0, max - tail - 5)} […] ${text.slice(-tail)}`;
}

const WORDS = new Intl.Segmenter(undefined, { granularity: 'word' });

function focusWords(focus: string): string[] {
  return [
    ...new Set(
      [...WORDS.segment(focus.toLowerCase())]
        .filter(({ isWordLike, segment }) => isWordLike && segment.length >= 2)
        .map(({ segment }) => segment)
    ),
  ];
}

function evidenceExcerpt(text: string, max: number, terms: string[]): string {
  if (text.length <= max || !text.includes('\n')) return quotedExcerpt(text, max);
  const unique = new Map<string, { line: string; index: number; rank: number }>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    // Log counters and timestamps do not make repeated diagnostics new evidence.
    const line = raw.trim().replace(/^(?:\[[^\]\r\n]{1,32}\]\s*){2,4}/, '');
    if (!line || unique.has(line)) continue;
    const normalized = line.toLowerCase();
    const matches = terms.filter((term) => normalized.includes(term)).length;
    const diagnostic =
      /\b(?:error|fail(?:ed|ure|ture)?|fatal|exception|exit code|timed? ?out|no such)\b|失败|异常|退出码/i.test(
        line
      );
    const value = /[\w_"']\s*[:=]\s*(?:[-+]?\d|\/)|SHA-?256/i.test(line);
    const preciseNumber = /\b\d+\.\d{4,}\b/.test(line);
    unique.set(line, {
      line,
      index,
      rank: matches * 3 + (diagnostic ? 4 : 0) + (value ? 2 : 0) + (preciseNumber ? 6 : 0),
    });
  }
  const values = [...unique.values()];
  if (!values.some(({ rank }) => rank > 0)) return quotedExcerpt(text, max);
  const pinned = [values[0], values.at(-1)].filter((item) => !!item);
  const candidates = values
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => b.rank - a.rank || a.index - b.index);
  const selected = new Map<number, string>();
  let remaining = max;
  for (const { line, index, rank } of [...pinned, ...candidates]) {
    if (remaining < 32 || selected.has(index)) continue;
    const excerpt = quotedExcerpt(
      line,
      Math.min(remaining - 5, rank ? Math.floor(max * 0.45) : Math.floor(max * 0.2))
    );
    selected.set(index, excerpt);
    remaining -= excerpt.length + 5;
  }
  return [...selected.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, line]) => line)
    .join(' […] ');
}

function spread<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  if (limit === 1) return items.slice(-1);
  return Array.from(
    { length: limit },
    (_, index) => items[Math.round((index * (items.length - 1)) / (limit - 1))]!
  );
}

function toEvidence(source: ContextSourceMessage): Evidence | undefined {
  const { content, role } = source.message;
  const toolOutput = Array.isArray(content)
    ? content.flatMap((part) => (part.type === 'tool_result' && part.content ? [part.content] : []))
    : [];
  const isTool = toolOutput.length > 0 && (source.origin === 'tool' || source.origin === 'legacy');
  const prose =
    typeof content === 'string'
      ? content
      : content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
  const text = (isTool ? toolOutput.join('\n') : prose).trim();
  if (!text || source.origin === 'runtime') return;
  const origin = isTool ? 'tool' : role === 'assistant' ? 'assistant' : source.origin;
  return {
    sourceId: source.id,
    origin,
    text,
    ordinal: source.ordinal,
    completeReply:
      role === 'assistant' &&
      (!Array.isArray(content) || !content.some((part) => part.type === 'tool_use')),
  };
}

export function prepareSummaryEvidence(
  rows: ContextSourceMessage[],
  corrections: string,
  budget: number,
  focus: string = ''
) {
  focus = quotedExcerpt(focus, 800);
  const terms = focusWords(focus);
  const evidence = rows.flatMap((row) => {
    const source = toEvidence(row);
    return source ? [source] : [];
  });
  const readouts = evidence.filter(({ origin }) => origin === 'tool');
  const other = evidence.filter(({ origin }) => origin !== 'tool');
  const recentReplies = new Set(other.filter(({ completeReply }) => completeReply).slice(-4));
  let selected = [
    ...spread(readouts, 64),
    ...spread(
      other.filter((source) => !recentReplies.has(source)),
      20
    ),
    ...recentReplies,
  ].sort((a, b) => a.ordinal - b.ordinal);
  const limit = Math.max(0, Math.min(MAX_EVIDENCE_TOKENS, budget));
  let maxChars = 1_800;
  for (;;) {
    const sources = selected.map(
      (source, index): AliasedEvidence => ({
        ...source,
        id: `s${index + 1}`,
        text: evidenceExcerpt(
          source.text,
          recentReplies.has(source) ? maxChars * 3 : maxChars,
          terms
        ),
      })
    );
    const prompt = JSON.stringify({
      corrections,
      focus,
      sources: sources.map(({ id, origin, text }) => ({ id, origin, text })),
    });
    const tokens = estimateTokensForText(prompt);
    if (tokens <= limit) return { evidence, sources, prompt };
    if (!selected.length) return { evidence, sources, prompt: '' };
    if (maxChars > 160) {
      maxChars = Math.max(160, Math.floor(maxChars * Math.min(0.8, limit / tokens)));
    } else {
      selected = spread(selected, Math.floor(selected.length * 0.75));
    }
  }
}

export function decodeSummaryEntries(
  raw: string,
  sources: AliasedEvidence[]
): ContextSummaryEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, ''));
  } catch {
    throw invalidSummary();
  }
  if (!Array.isArray(value) || value.length > MAX_SUMMARY_ENTRIES) throw invalidSummary();
  const known = new Map(sources.map((source) => [source.id, source]));
  const entries = value.flatMap((entry: unknown): ContextSummaryEntry[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { kind, text, sourceIds } = entry as Partial<ContextSummaryEntry>;
    if (
      !kind ||
      !SUMMARY_KINDS.has(kind) ||
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 1600 ||
      !Array.isArray(sourceIds) ||
      !sourceIds.length ||
      sourceIds.length > 16
    )
      return [];
    const cited = sourceIds.map((id) => (typeof id === 'string' ? known.get(id) : undefined));
    if (cited.some((source) => !source)) return [];
    const origins = cited.map((source) => source!.origin);
    const supported =
      (kind !== 'observation' || origins.includes('tool')) &&
      (kind !== 'user_decision' || origins.includes('user'));
    return [
      {
        kind: supported ? kind : 'unverified',
        text: text.trim(),
        sourceIds: [...new Set(cited.map((source) => source!.sourceId))],
      },
    ];
  });
  if (value.length && !entries.length) throw invalidSummary();
  return entries;
}

export function extractSummaryEntries(evidence: Evidence[]): ContextSummaryEntry[] {
  const toolEvidence = evidence.filter(({ origin }) => origin === 'tool');
  return spread(toolEvidence.length ? toolEvidence : evidence, 8).map((source) => ({
    kind: source.origin === 'tool' ? 'observation' : 'unverified',
    text: `Source excerpt: ${JSON.stringify(quotedExcerpt(source.text, 540))}`,
    sourceIds: [source.sourceId],
  }));
}

function invalidSummary(): MossError {
  return new MossError({
    code: ErrorCode.EXECUTION_STATE_INVALID,
    message: 'Context summary has invalid source references',
  });
}
