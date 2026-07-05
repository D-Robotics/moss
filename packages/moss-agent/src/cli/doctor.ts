import fs from 'node:fs';
import path from 'node:path';
import { checkForCliUpdate } from './update-check.js';
import { SkillRegistry } from '../skills/index.js';
import { auditResolvedCliConfig, hasTrustedToolWildcard } from './config.js';
import type { ResolvedCliConfig } from './config.js';
import { loadMcpConfigWithDiagnostics } from '../mcp/index.js';
import { MIN_NODE_MAJOR, MIN_NODE_MINOR, nodeVersionProblem } from './node-version-check.js';
import { errorMessage } from '../errors.js';

interface DoctorOptions {
  config: ResolvedCliConfig;
  runtimeDir: string;
  currentVersion: string;
  safetyMode: string;
  detailMode: string;
  npmLatest?: string;
  updateFetchImpl?: typeof fetch;
}


async function checkSessionIntegrity(sessionsDir: string): Promise<string[]> {
  const lines: string[] = [];
  try {
    const files = await fs.promises.readdir(sessionsDir);
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) {
      lines.push(ok('sessions', 'no saved sessions yet'));
      return lines;
    }

    let totalCorrupt = 0;
    let corruptFiles = 0;
    let totalFiles = 0;

    for (const file of jsonlFiles) {
      totalFiles++;
      const filePath = path.join(sessionsDir, file);
      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        const contentLines = raw.split('\n').filter((l) => l.trim());
        let fileCorrupt = 0;
        for (const line of contentLines) {
          try {
            JSON.parse(line.includes('\t') ? line.split('\t')[0] : line);
          } catch {
            fileCorrupt++;
          }
        }
        if (fileCorrupt > 0) {
          corruptFiles++;
          totalCorrupt += fileCorrupt;
        }
      } catch {
        
      }
    }

    if (corruptFiles === 0) {
      lines.push(ok('sessions', `${totalFiles} file(s), all healthy`));
    } else {
      lines.push(
        warn(
          'sessions',
          `${corruptFiles}/${totalFiles} file(s) have ${totalCorrupt} corrupt line(s). ` +
            `Run \`moss doctor\` again with \`--verbose\` for per-file details, ` +
            `or start fresh sessions with \`moss\` if corruption is severe.`
        )
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      lines.push(ok('sessions', 'no sessions directory yet'));
    } else {
      lines.push(warn('sessions', `could not scan: ${errorMessage(err)}`));
    }
  }
  return lines;
}

function ok(label: string, detail: string): string {
  return `  ok    ${label}: ${detail}`;
}

function warn(label: string, detail: string): string {
  return `  warn  ${label}: ${detail}`;
}

function fail(label: string, detail: string): string {
  return `  fail  ${label}: ${detail}`;
}








export function cliDoctorHasFailure(report: string): boolean {
  return report.split('\n').some((line) => line.startsWith('  fail '));
}

export function renderNodeDoctorLine(version: string = process.version): string {
  return nodeVersionProblem(version)
    ? fail('node', `${version}; requires >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`)
    : ok('node', version);
}

function canWriteDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function sourceLooksEnv(source: string): boolean {
  return source.startsWith('MOSS_');
}

function renderMcpDoctor(config: ResolvedCliConfig): string {
  if (!config.mcpEnabled) {
    return ok('mcp', `disabled (${config.mcpEnabledSource}); config ${config.mcpConfigPath}`);
  }

  if (!fs.existsSync(config.mcpConfigPath)) {
    return fail(
      'mcp',
      `enabled (${config.mcpEnabledSource}) but config is missing at ${config.mcpConfigPath}`
    );
  }

  const mcpLoadResult = loadMcpConfigWithDiagnostics(config.mcpConfigPath);
  const mcpConfig = mcpLoadResult.config;
  if (!mcpConfig) {
    const invalidServerNames = mcpLoadResult.diagnostics
      .map((diagnostic) => diagnostic.serverName)
      .filter((serverName): serverName is string => Boolean(serverName));
    if (invalidServerNames.length > 0) {
      const allNeedCommand = mcpLoadResult.diagnostics.every((diagnostic) =>
        diagnostic.message.toLowerCase().includes('command')
      );
      const details = allNeedCommand
        ? 'each server needs a command'
        : mcpLoadResult.diagnostics
            .map((diagnostic) =>
              diagnostic.serverName
                ? `${diagnostic.serverName}: ${diagnostic.message}`
                : diagnostic.message
            )
            .join('; ');
      return fail('mcp', `invalid server entries (${invalidServerNames.join(', ')}); ${details}`);
    }
    return fail(
      'mcp',
      `enabled (${config.mcpEnabledSource}) but config is invalid at ${config.mcpConfigPath}`
    );
  }

  const serverNames = Object.keys(mcpConfig.mcpServers);
  if (serverNames.length === 0) {
    return warn(
      'mcp',
      `enabled (${config.mcpEnabledSource}) but no servers are configured at ${config.mcpConfigPath}`
    );
  }

  const invalidServers = serverNames.filter((name) => {
    const server = mcpConfig.mcpServers[name];
    return !server || typeof server.command !== 'string' || server.command.trim() === '';
  });
  if (invalidServers.length > 0) {
    return fail(
      'mcp',
      `invalid server entries (${invalidServers.join(', ')}); each server needs a command`
    );
  }

  return ok(
    'mcp',
    `enabled (${config.mcpEnabledSource}); ${serverNames.length} server(s) from ${config.mcpConfigPath}`
  );
}

function renderApprovalDoctor(config: ResolvedCliConfig): string[] {
  const lines: string[] = [
    ok('approval', `${config.approvalPolicy} (${config.approvalPolicySource})`),
  ];

  const auditWarnings = auditResolvedCliConfig(config);
  for (const auditWarning of auditWarnings) {
    const label = auditWarning.code.startsWith('trustedTools.')
      ? 'trustedTools'
      : 'approval policy';
    lines.push(warn(label, auditWarning.message));
  }

  const hasBroadTrustedPattern = auditWarnings.some(
    (entry) => entry.code === 'trustedTools.broad_patterns'
  );
  if (config.trustedTools.length > 0 && hasTrustedToolWildcard(config) && !hasBroadTrustedPattern) {
    lines.push(
      ok(
        'trustedTools',
        `${config.trustedTools.length} configured (${config.trustedToolsSource}); wildcard patterns are narrow`
      )
    );
  } else {
    lines.push(
      ok(
        'trustedTools',
        `${config.trustedTools.length ? config.trustedTools.join(', ') : 'none'} (${config.trustedToolsSource})`
      )
    );
  }

  return lines;
}

function renderBaseUrlDoctor(config: ResolvedCliConfig): string {
  if (config.usingBundledDefault) {
    return ok('baseUrl', 'built-in default (hidden)');
  }
  return ok('baseUrl', `${config.baseUrl} (${config.baseUrlSource})`);
}

function renderSkillsDoctor(workspace: string): string {
  // Best-effort: count loadable skills (builtin + RDK bundle + workspace +
  // global roots). A broken skill file is logged by the registry but doesn't
  // fail the count; doctor reports the total + how many are disabled.
  try {
    const registry = new SkillRegistry({ workspaceDir: workspace });
    const all = registry.list();
    const disabled = all.filter((s) => !s.enabled).length;
    if (all.length === 0) {
      return warn('skills', 'none loaded — run /skills in the TUI, or add SKILL.md under .moss/skills/');
    }
    const disabledFragment = disabled > 0 ? `; ${disabled} disabled` : '';
    return ok('skills', `${all.length} loadable skill${all.length === 1 ? '' : 's'} (builtin + RDK + workspace + global)${disabledFragment}`);
  } catch (err) {
    return warn('skills', `could not scan: ${errorMessage(err)}`);
  }
}

export async function renderCliDoctor(options: DoctorOptions): Promise<string> {
  const configDir = path.dirname(options.config.configPath);
  const lines = ['[doctor] Moss'];
  lines.push(renderNodeDoctorLine());
  lines.push(ok('version', options.currentVersion));
  const authDetail =
    options.config.apiKeySource === 'built-in'
      ? 'built-in, shared gateway key'
      : `${options.config.apiKeySource}, ${options.config.apiKeyEncrypted ? 'encrypted' : 'plain text'}`;
  lines.push(
    options.config.apiKey
      ? ok('auth', `configured (${authDetail})`)
      : fail('auth', 'missing API key; run moss setup')
  );
  
  
  if (options.config.usingBundledDefault) {
    lines.push(ok('built-in model', 'active (no API key needed)'));
  } else if (options.config.bundledDefaultSuppressedBy) {
    lines.push(
      ok('built-in model', `available but shadowed by ${options.config.bundledDefaultSuppressedBy}`)
    );
  }
  lines.push(ok('provider', `${options.config.provider} (${options.config.providerSource})`));
  
  
  
  
  
  if (!options.config.model) {
    lines.push(
      warn(
        'model',
        'no default model set; pick one at runtime with `/model`, or set a default via `moss config set model=<name>`'
      )
    );
  } else {
    lines.push(ok('model', `${options.config.model} (${options.config.modelSource})`));
  }
  lines.push(renderBaseUrlDoctor(options.config));
  lines.push(
    canWriteDir(options.config.workspace)
      ? ok('workspace', `${options.config.workspace} (${options.config.workspaceSource})`)
      : fail('workspace', `${options.config.workspace} is not writable`)
  );
  lines.push(
    canWriteDir(options.runtimeDir)
      ? ok('runtime', options.runtimeDir)
      : fail('runtime', `${options.runtimeDir} is not writable`)
  );
  lines.push(ok('config', options.config.configPath));
  
  if (configDir.includes(path.sep + 'dmoss') && !configDir.includes(path.sep + 'moss')) {
    lines.push(
      warn(
        'config path',
        'using legacy ~/.config/dmoss/ — run `moss migrate` to move config to ~/.config/moss/ (old directory still works)'
      )
    );
  }
  lines.push(...renderApprovalDoctor(options.config));
  lines.push(ok('detail', options.detailMode));

  
  const sessionsDir = path.join(options.runtimeDir, 'sessions');
  const sessionLines = await checkSessionIntegrity(sessionsDir);
  lines.push(...sessionLines);

  lines.push(renderMcpDoctor(options.config));

  lines.push(renderSkillsDoctor(options.config.workspace));

  const envSources = [
    options.config.workspaceSource,
    options.config.mcpEnabledSource,
    options.config.mcpConfigPathSource,
  ].filter(sourceLooksEnv);
  if (envSources.length > 0) {
    lines.push(warn('env overrides', [...new Set(envSources)].join(', ')));
  }
  
  
  if (options.config.ignoredModelEnvVars.length > 0) {
    
    
    
    
    const guidance = options.config.apiKey
      ? 'your moss config is already in use — these env vars are intentionally ignored'
      : 'run moss setup or moss config set to configure a model';
    lines.push(
      warn(
        'env ignored',
        `${options.config.ignoredModelEnvVars.join(', ')} — model settings come only from moss config; ${guidance}`
      )
    );
  }

  const notice = await checkForCliUpdate({
    configDir,
    currentVersion: options.currentVersion,
    timeoutMs: 1500,
    forceRefresh: true,
    fetchImpl: options.updateFetchImpl,
  });
  if (notice) {
    lines.push(
      warn('npm update', `${notice.currentVersion} -> ${notice.latestVersion}; run moss update`)
    );
  } else if (options.npmLatest && options.npmLatest !== options.currentVersion) {
    lines.push(
      warn(
        'npm registry',
        `latest is ${options.npmLatest}; installed source reports ${options.currentVersion}`
      )
    );
  } else {
    lines.push(ok('npm update', 'no newer registry version detected'));
  }

  return lines.join('\n');
}
