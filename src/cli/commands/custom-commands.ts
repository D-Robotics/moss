import fs from 'node:fs';
import path from 'node:path';
import { INTERACTIVE_COMMAND_SECTIONS } from '../interactive-commands.js';
import { registryCommandNames, type CommandSpec } from './registry.js';

export function reservedBuiltinNames(): ReadonlySet<string> {
  const names = new Set<string>([
    ...registryCommandNames(),
    '/help',
    '/quit',
    '/exit',
    '/stop',
    '/abort',
    '/clear',
    '/logout',

    '/skills',
    '/queue',
  ]);
  for (const section of INTERACTIVE_COMMAND_SECTIONS) {
    for (const row of section.rows) {
      names.add(row.command.split(/\s+/, 1)[0]);
      for (const alias of row.aliases ?? []) names.add(alias);
    }
  }
  return names;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export interface CustomCommandSource {
  workspace: string;

  configDir: string;

  reservedNames: ReadonlySet<string>;
}

export interface ParsedCommandFile {
  description?: string;
  argumentHint?: string;
  body: string;
}

export function parseCommandFile(raw: string): ParsedCommandFile {
  let description: string | undefined;
  let argumentHint: string | undefined;
  let body = raw;
  const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim().replace(/^["']|["']$/g, '');
      if (key === 'description') description = value;
      else if (key === 'argument-hint' || key === 'argumenthint') argumentHint = value;
    }
  }
  return { description, argumentHint, body: body.trim() };
}

export function expandCommandBody(body: string, args: string): string {
  const trimmed = args.trim();
  const tokens = trimmed.length ? trimmed.split(/\s+/) : [];
  let used = false;
  let out = body.replace(/\$ARGUMENTS\b/g, () => {
    used = true;
    return trimmed;
  });
  out = out.replace(/\$([1-9])/g, (_match, digit: string) => {
    used = true;
    return tokens[Number(digit) - 1] ?? '';
  });
  if (!used && trimmed) out = `${out}\n\n${trimmed}`;
  return out.trim();
}

interface CommandFileEntry {
  name: string;
  file: string;
  parsed: ParsedCommandFile;
}

function readCommandsFromDir(dir: string): CommandFileEntry[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: CommandFileEntry[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -3);
    if (!NAME_RE.test(name)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, entry), 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseCommandFile(raw);
    if (!parsed.body) continue;
    out.push({ name, file: path.join(dir, entry), parsed });
  }
  return out;
}

export function loadCustomCommands(
  source: CustomCommandSource,
  onWarning?: (message: string) => void
): CommandSpec[] {
  const seen = new Set<string>();
  const specs: CommandSpec[] = [];
  const dirs = [
    path.join(source.workspace, '.moss', 'commands'),
    path.join(source.configDir, 'commands'),
  ];
  for (const dir of dirs) {
    for (const { name, file, parsed } of readCommandsFromDir(dir)) {
      const slash = `/${name}` as const;
      if (source.reservedNames.has(slash)) {
        onWarning?.(
          `Custom command file "${file}" uses reserved name "${slash}" — it will not be loaded. ` +
            `Rename the file to a name that does not conflict with a built-in command.`
        );
        continue;
      }
      if (seen.has(slash)) continue;
      seen.add(slash);
      const summary = parsed.description?.trim() || `custom command (${name}.md)`;
      specs.push({
        name: slash,
        summary: parsed.argumentHint ? `${summary} — args: ${parsed.argumentHint}` : summary,
        run(ctx, args) {
          const prompt = expandCommandBody(parsed.body, args);
          if (!prompt) {
            ctx.say('error', `Custom command ${slash} expanded to an empty prompt.`);
            return;
          }

          if (ctx.submitPrompt) ctx.submitPrompt(prompt);
          else ctx.prefillInput(prompt);
        },
      });
    }
  }
  return specs;
}
