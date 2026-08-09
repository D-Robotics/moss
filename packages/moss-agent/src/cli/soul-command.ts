import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MossSoul } from '@rdk-moss/core';
import type { MossAgent } from '../core/index.js';
import { resolveSoul, resolveSoulIdentity } from '../core/agent/soul.js';
import { ProcessError, runProcess, type RunProcessResult } from '../utils/run-process.js';

export interface SoulCliPaths {
  workspace: string;
  configDir: string;
}

export interface SoulDisplay {
  soul: MossSoul;
  label: string;
  workspacePath: string;
  globalPath: string;
  activePath?: string;
}

export type SoulFileTarget = 'workspace' | 'global';

const SKILLHUB_INSTALLER_URL =
  'https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/install.sh';
const SKILLHUB_KIT_URL =
  'https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/latest.tar.gz';

export interface SkillHubSoulChoice {
  code: string;
  name: string;
  summary: string;
}

export const SKILLHUB_SOULS: readonly SkillHubSoulChoice[] = [
  { code: 'YYDS', name: '神人', summary: '局势越乱越自信，主动破局' },
  { code: 'HHHH', name: '幽默者', summary: '用幽默化解压力与尴尬' },
  { code: 'MIAO', name: '喵之人', summary: '可爱、跳脱、充满随机感' },
  { code: 'OH-NO', name: '哦不人', summary: '风险雷达敏锐，谨慎可靠' },
  { code: 'WHY', name: '疑问者', summary: '持续追问，寻找根因' },
  { code: 'GRASS', name: '草人', summary: '直接犀利，话糙理不糙' },
  { code: 'MONK', name: '僧侣', summary: '沉静通透，古风哲思' },
  { code: 'MUM', name: '妈妈', summary: '温柔体贴，稳定支持' },
  { code: 'SOLO', name: '独行者', summary: '敏感慢热，重视安全感' },
  { code: 'GOOD', name: '好人', summary: '温和可靠，善于补位' },
  { code: 'MALO', name: '吗喽', summary: '外向高能，快乐行动派' },
  { code: 'FAKE', name: '假面人', summary: '善读情境，灵活适配' },
  { code: 'LOVE-R', name: '情种', summary: '浪漫细腻，内心戏丰富' },
  { code: 'ZZZZ', name: '装睡者', summary: '低调蓄力，关键时刻出手' },
  { code: 'WORK-er', name: '工作者', summary: '自嘲但可靠，持续推进' },
  { code: 'GOGO', name: '行人', summary: '永远在路上，边冲边调整' },
] as const;

const SOUL_TEMPLATE = `---
id: workspace-persona
mode: replace
---

# Who I am

I am a focused engineering partner. I communicate clearly, make evidence-based decisions,
and prefer small, verifiable changes over speculative complexity.

# How I work

- State important assumptions before acting.
- Explain tradeoffs briefly and recommend one path.
- Verify changes with the narrowest useful test.
- Never claim to be a different underlying model; the runtime reports the real model.
`;

function soulLabel(source: MossSoul['source']): string {
  if (source === 'workspace-file') return 'workspace persona';
  if (source === 'global-file') return 'global persona';
  return 'default Moss persona';
}

export function resolveSoulDisplay(paths: SoulCliPaths): SoulDisplay {
  const workspacePath = path.join(paths.workspace, '.moss', 'soul.md');
  const globalPath = path.join(paths.configDir, 'soul.md');
  const soul = resolveSoul({ workspaceDir: paths.workspace, configDir: paths.configDir });
  const activeCandidates =
    soul.source === 'workspace-file'
      ? [workspacePath, path.join(paths.workspace, '.moss', 'SOUL.md')]
      : soul.source === 'global-file'
        ? [globalPath, path.join(paths.configDir, 'SOUL.md')]
        : [];
  const activePath = activeCandidates.find((filePath) => fs.existsSync(filePath));
  return { soul, label: soulLabel(soul.source), workspacePath, globalPath, activePath };
}

export function renderSoulStatus(paths: SoulCliPaths): string {
  const display = resolveSoulDisplay(paths);
  const activePath = display.activePath ?? '(built-in identity)';
  return [
    'Soul / persona',
    `  active     ${display.label}`,
    `  id         ${display.soul.id}`,
    `  mode       ${display.soul.mode ?? 'replace'}`,
    `  source     ${activePath}`,
    '',
    'Create or edit a Soul file:',
    `  workspace  ${display.workspacePath}`,
    `             /soul init`,
    `  global     ${display.globalPath}`,
    `             /soul global init`,
    '',
    'Use `mode: replace` for a complete persona, or `mode: prepend` to layer it over the default Moss identity.',
    'Command-based switches apply to the next message; restart Moss after editing a Soul file directly.',
  ].join('\n');
}

export function createSoulFile(paths: SoulCliPaths & { target: SoulFileTarget }): {
  created: boolean;
  path: string;
} {
  const filePath =
    paths.target === 'workspace'
      ? path.join(paths.workspace, '.moss', 'soul.md')
      : path.join(paths.configDir, 'soul.md');
  if (fs.existsSync(filePath)) return { created: false, path: filePath };
  if (paths.target === 'workspace') {
    fs.rmSync(path.join(paths.workspace, '.moss', 'soul.default'), { force: true });
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const template =
    paths.target === 'workspace'
      ? SOUL_TEMPLATE
      : SOUL_TEMPLATE.replace('id: workspace-persona', 'id: global-persona');
  fs.writeFileSync(filePath, template, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { created: true, path: filePath };
}

function workspaceSoulPaths(workspace: string): { lower: string; upper: string; marker: string } {
  const dir = path.join(workspace, '.moss');
  return {
    lower: path.join(dir, 'soul.md'),
    upper: path.join(dir, 'SOUL.md'),
    marker: path.join(dir, 'soul.default'),
  };
}

function resolveSkillHubCommand(): string {
  const executable = process.platform === 'win32' ? 'skillhub.exe' : 'skillhub';
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const candidates = [
    ...pathEntries.map((entry) => path.join(entry, executable)),
    path.join(os.homedir(), '.local', 'bin', executable),
    path.join(os.homedir(), 'bin', executable),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? 'skillhub';
}

export async function installSkillHubCli(
  options: {
    fetchKit?: (url: string) => Promise<Uint8Array>;
    run?: (command: string, args: string[]) => Promise<RunProcessResult>;
  } = {}
): Promise<{ ok: boolean; command?: string; message?: string }> {
  if (process.platform === 'win32') {
    return { ok: false, message: 'The official SkillHub installer currently requires bash.' };
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skillhub-'));
  try {
    const kit = options.fetchKit
      ? await options.fetchKit(SKILLHUB_KIT_URL)
      : await fetch(SKILLHUB_KIT_URL).then(async (response) => {
          if (!response.ok) throw new Error(`kit download failed: HTTP ${response.status}`);
          return new Uint8Array(await response.arrayBuffer());
        });
    if (
      kit.byteLength < 2 ||
      kit.byteLength > 64 * 1024 * 1024 ||
      kit[0] !== 0x1f ||
      kit[1] !== 0x8b
    ) {
      throw new Error('official kit response was not a valid gzip archive');
    }
    const archivePath = path.join(tempDir, 'skillhub-kit.tar.gz');
    fs.writeFileSync(archivePath, kit);
    const runner =
      options.run ?? ((command, args) => runProcess(command, { args, timeout: 120_000 }));
    await runner('tar', ['-xzf', archivePath, '-C', tempDir]);
    const installerPath = path.join(tempDir, 'cli', 'install.sh');
    if (!fs.existsSync(installerPath))
      throw new Error('official kit does not contain cli/install.sh');
    await runner('bash', [installerPath, '--cli-only']);
    const command = resolveSkillHubCommand();
    if (command === 'skillhub') {
      throw new Error(
        'installation completed, but the skillhub executable was not found in PATH or ~/.local/bin'
      );
    }
    return { ok: true, command };
  } catch (err) {
    if (err instanceof ProcessError) {
      const detail = err.stderr.trim() || err.stdout.trim() || err.message;
      return { ok: false, message: detail };
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function resetWorkspaceSoul(paths: { workspace: string }): { removed: boolean } {
  const soulPaths = workspaceSoulPaths(paths.workspace);
  fs.mkdirSync(path.dirname(soulPaths.marker), { recursive: true, mode: 0o700 });
  let removed = false;
  for (const filePath of [soulPaths.lower, soulPaths.upper]) {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      removed = true;
    }
  }
  fs.writeFileSync(soulPaths.marker, 'Use the built-in Moss identity for this workspace.\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  return { removed };
}

export async function installSkillHubSoul(options: {
  workspace: string;
  code: string;
  run?: (command: string, args: string[]) => Promise<RunProcessResult>;
}): Promise<{ ok: boolean; path?: string; backupPath?: string; message?: string }> {
  const choice = SKILLHUB_SOULS.find(
    (soul) => soul.code.toLowerCase() === options.code.trim().toLowerCase()
  );
  if (!choice) return { ok: false, message: `Unknown SkillHub Soul: ${options.code}` };

  const soulPaths = workspaceSoulPaths(options.workspace);
  fs.mkdirSync(path.dirname(soulPaths.lower), { recursive: true, mode: 0o700 });
  const markerContent = fs.existsSync(soulPaths.marker)
    ? fs.readFileSync(soulPaths.marker, 'utf8')
    : undefined;
  fs.rmSync(soulPaths.marker, { force: true });
  const existingPath = [soulPaths.lower, soulPaths.upper].find((filePath) =>
    fs.existsSync(filePath)
  );
  const backupPath = existingPath ? `${existingPath}.backup-${Date.now()}` : undefined;
  if (existingPath && backupPath) fs.renameSync(existingPath, backupPath);

  const runner = options.run ?? ((command, args) => runProcess(command, { args }));
  try {
    await runner(resolveSkillHubCommand(), [
      'soul',
      'install',
      choice.code,
      '--dir',
      path.join(options.workspace, '.moss', 'skills'),
    ]);
    const installedPath = [soulPaths.upper, soulPaths.lower].find((filePath) =>
      fs.existsSync(filePath)
    );
    if (!installedPath) throw new Error('SkillHub completed without writing SOUL.md');
    const installedBody = fs.readFileSync(installedPath, 'utf8');
    if (!installedBody.startsWith('---\n')) {
      fs.writeFileSync(
        installedPath,
        `---\nid: skillhub-${choice.code}\nmode: replace\n---\n\n${installedBody}`,
        {
          encoding: 'utf8',
          mode: 0o600,
        }
      );
    }
    return { ok: true, path: installedPath, backupPath };
  } catch (err) {
    for (const filePath of [soulPaths.lower, soulPaths.upper]) fs.rmSync(filePath, { force: true });
    if (existingPath && backupPath && fs.existsSync(backupPath))
      fs.renameSync(backupPath, existingPath);
    if (markerContent !== undefined) {
      fs.writeFileSync(soulPaths.marker, markerContent, { encoding: 'utf8', mode: 0o600 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}

export function renderSkillHubSoulCatalog(): string {
  return [
    'SkillHub Soul personas',
    ...SKILLHUB_SOULS.map(
      (soul) => `  ${soul.code.padEnd(7)} ${soul.name.padEnd(5)} ${soul.summary}`
    ),
    '',
    'Switch with `/soul use <CODE>` or open `/soul` in the TUI.',
    'Source: https://skillhub.cn/soul · persona content stays owned by its original authors.',
  ].join('\n');
}

export function refreshAgentSoul(options: {
  agent: MossAgent;
  workspace: string;
  configDir: string;
  usingBundledDefault?: boolean;
}): MossSoul {
  options.agent.config.baseSystemPrompt = resolveSoulIdentity({
    workspaceDir: options.workspace,
    configDir: options.configDir,
    model: options.agent.config.model,
    usingBundledDefault: options.usingBundledDefault,
  });
  return resolveSoul({
    workspaceDir: options.workspace,
    configDir: options.configDir,
    model: options.agent.config.model,
    usingBundledDefault: options.usingBundledDefault,
  });
}

export function skillHubCliInstallHint(): string {
  return [
    'SkillHub CLI is required to install this persona. The TUI normally installs the official CLI-only kit automatically.',
    'Manual fallback:',
    '  curl -fsSL https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/install.sh | bash -s -- --cli-only',
    `Official guide: https://skillhub.cn/install/skillhub-soul-install.md · installer: ${SKILLHUB_INSTALLER_URL}`,
  ].join('\n');
}
