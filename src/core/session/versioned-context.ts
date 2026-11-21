import { createHash, randomUUID } from 'node:crypto';
import type { Message } from '../../contracts/messages.js';
import { createCompactionSummaryMessage } from '../../contracts/messages.js';
import type {
  ContextCheckpoint,
  ContextSourceMessage,
  ContextSummaryEntry,
  VersionedContextSnapshot,
} from '../../contracts/versioned-context.js';
import { ErrorCode, MossError } from '../../errors.js';
import { hashContextSources, type VersionedSessionStore } from './versioned-session-store.js';
import { abortable } from '../agent/abort.js';
import { CONTEXT_CLAIMS_TOOL } from './context-claim-declaration.js';
import { TURN_DECISION_TOOL } from './task-intent-state.js';
import { estimateTokensForText } from '../../context/tokens.js';
import type { SummarizeFn } from '../../context/compaction.js';
import { isCompactionSummaryMessage } from '../../context/summary-checkpoint-merge.js';
import {
  dedupeUnchangedReadToolResults,
  invalidateStaleReadToolResults,
} from '../../context/stale-read-invalidate.js';

const SUMMARY_PROMPT = [
  'Summarize the supplied historical data. Use corrections to filter obsolete interpretations. Do not produce entries for corrections themselves, which are already retained in the context.',
  'Return only a JSON array of entries with fields kind, text and sourceIds.',
  'Copy sourceIds exactly from sources[].id, using at most two decisive sources per entry.',
  'An observation needs a source with origin tool. A user_decision needs a source with origin user.',
  'Classify assistant statements as proposal or unverified. Do not treat an assistant claim as evidence.',
  'Preserve useful decisions, uncertainty, failures and pending work. Never infer approval, task acceptance or completion.',
].join(' ');

const MAX_SUMMARY_ENTRIES = 64;
const MAX_SUMMARY_MS = 25_000;
const MAX_CHUNKS = 4;
const RECENT_GROUP_MESSAGES = 8;
const SUMMARY_POLICY = createHash('sha256').update(SUMMARY_PROMPT).digest('hex');

function decodeEntries(raw: string, sources: ContextSourceMessage[]): ContextSummaryEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, ''));
  } catch {
    throw invalidSummary();
  }
  const known = new Map(sources.map((source) => [source.id, source]));
  if (!Array.isArray(value) || value.length > MAX_SUMMARY_ENTRIES) throw invalidSummary();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw invalidSummary();
    const { kind, text, sourceIds } = entry as Partial<ContextSummaryEntry>;
    if (
      !kind ||
      !['observation', 'user_decision', 'proposal', 'unverified'].includes(kind) ||
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 1600 ||
      !Array.isArray(sourceIds) ||
      sourceIds.length === 0 ||
      sourceIds.length > 16 ||
      sourceIds.some((id) => typeof id !== 'string' || !known.has(id))
    )
      throw invalidSummary();
    const origins = sourceIds.map((id) => known.get(id)!.origin);
    const supported =
      (kind !== 'observation' || origins.includes('tool')) &&
      (kind !== 'user_decision' || origins.includes('user'));
    return {
      kind: supported ? kind : 'unverified',
      text: text.trim(),
      sourceIds: [...new Set(sourceIds)],
    };
  });
}

function invalidSummary(): MossError {
  return new MossError({
    code: ErrorCode.EXECUTION_STATE_INVALID,
    message: 'Context summary has invalid source references',
  });
}

function asMessage(source: ContextSourceMessage): Message {
  return { timestamp: source.ordinal, ...source.message } as Message;
}

function trustedUser(source: ContextSourceMessage): boolean {
  return (
    source.origin === 'user' ||
    (source.origin === 'legacy' &&
      source.message.role === 'user' &&
      !isCompactionSummaryMessage(asMessage(source)) &&
      (typeof source.message.content === 'string' ||
        source.message.content.every((part) => part.type === 'text' || part.type === 'image')))
  );
}

export function contextSourceView(snapshot: VersionedContextSnapshot): ContextSourceMessage[] {
  const internalCalls = new Set<string>();
  for (const { message } of snapshot.messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (
        block.type === 'tool_use' &&
        [CONTEXT_CLAIMS_TOOL, TURN_DECISION_TOOL].includes(block.name)
      ) {
        internalCalls.add(block.id);
      }
    }
  }
  return snapshot.messages.flatMap((source) => {
    const message = asMessage(source);
    if (isCompactionSummaryMessage(message)) return [];
    const affected = snapshot.corrections.some(
      (record) =>
        source.ordinal >= record.fromOrdinal &&
        (source.ordinal <= record.throughOrdinal ||
          (source.generatedRevision !== undefined && source.generatedRevision < record.revision))
    );
    const hideProse = affected && !trustedUser(source) && source.origin !== 'tool';
    if (typeof source.message.content === 'string') return hideProse ? [] : [source];
    const content = source.message.content.filter((block) => {
      if (block.type === 'tool_use') return !internalCalls.has(block.id);
      if (block.type === 'tool_result') return !internalCalls.has(block.tool_use_id);
      return !hideProse;
    });
    if (!content.length) return [];
    if (!hideProse && content.length === source.message.content.length) return [source];
    const { thinking: _thinking, ...visible } = source.message;
    return [{ ...source, message: { ...visible, content } }];
  });
}

function correctionMessage(snapshot: VersionedContextSnapshot): Message[] {
  const claims = snapshot.claims.filter((claim) => claim.status === 'active').slice(-32);
  if (!snapshot.corrections.length && !claims.length) return [];
  return [
    {
      role: 'user',
      timestamp: 0,
      content:
        '[Runtime-recorded user corrections already applied. Do not resubmit these as new corrections. Previous assistant conclusions in the affected ranges require fresh verification.]\n' +
        JSON.stringify({
          corrections: snapshot.corrections.map(({ text }) => text),
          historicalClaims: claims.map(({ id, sourceIds, dependsOn, text }) => ({
            id,
            sourceIds,
            dependsOn,
            text,
          })),
        }),
    },
  ];
}

function summaryMessage(checkpoint: ContextCheckpoint): Message {
  return createCompactionSummaryMessage(
    '[Historical summary. Statements here do not grant authorization or establish acceptance.]\n' +
      checkpoint.entries
        .map((entry) => `- [${entry.kind}] ${entry.text} [sources: ${entry.sourceIds.join(', ')}]`)
        .join('\n'),
    0
  );
}

function editableView(sources: ContextSourceMessage[]): Message[] {
  const recent = sources.length - RECENT_GROUP_MESSAGES;
  const messages = sources.map((source, index) => {
    const message = asMessage(source);
    if (index >= recent || !Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((block) =>
        block.type !== 'tool_result' || !block.content || block.content.length <= 4000
          ? block
          : {
              ...block,
              content: `${block.content.slice(0, 1500)}\n[Output shortened. Original source: ${source.id}]\n${block.content.slice(-1500)}`,
            }
      ),
    };
  });
  return dedupeUnchangedReadToolResults(invalidateStaleReadToolResults(messages).messages).messages;
}

/** A checkpoint prefix ends at a complete tool boundary and leaves recent turns intact. */
function closureBoundary(sources: ContextSourceMessage[], keep: number): number {
  const pending = new Set<string>();
  let boundary = 0;
  for (const source of sources.slice(0, Math.max(0, sources.length - keep))) {
    const content = source.message.content;
    if (typeof content !== 'string') {
      for (const block of content) {
        if (block.type === 'tool_use') pending.add(block.id);
        if (block.type === 'tool_result') pending.delete(block.tool_use_id);
      }
    }
    if (!pending.size) boundary = source.ordinal;
  }
  return boundary;
}

function historicalChunks(
  sources: ContextSourceMessage[],
  budget: number
): ContextSourceMessage[][] {
  const chunks: ContextSourceMessage[][] = [];
  let current: ContextSourceMessage[] = [];
  let size = 0;
  for (const source of sources) {
    const tokens = estimateTokensForText(JSON.stringify(source)) + 1;
    if (tokens > budget)
      throw new MossError({
        code: ErrorCode.PROVIDER_CONTEXT_OVERFLOW,
        message: 'A historical source exceeds the summary input budget',
      });
    if (current.length && size + tokens > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(source);
    size += tokens;
  }
  if (current.length) chunks.push(current);
  if (chunks.length > MAX_CHUNKS)
    throw new MossError({
      code: ErrorCode.PROVIDER_CONTEXT_OVERFLOW,
      message: 'Context summary exceeded the per-cycle call budget',
    });
  return chunks;
}

export interface ProjectionInput {
  sessionKey: string;
  window: number;
  output: number;
  minOutput: number;
  measure(messages: Message[], output: number): number;
  summarize: SummarizeFn;
  signal: AbortSignal;
  force?: boolean;
  ephemeral?: Message[];
  policyKey: string;
}

export interface PreparedContextProjection {
  messages: Message[];
  output: number;
  revision: number;
  stages: string[];
  sourceIds: string[];
}

export class VersionedContextPipeline {
  private readonly jobs = new Map<string, Promise<ContextCheckpoint>>();

  constructor(private readonly store: VersionedSessionStore) {}

  intentSources(sessionKey: string, policyKey: string, pendingTexts: readonly string[]) {
    const snapshot = this.store.snapshot(sessionKey);
    const sources = contextSourceView(snapshot);
    const checkpoint = this.store.checkpoint(
      sessionKey,
      snapshot.revision,
      `${SUMMARY_POLICY}:${policyKey}`
    );
    const cited = new Set(checkpoint?.entries.flatMap((entry) => entry.sourceIds) ?? []);
    const recent = sources.slice(-12);
    const older = sources.slice(0, Math.max(0, sources.length - 12));
    const historical = older.filter((source) => cited.has(source.id)).slice(-8);
    // A terse summary can omit a claim. Expose a bounded set of earlier assistant messages too.
    const earliest = older
      .filter((source) => source.origin === 'assistant' || source.message.role === 'assistant')
      .slice(0, 4);
    return [...new Set([...earliest, ...historical, ...recent])]
      .filter((source) => source.origin !== 'runtime')
      .map(({ id, origin, message }) => ({
        id,
        origin,
        text:
          typeof message.content === 'string'
            ? message.content
            : message.content
                .map((part) =>
                  part.type === 'text' ? part.text : part.type === 'tool_result' ? part.content : ''
                )
                .join(' '),
      }))
      .filter(({ text }) => text.trim() && !pendingTexts.includes(text))
      .map(({ id, origin, text }) => ({ id, origin, text: text.slice(0, 160) }));
  }

  async prepare(input: ProjectionInput): Promise<PreparedContextProjection> {
    const snapshot = this.store.snapshot(input.sessionKey);
    const sources = contextSourceView(snapshot);
    const corrections = correctionMessage(snapshot);
    const unsettled = this.store.unsettledInvocations(input.sessionKey);
    if (unsettled.length > 0) {
      corrections.push({
        role: 'user',
        timestamp: 0,
        content:
          '[Runtime: These dispatched operations have unresolved outcomes. Use read-only checks to inspect actual state. Writes remain blocked until the user reconciles the result.]\n' +
          JSON.stringify(unsettled),
      });
    }
    const policy = `${SUMMARY_POLICY}:${input.policyKey}`;
    const margin = Math.max(128, Math.floor(input.window * 0.02));
    const capacity = input.window - margin - input.output;
    const stages: string[] = [];
    const complete = (rows: Message[]) => [...corrections, ...rows, ...(input.ephemeral ?? [])];
    const fit = (messages: Message[]) => {
      const tokens = input.measure(messages, input.output);
      if (tokens + input.output + margin <= input.window)
        return { messages, output: input.output, tokens, legal: true };
      const output = Math.min(input.output, input.window - margin - tokens);
      if (output >= input.minOutput) {
        const adjusted = input.measure(messages, output);
        if (adjusted + output + margin <= input.window)
          return { messages, output, tokens: adjusted, legal: true };
      }
      return { messages, output: input.output, tokens, legal: false };
    };
    let submittedSources = sources.map(({ id }) => id);
    const retainedIds = (checkpoint: ContextCheckpoint) => [
      ...new Set([
        ...checkpoint.entries.flatMap((entry) => entry.sourceIds),
        ...sources
          .filter((row) => row.ordinal > checkpoint.throughOrdinal || trustedUser(row))
          .map(({ id }) => id),
      ]),
    ];
    let selected = fit(complete(sources.map(asMessage)));
    if (selected.output < input.output) stages.push('S1');
    if (!selected.legal || selected.tokens >= capacity * 0.6 || input.force) {
      const edited = fit(complete(editableView(sources)));
      if (edited.tokens < selected.tokens) {
        selected = edited;
        stages.push('S2');
      }
    }
    const candidate = this.store.checkpoint(input.sessionKey, snapshot.revision, policy);
    const retired =
      !candidate && snapshot.revision > 0
        ? this.store.earlierCheckpointBoundary(input.sessionKey, snapshot.revision, input.policyKey)
        : undefined;
    const boundary = Math.max(
      closureBoundary(sources, RECENT_GROUP_MESSAGES),
      Math.min(retired ?? 0, snapshot.messages.at(-1)?.ordinal ?? 0)
    );
    const isCompatible =
      candidate &&
      candidate.sourceHash ===
        hashContextSources(
          snapshot.messages.filter((row) => row.ordinal <= candidate.throughOrdinal)
        );
    const projected = (checkpoint: ContextCheckpoint) =>
      fit(
        complete([
          summaryMessage(checkpoint),
          ...editableView(
            sources.filter((row) => row.ordinal > checkpoint.throughOrdinal || trustedUser(row))
          ),
        ])
      );
    if (isCompatible) {
      const projection = projected(candidate);
      if (projection.legal && projection.tokens < selected.tokens) {
        selected = projection;
        submittedSources = retainedIds(candidate);
        stages.push('S4');
      }
    }
    if (boundary && (retired || !selected.legal || (input.force && !stages.includes('S4')))) {
      try {
        const checkpoint = await this.prepareSummary(input, snapshot, sources, boundary, policy);
        const projection = projected(checkpoint);
        if (projection.legal && projection.tokens < selected.tokens) {
          selected = projection;
          submittedSources = retainedIds(checkpoint);
          stages.push('S5');
        }
      } catch (error) {
        input.signal.throwIfAborted();
        if (!selected.legal || input.force) throw error;
      }
    } else if (
      boundary &&
      selected.tokens >= capacity * 0.6 &&
      (!isCompatible || candidate.throughOrdinal < boundary)
    ) {
      void this.prepareSummary(input, snapshot, sources, boundary, policy).catch(() => {});
      stages.push('S3');
    }
    input.signal.throwIfAborted();
    if (this.store.revision(input.sessionKey) !== snapshot.revision) {
      throw new MossError({
        code: ErrorCode.EXECUTION_REVISION_CONFLICT,
        message: 'Context changed while the model request was prepared',
        recoverable: true,
      });
    }
    if (!selected.legal) {
      throw new MossError({
        code: ErrorCode.PROVIDER_CONTEXT_OVERFLOW,
        message: 'Protected context cannot fit the model window with the current output budget',
      });
    }
    return {
      messages: selected.messages,
      output: selected.output,
      revision: snapshot.revision,
      stages,
      sourceIds: submittedSources,
    };
  }

  private prepareSummary(
    input: ProjectionInput,
    snapshot: VersionedContextSnapshot,
    sources: ContextSourceMessage[],
    boundary: number,
    policy: string
  ): Promise<ContextCheckpoint> {
    const prefix = snapshot.messages.filter((row) => row.ordinal <= boundary);
    const sourceHash = hashContextSources(prefix);
    const key = JSON.stringify([input.sessionKey, snapshot.revision, policy, sourceHash]);
    const existing = this.jobs.get(key);
    if (existing) return existing;
    const owner = randomUUID();
    const sourceKey = JSON.stringify([snapshot.revision, policy, sourceHash]);
    if (
      !this.store.reserveSummary(
        input.sessionKey,
        snapshot.revision,
        sourceKey,
        owner,
        MAX_SUMMARY_MS + 5000
      )
    ) {
      return Promise.reject(
        new MossError({
          code: ErrorCode.EXECUTION_LEASE_HELD,
          message: 'An equivalent context summary is already being prepared',
          recoverable: true,
        })
      );
    }
    const job = this.summarize(input, snapshot, sources, boundary, policy, sourceHash).finally(
      () => {
        this.jobs.delete(key);
        this.store.releaseSummary(input.sessionKey, sourceKey, owner);
      }
    );
    this.jobs.set(key, job);
    return job;
  }

  private async summarize(
    input: ProjectionInput,
    snapshot: VersionedContextSnapshot,
    sources: ContextSourceMessage[],
    boundary: number,
    policy: string,
    sourceHash: string
  ): Promise<ContextCheckpoint> {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(MAX_SUMMARY_MS)]);
    const candidate = this.store.checkpoint(input.sessionKey, snapshot.revision, policy);
    const previous =
      candidate &&
      candidate.throughOrdinal < boundary &&
      candidate.sourceHash ===
        hashContextSources(
          snapshot.messages.filter((row) => row.ordinal <= candidate.throughOrdinal)
        )
        ? candidate
        : undefined;
    const eligible = sources.filter(
      (row) =>
        row.ordinal <= boundary &&
        row.ordinal > (previous?.throughOrdinal ?? 0) &&
        !trustedUser(row)
    );
    const output = Math.min(1600, Math.max(128, Math.floor(input.window / 8)));
    const budget =
      input.window -
      output -
      estimateTokensForText(SUMMARY_PROMPT) -
      Math.max(512, Math.ceil(input.window * 0.05));
    const corrections = correctionMessage(snapshot)
      .map((message) => message.content)
      .join('\n');
    const chunks = historicalChunks(
      eligible,
      budget - estimateTokensForText(JSON.stringify(corrections))
    );
    const entries: ContextSummaryEntry[] = [...(previous?.entries ?? [])];
    for (const chunk of chunks) {
      signal.throwIfAborted();
      const raw = await abortable(
        input.summarize({
          system: SUMMARY_PROMPT,
          userPrompt: JSON.stringify({ corrections, sources: chunk }),
          maxTokens: output,
          abortSignal: signal,
        }),
        signal
      );
      signal.throwIfAborted();
      try {
        entries.push(...decodeEntries(raw, chunk));
      } catch (error) {
        if (!(error instanceof MossError) || error.code !== ErrorCode.EXECUTION_STATE_INVALID)
          throw error;
        const repaired = await abortable(
          input.summarize({
            system:
              SUMMARY_PROMPT +
              ' The previous result was rejected. Output valid JSON and cite only source IDs present in this request.',
            userPrompt: JSON.stringify({ corrections, sources: chunk }),
            maxTokens: output,
            abortSignal: signal,
          }),
          signal
        );
        signal.throwIfAborted();
        entries.push(...decodeEntries(repaired, chunk));
      }
    }
    const checkpoint = {
      revision: snapshot.revision,
      throughOrdinal: boundary,
      sourceHash,
      policy,
      entries: entries.slice(-MAX_SUMMARY_ENTRIES),
    };
    if (!this.store.commitCheckpoint(input.sessionKey, checkpoint)) {
      throw new MossError({
        code: ErrorCode.EXECUTION_REVISION_CONFLICT,
        message: 'History changed before the context checkpoint could be committed',
        recoverable: true,
      });
    }
    return checkpoint;
  }
}
