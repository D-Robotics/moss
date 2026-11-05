/**
 * Concise `moss <command> --help` text: usage, options, and one or two examples.
 * English is the default; Chinese follows the CLI locale (`zh*`).
 */
import { fileURLToPath } from 'node:url';
import { isZhLocale } from './cli-locale.js';

export function superagentHelp(zh = isZhLocale()): string {
  return [
    zh ? '用法：moss superagent <命令>' : 'Usage: moss superagent <command>',
    zh ? '  init --accept "<验收命令>" [--workers N]' : '  init --accept "<command>" [--workers N]',
    zh
      ? '  submit "<目标>" [--id <事件编号>] [--thread <会话编号>]'
      : '  submit "<goal>" [--id event-id] [--thread thread-id]',
    '  work | start',
    zh ? '  status [工单编号]' : '  status [ticket-id]',
    zh
      ? '  pause | resume | stop <工单编号> | retry <工单编号>'
      : '  pause | resume | stop <ticket-id> | retry <ticket-id>',
    zh ? '  configure <策略文件.json>' : '  configure <policy.json>',
    '',
    zh ? '选项：' : 'Options:',
    zh
      ? '  --accept   固定验收命令；--workers 并发数；--id 事件编号；--thread 会话编号'
      : '  --accept fixed oracle; --workers concurrency; --id event ID; --thread conversation ID',
    '',
    zh ? '示例：' : 'Examples:',
    '  moss superagent init --accept "npm test"',
    zh
      ? '  moss superagent submit "修复失败的测试"'
      : '  moss superagent submit "Fix the failing test"',
    '  moss superagent work',
    '',
    zh
      ? '独立 Moss 执行进程；只有原生任务与固定验收命令都通过才报告就绪。'
      : 'Isolated Moss workers; ready requires native acceptance and the fixed operator command.',
    zh
      ? 'start 前台轮询；Ctrl+C 停止调度。work 处理当前队列后退出。'
      : 'start polls in the foreground; Ctrl+C stops the scheduler. work drains the current queue.',
    zh
      ? '配置模型沿用 moss setup。默认 observe；此版本没有代码托管或消息平台连接器。'
      : 'Uses moss setup model configuration. Default observe; this version has no code-hosting or messaging connectors.',
  ].join('\n');
}
function removed(command: string, zh: boolean, detail: { en: string; zh: string }): string {
  if (zh) {
    return [
      '用法：',
      `  moss ${command}`,
      '',
      detail.zh,
      '',
      '选项：',
      '  （无）  不接受其它参数。直接运行会非零退出，并说明尚未实现。',
      '',
      '示例：',
      `  moss ${command}`,
      '  moss --help',
    ].join('\n');
  }
  return [
    'Usage:',
    `  moss ${command}`,
    '',
    detail.en,
    '',
    'Options:',
    '  (none)  no flags. Running it exits non-zero and reports that it is not implemented.',
    '',
    'Examples:',
    `  moss ${command}`,
    '  moss --help',
  ].join('\n');
}

function authHelp(zh: boolean): string {
  if (zh) {
    return [
      '用法：',
      '  moss auth status',
      '  moss auth logout',
      '',
      '查看是否存了 API 密钥，或删掉它。',
      '',
      '选项：',
      '  status    打印服务商、模型，以及是否存了密钥',
      '  logout    确认 [y/N] 后删除已存的 API 密钥',
      '',
      '示例：',
      '  moss auth status',
      '  moss auth logout',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss auth status',
    '  moss auth logout',
    '',
    'Show whether an API key is stored, or remove it.',
    '',
    'Options:',
    '  status    print provider, model, and whether a key is stored',
    '  logout    delete the stored API key after a [y/N] confirm',
    '',
    'Examples:',
    '  moss auth status',
    '  moss auth logout',
  ].join('\n');
}

function doctorHelp(zh: boolean): string {
  if (zh) {
    return [
      '用法：',
      '  moss doctor',
      '  moss doctor -C <dir>',
      '',
      '检查配置、凭据、工作区、运行时和搜索后端。',
      'MOSS_RDK_DOCS_PIN_CHECK=1 时向 npm 查询 rdk-docs-mcp@0.3.0 的最新版，若比内置钉的版本新就记一笔。默认关闭，启动时不查询。',
      '',
      '选项：',
      '  -C, --cd <dir>       检查另一个工作区',
      '  --verbose            把报告的详细程度设为详细',
      '  --quiet              把报告的详细程度设为安静',
      '  --config-file <path> 只加载这个配置文件',
      '',
      '示例：',
      '  moss doctor',
      '  moss doctor -C ~/robot --verbose',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss doctor',
    '  moss doctor -C <dir>',
    '',
    'Check config, credentials, workspace, runtime, and the search backend.',
    'MOSS_RDK_DOCS_PIN_CHECK=1 asks npm whether rdk-docs-mcp latest is newer than the pin. Off by default, and startup does not query npm.',
    '',
    'Options:',
    '  -C, --cd <dir>       inspect a different workspace',
    '  --verbose            record detail mode verbose on the report',
    '  --quiet              record detail mode quiet on the report',
    '  --config-file <path> load only this config file',
    '',
    'Examples:',
    '  moss doctor',
    '  moss doctor -C ~/robot --verbose',
  ].join('\n');
}

function resumeHelp(zh: boolean): string {
  if (zh) {
    return [
      '用法：',
      '  moss resume',
      '  moss resume --last',
      '  moss resume <会话>',
      '  moss resume --session <key>',
      '',
      '继续一个已保存的会话。TTY 上不带密钥时，界面会打开会话选择器。',
      '',
      '选项：',
      '  --last            继续最近一次会话',
      '  --session <key>   继续这个会话密钥',
      '  <会话>            与 --session 相同的位置参数',
      '',
      '示例：',
      '  moss resume --last',
      '  moss resume 01hxyz',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss resume',
    '  moss resume --last',
    '  moss resume <session>',
    '  moss resume --session <key>',
    '',
    'Continue a saved session. With no key on a TTY, the shell opens the session picker.',
    '',
    'Options:',
    '  --last            continue the latest saved session',
    '  --session <key>   continue this session key',
    '  <session>         positional form of --session',
    '',
    'Examples:',
    '  moss resume --last',
    '  moss resume 01hxyz',
  ].join('\n');
}

function forkHelp(zh: boolean): string {
  if (zh) {
    return [
      '用法：',
      '  moss fork <会话>',
      '  moss fork --fork-from <key>',
      '',
      '从一个已保存的会话分叉出新会话。',
      '',
      '选项：',
      '  --fork-from <key>   源会话',
      '  <会话>              与 --fork-from 相同的位置参数',
      '',
      '示例：',
      '  moss fork --fork-from 01hxyz',
      '  moss fork 01hxyz',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss fork <session>',
    '  moss fork --fork-from <key>',
    '',
    'Start a new session from a saved one.',
    '',
    'Options:',
    '  --fork-from <key>   source session',
    '  <session>           positional form of --fork-from',
    '',
    'Examples:',
    '  moss fork --fork-from 01hxyz',
    '  moss fork 01hxyz',
  ].join('\n');
}

function sessionsHelp(zh: boolean): string {
  if (zh) {
    return [
      '用法：',
      '  moss sessions',
      '  moss sessions list [--limit=<n>] [--no-limit]',
      '  moss sessions delete <key>',
      '  moss sessions search <text>',
      '  moss sessions export <key> [--out=<file>]',
      '',
      '列出、删除、搜索或导出当前工作区的会话。',
      '',
      '选项：',
      '  --limit=<n>    最多列出 n 条（默认 20）',
      '  --no-limit     列出全部会话',
      '  --out=<file>   把导出写到文件（--out=- 写到 stdout）',
      '',
      '示例：',
      '  moss sessions list --limit=5',
      '  moss sessions export 01hxyz --out=session.md',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss sessions',
    '  moss sessions list [--limit=<n>] [--no-limit]',
    '  moss sessions delete <key>',
    '  moss sessions search <text>',
    '  moss sessions export <key> [--out=<file>]',
    '',
    'List, delete, search, or export sessions in the current workspace.',
    '',
    'Options:',
    '  --limit=<n>    list at most n sessions (default 20)',
    '  --no-limit     list every session',
    '  --out=<file>   write the export to a file (--out=- writes stdout)',
    '',
    'Examples:',
    '  moss sessions list --limit=5',
    '  moss sessions export 01hxyz --out=session.md',
  ].join('\n');
}

function trustHelp(zh: boolean): string {
  if (zh) {
    return [
      '用法：',
      '  moss trust list',
      '  moss trust remove [path]',
      '',
      '列出或取消已记住的文件夹信任。信任存在用户配置目录，不在项目里。',
      '',
      '选项：',
      '  list           打印已信任的文件夹',
      '  remove [path]  取消该路径（或当前文件夹）的信任',
      '',
      '示例：',
      '  moss trust list',
      '  moss trust remove',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss trust list',
    '  moss trust remove [path]',
    '',
    'List or forget remembered folder trust. The store is in the user config directory, not the project.',
    '',
    'Options:',
    '  list           print trusted folders',
    '  remove [path]  forget trust for that path, or for the current folder',
    '',
    'Examples:',
    '  moss trust list',
    '  moss trust remove',
  ].join('\n');
}

function uninstallHelp(zh: boolean): string {
  if (zh) {
    return [
      '用法：',
      '  moss uninstall',
      '',
      '打印全局包和 ~/.moss 路径。只在终端里确认后删除配置目录，并先列出将删除的文件。',
      '不会删除主目录、主目录的上级目录、/、当前目录、当前目录的上级目录，也不会删除不像 Moss 配置目录的路径或工作区 .moss/。',
      '',
      '选项：',
      '  （无）',
      '',
      '示例：',
      '  moss uninstall',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss uninstall',
    '',
    'Print the global package and ~/.moss paths. The config directory is deleted only after a [y/N] confirm in a terminal, and the files are listed first.',
    'Refuses when the config directory is HOME, a parent of HOME, /, the current directory, a parent of the current directory, or not a Moss config directory. Does not delete a workspace .moss/.',
    '',
    'Options:',
    '  (none)',
    '',
    'Examples:',
    '  moss uninstall',
  ].join('\n');
}

async function updateHelp(zh: boolean): Promise<string> {
  const { findMossPackageRoot, readMossPackage, renderUpdateHelp } =
    await import('./update-command.js');
  const root = findMossPackageRoot(fileURLToPath(import.meta.url));
  return renderUpdateHelp(zh, readMossPackage(root));
}

/**
 * Help for a registered subcommand, or null when `command` is not one.
 *
 * B18: each command's usage renderer is imported on demand. Ten command modules
 * (and their tool registries: review-tools, task-run, device-commands, …) used
 * to be pulled into every `moss` process just because the help table mentioned
 * them; `-p` runs pay none of that now, and `moss <cmd> --help` still pays one
 * module.
 */
function runHelp(zh: boolean): string {
  if (zh) {
    return [
      '用法：',
      '  moss run "<意图>" [--accept "<验收命令>"] [--max-repairs N] [--max-turns N]',
      '  moss run "<意图>" --until "<命令>" [--max N] [--every <时长>]   运行→验收→修复的本地闭环',
      '  moss run --workflow <plan.json> [--mock]                        声明式多步 workflow',
      '  moss run --resume [<task_id>] [--accept "<验收命令>"] …        续跑（不给 id 取最新可恢复任务）',
      '',
      '  一个 run 动词 + 三个修饰符：--accept（单次验证）、--until（反复到命令通过）、--workflow（多步依赖）。',
      '  --until 与 --workflow 互斥；两者都不接受 --accept（成功由它们自己的检查决定）。',
      '',
      '验证式运行——`moss task run` 的快捷方式：同一个任务状态机、同样的 Ctrl+C 暂停语义、',
      '同样的退出码（0 通过 / 1 失败或阻塞 / 130 中断可续跑）。',
      'PASS 只由验收命令决定，模型的自述不算数。',
      '',
      '选项：',
      '  --accept "<命令>"  可机检的验收命令（oracle）',
      '  --max-repairs N    本次运行的修复预算',
      '  --max-turns N      agent 回合预算（含计划回合）',
      '',
      '示例：',
      '  moss run "创建 hello.txt 内容为 MOSS_OK" --accept "grep -qx MOSS_OK hello.txt"',
      '  moss run "修复失败的测试" --accept "npm test"',
      '  moss task status --json      # 运行后看同一份事实',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss run "<intent>" [--accept "<command>"] [--max-repairs N] [--max-turns N]',
    '  moss run "<intent>" --until "<command>" [--max N] [--every <duration>]   run→check→fix loop',
    '  moss run --workflow <plan.json> [--mock]                                declarative multi-step workflow',
    '  moss run --resume [<task_id>] [--accept "<command>"] …                  resume (newest resumable without an id)',
    '',
    '  One run verb plus three modifiers: --accept (single verdict), --until (repeat until the',
    '  command passes), --workflow (dependent steps). --until and --workflow are exclusive and neither',
    '  accepts --accept: their own checks decide success.',
    '',
    'Verified run — a shortcut for `moss task run`: same task state machine, same',
    'Ctrl+C pause semantics and the same exit codes (0 pass, 1 fail/blocked, 130',
    'interrupted and resumable). The acceptance command decides PASS; model prose',
    'never does.',
    '',
    'Options:',
    '  --accept "<cmd>"   machine-checkable acceptance command (oracle)',
    '  --max-repairs N    repair budget for this run',
    '  --max-turns N      agent turn budget (planning turn included)',
    '',
    'Examples:',
    '  moss run "create hello.txt containing MOSS_OK" --accept "grep -qx MOSS_OK hello.txt"',
    '  moss run "fix the failing tests" --accept "npm test"',
    '  moss task status --json      # the same facts after the run',
  ].join('\n');
}

export async function renderSubcommandHelp(
  command: string,
  zh: boolean = isZhLocale()
): Promise<string | null> {
  switch (command) {
    case 'setup': {
      const { renderSetupHelp } = await import('./setup-wizard.js');
      return renderSetupHelp(zh);
    }
    case 'auth':
      return authHelp(zh);
    case 'config': {
      const { renderConfigHelp } = await import('./config-commands.js');
      return renderConfigHelp(zh);
    }
    case 'doctor':
      return doctorHelp(zh);
    case 'update':
      return updateHelp(zh);
    case 'trust':
      return trustHelp(zh);
    case 'uninstall':
      return uninstallHelp(zh);
    case 'resume':
      return resumeHelp(zh);
    case 'fork':
      return forkHelp(zh);
    case 'mcp': {
      const { renderMcpUsage } = await import('./mcp-commands.js');
      return renderMcpUsage(zh);
    }
    case 'device': {
      const { renderDeviceUsage } = await import('./device-commands.js');
      return renderDeviceUsage(zh);
    }
    case 'skill': {
      const { renderSkillUsage } = await import('./skill-commands.js');
      return renderSkillUsage(zh);
    }
    case 'review': {
      const { renderReviewUsage } = await import('./review-commands.js');
      return renderReviewUsage(zh);
    }
    case 'workflow': {
      const { renderWorkflowUsage } = await import('./workflow-command.js');
      return renderWorkflowUsage(zh);
    }
    case 'rules': {
      const { renderRulesUsage } = await import('./rules-commands.js');
      return renderRulesUsage(zh);
    }
    case 'remember': {
      // The usage renderer is bilingual already (uiText); keep passing zh only
      // when the module grows a parameter.
      const { renderRememberUsage } = await import('./remember-command.js');
      return renderRememberUsage();
    }
    case 'loop': {
      const { renderLoopUsage } = await import('./loop-command.js');
      return renderLoopUsage(zh);
    }
    case 'plugins': {
      const { renderPluginsUsage } = await import('./plugin-commands.js');
      return renderPluginsUsage(zh);
    }
    case 'migrate':
      return removed('migrate', zh, {
        en: 'The migrate subsystem is not implemented in this build.',
        zh: '这个构建没有迁移子系统。',
      });
    case 'superagent':
      return superagentHelp(zh);
    case 'task': {
      const { renderTaskCliUsage } = await import('./task-run.js');
      return renderTaskCliUsage(zh);
    }
    case 'run':
      return runHelp(zh);
    case 'init': {
      const { renderInitUsage } = await import('./init-command.js');
      return renderInitUsage(zh);
    }
    case 'capabilities': {
      const { renderCapabilitiesUsage } = await import('./capabilities-command.js');
      return renderCapabilitiesUsage(zh);
    }
    case 'artifacts': {
      const { renderArtifactsUsage } = await import('./artifacts-command.js');
      return renderArtifactsUsage(zh);
    }
    case 'runs': {
      const { renderRunsUsage } = await import('./runs-command.js');
      return renderRunsUsage(zh);
    }
    case 'sessions':
      return sessionsHelp(zh);
    case 'web':
      return removed('web', zh, {
        en: 'The web UI subsystem is not implemented in this build.',
        zh: '这个构建没有网页界面子系统。',
      });
    case 'agent':
      return removed('agent', zh, {
        en: 'moss agent is not implemented. Start a session with `moss` or `moss "<prompt>"`.',
        zh: '这个构建没有 moss agent。用 `moss` 或 `moss "<prompt>"` 开始会话。',
      });
    default:
      return null;
  }
}
