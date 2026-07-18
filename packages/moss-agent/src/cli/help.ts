import { resolveConfigPath } from './config.js';
import { INTERACTIVE_COMMAND_SECTIONS } from './interactive-commands.js';
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
      `  ${c.bold(c.cyan('moss'))}  ${c.dim('— D-Robotics 跨平台 agent harness：日常 coding / 办公为主，机器人能力以 skill 接入')}`,
      '',
      `  ${c.bold('最常用')}`,
      `    ${c.cyan('$')} moss                          ${c.dim('# 启动交互式 Moss；内置模型开箱即用')}`,
      `    ${c.cyan('$')} moss auth login               ${c.dim('# 可选：绑定地瓜开发者社区账号')}`,
      `    ${c.cyan('$')} moss auth login --manual      ${c.dim('# 可选：无浏览器登录，粘贴回调 URL 或 token')}`,
      `    ${c.cyan('$')} moss setup                    ${c.dim('# 改用自己的服务商 / 模型 / API key')}`,
      `    ${c.cyan('$')} moss "检查这个项目"            ${c.dim('# 一次性任务模式')}`,
      '',
      `  ${c.bold('进入 Moss 后')}`,
      `    ${c.green('/quickstart')}    引导配置模型、工作区、开发板与首批任务`,
      `    ${c.green('/help')}          查看命令帮助`,
      `    ${c.green('/status')}        当前模型、登录、工作区、开发板状态`,
      `    ${c.green('/model')}         切换本会话模型`,
      process.platform === 'darwin'
        ? `    ${c.green('Ctrl+V')}              粘贴剪贴板图片 / Finder 文件 / 路径（macOS；Linux: wl-paste/xclip；Windows: PowerShell）`
        : `    ${c.green('Ctrl+V')}              粘贴剪贴板图片或路径（Linux 需 wl-paste 或 xclip）`,
      `    ${c.green('/connect <ip>')}  连接 RDK 开发板（本会话）`,
      '',
      `  ${c.bold('模型配置')}`,
      `    内置模型：无需模型 API key 或社区登录；${c.green('moss auth login')} 可选。`,
      `    自有模型示例：`,
      `      moss setup ${c.dim('# 交互式：选服务商 + 模型，粘贴 API key')}`,
      `    OpenAI 兼容示例：`,
      `      moss config set provider=openai-compatible model=<your-model> baseUrl=<https://host>`,
      `      moss setup ${c.dim('# 保存 API key（隐藏输入）')}`,
      `    优先级：${c.bold('CLI flags/-c')} > ${c.bold('项目 .moss/config.json')} > ${c.bold('用户配置')} > ${c.bold('内置默认')}。`,
      `    模型设置不会从环境变量读取（DEEPSEEK_API_KEY 等会被忽略）。`,
      '',
      `  ${c.dim('完整参考：moss --help --all · 配置参考：moss config --help')}`,
      `  ${c.dim(`配置文件：${configPath}`)}`,
      '',
    ];
  }

  return [
    '',
    `  ${c.bold(c.cyan('moss'))}  ${c.dim('— a cross-platform agent harness by D-Robotics for daily coding & office work; robotics comes as skills')}`,
    '',
    `  ${c.bold('Most useful')}`,
    `    ${c.cyan('$')} moss                          ${c.dim('# start interactive Moss; built-in model is ready')}`,
    `    ${c.cyan('$')} moss auth login               ${c.dim('# optional: link a D-Robotics community account')}`,
    `    ${c.cyan('$')} moss auth login --manual      ${c.dim('# optional browserless community login: paste redirect URL or token')}`,
    `    ${c.cyan('$')} moss setup                    ${c.dim('# use your own provider/model/API key instead')}`,
    `    ${c.cyan('$')} moss "check this project"      ${c.dim('# one-shot mode')}`,
    '',
    `  ${c.bold('Inside Moss')}`,
    `    ${c.green('/quickstart')}    guided setup for model, workspace, board, and first tasks`,
    `    ${c.green('/help')}          focused command help`,
    `    ${c.green('/status')}        current model, login, workspace, board`,
    `    ${c.green('/model')}         choose/switch model for this session`,
    process.platform === 'darwin'
      ? `    ${c.green('Ctrl+V')}              attach clipboard image / Finder file / path (macOS; Linux: wl-paste/xclip; Windows: PowerShell)`
      : `    ${c.green('Ctrl+V')}              attach clipboard image or path (install wl-paste or xclip on Linux)`,
    `    ${c.green('/connect <ip>')}  connect an RDK board for this session`,
    '',
    `  ${c.bold('Model configuration')}`,
    `    Built-in: no model API key or community login is required; ${c.green('moss auth login')} is optional.`,
    `    Own model example:`,
    `      moss setup ${c.dim('# interactive: choose provider + model, paste API key')}`,
    `    OpenAI-compatible example:`,
    `      moss config set provider=openai-compatible model=<your-model> baseUrl=<https://host>`,
    `      moss setup ${c.dim('# stores the API key (hidden prompt)')}`,
    `    Priority: ${c.bold('CLI flags/-c')} > ${c.bold('project .moss/config.json')} > ${c.bold('user config')} > ${c.bold('built-in default')}.`,
    `    Model settings are never read from environment variables (DEEPSEEK_API_KEY etc. are ignored).`,
    '',
    `  ${c.dim('Full reference: moss --help --all · config reference: moss config --help')}`,
    `  ${c.dim(`Config file: ${configPath}`)}`,
    '',
  ];
}

export function displayHelp(c: Colors, options: { all?: boolean } = {}): void {
  const configPath = resolveConfigPath();
  const interactiveLines = INTERACTIVE_COMMAND_SECTIONS.flatMap((section) => [
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
    `  ${c.bold(c.cyan('moss'))}  ${c.dim('— a cross-platform agent harness for daily coding & office work; robotics as skills')}`,
    '',
    `  ${c.bold('Quick start')}`,
    `    ${c.cyan('$')} moss                       ${c.dim('# interactive TUI; built-in model works without login')}`,
    `    ${c.cyan('$')} moss setup                 ${c.dim('# optional: use your own provider, model, and API key')}`,
    `    ${c.cyan('$')} moss --provider deepseek -m deepseek-v4-flash  ${c.dim('# switch provider + model for this run')}`,
    `    ${c.cyan('$')} moss resume --last         ${c.dim('# continue the latest saved session')}`,
    `    ${c.cyan('$')} moss --session work        ${c.dim('# continue or create a named session')}`,
    `    ${c.cyan('$')} moss "check disk usage"    ${c.dim('# one-shot mode')}`,
    `    ${c.cyan('$')} echo "list files" | moss   ${c.dim('# piped stdin')}`,
    '',
    `  ${c.bold('Setup & auth')}`,
    `    ${c.green('setup')}                 configure your own provider/model/API key`,
    `    ${c.green('auth login')}            optional: link a D-Robotics developer community account`,
    `    ${c.green('auth status')}           show community login and provider/model/key status`,
    `    ${c.green('auth logout')}           remove stored community login and API key config`,
    `    ${c.green('doctor')}                inspect config, auth, workspace, runtime, and update state`,
    `    ${c.green('update')}                run npm global update for Moss`,
    `    ${c.green('migrate')}               upgrade legacy dmoss dirs/sessions to moss (one-time)`,
    `    ${c.green('sessions list')}         list saved JSONL sessions`,
    `    ${c.green('sessions delete')} ${c.dim('<key>')}  delete a saved session`,
    `    ${c.green('resume')} ${c.dim('[--last]')}       resume a saved JSONL session`,
    `    ${c.green('fork')} ${c.dim('[--last]')}         copy a saved session into a new branch`,
    `    ${c.green('mcp list')}             show configured MCP servers`,
    `    ${c.green('mcp add')} ${c.dim('<name> <cmd> [args...]')} register an MCP server (no JSON editing)`,
    `    ${c.green('mcp remove')} ${c.dim('<name>')}    remove a configured MCP server`,
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
    `    ${c.green('config set mcp.enabled')} ${c.dim('<bool>')} enable MCP servers from config`,
    `    ${c.green('config set mcp.configPath')} ${c.dim('<path>')} set MCP server config path`,
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
    `    ${c.yellow('--plan')}               start in plan mode (propose, do not execute mutations; leave with /mode default or Shift+Tab)`,
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
    `    ${c.yellow('--workspace-write')}    allow workspace writes/exec (default safety ceiling)`,
    `    ${c.yellow('--full-access')}        allow device/external tools with approval`,
    `    ${c.yellow('--no-color')}           disable ANSI colors`,
    `    ${c.yellow('--help, -h')}           show this help`,
    `    ${c.yellow('--version, -v')}        show version`,
    '',
    `  ${c.bold('Environment')}`,
    `    ${c.dim('Model settings (provider/model/baseUrl/apiKey) are never read from env vars —')}`,
    `    ${c.dim('use moss setup / moss config set. Leftover DEEPSEEK_API_KEY etc. are ignored.')}`,
    `    ${c.magenta('MOSS_PROFILE')}           ${c.dim('cautious | balanced | autonomous config profile')}`,
    `    ${c.magenta('MOSS_CONFIG_FILE')}       ${c.dim('explicit config JSON path (overrides config dir)')}`,
    `    ${c.magenta('MOSS_WORKSPACE')}         ${c.dim('working directory (default: cwd)')}`,
    `    ${c.magenta('MOSS_EXEC_BACKEND')}      ${c.dim('local (default) or docker')}`,
    `    ${c.magenta('MOSS_LOOP_MAX')}          ${c.dim('optional max iterations for /loop and /goal auto-run (default: unlimited)')}`,
    `    ${c.magenta('MOSS_GOAL_AUTO_MAX_RUNS')} ${c.dim('override max /goal auto-run iterations (falls back to MOSS_LOOP_MAX)')}`,
    `    ${c.magenta('MOSS_BROWSER_EXECUTABLE')} ${c.dim('Chrome/Chromium executable for browser tools')}`,
    `    ${c.magenta('MOSS_SAFETY_MODE')}       ${c.dim('read-only | workspace-write | full-access')}`,
    `    ${c.magenta('MOSS_CLI_AUTO_APPROVE')}  ${c.dim('=1 → approve allowed mutating tools without prompting')}`,
    `    ${c.magenta('MOSS_DOCKER_IMAGE')}      ${c.dim('docker image (default: node:20-slim)')}`,
    `    ${c.magenta('MOSS_DEVICE_HOST')}       ${c.dim('device IP/hostname (enables SSH tools)')}`,
    `    ${c.magenta('MOSS_DEVICE_USER')}       ${c.dim('device SSH user (default: root)')}`,
    `    ${c.magenta('MOSS_DEVICE_PASSWORD')}   ${c.dim('device SSH password')}`,
    `    ${c.magenta('MOSS_DEVICE_PORT')}       ${c.dim('device SSH port (default: 22)')}`,
    `    ${c.magenta('MOSS_DEVICE_KEY')}        ${c.dim('path to SSH private key')}`,
    `    ${c.magenta('MOSS_DEVICE_NO_VERIFY')}  ${c.dim('=1 → skip the startup SSH reachability probe')}`,
    `    ${c.magenta('MOSS_DEVICE_HYBRID')}     ${c.dim('=1 → keep local tools at startup instead of board mode')}`,
    `    ${c.magenta('MOSS_MESH_ENABLED')}      ${c.dim('=true → start the agent mesh (MOSS_MESH_PORT/_PEERS/_SHARED_SECRET)')}`,
    `    ${c.magenta('MOSS_MCP_ENABLED')}       ${c.dim('=true/false → override MCP enablement from config')}`,
    `    ${c.magenta('MOSS_MCP_CONFIG')}        ${c.dim('path to MCP servers JSON (overrides config dir)')}`,
    `    ${c.magenta('MOSS_LOG_LEVEL')}         ${c.dim('overrides default log level')}`,
    `    ${c.magenta('MOSS_LOG_JSON')}          ${c.dim('=1 → format internal logs as JSON lines (use --json for response output)')}`,
    `    ${c.magenta('MOSS_CLI_DETAIL')}        ${c.dim('quiet | progress (default) | verbose')}`,
    `    ${c.magenta('MOSS_SHOW_THINKING')}     ${c.dim('=true → print raw thinking deltas in verbose mode')}`,
    `    ${c.magenta('MOSS_TRACE')}             ${c.dim('console → emit tracing spans to stderr')}`,
    `    ${c.magenta('MOSS_LLM_USAGE_LOG')}     ${c.dim('path to append LLM usage JSONL records')}`,
    `    ${c.magenta('MOSS_LLM_USAGE')}         ${c.dim('=1 → enable usage logging even without explicit path')}`,
    `    ${c.magenta('MOSS_SELF_LEARNING')}     ${c.dim('=true → extract user correction feedback as memory')}`,
    '',
    `  ${c.bold('Config file')}`,
    `    ${c.gray(configPath)}`,
    `    ${c.gray('.moss/config.json')} ${c.dim('in the current workspace is read as project defaults')}`,
    '',
    `  ${c.bold('Built-in features')}`,
    `    ${c.green('✓')} Session persistence (JSONL) with ${c.cyan('moss resume')}-style recovery`,
    `    ${c.green('✓')} Long-term memory (memory_read / write / delete)`,
    `    ${c.green('✓')} Project instructions (AGENTS.md auto-loaded from workspace root)`,
    `    ${c.green('✓')} Skill learning — successful runs crystallize into SKILL.md`,
    `    ${c.green('✓')} Docker sandbox (${c.yellow('MOSS_EXEC_BACKEND=docker')})`,
    `    ${c.green('✓')} ${c.cyan('LAN Agent Mesh')} — P2P discovery via UDP broadcast`,
    `    ${c.green('✓')} Framework-level tool-call self-healing (stream-error resilient)`,
    '',
    `  ${c.bold('Device & robotics tools')}`,
    `    ${c.blue('device_exec')} · ${c.blue('device_info')} · ${c.blue('device_file_read')} · ${c.blue('device_file_list')}`,
    `    ${c.blue('device_temperature')} · ${c.blue('device_resources')} · ${c.blue('device_processes')} · ${c.blue('device_network')} · ${c.blue('device_cameras')}`,
    `    ${c.blue('ros2_topic_list')} · ${c.blue('ros2_topic_echo')} · ${c.blue('ros2_topic_hz')} · ${c.blue('ros2_node_list')}`,
    `    ${c.blue('ros2_service_list')} · ${c.blue('ros2_service_call')} · ${c.blue('ros2_launch')} · ${c.blue('ros2_pkg_list')}`,
    '',
    `  ${c.bold('Customizing moss')} — build your own agent`,
    `    ${c.green('Persona')}         .moss/soul.md (or global) — replace/prepend the identity`,
    `    ${c.green('Skills')}          .moss/skills/<name>/SKILL.md — auto-matched per turn, /skills to list`,
    `    ${c.green('Slash commands')}  .moss/commands/<name>.md — reusable prompt expansions`,
    `    ${c.green('Tools')}           builtins · MCP (moss mcp add) · agent.tools.register() when embedding`,
    `    ${c.green('Model')}           /model · moss config set provider/model/baseUrl`,
    `    ${c.green('Automation')}      /goal <objective> · /loop <prompt> · /btw <question>`,
    `    ${c.green('Embed')}           npx create-moss-app my-agent  ·  MossAgent from @rdk-moss/agent`,
    `    ${c.dim('Full extension guide: packages/moss-agent/EXTENDING.md')}`,
    '',
    `  ${c.dim('Docs: https://github.com/D-Robotics/moss/tree/main/packages/moss-agent · License: MIT')}`,
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
