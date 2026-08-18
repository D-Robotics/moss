import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ErrorCode, MossError, wrapAsMoss } from '../errors.js';
import type { MossPlugin } from '../core/plugins/plugin-host.js';
import {
  parseMossPluginConfigSchema,
  type MossPluginConfigSchema,
} from './plugin-config-schema.js';

interface AdapterSkill {
  readonly id: string;
  readonly file: string;
  readonly name?: string;
  readonly description?: string;
  readonly triggers?: readonly string[];
}

interface AdapterCommand {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly prompt: string;
}

interface AdapterMcpPreset {
  readonly id: string;
  readonly displayName: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

interface ParsedDshPackage {
  readonly id: string;
  readonly version: string;
  readonly root: string;
  readonly skills: readonly AdapterSkill[];
  readonly commands: readonly AdapterCommand[];
  readonly mcpPresets: readonly AdapterMcpPreset[];
  readonly configSchema?: MossPluginConfigSchema;
  readonly skipped: readonly string[];
}

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[./-][a-z0-9]+)*$/;
const EXACT_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Result of auditing a real DSH package without executing it. @beta */
export interface DshPackageCompatibilityReport {
  readonly compatible: boolean;
  readonly id?: string;
  readonly version?: string;
  readonly imported: readonly string[];
  readonly skipped: readonly string[];
  readonly reasons: readonly string[];
}

/** A safely mapped, data-only DSH package. @beta */
export interface ImportedDshPackage {
  readonly report: DshPackageCompatibilityReport;
  readonly plugin: MossPlugin;
  readonly configSchema?: MossPluginConfigSchema;
}

function invalid(message: string): MossError {
  return new MossError({ code: ErrorCode.USER_INPUT_INVALID, message });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalid(`${field} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw invalid(`${field} must be an array of strings`);
  }
  return value as string[];
}

function stringRecord(value: unknown, field: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const result = record(value, field);
  for (const [name, item] of Object.entries(result)) {
    if (typeof item !== 'string') throw invalid(`${field}.${name} must be a string`);
  }
  return result as Record<string, string>;
}

async function containedPath(root: string, relative: string, field: string): Promise<string> {
  if (path.isAbsolute(relative)) throw invalid(`${field} must be package-relative`);
  const target = await realpath(path.resolve(root, relative));
  const fromRoot = path.relative(root, target);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw invalid(`${field} escapes the DSH package root`);
  }
  return target;
}

function hasClientAbi(packageJson: Record<string, unknown>, patch: unknown): boolean {
  if (recordOrEmpty(packageJson.dsh).client !== undefined) return true;
  const dependencies = {
    ...recordOrEmpty(packageJson.dependencies),
    ...recordOrEmpty(packageJson.peerDependencies),
  };
  if (Object.keys(dependencies).some((name) => /dsh-(?:client|web)|dsh\/client/i.test(name))) {
    return true;
  }
  return /(?:dsh\.client|client\.slot|clientSlots|dsh-client)/i.test(JSON.stringify(patch));
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function optionalFile(root: string, name: string): Promise<string | undefined> {
  try {
    const target = await containedPath(root, name, name);
    await access(target);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseAdapterSkill(value: unknown, index: number): AdapterSkill {
  const item = record(value, `adapter.skills[${index}]`);
  return {
    id: stringField(item.id ?? item.name, `adapter.skills[${index}].id`),
    file: stringField(item.file, `adapter.skills[${index}].file`),
    ...(typeof item.name === 'string' ? { name: item.name } : {}),
    ...(typeof item.description === 'string' ? { description: item.description } : {}),
    ...(stringArray(item.triggers ?? item.trigger, `adapter.skills[${index}].triggers`)
      ? {
          triggers: stringArray(item.triggers ?? item.trigger, `adapter.skills[${index}].triggers`),
        }
      : {}),
  };
}

async function parsePackage(source: string): Promise<ParsedDshPackage> {
  const root = await realpath(path.resolve(source));
  const packagePath = await containedPath(root, 'package.json', 'package.json');
  const packageJson = record(JSON.parse(await readFile(packagePath, 'utf8')), packagePath);
  const id = stringField(packageJson.name, 'package.json.name')
    .replace(/^@/, '')
    .replaceAll('/', '-')
    .replace(/[^a-z0-9.-]+/gi, '-')
    .toLowerCase();
  const version = stringField(packageJson.version, 'package.json.version');
  if (!PLUGIN_ID_PATTERN.test(id))
    throw invalid(`package.json.name maps to an invalid plugin id: ${id}`);
  if (!EXACT_VERSION_PATTERN.test(version)) {
    throw invalid('package.json.version must be an exact semantic version');
  }
  const patchPath = await optionalFile(root, 'cordis.patch.yml');
  if (!patchPath) throw invalid('not a DSH package: cordis.patch.yml is missing');
  let patch: unknown;
  try {
    patch = parseYaml(await readFile(patchPath, 'utf8'), { maxAliasCount: 0 });
  } catch (error) {
    throw invalid(
      `cordis.patch.yml is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (hasClientAbi(packageJson, patch)) {
    throw invalid('DSH package requires unsupported Cordis client UI slots');
  }

  const adapterPath = await optionalFile(root, 'moss.dsh-adapter.json');
  const adapter = adapterPath
    ? record(JSON.parse(await readFile(adapterPath, 'utf8')), adapterPath)
    : {};
  const adapterSkills = adapter.skills ?? [];
  const adapterCommands = adapter.commands ?? [];
  const adapterMcp = adapter.mcpPresets ?? adapter.mcp ?? [];
  if (
    !Array.isArray(adapterSkills) ||
    !Array.isArray(adapterCommands) ||
    !Array.isArray(adapterMcp)
  ) {
    throw invalid('Moss DSH adapter contributions must be arrays');
  }
  const skills = adapterSkills.map(parseAdapterSkill);
  if (skills.length === 0) {
    const skillPath = await optionalFile(root, 'SKILL.md');
    if (skillPath) skills.push({ id, name: id, file: 'SKILL.md' });
  }
  const commands = adapterCommands.map((value, index): AdapterCommand => {
    const item = record(value, `adapter.commands[${index}]`);
    return {
      id: stringField(item.id, `adapter.commands[${index}].id`),
      title: stringField(item.title, `adapter.commands[${index}].title`),
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      prompt: stringField(item.prompt, `adapter.commands[${index}].prompt`),
    };
  });
  const mcpPresets = adapterMcp.map((value, index): AdapterMcpPreset => {
    const item = record(value, `adapter.mcp[${index}]`);
    const server = record(item.server ?? item, `adapter.mcp[${index}].server`);
    const args = stringArray(server.args, `adapter.mcp[${index}].args`);
    const env = stringRecord(server.env, `adapter.mcp[${index}].env`);
    return {
      id: stringField(item.id, `adapter.mcp[${index}].id`),
      displayName: stringField(item.displayName ?? item.name, `adapter.mcp[${index}].displayName`),
      command: stringField(server.command, `adapter.mcp[${index}].command`),
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
    };
  });
  const configSchema = adapter.configSchema
    ? typeof adapter.configSchema === 'string'
      ? parseMossPluginConfigSchema(
          JSON.parse(
            await readFile(
              await containedPath(root, adapter.configSchema, 'adapter.configSchema'),
              'utf8'
            )
          ),
          `${adapterPath}#configSchema`
        )
      : parseMossPluginConfigSchema(adapter.configSchema, `${adapterPath}#configSchema`)
    : undefined;
  if (skills.length + commands.length + mcpPresets.length + (configSchema ? 1 : 0) === 0) {
    throw invalid(
      'DSH package has no safely mappable SKILL.md or Moss adapter command/MCP/config declaration'
    );
  }
  return {
    id,
    version,
    root,
    skills,
    commands,
    mcpPresets,
    ...(configSchema ? { configSchema } : {}),
    skipped: Object.freeze(['cordis.patch.yml runtime']),
  };
}

/** Audit a real `package.json + cordis.patch.yml` DSH package without executing JavaScript. @beta */
export async function inspectDshPackageCompatibility(
  source: string
): Promise<DshPackageCompatibilityReport> {
  try {
    const parsed = await parsePackage(source);
    return Object.freeze({
      compatible: true,
      id: parsed.id,
      version: parsed.version,
      imported: Object.freeze([
        ...parsed.skills.map(({ id }) => `skill:${id}`),
        ...parsed.commands.map(({ id }) => `command:${id}`),
        ...parsed.mcpPresets.map(({ id }) => `mcp:${id}`),
        ...(parsed.configSchema ? ['config:schema'] : []),
      ]),
      skipped: parsed.skipped,
      reasons: Object.freeze([
        'Only package data and the explicit Moss DSH adapter are mapped; Cordis runtime JavaScript is not executed.',
      ]),
    });
  } catch (error) {
    let packageIdentity: { id?: string; version?: string } = {};
    try {
      const root = await realpath(path.resolve(source));
      const value = record(
        JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')),
        'package.json'
      );
      packageIdentity = {
        ...(typeof value.name === 'string' ? { id: value.name } : {}),
        ...(typeof value.version === 'string' ? { version: value.version } : {}),
      };
    } catch {}
    return Object.freeze({
      compatible: false,
      ...packageIdentity,
      imported: Object.freeze([]),
      skipped: Object.freeze(['Cordis runtime and client contributions']),
      reasons: Object.freeze([error instanceof Error ? error.message : String(error)]),
    });
  }
}

/** Import the safe declarative subset of a real DSH package as a Moss plugin. @beta */
export async function importDshPackage(source: string): Promise<ImportedDshPackage> {
  try {
    const parsed = await parsePackage(source);
    const report = await inspectDshPackageCompatibility(source);
    const plugin: MossPlugin = {
      id: parsed.id,
      async setup(context) {
        for (const skill of parsed.skills) {
          const sourcePath = await containedPath(parsed.root, skill.file, `skill ${skill.id}`);
          const raw = await readFile(sourcePath, 'utf8');
          const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
          if (!body) throw invalid(`DSH Skill ${skill.id} is empty`);
          context.registerSkill({
            stableId: skill.id,
            name: skill.name ?? skill.id,
            description: skill.description ?? `Imported data-only Skill from ${parsed.id}`,
            summary: skill.description ?? `Imported data-only Skill from ${parsed.id}`,
            sourcePath,
            version: parsed.version,
            tags: ['dsh-compatible'],
            trigger: [...(skill.triggers ?? [skill.id])],
            risk: 'low',
            permissions: { workspaceRead: true },
            enabled: true,
            updatedAt: 0,
            body,
          });
        }
        for (const command of parsed.commands) {
          context.registerCommand({
            id: command.id,
            title: command.title,
            ...(command.description ? { description: command.description } : {}),
            expand: (args) => command.prompt.replaceAll('{{args}}', args.trim()),
          });
        }
        for (const preset of parsed.mcpPresets) {
          context.registerMcpPreset({
            id: preset.id,
            displayName: preset.displayName,
            server: {
              command: preset.command,
              ...(preset.args ? { args: preset.args } : {}),
              ...(preset.env ? { env: preset.env } : {}),
            },
          });
        }
      },
    };
    return {
      report,
      plugin,
      ...(parsed.configSchema ? { configSchema: parsed.configSchema } : {}),
    };
  } catch (error) {
    throw wrapAsMoss(error, ErrorCode.USER_INPUT_INVALID, {
      message: `unable to import DSH package ${source}`,
      context: { source },
    });
  }
}
