/**
 * `moss capabilities` — one screen that answers "what can this install do?".
 *
 * The audit (B129) found the capability surface scattered across `/skills`,
 * `/agents`, `moss device`, `moss mcp`, `moss skill` and the help banner: you
 * had to know six commands to see what is actually available. This aggregates
 * the registries that already exist (no new storage) into one read-only view,
 * with `--json` for scripts. It is a workspace command: no model configuration
 * required, so `moss doctor`-style checks work on a fresh machine too.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinTools } from '../tools/builtin.js';
import { DISPATCHABLE_SLASH_COMMANDS } from './interactive-commands.js';
import { reservedBuiltinNames, loadCustomCommands } from './commands/custom-commands.js';
import { defaultSkillDirSpecs, loadSkillCatalog } from '../core/skills/skill-registry.js';
import { loadAgentFiles } from '../core/subagent/agent-file-loader.js';
import { isFolderTrusted } from '../utils/folder-trust-store.js';
import { loadDeviceRegistry } from '../device/device-registry-file.js';
import { effectiveMcpConfigs } from './rdk-docs-mcp.js';
import { loadConfigFile } from './config.js';
import { resolveConfigDir } from './config.js';
import { isZhLocale } from './cli-locale.js';
import { uiText } from '../utils/ui-language.js';

export interface CapabilitiesSnapshot {
  version: 1;
  runtime: {
    moss: string;
    node: string;
    platform: string;
    arch: string;
    workspace: string;
    configDir: string;
  };
  surfaces: string[];
  tools: { total: number; device: number };
  slashCommands: { builtin: number };
  skills: { total: number; workspace: number; user: number; names: string[] };
  commands: { total: number; names: string[] };
  agents: { total: number; names: string[] };
  hooks: { total: number; events: Record<string, number> };
  mcp: { total: number; names: string[] };
  devices: { total: number; ids: string[] };
}

function readVersion(): string {
  try {
    const packageJson = path.resolve(import.meta.dirname, '../../package.json');
    const parsed = JSON.parse(fs.readFileSync(packageJson, 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function countHooks(configDir: string, workspaceDir: string): Record<string, number> {
  const events: Record<string, number> = {};
  const files = [
    path.join(configDir, 'config.json'),
    path.join(workspaceDir, '.moss', 'config.json'),
  ];
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        hooks?: Record<string, unknown>;
      };
      for (const [event, value] of Object.entries(raw.hooks ?? {})) {
        const list = Array.isArray(value) ? value : [];
        events[event] = (events[event] ?? 0) + list.length;
      }
    } catch {
      /* a missing or unreadable config contributes nothing */
    }
  }
  return events;
}

/**
 * B290: a user with many skills got a three-line name paragraph. Show a bounded
 * preview (`a, b, … +13 more`) instead of every name in the one-screen view.
 */
function previewNames(names: readonly string[], max = 8): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')}, ${uiText(`+${names.length - max} more`, `+${names.length - max} 个`)}`;
}

export function collectCapabilities(workspaceDir: string, configDir: string): CapabilitiesSnapshot {
  const deviceTools = builtinTools.filter((tool) => tool.name.startsWith('device_')).length;
  const skills = loadSkillCatalog(defaultSkillDirSpecs(workspaceDir, configDir));
  const commands = loadCustomCommands(
    { workspace: workspaceDir, configDir, reservedNames: reservedBuiltinNames() },
    () => {},
    'en'
  );
  // Project agents only load when the folder is trusted; showing them anyway
  // would advertise capabilities the run would refuse.
  const trusted = isFolderTrusted(configDir, workspaceDir);
  const agents = loadAgentFiles({
    workspaceDir,
    homeDir: os.homedir(),
    projectTrust: { trusted, claudeOptIn: trusted },
  }).agents;
  const devices = loadDeviceRegistry(workspaceDir);
  // B291: include the builtin rdk-docs exactly when `moss mcp list` does.
  let rdkDocsConfig: unknown;
  try {
    rdkDocsConfig = loadConfigFile().rdkDocs;
  } catch {
    rdkDocsConfig = undefined;
  }
  const mcp = effectiveMcpConfigs({
    workspaceDir,
    configDir,
    env: process.env,
    rdkDocs: rdkDocsConfig,
  });
  return {
    version: 1,
    runtime: {
      moss: readVersion(),
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      workspace: workspaceDir,
      configDir,
    },
    surfaces: ['tui', 'repl', 'headless', 'sdk'],
    tools: { total: builtinTools.length, device: deviceTools },
    slashCommands: { builtin: DISPATCHABLE_SLASH_COMMANDS.length },
    skills: {
      total: skills.length,
      workspace: skills.filter((skill) => skill.scope === 'workspace').length,
      user: skills.filter((skill) => skill.scope === 'user').length,
      names: skills.map((skill) => skill.name).sort(),
    },
    commands: {
      total: commands.length,
      names: commands.map((command) => command.name.replace(/^\//, '')).sort(),
    },
    agents: { total: agents.length, names: agents.map((agent) => agent.id).sort() },
    hooks: (() => {
      const events = countHooks(configDir, workspaceDir);
      const total = Object.values(events).reduce((sum, count) => sum + count, 0);
      return { total, events };
    })(),
    mcp: { total: mcp.length, names: mcp.map((server) => server.name).sort() },
    devices: {
      total: devices.length,
      ids: devices.map((device) => device.deviceId).sort(),
    },
  };
}

/** Sections `--kind` can narrow to; the text view shows one block. */
export const CAPABILITY_KINDS = [
  'runtime',
  'tools',
  'skills',
  'commands',
  'agents',
  'hooks',
  'mcp',
  'devices',
] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export function renderCapabilitiesUsage(zh = isZhLocale()): string {
  return zh
    ? [
        '用法：',
        '  moss capabilities [--json] [--kind <section>]',
        '',
        '一屏看清当前安装的能力：工具、内置斜杠命令、技能、自定义命令、子代理、',
        'hooks、MCP 服务器、已注册设备。只读，不需要模型配置。',
        '',
        `  可收窄的 section：${CAPABILITY_KINDS.join(' | ')}`,
        '',
        '示例：',
        '  moss capabilities',
        '  moss capabilities --json',
        '  moss capabilities --kind skills',
      ].join('\n')
    : [
        'Usage:',
        '  moss capabilities [--json] [--kind <section>]',
        '',
        'One screen for what this install can do: tools, built-in slash commands,',
        'skills, custom commands, sub-agents, hooks, MCP servers and registered devices.',
        'Read-only; needs no model configuration.',
        '',
        `  sections: ${CAPABILITY_KINDS.join(' | ')}`,
        '',
        'Examples:',
        '  moss capabilities',
        '  moss capabilities --json',
        '  moss capabilities --kind skills',
      ].join('\n');
}

export function renderCapabilities(
  snapshot: CapabilitiesSnapshot,
  zh = isZhLocale(),
  kind?: CapabilityKind
): string {
  const t = (en: string, cn: string): string => (zh ? cn : en);
  const blocks: { kind: CapabilityKind | 'head' | 'grow'; lines: string[] }[] = [
    {
      kind: 'head',
      lines: [
        t(
          `moss ${snapshot.runtime.moss} · node ${snapshot.runtime.node} · ${snapshot.runtime.platform}/${snapshot.runtime.arch}`,
          `moss ${snapshot.runtime.moss} · node ${snapshot.runtime.node} · ${snapshot.runtime.platform}/${snapshot.runtime.arch}`
        ),
        `${t('workspace', '工作区')}: ${snapshot.runtime.workspace}`,
        `${t('config', '配置')}: ${snapshot.runtime.configDir}`,
        '',
      ],
    },
    {
      kind: 'runtime',
      lines: [
        `${t('surfaces', '交互面')}: ${snapshot.surfaces.join(' · ')}`,
        `${t('built-in slash commands', '内置斜杠命令')}: ${snapshot.slashCommands.builtin}`,
      ],
    },
    {
      kind: 'tools',
      lines: [
        `${t('tools', '工具')}: ${snapshot.tools.total} ${t('built-in', '内置')} (${snapshot.tools.device} ${t('device', '设备')})`,
      ],
    },
    {
      kind: 'skills',
      lines: [
        `${t('skills', '技能')}: ${snapshot.skills.total} (${t('workspace', '工作区')} ${snapshot.skills.workspace} · ${t(
          'user',
          '用户'
        )} ${snapshot.skills.user})${snapshot.skills.names.length > 0 ? ` — ${previewNames(snapshot.skills.names)}` : ''}`,
      ],
    },
    {
      kind: 'commands',
      lines: [
        `${t('custom commands', '自定义命令')}: ${snapshot.commands.total}${
          snapshot.commands.names.length > 0
            ? ` — ${snapshot.commands.names.map((name) => `/${name}`).join(', ')}`
            : ''
        }`,
      ],
    },
    {
      kind: 'agents',
      lines: [
        `${t('sub-agents', '子代理')}: ${snapshot.agents.total}${
          snapshot.agents.names.length > 0 ? ` — ${previewNames(snapshot.agents.names)}` : ''
        }`,
      ],
    },
    {
      kind: 'hooks',
      lines: [
        `${t('hooks', '钩子')}: ${snapshot.hooks.total}${
          snapshot.hooks.total > 0
            ? ` — ${Object.entries(snapshot.hooks.events)
                .map(([event, count]) => `${event} ${count}`)
                .join(' · ')}`
            : ''
        }`,
      ],
    },
    {
      kind: 'mcp',
      lines: [
        `${t('MCP', 'MCP')}: ${snapshot.mcp.total}${
          snapshot.mcp.names.length > 0 ? ` — ${previewNames(snapshot.mcp.names)}` : ''
        }`,
      ],
    },
    {
      kind: 'devices',
      lines: [
        `${t('devices', '设备')}: ${snapshot.devices.total}${
          snapshot.devices.ids.length > 0 ? ` — ${previewNames(snapshot.devices.ids)}` : ''
        }`,
      ],
    },
    {
      kind: 'grow',
      lines: [
        '',
        t(
          'grow it: `moss skill create`, `.moss/commands/*.md`, `.moss/agents/*.md`, `moss plugins install`, `moss mcp add`',
          '扩展：`moss skill create`、`.moss/commands/*.md`、`.moss/agents/*.md`、`moss plugins install`、`moss mcp add`'
        ),
      ],
    },
  ];
  if (!kind) return blocks.flatMap((block) => block.lines).join('\n');
  const block = blocks.find((entry) => entry.kind === kind);
  if (!block) return '';
  const lines = [...block.lines];
  if (kind === 'runtime') lines.unshift(...blocks[0]!.lines);
  return lines.join('\n');
}

export interface CapabilitiesCommandContext {
  workspace: string;
  configDir?: string;
  outputJson?: boolean;
  output?: (stream: 'stdout' | 'stderr', text: string) => void;
}

export async function runCapabilitiesCommand(
  args: readonly string[],
  ctx: CapabilitiesCommandContext
): Promise<number> {
  const output =
    ctx.output ?? ((stream: 'stdout' | 'stderr', text: string) => process[stream].write(text));
  const zh = isZhLocale();
  let json = ctx.outputJson === true;
  let kind: CapabilityKind | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') {
      output('stdout', `${renderCapabilitiesUsage(zh)}\n`);
      return 0;
    } else if (arg === '--kind' || arg.startsWith('--kind=')) {
      const raw = (arg.includes('=') ? arg.slice('--kind='.length) : (args[++i] ?? '')).trim();
      if (!CAPABILITY_KINDS.includes(raw as CapabilityKind)) {
        output(
          'stderr',
          `unknown --kind ${raw || '(empty)'}; use ${CAPABILITY_KINDS.join(', ')}\n\n${renderCapabilitiesUsage(zh)}\n`
        );
        return 2;
      }
      kind = raw as CapabilityKind;
    } else {
      output('stderr', `unknown argument ${arg}\n\n${renderCapabilitiesUsage(zh)}\n`);
      return 2;
    }
  }
  if (kind && json) {
    output(
      'stderr',
      `${zh ? '--kind 只收窄文本视图；--json 已包含全部 section' : '--kind narrows the text view; --json already carries every section'}\n`
    );
    return 2;
  }
  const configDir = ctx.configDir ?? resolveConfigDir();
  const snapshot = {
    schema: 'moss_capabilities.v1' as const,
    ...collectCapabilities(ctx.workspace, configDir),
  };
  if (json) output('stdout', `${JSON.stringify(snapshot, null, 2)}\n`);
  else output('stdout', `${renderCapabilities(snapshot, zh, kind)}\n`);
  return 0;
}
