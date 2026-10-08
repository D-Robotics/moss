import { resolveConfigPath } from './config.js';
import { REPL_COMMAND_SECTIONS } from './interactive-commands.js';
import { getPackageVersion } from './package-info.js';
import { isZhLocale } from './cli-locale.js';

type ColorFn = (s: string) => string;

interface Colors {
  bold: ColorFn;
  dim: ColorFn;
  red: ColorFn;
  green: ColorFn;
  yellow: ColorFn;
  blue: ColorFn;
  cyan: ColorFn;
  magenta: ColorFn;
  gray: ColorFn;
}

/** Brief `moss --help` body (no --all). Exported for unit tests. */
export function briefHelpLines(c: Colors, configPath: string, zh: boolean): string[] {
  if (zh) {
    return [
      '',
      `  ${c.bold(c.cyan('moss'))}  ${c.dim('— 跨平台 coding agent harness：对话、工具、上下文管理、会话')}`,
      '',
      `  ${c.bold('最常用')}`,
      `    ${c.cyan('$')} moss                          ${c.dim('# 启动交互式 Moss')}`,
      `    ${c.cyan('$')} moss setup                    ${c.dim('# 配置服务商 / 模型 / API key')}`,
      `    ${c.cyan('$')} moss "检查这个项目"            ${c.dim('# 一次性任务模式')}`,
      '',
      `  ${c.bold('进入 Moss 后')}`,
      `    ${c.green('/help')}          查看命令帮助`,
      `    ${c.green('/status')}        当前模型、工作区状态`,
      `    ${c.green('/model')}         切换本会话模型`,
      process.platform === 'darwin'
        ? `    ${c.green('Ctrl+V')}              粘贴剪贴板图片 / Finder 文件 / 路径（macOS；Linux: wl-paste/xclip；Windows: PowerShell）`
        : `    ${c.green('Ctrl+V')}              粘贴剪贴板图片或路径（Linux 需 wl-paste 或 xclip）`,
      '',
      `  ${c.dim('完整参考：moss --help --all · 配置参考：moss config --help')}`,
      `  ${c.dim(`配置文件：${configPath}`)}`,
      '',
    ];
  }

  return [
    '',
    `  ${c.bold(c.cyan('moss'))}  ${c.dim('— a cross-platform coding agent harness: chat, tools, context management, sessions')}`,
    '',
    `  ${c.bold('Most useful')}`,
    `    ${c.cyan('$')} moss                          ${c.dim('# start interactive Moss')}`,
    `    ${c.cyan('$')} moss setup                    ${c.dim('# configure your provider/model/API key')}`,
    `    ${c.cyan('$')} moss "check this project"      ${c.dim('# one-shot mode')}`,
    '',
    `  ${c.bold('Inside Moss')}`,
    `    ${c.green('/help')}          focused command help`,
    `    ${c.green('/status')}        current model and workspace`,
    `    ${c.green('/model')}         choose/switch model for this session`,
    process.platform === 'darwin'
      ? `    ${c.green('Ctrl+V')}              attach clipboard image / Finder file / path (macOS; Linux: wl-paste/xclip; Windows: PowerShell)`
      : `    ${c.green('Ctrl+V')}              attach clipboard image or path (install wl-paste or xclip on Linux)`,
    '',
    `  ${c.dim('Full reference: moss --help --all · config reference: moss config --help')}`,
    `  ${c.dim(`Config file: ${configPath}`)}`,
    '',
  ];
}

/** Full `moss --help --all` body. Exported for unit tests (line budget ≤ 60). */
export function fullHelpLines(c: Colors, configPath: string): string[] {
  const interactiveLines = REPL_COMMAND_SECTIONS.flatMap((section) => [
    `    ${c.bold(section.title)}`,
    ...section.rows
      .filter((row) => !row.hidden)
      .map((row) => `      ${c.green(row.command.padEnd(24))} ${row.description}`),
  ]);
  return [
    '',
    `  ${c.bold(c.cyan('moss'))}  ${c.dim('— a cross-platform coding agent harness: chat, tools, context management, sessions')}`,
    '',
    `  ${c.bold('Quick start')}`,
    `    ${c.cyan('$')} moss                       ${c.dim('# interactive shell (REPL or TUI)')}`,
    `    ${c.cyan('$')} moss setup                 ${c.dim('# configure your provider, model, and API key')}`,
    `    ${c.cyan('$')} moss resume --last         ${c.dim('# continue the latest saved session')}`,
    `    ${c.cyan('$')} moss "check disk usage"    ${c.dim('# one-shot (or pipe: echo "list files" | moss)')}`,
    '',
    `  ${c.bold('Setup, sessions & tasks')}`,
    `    ${c.green('setup')} / ${c.green('doctor')}         configure · health-check config and runtime`,
    `    ${c.green('mcp')} ${c.dim('add|list|remove|test')}          manage MCP servers`,
    `    ${c.green('device')} ${c.dim('add|list|remove|test')}       manage robot devices (.moss/devices.json)`,
    `    ${c.green('skill')} ${c.dim('create|list')}                manage skills (.moss/skills)`,
    `    ${c.green('sessions')} ${c.dim('list|delete|search|export')}  manage saved sessions`,
    `    ${c.green('task')} ${c.dim('run|resume|status|timeline')}      verified Task OS tasks (${c.green('tasks')} inspects robotics artifacts)`,
    `    ${c.green('config')}                ${c.dim('show|init|set|unset|validate')} — keys: \`moss config --help\``,
    '',
    `  ${c.bold('Interactive commands')}`,
    ...interactiveLines,
    '',
    `  ${c.bold('Common flags')}`,
    `    ${c.yellow('-m, --model')} <m> · ${c.yellow('--provider')} <p> · ${c.yellow('--base-url')} <url>   this run only`,
    `    ${c.yellow('-c, --config')} k=v    override profile/model/provider/baseUrl/workspace/policy`,
    `    ${c.yellow('--session')} <key> · ${c.yellow('--last')}      named / latest session`,
    `    ${c.yellow('-C, --cd')} <dir>       use a different workspace`,
    `    ${c.yellow('--read-only')} · ${c.yellow('--workspace-write')} · ${c.yellow('--full-access')}   mode overrides: manual+ceiling / manual / full (the v0.26 default equivalent; deny rules + hard blocks still apply)`,
    `    ${c.yellow('--accept-edits')} · ${c.yellow('--plan')} · ${c.yellow('--ask-for-approval')} <never|prompt>   other mode overrides (mutually exclusive)`,
    `    ${c.yellow('--mock')} · ${c.yellow('--json')} · ${c.yellow('--output-format')} <f>   offline · machine-readable output`,
    `    ${c.yellow('--quiet')} · ${c.yellow('--verbose')} · ${c.yellow('--debug')} · ${c.yellow('--no-color')}`,
    '',
    `  ${c.bold('Environment')}`,
    `    ${c.magenta('MOSS_PROFILE')} · ${c.magenta('MOSS_SAFETY_MODE')} · ${c.magenta('MOSS_APPROVAL_POLICY')} · ${c.magenta('MOSS_WORKSPACE')} · ${c.magenta('MOSS_CONFIG_FILE')} · ${c.magenta('MOSS_LOG_LEVEL')} ${c.dim('— full list: /permissions --verbose; model settings are config-only; the safety/approval keys are mode overrides (read-only arms the ceiling)')}`,
    '',
    `  ${c.bold('Config file')}`,
    `    ${c.gray(configPath)} ${c.dim('(project defaults: .moss/config.json)')}`,
    '',
    `  ${c.bold('Customizing moss')}`,
    `    ${c.green('Persona')}         .moss/soul.md (or global) — replace/prepend the identity`,
    `    ${c.green('Slash commands')}  .moss/commands/<name>.md — reusable prompt expansions`,
    `    ${c.green('Skills')}          .moss/skills/<name>/SKILL.md — indexed, loaded on demand`,
    `  ${c.dim('License: MIT')}`,
    '',
  ];
}

export function displayHelp(c: Colors, options: { all?: boolean } = {}): void {
  const configPath = resolveConfigPath();
  if (!options.all) {
    const lines = briefHelpLines(c, configPath, isZhLocale());
    console.log(lines.join('\n'));
    process.exit(0);
  }
  console.log(fullHelpLines(c, configPath).join('\n'));
  process.exit(0);
}

export function displayVersion(c: Colors): void {
  const version = getPackageVersion();
  console.log(
    `${c.bold('moss')} ${version === 'unknown' ? c.dim('(unknown version)') : c.cyan(`v${version}`)}`
  );
  process.exit(0);
}
