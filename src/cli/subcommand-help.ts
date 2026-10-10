/**
 * Concise `moss <command> --help` text: usage, options, and one or two examples.
 * English is the default; Chinese follows the CLI locale (`zh*`).
 */
import { fileURLToPath } from 'node:url';
import { isZhLocale } from './cli-locale.js';
import { renderConfigHelp } from './config-commands.js';
import { renderDeviceUsage } from './device-commands.js';
import { renderMcpUsage } from './mcp-commands.js';
import { renderSetupHelp } from './setup-wizard.js';
import { renderSkillUsage } from './skill-commands.js';
import { renderTaskCliUsage } from './task-run.js';
import { renderTasksUsage } from './tasks-commands.js';
import { findMossPackageRoot, readMossPackage, renderUpdateHelp } from './update-command.js';

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

function updateHelp(zh: boolean): string {
  const root = findMossPackageRoot(fileURLToPath(import.meta.url));
  return renderUpdateHelp(zh, readMossPackage(root));
}

/** Help for a registered subcommand, or null when `command` is not one. */
export function renderSubcommandHelp(command: string, zh: boolean = isZhLocale()): string | null {
  switch (command) {
    case 'setup':
      return renderSetupHelp(zh);
    case 'auth':
      return authHelp(zh);
    case 'config':
      return renderConfigHelp(zh);
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
    case 'mcp':
      return renderMcpUsage(zh);
    case 'device':
      return renderDeviceUsage(zh);
    case 'skill':
      return renderSkillUsage(zh);
    case 'plugins':
      return removed('plugins', zh, {
        en: 'The plugin subsystem is not implemented in this build.',
        zh: '这个构建没有插件子系统。',
      });
    case 'migrate':
      return removed('migrate', zh, {
        en: 'The migrate subsystem is not implemented in this build.',
        zh: '这个构建没有迁移子系统。',
      });
    case 'tasks':
      return renderTasksUsage(zh);
    case 'task':
      return renderTaskCliUsage(zh);
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
