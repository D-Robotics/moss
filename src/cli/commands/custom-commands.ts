import fs from 'node:fs';
import path from 'node:path';
import { INTERACTIVE_COMMAND_SECTIONS } from '../interactive-commands.js';
import { announceCatalogSkip } from '../catalog-skip-notice.js';
import {
  CATALOG_NAME_RE,
  containsTemplatePlaceholder,
  skillSkipReason,
  skillSlashName,
  type SkillSkipReason,
} from '../../core/skills/skill-registry.js';
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

/** First token of a typed line, so `/modle kimi-k2` is `/modle`. */
export function slashHead(text: string): string {
  const trimmed = text.trim();
  return trimmed.split(/\s+/, 1)[0] ?? trimmed;
}

/**
 * A typed `/…` line is a slash command unless it is a filesystem path or a
 * slash followed only by whitespace. A token with another `/` (`/usr/bin/foo`)
 * is a path and stays an ordinary prompt. Anything else that is not a path,
 * including an unfilled `/{{name}}`, is still a command attempt and must not
 * reach the model.
 */
export function isSlashCommandInput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;
  const token = slashHead(trimmed);
  if (token === '/') return false;
  const name = token.slice(1);
  // `/usr/bin/foo` — a path, not a command name.
  if (name.includes('/')) return false;
  return true;
}

/**
 * A loaded skill is dispatched only from the interactive shell. `-p "/greet"`
 * must say so instead of calling the skill unknown.
 */
export function isLoadedSkillSlash(token: string, skills: readonly { name: string }[]): boolean {
  const head = slashHead(token).toLowerCase();
  const name = head.startsWith('/') ? head.slice(1) : head;
  if (!name || name.includes('/')) return false;
  return skills.some((skill) => {
    const raw = skill.name.toLowerCase();
    const alias = skillSlashName(skill.name).toLowerCase();
    return raw === name || alias === name;
  });
}

/**
 * `/` token for a skill, using the slash alias. Undefined when that alias is
 * still not a command name (`c++-helper`, `Deploy (prod)`): the skill tool
 * keeps the original name, and no slash entry is offered.
 */
export function skillSlashToken(skill: { name: string; description: string }): string | undefined {
  const alias = skillSlashName(skill.name);
  if (skillSkipReason(alias, skill.description) !== undefined) return undefined;
  return `/${alias}`;
}

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

export interface SkillCommandRef {
  name: string;
  description: string;
}

export type ResolvedUserCommand =
  | { kind: 'builtin'; name: string; args: string }
  | { kind: 'custom'; name: string; args: string; prompt: string }
  | { kind: 'skill'; name: string; args: string; prompt: string }
  | { kind: 'unknown'; name: string; args: string };

/**
 * Resolve a slash line the way both shells do: built-in, then a file command,
 * then a skill, then unknown. A skill prompt keeps the caller's arguments.
 */
export function resolveUserCommand(
  input: string,
  options: {
    builtinNames: ReadonlySet<string>;
    customCommands: readonly CommandSpec[];
    skills: readonly SkillCommandRef[];
  }
): ResolvedUserCommand {
  const trimmed = input.trim();
  const head = (trimmed.split(/\s+/, 1)[0] ?? trimmed).toLowerCase();
  const args = trimmed.slice(head.length).trim();
  if (options.builtinNames.has(head)) return { kind: 'builtin', name: head, args };
  const custom = options.customCommands.find((command) => command.name === head);
  if (custom?.body) {
    return { kind: 'custom', name: head, args, prompt: expandCommandBody(custom.body, args) };
  }
  const exact = options.skills.find(
    (entry) =>
      `/${entry.name}`.toLowerCase() === head &&
      skillSkipReason(entry.name, entry.description) === undefined
  );
  const skill =
    exact ??
    options.skills.find((entry) => {
      const alias = skillSlashName(entry.name);
      return (
        `/${alias}`.toLowerCase() === head &&
        alias.toLowerCase() !== entry.name.toLowerCase() &&
        skillSkipReason(alias, entry.description) === undefined
      );
    });
  if (skill) {
    const base = `Use the "${skill.name}" skill${skill.description ? ` (${skill.description})` : ''} for this task. Read the skill body with the skill tool first, then follow it.`;
    return {
      kind: 'skill',
      name: head,
      args,
      prompt: expandCommandBody(`${base}\n\n$ARGUMENTS`, args).trim(),
    };
  }
  return { kind: 'unknown', name: head, args };
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

function commandSkipReason(
  name: string,
  description: string | undefined
): SkillSkipReason | undefined {
  if (containsTemplatePlaceholder(name)) return 'placeholder';
  if (!CATALOG_NAME_RE.test(name)) return 'invalid-name';
  if (description === undefined) return undefined;
  const trimmed = description.trim();
  if (!trimmed) return 'empty';
  if (containsTemplatePlaceholder(trimmed)) return 'placeholder';
  return undefined;
}

function readCommandsFromDir(
  dir: string,
  onSkip?: (file: string, reason: SkillSkipReason) => void
): CommandFileEntry[] {
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
    const file = path.join(dir, entry);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseCommandFile(raw);
    const reason = commandSkipReason(name, parsed.description);
    if (reason) {
      onSkip?.(file, reason);
      continue;
    }
    if (!parsed.body) continue;
    out.push({ name, file, parsed });
  }
  return out;
}

export function loadCustomCommands(
  source: CustomCommandSource,
  onWarning?: (message: string) => void,
  locale?: string
): CommandSpec[] {
  const seen = new Set<string>();
  const announced = new Set<string>();
  const specs: CommandSpec[] = [];
  const dirs = [
    path.join(source.workspace, '.moss', 'commands'),
    path.join(source.configDir, 'commands'),
  ];
  for (const dir of dirs) {
    for (const { name, file, parsed } of readCommandsFromDir(dir, (skipped, reason) => {
      if (announced.has(skipped)) return;
      announced.add(skipped);
      if (!onWarning) return;
      announceCatalogSkip(source.workspace, skipped, reason, locale, onWarning);
    })) {
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
        body: parsed.body,
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
