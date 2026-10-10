import { resolveConfigPath } from './config.js';
import { REPL_COMMAND_SECTIONS } from './interactive-commands.js';
import { getPackageVersion } from './package-info.js';
import { isZhLocale } from './cli-locale.js';
import { tui } from './tui/copy.js';
import { workspaceWriteLimit } from './workspace-write-copy.js';

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
        ? `    ${c.green('Ctrl+V')}              粘贴剪贴板图片 / Finder 文件 / 路径（macOS；Linux：wl-paste/xclip；Windows：PowerShell）`
        : `    ${c.green('Ctrl+V')}              粘贴剪贴板图片或路径（Linux 需 wl-paste 或 xclip）`,
      '',
      `  ${c.dim(workspaceWriteLimit(true))}`,
      `  ${c.dim('界面语言优先级：--lang > MOSS_LANG > 配置 > 系统区域。')}`,
      `  ${c.dim('完整参考：moss --help --all · 配置参考：moss config --help · 子命令：moss <command> --help')}`,
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
    `  ${c.dim(workspaceWriteLimit(false))}`,
    `  ${c.dim('Language: --lang > MOSS_LANG > config > system locale.')}`,
    `  ${c.dim('Full reference: moss --help --all · config reference: moss config --help · subcommand: moss <command> --help')}`,
    `  ${c.dim(`Config file: ${configPath}`)}`,
    '',
  ];
}

const SECTION_TITLE_ZH: Record<string, string> = {
  Work: '工作',
  Inspect: '查看',
  Configure: '配置',
  Control: '控制',
};

/** Full `moss --help --all` body. Exported for unit tests (line budget ≤ 60). */
export function fullHelpLines(c: Colors, configPath: string, zh = false): string[] {
  const interactiveLines = REPL_COMMAND_SECTIONS.flatMap((section) => [
    `    ${c.bold(zh ? (SECTION_TITLE_ZH[section.title] ?? section.title) : section.title)}`,
    ...section.rows
      .filter((row) => !row.hidden)
      .map((row) => `      ${c.green(row.command.padEnd(24))} ${tui(row.description)}`),
  ]);
  if (zh) return fullHelpLinesZh(c, configPath, interactiveLines);
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
    `    ${c.yellow('-m, --model')} <m> · ${c.yellow('--provider')} <p> · ${c.yellow('--base-url')} <url> · ${c.yellow('--lang')} <en|zh>   this run only`,
    `    ${c.yellow('-c, --config')} k=v    override profile/model/provider/baseUrl/workspace/policy`,
    `    ${c.yellow('--session')} <key> · ${c.yellow('--last')}      named / latest session`,
    `    ${c.yellow('-C, --cd')} <dir>       use a different workspace`,
    `    ${c.yellow('--read-only')} · ${c.yellow('--workspace-write')} · ${c.yellow('--full-access')}   mode overrides: manual+ceiling / manual / full (deny rules and hard blocks still apply). ${workspaceWriteLimit(false)}`,
    `    ${c.yellow('--trust-device')}   destructive device ops this process · ${c.yellow('--trust-workspace')}   run project hooks and stdio MCP`,
    `    ${c.yellow('--accept-edits')} · ${c.yellow('--plan')} · ${c.yellow('--ask-for-approval')} <never|prompt>   other mode overrides (mutually exclusive)`,
    `    ${c.yellow('--mock')} · ${c.yellow('--json')} · ${c.yellow('--output-format')} <f>   offline · machine-readable output`,
    `    ${c.yellow('--quiet')} · ${c.yellow('--verbose')} · ${c.yellow('--debug')} · ${c.yellow('--no-color')}`,
    `  ${c.bold('Environment')}`,
    `    ${c.magenta('MOSS_PROFILE')} · ${c.magenta('MOSS_SAFETY_MODE')} · ${c.magenta('MOSS_APPROVAL_POLICY')} · ${c.magenta('MOSS_WORKSPACE')} · ${c.magenta('MOSS_CONFIG_FILE')} · ${c.magenta('MOSS_LANG')} · ${c.magenta('MOSS_LOG_LEVEL')} ${c.dim('— full list: /permissions --verbose; model settings are config-only; the safety/approval keys are mode overrides (read-only arms the ceiling)')}`,
    '',
    `  ${c.bold('Config file')}`,
    `    ${c.gray(configPath)} ${c.dim('(project defaults: .moss/config.json)')}`,
    '',
    `  ${c.bold('Customizing moss')}`,
    `    ${c.green('Persona')}         .moss/soul.md (or global) — replace/prepend the identity`,
    `    ${c.green('Slash commands')}  .moss/commands/<name>.md — reusable prompt expansions`,
    `    ${c.green('Skills')}          .moss/skills/<name>/SKILL.md — indexed, loaded on demand`,
    `    ${c.green('Sub-agents')}      .moss/agents/*.md and .claude/agents/*.md — /agents lists them`,
    `  ${c.dim('License: MIT')}`,
    '',
  ];
}

function fullHelpLinesZh(c: Colors, configPath: string, interactiveLines: string[]): string[] {
  return [
    '',
    `  ${c.bold(c.cyan('moss'))}  ${c.dim('— 跨平台 coding agent harness：对话、工具、上下文管理、会话')}`,
    '',
    `  ${c.bold('快速开始')}`,
    `    ${c.cyan('$')} moss                       ${c.dim('# 交互式外壳（REPL 或 TUI）')}`,
    `    ${c.cyan('$')} moss setup                 ${c.dim('# 配置服务商、模型和 API key')}`,
    `    ${c.cyan('$')} moss resume --last         ${c.dim('# 继续最近一次保存的会话')}`,
    `    ${c.cyan('$')} moss "检查磁盘占用"        ${c.dim('# 一次性任务（也可管道：echo "列出文件" | moss）')}`,
    '',
    `  ${c.bold('设置、会话与任务')}`,
    `    ${c.green('setup')} / ${c.green('doctor')}         配置 · 检查配置和运行时`,
    `    ${c.green('mcp')} ${c.dim('add|list|remove|test')}          管理 MCP 服务器`,
    `    ${c.green('device')} ${c.dim('add|list|remove|test')}       管理机器人设备（.moss/devices.json）`,
    `    ${c.green('skill')} ${c.dim('create|list')}                管理 skills（.moss/skills）`,
    `    ${c.green('sessions')} ${c.dim('list|delete|search|export')}  管理已保存的会话`,
    `    ${c.green('task')} ${c.dim('run|resume|status|timeline')}      带验收的 Task OS 任务（${c.green('tasks')} 查看机器人工件）`,
    `    ${c.green('config')}                ${c.dim('show|init|set|unset|validate')} — 键说明：\`moss config --help\``,
    '',
    `  ${c.bold('交互命令')}`,
    ...interactiveLines,
    '',
    `  ${c.bold('常用参数')}`,
    `    ${c.yellow('-m, --model')} <m> · ${c.yellow('--provider')} <p> · ${c.yellow('--base-url')} <url> · ${c.yellow('--lang')} <en|zh>   仅本次运行`,
    `    ${c.yellow('-c, --config')} k=v    覆盖 profile/model/provider/baseUrl/workspace/policy`,
    `    ${c.yellow('--session')} <key> · ${c.yellow('--last')}      指定会话 / 最近一次会话`,
    `    ${c.yellow('-C, --cd')} <dir>       换一个工作区`,
    `    ${c.yellow('--read-only')} · ${c.yellow('--workspace-write')} · ${c.yellow('--full-access')}   模式覆盖：manual+上限 / manual / full（deny 规则和硬拦截仍然生效）。${workspaceWriteLimit(true)}`,
    `    ${c.yellow('--trust-device')}   本进程允许毁灭性设备操作 · ${c.yellow('--trust-workspace')}   运行项目钩子和 stdio MCP`,
    `    ${c.yellow('--accept-edits')} · ${c.yellow('--plan')} · ${c.yellow('--ask-for-approval')} <never|prompt>   其它互斥的模式覆盖`,
    `    ${c.yellow('--mock')} · ${c.yellow('--json')} · ${c.yellow('--output-format')} <f>   离线 · 机器可读输出`,
    `    ${c.yellow('--quiet')} · ${c.yellow('--verbose')} · ${c.yellow('--debug')} · ${c.yellow('--no-color')}`,
    `  ${c.bold('环境变量')}`,
    `    ${c.magenta('MOSS_PROFILE')} · ${c.magenta('MOSS_SAFETY_MODE')} · ${c.magenta('MOSS_APPROVAL_POLICY')} · ${c.magenta('MOSS_WORKSPACE')} · ${c.magenta('MOSS_CONFIG_FILE')} · ${c.magenta('MOSS_LANG')} · ${c.magenta('MOSS_LOG_LEVEL')} ${c.dim('— 完整列表：/permissions --verbose；模型设置只来自配置；安全/审批键是模式覆盖（read-only 会打开只读上限）')}`,
    '',
    `  ${c.bold('配置文件')}`,
    `    ${c.gray(configPath)} ${c.dim('（项目默认：.moss/config.json）')}`,
    '',
    `  ${c.bold('定制 moss')}`,
    `    ${c.green('人格')}           .moss/soul.md（或全局）— 替换或前置身份说明`,
    `    ${c.green('斜杠命令')}       .moss/commands/<name>.md — 可复用的提示展开`,
    `    ${c.green('Skills')}        .moss/skills/<name>/SKILL.md — 建立索引，按需加载`,
    `    ${c.green('子代理')}         .moss/agents/*.md 与 .claude/agents/*.md — /agents 列出它们`,
    `  ${c.dim('界面语言优先级：--lang > MOSS_LANG > 配置 > 系统区域。')}`,
    `  ${c.dim('许可证：MIT')}`,
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
  console.log(fullHelpLines(c, configPath, isZhLocale()).join('\n'));
  process.exit(0);
}

export function displayVersion(c: Colors): void {
  const version = getPackageVersion();
  console.log(
    `${c.bold('moss')} ${version === 'unknown' ? c.dim('(unknown version)') : c.cyan(`v${version}`)}`
  );
  process.exit(0);
}
