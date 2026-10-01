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
      `  ${c.bold('模型配置')}`,
      `    自有模型示例：`,
      `      moss setup ${c.dim('# 交互式：选服务商 + 模型，粘贴 API key')}`,
      `    OpenAI 兼容示例：`,
      `      moss config set provider=openai-compatible model=<your-model> baseUrl=<https://host>`,
      `      moss setup ${c.dim('# 保存 API key（隐藏输入）')}`,
      `    优先级：${c.bold('CLI flags/-c')} > ${c.bold('项目 .moss/config.json')} > ${c.bold('用户配置')}。`,
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
    `  ${c.bold('Model configuration')}`,
    `    Own model example:`,
    `      moss setup ${c.dim('# interactive: choose provider + model, paste API key')}`,
    `    OpenAI-compatible example:`,
    `      moss config set provider=openai-compatible model=<your-model> baseUrl=<https://host>`,
    `      moss setup ${c.dim('# stores the API key (hidden prompt)')}`,
    `    Priority: ${c.bold('CLI flags/-c')} > ${c.bold('project .moss/config.json')} > ${c.bold('user config')}.`,
    '',
    `  ${c.dim('Full reference: moss --help --all · config reference: moss config --help')}`,
    `  ${c.dim(`Config file: ${configPath}`)}`,
    '',
  ];
}

export function displayHelp(c: Colors, options: { all?: boolean } = {}): void {
  const configPath = resolveConfigPath();
  const interactiveLines = REPL_COMMAND_SECTIONS.flatMap((section) => [
    `    ${c.bold(section.title)}`,
    ...section.rows.map((row) => `      ${c.green(row.command.padEnd(24))} ${row.description}`),
  ]);
  if (!options.all) {
    const lines = briefHelpLines(c, configPath, isZhLocale());
    console.log(lines.join('\n'));
    process.exit(0);
  }
  const lines = [
    '',
    `  ${c.bold(c.cyan('moss'))}  ${c.dim('— a cross-platform coding agent harness: chat, tools, context management, sessions')}`,
    '',
    `  ${c.bold('Quick start')}`,
    `    ${c.cyan('$')} moss                       ${c.dim('# interactive REPL')}`,
    `    ${c.cyan('$')} moss setup                 ${c.dim('# configure your provider, model, and API key')}`,
    `    ${c.cyan('$')} moss --provider deepseek -m deepseek-chat  ${c.dim('# switch provider + model for this run')}`,
    `    ${c.cyan('$')} moss resume --last         ${c.dim('# continue the latest saved session')}`,
    `    ${c.cyan('$')} moss --session work        ${c.dim('# continue or create a named session')}`,
    `    ${c.cyan('$')} moss "check disk usage"    ${c.dim('# one-shot mode')}`,
    `    ${c.cyan('$')} echo "list files" | moss   ${c.dim('# piped stdin')}`,
    '',
    `  ${c.bold('Setup & sessions')}`,
    `    ${c.green('setup')}                 configure your provider/model/API key`,
    `    ${c.green('doctor')}                inspect config, workspace, and runtime state`,
    `    ${c.green('sessions list')}         list saved JSONL sessions`,
    `    ${c.green('sessions delete')} ${c.dim('<key>')}  delete a saved session`,
    `    ${c.green('sessions search')} ${c.dim('<text>')}  find saved sessions whose messages contain <text>`,
    `    ${c.green('sessions export')} ${c.dim('<key> [--out <file>]')}  export a saved session to Markdown (stdout or --out=-)`,
    `    ${c.green('tasks')}                inspect robotics loop artifacts: contracts, evidence, deployments, acceptance, device`,
    `    ${c.green('resume')} ${c.dim('[--last]')}       resume a saved JSONL session`,
    `    ${c.green('fork')} ${c.dim('[--last]')}         copy a saved session into a new branch`,
    `    ${c.green('config')}               show resolved config values and sources`,
    `    ${c.green('config show')}          same as config; safe for scripts`,
    `    ${c.green('config show --json')}   emit redacted resolved config JSON`,
    `    ${c.green('config validate')}      check config files and audit warnings`,
    `    ${c.green('config validate --strict')} fail when audit warnings are present`,
    `    ${c.green('config init')}          create a user or project config file`,
    `    ${c.green('config set model')} ${c.dim('<m>')}  update stored model`,
    `    ${c.green('config set baseUrl')} ${c.dim('<u>')} update stored OpenAI-compatible base URL`,
    `    ${c.green('config set')} ${c.dim('<key>=<value> [<key>=<value>...]')} batch-set multiple values`,
    `    ${c.green('config set profile')} ${c.dim('<p>')} cautious | balanced | autonomous`,
    `    ${c.green('config set provider')} ${c.dim('<p>')} deepseek | qwen | openai | anthropic | openai-compatible`,
    `    ${c.green('config set trustedTools')} ${c.dim('<csv>')} auto-approve tool names/globs after safety checks`,
    `    ${c.green('config set deniedTools')} ${c.dim('<csv>')} always block tool names/globs`,
    `    ${c.green('config set promptCacheDebug')} ${c.dim('<bool>')} enable prompt-prefix cache diagnostics`,
    `    ${c.green('config set guardrails.input.redactPatterns')} ${c.dim('<csv>')} redact matching user text`,
    `    ${c.green('config set guardrails.output.blockPatterns')} ${c.dim('<csv>')} block matching responses`,
    `    ${c.green('config set agent.maxTurns')} ${c.dim('<n>')} set per-request agent turn budget`,
    `    ${c.green('config set agent.contextTokens')} ${c.dim('<n>')} set context budget used by pruning/compaction`,
    `    ${c.green('config unset')} ${c.dim('<key>')}   remove a stored user/project override`,
    '',
    `  ${c.bold('Interactive commands')}`,
    ...interactiveLines,
    '',
    `  ${c.bold('Flags')}`,
    `    ${c.yellow('--debug')}              verbose logging (level=debug)`,
    `    ${c.yellow('--quiet')}              only warnings & errors (level=warn)`,
    `    ${c.yellow('--verbose')}            show full tool I/O and thinking (detail mode: verbose)`,
    `    ${c.yellow('--log-level=')}${c.dim('<lv>')}   debug | info | warn | error`,
    `    ${c.yellow('--json')}               output the primary response as JSON (alias for --output-format json)`,
    `    ${c.yellow('--output-format')} ${c.dim('<f>')} text | json | stream-json  (--json is alias for json)`,
    `    ${c.yellow('--accept-edits')}       auto-approve workspace file edits (skip per-call prompt)`,
    `    ${c.yellow('--mock')}               offline mode — no API key required, no live LLM calls`,
    `    ${c.yellow('-m, --model')} ${c.dim('<m>')}     override model for this run`,
    `    ${c.yellow('-C, --cd')} ${c.dim('<dir>')}      use a different workspace`,
    `    ${c.yellow('-c, --config')} ${c.dim('k=v')}    override profile/model/provider/baseUrl/workspace/policy`,
    `    ${c.yellow('--config-file')} ${c.dim('<p>')}   read/write an explicit config JSON file`,
    `    ${c.yellow('--provider')} ${c.dim('<p>')}      deepseek | qwen | openai | anthropic | openai-compatible`,
    `    ${c.yellow('--base-url')} ${c.dim('<url>')}    override provider base URL`,
    `    ${c.yellow('--session')} ${c.dim('<key>')}     continue or create a named session key`,
    `    ${c.yellow('--last')}               with resume/fork, use latest session`,
    `    ${c.yellow('--ask-for-approval')} ${c.dim('<p>')} never | prompt | on-request | read-only | workspace-write | full-access`,
    `    ${c.yellow('--read-only')}          block mutating tools`,
    `    ${c.yellow('--workspace-write')}    restrict writes/exec to workspace boundaries`,
    `    ${c.yellow('--full-access')}        allow all tools (default safety ceiling)`,
    `    ${c.yellow('--no-color')}           disable ANSI colors`,
    `    ${c.yellow('--help, -h')}           show this help`,
    `    ${c.yellow('--version, -v')}        show version`,
    '',
    `  ${c.bold('Environment')}`,
    `    ${c.dim('Model settings (provider/model/baseUrl/apiKey) are never read from env vars —')}`,
    `    ${c.dim('use moss setup / moss config set.')}`,
    `    ${c.magenta('MOSS_PROFILE')}           ${c.dim('cautious | balanced | autonomous config profile')}`,
    `    ${c.magenta('MOSS_CONFIG_FILE')}       ${c.dim('explicit config JSON path (overrides config dir)')}`,
    `    ${c.magenta('MOSS_WORKSPACE')}         ${c.dim('working directory (default: cwd)')}`,
    `    ${c.magenta('MOSS_SAFETY_MODE')}       ${c.dim('read-only | workspace-write | full-access')}`,
    `    ${c.magenta('MOSS_CLI_AUTO_APPROVE')}  ${c.dim('=1 → approve allowed mutating tools without prompting')}`,
    `    ${c.magenta('MOSS_LOG_LEVEL')}         ${c.dim('overrides default log level')}`,
    `    ${c.magenta('MOSS_LOG_JSON')}          ${c.dim('=1 → format internal logs as JSON lines (use --json for response output)')}`,
    `    ${c.magenta('MOSS_CLI_DETAIL')}        ${c.dim('quiet | progress (default) | verbose')}`,
    `    ${c.magenta('MOSS_SHOW_THINKING')}     ${c.dim('=true → print raw thinking deltas in verbose mode')}`,
    '',
    `  ${c.bold('Config file')}`,
    `    ${c.gray(configPath)}`,
    `    ${c.gray('.moss/config.json')} ${c.dim('in the current workspace is read as project defaults')}`,
    '',
    `  ${c.bold('Built-in features')}`,
    `    ${c.green('✓')} Session persistence (JSONL) with ${c.cyan('moss resume')}-style recovery`,
    `    ${c.green('✓')} Project instructions (AGENTS.md auto-loaded from workspace root)`,
    `    ${c.green('✓')} Subagents (${c.cyan('create_subagent')} / ${c.cyan('fan_out_subagents')})`,
    `    ${c.green('✓')} Background command execution (${c.cyan('exec_background')} / ${c.cyan('exec_logs')})`,
    `    ${c.green('✓')} Web tools (${c.cyan('web_fetch')} / ${c.cyan('web_search')})`,
    `    ${c.green('✓')} Framework-level tool-call self-healing (stream-error resilient)`,
    '',
    `  ${c.bold('Customizing moss')} — build your own agent`,
    `    ${c.green('Persona')}         .moss/soul.md (or global) — replace/prepend the identity`,
    `    ${c.green('Slash commands')}  .moss/commands/<name>.md — reusable prompt expansions`,
    `    ${c.green('Tools')}           builtins · agent.tools.register() when embedding`,
    `    ${c.green('Model')}           /model · moss config set provider/model/baseUrl`,
    `    ${c.green('Automation')}      /loop <prompt>`,
    `    ${c.green('Embed')}           MossAgent from this package`,
    '',
    `  ${c.dim('License: MIT')}`,
    '',
  ];
  console.log(lines.join('\n'));
  process.exit(0);
}

export function displayVersion(c: Colors): void {
  const version = getPackageVersion();
  console.log(
    `${c.bold('moss')} ${version === 'unknown' ? c.dim('(unknown version)') : c.cyan(`v${version}`)}`
  );
  process.exit(0);
}
