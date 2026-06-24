/**
 * Durable persistence for a {@link SessionInbox}.
 *
 * The inbox is the durable record of admitted-but-not-yet-run prompts. Persisting
 * it (here, one JSON file per session) is what makes "durable admission" survive a
 * restart: pending steers/queued prompts and their sequence counters are replayed
 * exactly, so a host can crash mid-drain and resume without losing or double-running
 * input. Writes are atomic (temp + rename) so a crash never leaves a half-written
 * inbox.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SessionInbox, type SessionInboxEntry } from './session-inbox.js';

/** Load a durable inbox from a JSON file. A missing or unreadable file yields an empty inbox. */
export function loadSessionInbox(filePath: string): SessionInbox {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return new SessionInbox();
  }
  try {
    const entries = JSON.parse(raw) as SessionInboxEntry[];
    return Array.isArray(entries) ? SessionInbox.fromEntries(entries) : new SessionInbox();
  } catch {
    // A corrupt inbox file must not crash startup; treat it as empty.
    return new SessionInbox();
  }
}

/** Persist a durable inbox to a JSON file (atomic: write temp then rename). */
export function saveSessionInbox(filePath: string, inbox: SessionInbox): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(inbox.toEntries(), null, 2));
  fs.renameSync(tmp, filePath);
}
