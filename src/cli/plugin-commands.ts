/**
 * `moss plugins validate|install|list|remove` — local capability packs.
 *
 * A pack is a directory with `plugin.json`; installing copies its skills,
 * slash commands and sub-agents into `.moss/`, merges its hooks into
 * `.moss/config.json` and its MCP servers into `.moss/mcp.json`, and records
 * exactly what it wrote in `.moss/plugins/<name>/installed.json` so `remove`
 * can take back only what the pack added. Installed files keep a sha256 so
 * `list` can show drift (a locally edited file is reported, not deleted).
 *
 * Packs are project code: hooks and stdio MCP run on the user's machine, so
 * install/remove require an explicit `--yes` (or an interactive confirmation)
 * and refuse in a non-interactive shell without it.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { uiText } from '../utils/ui-language.js';
import {
  describePlugin,
  sha256File,
  validatePlugin,
  type PluginFile,
  type PluginValidation,
} from '../core/skills/plugin-manifest.js';

/**
 * B287: installed-file records and `plugins list --json` are data, not OS paths;
 * a Windows install wrote `.moss\skills\…` and the same pack looked different in
 * CI reports. Normalize to `/` (fs access accepts both separators).
 */
function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/');
}

export const PLUGINS_SCHEMA = 'moss_plugins.v1';
export const PLUGIN_INSTALLED_SCHEMA = 'moss_plugin_installed.v1';

interface InstalledFile {
  path: string;
  sha256: string;
}

interface InstalledHook {
  event: string;
  hook: Record<string, unknown>;
}

export interface InstalledPlugin {
  schema: typeof PLUGIN_INSTALLED_SCHEMA;
  name: string;
  version: string;
  description?: string;
  source: string;
  installedAt: string;
  files: InstalledFile[];
  hooks: InstalledHook[];
  mcpServers: Record<string, unknown>;
}

interface InstallOptions {
  workspaceDir: string;
  sourceDir: string;
  force: boolean;
}

export function renderPluginsUsage(zh: boolean): string {
  if (zh) {
    return [
      '用法：',
      '  moss plugins list [--json]                 列出已安装的能力包与文件漂移',
      '  moss plugins validate <packDir> [--json]   校验 plugin.json 与组件（不写入任何东西）',
      '  moss plugins install <packDir> [--yes] [--force]',
      '  moss plugins remove <name> [--yes] [--force]',
      '',
      '能力包 = 一个目录 + plugin.json（skills / commands / agents / hooks / mcp 任意组合）。',
      '安装只写工作区 .moss/；hooks 合并进 .moss/config.json，MCP 合并进 .moss/mcp.json；',
      '不做 registry/marketplace，一张 git clone 就是合法的包。',
      '安装/卸载会写入项目代码（hook 与 stdio MCP 会执行命令），非交互环境必须显式 --yes。',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss plugins list [--json]                 list installed packs and file drift',
    '  moss plugins validate <packDir> [--json]   validate plugin.json and components (writes nothing)',
    '  moss plugins install <packDir> [--yes] [--force]',
    '  moss plugins remove <name> [--yes] [--force]',
    '',
    'A pack is a directory with plugin.json (any of skills / commands / agents / hooks / mcp).',
    'Assets go under .moss/; hooks merge into .moss/config.json and MCP into .moss/mcp.json.',
    'No registry or marketplace: a pack is whatever you can copy or git clone.',
    'install/remove write project code (hooks and stdio MCP execute commands); a non-interactive',
    'shell must pass --yes explicitly.',
  ].join('\n');
}

function installedDir(workspaceDir: string, name: string): string {
  return path.join(workspaceDir, '.moss', 'plugins', name);
}

function installedFile(workspaceDir: string, name: string): string {
  return path.join(installedDir(workspaceDir, name), 'installed.json');
}

function readInstalled(workspaceDir: string, name: string): InstalledPlugin | undefined {
  const file = installedFile(workspaceDir, name);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as InstalledPlugin;
    if (raw.schema !== PLUGIN_INSTALLED_SCHEMA) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

function listInstalled(workspaceDir: string): InstalledPlugin[] {
  const dir = path.join(workspaceDir, '.moss', 'plugins');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => readInstalled(workspaceDir, name))
    .filter((entry): entry is InstalledPlugin => entry !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch {
    // Missing or invalid: install will create it; remove reports the problem.
  }
  return undefined;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function projectsHooks(workspaceDir: string): Record<string, unknown[]> {
  const file = path.join(workspaceDir, '.moss', 'config.json');
  const config = readJsonObject(file);
  const hooks = config?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return {};
  const out: Record<string, unknown[]> = {};
  for (const [event, list] of Object.entries(hooks as Record<string, unknown>)) {
    if (Array.isArray(list)) out[event] = [...list];
  }
  return out;
}

function projectsMcpServers(workspaceDir: string): Record<string, unknown> {
  const file = path.join(workspaceDir, '.moss', 'mcp.json');
  const raw = readJsonObject(file);
  if (!raw) return {};
  const servers = raw.mcpServers ?? raw;
  return servers && typeof servers === 'object' && !Array.isArray(servers)
    ? { ...(servers as Record<string, unknown>) }
    : {};
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) out.push(absolute);
    }
  };
  visit(dir);
  return out;
}

/** Everything the pack would install, as workspace-relative destinations. */
function planInstall(validation: PluginValidation): PluginFile[] {
  const manifest = validation.manifest;
  if (!manifest) return [];
  const planned: PluginFile[] = [...validation.files];
  const root = validation.root;
  for (const skillsDir of manifest.skills ?? []) {
    const absoluteSkills = path.resolve(root, skillsDir);
    for (const entry of fs.readdirSync(absoluteSkills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillRoot = path.join(absoluteSkills, entry.name);
      for (const file of walkFiles(skillRoot)) {
        planned.push({
          from: path.relative(root, file),
          to: path.join('.moss', 'skills', entry.name, path.relative(skillRoot, file)),
          sha256: sha256File(file),
        });
      }
    }
  }
  const normalized = planned.map((file) => ({ ...file, to: toPosixPath(file.to) }));
  const deduped = new Map<string, PluginFile>();
  for (const file of normalized) deduped.set(file.to, file);
  return [...deduped.values()].sort((a, b) => a.to.localeCompare(b.to));
}

async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Files recorded by a previous install that are still untouched are kept. */
function carryFiles(
  workspaceDir: string,
  previous: InstalledPlugin | undefined,
  plan: PluginFile[]
): InstalledFile[] {
  const byPath = new Map<string, InstalledFile>();
  for (const file of plan) byPath.set(file.to, { path: file.to, sha256: file.sha256 });
  for (const file of previous?.files ?? []) {
    const installedPath = toPosixPath(file.path);
    if (byPath.has(installedPath)) continue;
    const target = path.join(workspaceDir, installedPath);
    if (!fs.existsSync(target)) continue;
    try {
      if (sha256File(target) === file.sha256)
        byPath.set(installedPath, { path: installedPath, sha256: file.sha256 });
    } catch {
      // Unreadable: do not claim it.
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** MCP servers from a previous install that are still configured unchanged. */
function carryMcpServers(
  workspaceDir: string,
  previous: InstalledPlugin | undefined,
  next: Record<string, unknown>
): Record<string, unknown> {
  const current = projectsMcpServers(workspaceDir);
  const merged: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(previous?.mcpServers ?? {})) {
    if (sameJson(current[name], config)) merged[name] = config;
  }
  return { ...merged, ...next };
}

/** Copy the plan, merge hooks/MCP, then record the install atomically enough. */
function applyInstall(
  options: InstallOptions,
  validation: PluginValidation
): InstalledPlugin | string[] {
  const { workspaceDir, sourceDir, force } = options;
  const manifest = validation.manifest;
  if (!manifest) return ['pack has no manifest'];
  const plan = planInstall(validation);
  const conflicts = plan.filter((file) => {
    const target = path.join(workspaceDir, file.to);
    if (!fs.existsSync(target)) return false;
    try {
      return sha256File(target) !== file.sha256;
    } catch {
      return true;
    }
  });
  if (conflicts.length > 0 && !force) {
    return conflicts.map((file) => `already exists with different content: ${file.to}`);
  }
  const workspaceMcp = projectsMcpServers(workspaceDir);
  const mcpConflicts = Object.entries(validation.mcpServers).filter(([name, config]) => {
    const existing = workspaceMcp[name];
    return existing !== undefined && !sameJson(existing, config);
  });
  if (mcpConflicts.length > 0 && !force) {
    return mcpConflicts.map(([name]) => `MCP server already configured differently: ${name}`);
  }
  for (const file of plan) {
    const target = path.join(workspaceDir, file.to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceDir, file.from), target);
  }
  // Re-install must not forget what a previous version installed and is still
  // live: carry over recorded entries that are still present, then add the new.
  const previous = readInstalled(workspaceDir, manifest.name);
  const installedHooks: InstalledHook[] = [];
  {
    const hooks = projectsHooks(workspaceDir);
    for (const entry of previous?.hooks ?? []) {
      if ((hooks[entry.event] ?? []).some((candidate) => sameJson(candidate, entry.hook))) {
        installedHooks.push(entry);
      }
    }
  }
  if (validation.hooks.length > 0) {
    const hooks = projectsHooks(workspaceDir);
    for (const entry of validation.hooks) {
      const list = hooks[entry.event] ?? [];
      // Re-installing (or --force after a manual remove) must not duplicate a
      // hook that is already there; only record what this install added.
      if (list.some((candidate) => sameJson(candidate, entry.hook))) continue;
      hooks[entry.event] = [...list, entry.hook];
      installedHooks.push(entry);
    }
    const file = path.join(workspaceDir, '.moss', 'config.json');
    const config = readJsonObject(file) ?? {};
    writeJson(file, { ...config, hooks });
  }
  if (Object.keys(validation.mcpServers).length > 0) {
    const file = path.join(workspaceDir, '.moss', 'mcp.json');
    writeJson(file, { mcpServers: { ...workspaceMcp, ...validation.mcpServers } });
  }
  const record: InstalledPlugin = {
    schema: PLUGIN_INSTALLED_SCHEMA,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description ? { description: manifest.description } : {}),
    source: path.resolve(sourceDir),
    installedAt: new Date().toISOString(),
    files: carryFiles(workspaceDir, previous, plan),
    hooks: installedHooks,
    mcpServers: carryMcpServers(workspaceDir, previous, validation.mcpServers),
  };
  writeJson(installedFile(workspaceDir, manifest.name), record);
  return record;
}

export interface PluginsCommandOptions {
  workspaceDir: string;
  zh?: boolean;
  /** For tests/hosts: assume an interactive "yes" without touching stdin. */
  assumeYes?: boolean;
  /** `--json` is a global output flag, so the dispatcher passes it explicitly. */
  json?: boolean;
}

export async function runPluginsCommand(
  argv: readonly string[],
  options: PluginsCommandOptions
): Promise<number> {
  const zh = options.zh ?? false;
  const [sub, ...rest] = argv;
  const yes = rest.includes('--yes') || options.assumeYes === true;
  const force = rest.includes('--force');
  const json = options.json === true || rest.includes('--json');
  const positional = rest.filter((arg) => !arg.startsWith('--'));

  if (sub === undefined || sub === '--help' || sub === '-h') {
    console.error(renderPluginsUsage(zh));
    return sub === undefined ? 2 : 0;
  }

  if (sub === 'list') {
    const installed = listInstalled(options.workspaceDir);
    const rows = installed.map((plugin) => {
      const changed: string[] = [];
      const missing: string[] = [];
      for (const file of plugin.files) {
        const target = path.join(options.workspaceDir, file.path);
        if (!fs.existsSync(target)) {
          missing.push(file.path);
          continue;
        }
        try {
          if (sha256File(target) !== file.sha256) changed.push(file.path);
        } catch {
          missing.push(file.path);
        }
      }
      return { ...plugin, drift: { changed, missing } };
    });
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ schema: PLUGINS_SCHEMA, plugins: rows }, null, 2)}\n`
      );
      return 0;
    }
    if (rows.length === 0) {
      console.error(uiText('No capability packs installed.', '未安装能力包。'));
      return 0;
    }
    console.error(
      uiText(`Installed packs (${String(rows.length)})`, `已安装能力包（${String(rows.length)}）`)
    );
    for (const row of rows) {
      console.error(
        `  ${row.name} ${row.version}  ${row.files.length} file(s), ${String(row.hooks.length)} hook(s), ${String(Object.keys(row.mcpServers).length)} MCP server(s)`
      );
      if (row.description) console.error(`    ${row.description}`);
      if (row.drift.changed.length > 0) {
        console.error(
          uiText(
            `    ! locally edited: ${row.drift.changed.join(', ')}`,
            `    ! 本地已修改：${row.drift.changed.join(', ')}`
          )
        );
      }
      if (row.drift.missing.length > 0) {
        console.error(
          uiText(
            `    ! missing: ${row.drift.missing.join(', ')}`,
            `    ! 缺失：${row.drift.missing.join(', ')}`
          )
        );
      }
    }
    return 0;
  }

  if (sub === 'validate') {
    const source = positional[0];
    if (!source) {
      console.error(renderPluginsUsage(zh));
      return 2;
    }
    const validation = validatePlugin(source);
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            schema: 'moss_plugin_validation.v1',
            root: validation.root,
            manifest: validation.manifest,
            errors: validation.errors,
            warnings: validation.warnings,
            files: validation.files,
            hooks: validation.hooks,
            mcpServers: Object.keys(validation.mcpServers),
          },
          null,
          2
        )}\n`
      );
    } else {
      console.error(uiText(`Pack ${validation.root}`, `能力包 ${validation.root}`));
      if (validation.manifest) {
        console.error(
          `  ${validation.manifest.name} ${validation.manifest.version} · ${describePlugin(validation.manifest)}`
        );
      }
      console.error(
        `  ${String(validation.files.length)} file(s), ${String(validation.hooks.length)} hook(s), ${String(Object.keys(validation.mcpServers).length)} MCP server(s)`
      );
      for (const warning of validation.warnings) console.error(`  warning: ${warning}`);
      for (const error of validation.errors) console.error(`  error: ${error}`);
      console.error(
        validation.errors.length === 0
          ? uiText('  valid', '  校验通过')
          : uiText(
              `  ${String(validation.errors.length)} error(s)`,
              `  ${String(validation.errors.length)} 个错误`
            )
      );
    }
    return validation.errors.length === 0 ? 0 : 1;
  }

  if (sub === 'install') {
    const source = positional[0];
    if (!source) {
      console.error(renderPluginsUsage(zh));
      return 2;
    }
    const validation = validatePlugin(source);
    if (validation.errors.length > 0 || !validation.manifest) {
      for (const error of validation.errors) console.error(`error: ${error}`);
      console.error(uiText('not installing an invalid pack', '能力包无效，未安装'));
      return 1;
    }
    const manifest = validation.manifest;
    if (!yes) {
      const message = uiText(
        `Install pack "${manifest.name}" ${manifest.version}? It writes .moss/ files and runs project hooks/MCP.`,
        `安装能力包 "${manifest.name}" ${manifest.version}？它会写入 .moss/ 并运行项目 hook/MCP。`
      );
      if (!(await confirm(message))) {
        console.error(
          uiText(
            'refused: pass --yes to install a pack in a non-interactive shell',
            '已拒绝：非交互环境请显式传 --yes'
          )
        );
        return 2;
      }
    }
    const applied = applyInstall(
      {
        workspaceDir: options.workspaceDir,
        sourceDir: validation.root,
        force,
      },
      validation
    );
    if (Array.isArray(applied)) {
      for (const conflict of applied) console.error(`conflict: ${conflict}`);
      console.error(
        uiText('nothing was changed; pass --force to overwrite', '未做任何修改；用 --force 覆盖')
      );
      return 1;
    }
    console.error(
      uiText(
        `installed ${applied.name} ${applied.version}: ${String(applied.files.length)} file(s), ${String(applied.hooks.length)} hook(s), ${String(Object.keys(applied.mcpServers).length)} MCP server(s)`,
        `已安装 ${applied.name} ${applied.version}：${String(applied.files.length)} 个文件、${String(applied.hooks.length)} 个 hook、${String(Object.keys(applied.mcpServers).length)} 个 MCP server`
      )
    );
    console.error(
      uiText(
        'restart the session (or run /skills, /agents) to pick up the installed assets',
        '重启会话（或运行 /skills、/agents）后可见'
      )
    );
    return 0;
  }

  if (sub === 'remove') {
    const name = positional[0];
    if (!name) {
      console.error(renderPluginsUsage(zh));
      return 2;
    }
    const record = readInstalled(options.workspaceDir, name);
    if (!record) {
      console.error(uiText(`pack "${name}" is not installed`, `能力包 "${name}" 未安装`));
      return 1;
    }
    if (!yes && !(await confirm(uiText(`Remove pack "${name}"?`, `卸载能力包 "${name}"？`)))) {
      console.error(uiText('refused: pass --yes to remove a pack', '已拒绝：请显式传 --yes'));
      return 2;
    }
    const removed: string[] = [];
    const drifted: string[] = [];
    for (const file of record.files) {
      const target = path.join(options.workspaceDir, file.path);
      if (!fs.existsSync(target)) continue;
      let current: string | undefined;
      try {
        current = sha256File(target);
      } catch {
        current = undefined;
      }
      if (current !== file.sha256 && !force) {
        drifted.push(file.path);
        continue;
      }
      fs.rmSync(target, { force: true });
      removed.push(file.path);
    }
    let hooksRemoved = 0;
    if (record.hooks.length > 0) {
      const hooks = projectsHooks(options.workspaceDir);
      for (const entry of record.hooks) {
        const list = hooks[entry.event] ?? [];
        const index = list.findIndex((candidate) => sameJson(candidate, entry.hook));
        if (index >= 0) {
          list.splice(index, 1);
          hooksRemoved += 1;
        }
      }
      // B306: the pack created these files during install; leaving `hooks: []`
      // behind made an empty config look user-authored.
      const remaining = Object.fromEntries(
        Object.entries(hooks).filter(([, list]) => Array.isArray(list) && list.length > 0)
      );
      const configFile = path.join(options.workspaceDir, '.moss', 'config.json');
      const config = readJsonObject(configFile) ?? {};
      if (Object.keys(remaining).length > 0) writeJson(configFile, { ...config, hooks: remaining });
      else {
        delete (config as { hooks?: unknown }).hooks;
        if (Object.keys(config).length > 0) writeJson(configFile, config);
        else fs.rmSync(configFile, { force: true });
      }
    }
    let serversRemoved = 0;
    if (Object.keys(record.mcpServers).length > 0) {
      const servers = projectsMcpServers(options.workspaceDir);
      for (const [name, config] of Object.entries(record.mcpServers)) {
        if (sameJson(servers[name], config)) {
          delete servers[name];
          serversRemoved += 1;
        }
      }
      const mcpFile = path.join(options.workspaceDir, '.moss', 'mcp.json');
      if (Object.keys(servers).length > 0) writeJson(mcpFile, { mcpServers: servers });
      else fs.rmSync(mcpFile, { force: true });
    }
    fs.rmSync(installedDir(options.workspaceDir, name), { recursive: true, force: true });
    // B306: the pack registry directory itself is pack-managed; remove it when
    // the last pack goes, instead of leaving an empty `.moss/plugins/`.
    const registryDir = path.join(options.workspaceDir, '.moss', 'plugins');
    try {
      if (fs.readdirSync(registryDir).length === 0) fs.rmdirSync(registryDir);
    } catch {
      // Missing or unreadable: nothing to clean up.
    }
    console.error(
      uiText(
        `removed ${name}: ${String(removed.length)} file(s)` +
          (hooksRemoved > 0 ? `, ${String(hooksRemoved)} hook(s)` : '') +
          (serversRemoved > 0 ? `, ${String(serversRemoved)} MCP server(s)` : ''),
        `已卸载 ${name}：${String(removed.length)} 个文件` +
          (hooksRemoved > 0 ? `、${String(hooksRemoved)} 条 hook` : '') +
          (serversRemoved > 0 ? `、${String(serversRemoved)} 个 MCP 服务器` : '')
      )
    );
    for (const file of drifted) {
      console.error(
        uiText(
          `kept locally edited file: ${file} (pass --force to delete it)`,
          `保留本地已修改文件：${file}（传 --force 可强制删除）`
        )
      );
    }
    return 0;
  }

  console.error(renderPluginsUsage(zh));
  return 2;
}
