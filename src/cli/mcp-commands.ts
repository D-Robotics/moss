/**
 * `moss mcp <subcommand>` — the lifecycle surface for MCP servers, writing the
 * same `.moss/mcp.json` (project) / `<configDir>/mcp.json` (user) files the
 * loader reads. Credential values stay `${ENV_VAR}` references: the command
 * layer never resolves or stores secrets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { McpClient } from '../core/mcp/client.js';
import type { McpServerConfig } from '../core/mcp/types.js';
import { isZhLocale } from './cli-locale.js';
import { loadMcpConfigs } from './mcp-config.js';

const SERVER_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

export function renderMcpUsage(zh: boolean = isZhLocale()): string {
  if (zh) {
    return [
      '用法：',
      '  moss mcp add <name> <command...>            stdio 服务器（参数跟在命令后）',
      '  moss mcp add <name> <url> [--header k=v]    http 服务器',
      '  moss mcp add --project <name> <command...>  写入 .moss/mcp.json 而非用户级文件',
      '  moss mcp list                               查看已配置的服务器与文件',
      '  moss mcp remove <name> [--project]          删除一个服务器',
      '  moss mcp test <name>                        立即连接并列出工具',
      '',
      '值支持 ${ENV_VAR} 引用——凭据只留在环境变量里。',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss mcp add <name> <command...>            stdio server (args after the command)',
    '  moss mcp add <name> <url> [--header k=v]    http server',
    '  moss mcp add --project <name> <command...>  write .moss/mcp.json instead of the user file',
    '  moss mcp list                               show configured servers and files',
    '  moss mcp remove <name> [--project]          drop a server',
    '  moss mcp test <name>                        connect + tools/list now',
    '',
    'Values support ${ENV_VAR} references — credentials stay in the environment.',
  ].join('\n');
}

function serverFilePath(kind: 'project' | 'user', workspaceDir: string, configDir: string): string {
  return kind === 'project'
    ? path.join(workspaceDir, '.moss', 'mcp.json')
    : path.join(configDir, 'mcp.json');
}

function readRawServers(filePath: string): Record<string, Record<string, unknown>> {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const servers = (raw as { mcpServers?: unknown }).mcpServers ?? raw;
      if (typeof servers === 'object' && servers !== null && !Array.isArray(servers)) {
        const out: Record<string, Record<string, unknown>> = {};
        for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
          if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
            out[name] = entry as Record<string, unknown>;
          }
        }
        return out;
      }
    }
  } catch {
    /* missing/broken file starts empty */
  }
  return {};
}

function writeRawServers(filePath: string, servers: Record<string, Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 'utf-8');
}

/** Validate a candidate entry BEFORE it is written; returns the first problem. */
export function validateServerEntry(
  name: string,
  entry: Record<string, unknown>
): string | undefined {
  if (!SERVER_NAME_RE.test(name)) return `name "${name}" must be alphanumeric/-/_/.`;
  const transport = entry.transport === 'http' ? 'http' : 'stdio';
  if (transport === 'http') {
    const url = entry.url;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      return 'http transport requires an http(s) "url"';
    }
  } else {
    if (typeof entry.command !== 'string' || !entry.command.trim()) {
      return 'stdio transport requires a non-empty "command"';
    }
  }
  if (entry.args !== undefined && !Array.isArray(entry.args)) return '"args" must be an array';
  for (const field of ['env', 'headers'] as const) {
    const value = entry[field];
    if (value === undefined) continue;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `"${field}" must be an object`;
    }
  }
  return undefined;
}

export interface McpCommandContext {
  workspaceDir: string;
  configDir: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Build a raw (unexpanded) server entry from `moss mcp add` argv. Values keep
 * their `${VAR}` references verbatim — expansion belongs to the loader.
 * Grammar: <command...> | <url> [--header k=v]... (options may trail either).
 */
export function buildEntryFromArgv(
  argv: readonly string[]
): Record<string, unknown> | { error: string } {
  const headers: Record<string, string> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const token = argv[i] ?? '';
    if (token === '--header' || token === '-H') {
      const pair = argv[i + 1];
      if (pair === undefined || !pair.includes('=')) {
        return { error: '--header expects k=v (repeatable)' };
      }
      const eq = pair.indexOf('=');
      headers[pair.slice(0, eq)] = pair.slice(eq + 1);
      i += 2;
      continue;
    }
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('-') && token.length > 1 && positional.length === 0) {
      return { error: `unknown option "${token}"` };
    }
    positional.push(token);
    i += 1;
  }
  if (positional.length === 0) return { error: 'a command or url is required' };
  const first = positional[0] ?? '';
  if (/^https?:\/\//.test(first)) {
    if (positional.length > 1) {
      return { error: 'extra args after a url are not valid for http servers' };
    }
    return { transport: 'http', url: first, ...(Object.keys(headers).length ? { headers } : {}) };
  }
  if (Object.keys(headers).length > 0) {
    return { error: '--header applies to http servers only' };
  }
  return {
    transport: 'stdio',
    command: first,
    ...(positional.length > 1 ? { args: positional.slice(1) } : {}),
  };
}

export async function runMcpCommand(argv: string[], ctx: McpCommandContext): Promise<number> {
  const out = (text: string) => process.stdout.write(`${text}\n`);
  const err = (text: string) => process.stderr.write(`${text}\n`);
  const sub = argv[0] ?? 'list';
  const zh = isZhLocale();

  const parseScope = (rest: string[]): { scope: 'project' | 'user'; rest: string[] } => {
    if (rest[0] === '--project') return { scope: 'project', rest: rest.slice(1) };
    return { scope: 'user', rest };
  };

  if (sub === 'add') {
    const { scope, rest } = parseScope(argv.slice(1));
    const name = rest[0];
    if (!name) {
      err(
        'moss mcp add: ' +
          (zh ? '需要服务器名。\n\n' : 'a server name is required.\n\n') +
          renderMcpUsage(zh)
      );
      return 2;
    }
    const built = buildEntryFromArgv(rest.slice(1));
    if ('error' in built) {
      err(`moss mcp add: ${built.error}`);
      return 2;
    }
    const invalid = validateServerEntry(name, built);
    if (invalid) {
      err(`moss mcp add: ${invalid}`);
      return 2;
    }
    const filePath = serverFilePath(scope, ctx.workspaceDir, ctx.configDir);
    const servers = readRawServers(filePath);
    if (servers[name]) {
      err(
        zh
          ? `moss mcp add: "${name}" 已存在于 ${filePath}（先 moss mcp remove ${name}）`
          : `moss mcp add: "${name}" already exists in ${filePath} (moss mcp remove ${name} first)`
      );
      return 1;
    }
    servers[name] = built;
    writeRawServers(filePath, servers);
    out(
      zh
        ? `已添加 ${name}（${built.transport}）到 ${filePath}`
        : `Added ${name} (${built.transport}) to ${filePath}`
    );
    out(zh ? `现在验证：moss mcp test ${name}` : `Test it now: moss mcp test ${name}`);
    return 0;
  }

  if (sub === 'list') {
    const merged = loadMcpConfigs(ctx.workspaceDir, ctx.configDir, ctx.env ?? process.env);
    if (merged.length === 0) {
      out(
        zh
          ? '未配置 MCP 服务器。添加一个：moss mcp add <name> <command...>'
          : 'No MCP servers configured. Add one: moss mcp add <name> <command...>'
      );
      return 0;
    }
    for (const config of merged) {
      const where = config.transport === 'http' ? config.url : config.command;
      out(`  ${config.name.padEnd(18)} ${config.transport.padEnd(6)} ${where ?? ''}`);
    }
    out(
      zh
        ? `\n共 ${merged.length} 个服务器。moss mcp test <name> 可立即检测。`
        : `\n${merged.length} server(s). moss mcp test <name> checks one now.`
    );
    return 0;
  }

  if (sub === 'remove') {
    const { scope, rest } = parseScope(argv.slice(1));
    const name = rest[0];
    if (!name) {
      err(zh ? 'moss mcp remove: 需要服务器名。' : 'moss mcp remove: a server name is required.');
      return 2;
    }
    const filePath = serverFilePath(scope, ctx.workspaceDir, ctx.configDir);
    const servers = readRawServers(filePath);
    if (!servers[name]) {
      err(
        zh
          ? `moss mcp remove: "${name}" 不在 ${filePath} 中`
          : `moss mcp remove: "${name}" is not in ${filePath}`
      );
      return 1;
    }
    delete servers[name];
    writeRawServers(filePath, servers);
    out(zh ? `已从 ${filePath} 删除 ${name}` : `Removed ${name} from ${filePath}`);
    return 0;
  }

  if (sub === 'test') {
    const name = argv[1];
    if (!name) {
      err(zh ? 'moss mcp test: 需要服务器名。' : 'moss mcp test: a server name is required.');
      return 2;
    }
    const merged = loadMcpConfigs(ctx.workspaceDir, ctx.configDir, ctx.env ?? process.env);
    const config: McpServerConfig | undefined = merged.find((c) => c.name === name);
    if (!config) {
      err(
        zh
          ? `moss mcp test: "${name}" 未配置（查看 moss mcp list）`
          : `moss mcp test: "${name}" is not configured (moss mcp list)`
      );
      return 1;
    }
    out(
      zh
        ? `正在连接 ${name}（${config.transport}）…`
        : `Connecting to ${name} (${config.transport})…`
    );
    const client = new McpClient(config, { connectTimeoutMs: 10_000, requestTimeoutMs: 10_000 });
    try {
      await client.connect();
      const tools = await client.listTools();
      out(zh ? `  已连接 — ${tools.length} 个工具` : `  connected — ${tools.length} tool(s)`);
      for (const tool of tools.slice(0, 5)) out(`    · ${tool.name}`);
      if (tools.length > 5)
        out(zh ? `    … 还有 ${tools.length - 5} 个` : `    … ${tools.length - 5} more`);
      return 0;
    } catch (failure) {
      err(
        zh
          ? `  失败：${failure instanceof Error ? failure.message.split('\n')[0] : String(failure)}`
          : `  failed: ${failure instanceof Error ? failure.message.split('\n')[0] : String(failure)}`
      );
      err(
        zh
          ? '  请检查 command/url、${ENV_VAR} 展开以及服务器是否在运行。'
          : '  check the command/url, ${ENV_VAR} expansion, and that the server runs.'
      );
      return 1;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  err(renderMcpUsage(zh));
  return 2;
}
