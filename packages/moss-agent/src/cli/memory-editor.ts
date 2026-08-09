import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function resolveEditorCommand(
  env: NodeJS.ProcessEnv = process.env
): { command: string; args: string[] } | null {
  const raw = (env.VISUAL || env.EDITOR || '').trim();
  if (raw) {
    const parts = raw.split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  }
  if (process.platform === 'win32') return { command: 'notepad', args: [] };

  return { command: 'nano', args: [] };
}

export function openInEditor(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  return new Promise((resolve, reject) => {
    const resolved = resolveEditorCommand(env);
    if (!resolved) {
      reject(new Error('No editor configured ($VISUAL / $EDITOR unset)'));
      return;
    }
    const child = spawn(resolved.command, [...resolved.args, filePath], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });
}

const QUICK_ADD_SECTION = '## Memories';

export function parseQuickAddMemory(raw: string): string | null {
  const m = /^#[ \t]+(\S.*)$/.exec(raw);
  return m ? m[1].trim() : null;
}

export function appendQuickAddMemory(workspace: string, text: string, template?: string): string {
  const target = path.join(workspace, 'AGENTS.md');
  let body = '';
  try {
    body = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    body = template ?? '';
  }
  const line = `- ${text}`;
  if (body.includes(QUICK_ADD_SECTION)) {
    body = body.replace(new RegExp(`${QUICK_ADD_SECTION}\\n`), (m) => `${m}${line}\n`);
  } else {
    const sep = body.length > 0 && !body.endsWith('\n') ? '\n' : '';
    body = `${body}${sep}\n${QUICK_ADD_SECTION}\n${line}\n`;
  }
  fs.writeFileSync(target, body, 'utf8');
  return target;
}
