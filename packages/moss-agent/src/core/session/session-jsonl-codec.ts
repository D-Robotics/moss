import fs from 'node:fs/promises';
import {
  CURRENT_SESSION_VERSION,
  type CompactionEntry,
  type Message,
  type MessageEntry,
  type SessionEntry,
  type SessionHeaderEntry,
} from './session-jsonl-types.js';

const CRC8_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let j = 0; j < 8; j++) {
    crc = crc & 0x80 ? (crc << 1) ^ 0x07 : crc << 1;
  }
  CRC8_TABLE[i] = crc & 0xff;
}

function crc8(data: string): string {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc = CRC8_TABLE[crc ^ data.charCodeAt(i)] ?? 0;
  }
  return crc.toString(16).padStart(2, '0');
}

export function formatJsonlLine(entry: unknown): string {
  const json = JSON.stringify(entry);
  return `${json}\t${crc8(json)}`;
}

function isSessionHeader(value: unknown): value is SessionHeaderEntry {
  if (!value || typeof value !== 'object') return false;
  const header = value as SessionHeaderEntry;
  return header.type === 'session' && typeof header.id === 'string';
}

function isLegacyMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const msg = value as Message;
  if (msg.role !== 'user' && msg.role !== 'assistant') return false;
  if (!('content' in msg)) return false;
  return typeof msg.timestamp === 'number';
}

export interface JsonlParseResult {
  entries: unknown[];

  corruptLines: number;
}

function parseJsonlLines(content: string, filePath?: string): JsonlParseResult {
  const entries: unknown[] = [];
  const lines = content.split('\n');
  let corruptLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;

    const tabIndex = raw.lastIndexOf('\t');
    let jsonStr = raw;
    if (tabIndex > 0) {
      const candidateJson = raw.slice(0, tabIndex);
      const candidateCrc = raw.slice(tabIndex + 1).trim();
      if (/^[0-9a-f]{2}$/.test(candidateCrc)) {
        if (crc8(candidateJson) === candidateCrc) {
          jsonStr = candidateJson;
        } else {
          corruptLines++;
          continue;
        }
      }
    }

    try {
      entries.push(JSON.parse(jsonStr));
    } catch {
      corruptLines++;
    }
  }

  if (corruptLines > 0) {
    const fileLabel = filePath ? ` in ${filePath}` : '';
    const pct =
      entries.length > 0
        ? ` (${((corruptLines / (entries.length + corruptLines)) * 100).toFixed(1)}% of all lines)`
        : '';
    console.warn(
      `[jsonl] skipped ${corruptLines} corrupt line(s)${pct}${fileLabel}. ` +
        `Some entries failed CRC8 checksum or JSON parse — the session data is partially recovered. ` +
        `Possible causes: incomplete writes, disk errors, or manual edits. ` +
        `To fix: restore from backup, or start a fresh session with \`moss\`.`
    );
  }

  return { entries, corruptLines };
}

export async function loadSessionFile(filePath: string): Promise<{
  header?: SessionHeaderEntry;
  entries: SessionEntry[];
  legacyMessages?: Message[];
  corruptLines: number;
}> {
  const content = await fs.readFile(filePath, 'utf-8');
  const { entries: rawEntries, corruptLines } = parseJsonlLines(content, filePath);

  if (rawEntries.length === 0) {
    return { entries: [], corruptLines };
  }

  const [first, ...rest] = rawEntries;
  if (!isSessionHeader(first)) {
    const messages = rawEntries.filter(isLegacyMessage);
    return { entries: [], legacyMessages: messages, corruptLines };
  }

  const header: SessionHeaderEntry = {
    ...first,
    version: typeof first.version === 'number' ? first.version : CURRENT_SESSION_VERSION,
  };
  const entries: SessionEntry[] = [];

  const entryIds = new Set<string>();
  for (const entry of rest) {
    if (!entry || typeof entry !== 'object') continue;
    const typed = entry as SessionEntry;
    if (!typed.type || typeof typed.id !== 'string') continue;
    if (typed.type === 'message' && (typed as MessageEntry).message) {
      entries.push(typed);
      entryIds.add(typed.id);
      continue;
    }
    if (
      typed.type === 'compaction' &&
      typeof (typed as CompactionEntry).summary === 'string' &&
      typeof (typed as CompactionEntry).firstKeptEntryId === 'string'
    ) {
      const comp = typed as CompactionEntry;
      if (!entryIds.has(comp.firstKeptEntryId)) {
        console.warn(
          `[jsonl] compaction entry in ${filePath} references nonexistent firstKeptEntryId: ${comp.firstKeptEntryId}. ` +
            `This will cause incomplete conversation context — earlier messages may be missing. ` +
            `Recommendation: start a fresh session with \`moss\` to avoid context confusion.`
        );
      }
      entries.push(typed);
    }
  }

  return { header, entries, corruptLines };
}
