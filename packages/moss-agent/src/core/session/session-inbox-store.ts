









import fs from 'node:fs';
import path from 'node:path';
import { SessionInbox, type SessionInboxEntry } from './session-inbox.js';


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
    
    return new SessionInbox();
  }
}


export function saveSessionInbox(filePath: string, inbox: SessionInbox): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(inbox.toEntries(), null, 2));
  fs.renameSync(tmp, filePath);
}
