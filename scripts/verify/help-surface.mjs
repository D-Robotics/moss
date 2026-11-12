#!/usr/bin/env node
/**
 * CLI help surface contract.
 *
 * `moss --help --all` says it is the full reference, and the dispatcher is the
 * only list of what exists. They drifted: `auth`, `update`, `loop`, `review`,
 * `remember` and `rules` were runnable but unlisted, so users could not discover
 * them from help. This probe pins the two directions that matter:
 *
 *   1. every dispatchable command appears in both the English and Chinese full
 *      help, and carries a description (the dispatcher's own metadata);
 *   2. install/auth verbs execute instead of only being suggested —
 *      `moss logout` used to print "unknown command 'logout'" and exit 2.
 *
 * Usage: node scripts/verify/help-surface.mjs [--json]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..', '..');
const load = async (relative) => import(pathToFileURL(path.join(root, 'dist', relative)).href);

const { COMMANDS } = await load('cli/command-dispatcher.js');
const { briefHelpLines, fullHelpLines } = await load('cli/help.js');
const { parseCliArgs } = await load('cli/args.js');

const plain = (text) => text;
const colors = {
  bold: plain,
  dim: plain,
  red: plain,
  green: plain,
  yellow: plain,
  blue: plain,
  cyan: plain,
  magenta: plain,
  gray: plain,
};

const failures = [];
const helpEn = fullHelpLines(colors, '/tmp/config.json', false).join('\n');
const helpZh = fullHelpLines(colors, '/tmp/config.json', true).join('\n');

// B271: subcommand lists in the full help must name what exists; `runs` said
// list|show|prune while export/follow/summary were shipped, and `task` listed
// the separate `artifacts` command as its own subcommand.
for (const [name, text] of [
  ['en', helpEn],
  ['zh', helpZh],
]) {
  for (const required of ['list|show|export|follow|summary|prune', 'run|resume|status|timeline']) {
    if (!text.includes(required)) failures.push(`${name} full help lost "${required}"`);
  }
  if (text.includes('status|timeline|artifacts')) {
    failures.push(`${name} help still lists artifacts as a task subcommand`);
  }
}

/**
 * Only the subcommand sections count. The interactive-command section lists
 * `/rules`, `/remember`, … and would otherwise "satisfy" a missing subcommand
 * row — which is exactly the drift this probe exists to catch.
 */
function subcommandSection(help, titles) {
  const lines = help.split('\n');
  const start = lines.findIndex((line) => titles.some((title) => line.includes(title)));
  if (start === -1) return help;
  // Stop before the interactive-command table: `/rules` is a REPL command, not
  // `moss rules`, and counting it would hide exactly the drift this catches.
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      (line.includes('Interactive commands') ||
        line.includes('交互命令') ||
        line.includes('Common flags') ||
        line.includes('常用参数'))
  );
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

const sections = [
  { label: 'en', text: subcommandSection(helpEn, ['Setup, sessions & tasks']) },
  { label: 'zh', text: subcommandSection(helpZh, ['设置、会话与任务']) },
];
for (const [name, command] of Object.entries(COMMANDS)) {
  for (const section of sections) {
    if (!new RegExp(`(^|[^a-z-])${name}([^a-z-]|$)`, 'm').test(section.text)) {
      failures.push(`--help --all (${section.label}) does not mention command "${name}"`);
    }
  }
  if (typeof command.description !== 'string' || !command.description.trim()) {
    failures.push(`command "${name}" has no dispatcher description`);
  }
}

// `moss <cmd> --help` must print that command's usage, not fall back to the root
// banner: rules/remember did exactly that until B54.
const { renderSubcommandHelp } = await load('cli/subcommand-help.js');
for (const name of Object.keys(COMMANDS)) {
  const help = await renderSubcommandHelp(name, false);
  if (typeof help !== 'string' || !help.trim()) {
    failures.push(`moss ${name} --help has no subcommand usage (falls back to root help)`);
  }
}

const aliases = [
  { typed: 'logout', command: 'auth', args: ['logout'] },
  { typed: 'login', command: 'setup', args: [] },
  { typed: 'install', command: 'setup', args: [] },
  { typed: 'upgrade', command: 'update', args: [] },
];
for (const alias of aliases) {
  const parsed = parseCliArgs([alias.typed]);
  if (parsed.command !== alias.command) {
    failures.push(`"moss ${alias.typed}" resolved to ${parsed.command}, expected ${alias.command}`);
    continue;
  }
  const got = parsed.commandArgs.join(' ');
  if (got !== alias.args.join(' ')) {
    failures.push(`"moss ${alias.typed}" args "${got}", expected "${alias.args.join(' ')}"`);
  }
  if (parsed.unknownCommand) {
    failures.push(`"moss ${alias.typed}" still reports unknownCommand`);
  }
}

// B335: the brief `moss --help` is the first screen of the product. Both
// locales must advertise the same verbs (zh was missing init/goal, and neither
// showed a read path).
const briefEn = briefHelpLines(colors, '/tmp/config.json', false).join('\n');
const briefZh = briefHelpLines(colors, '/tmp/config.json', true).join('\n');
for (const needle of ['moss setup', 'moss init', 'moss goal', 'moss capabilities']) {
  for (const [locale, text] of [
    ['en', briefEn],
    ['zh', briefZh],
  ]) {
    if (!text.includes(needle)) failures.push(`brief ${locale} help is missing "${needle}"`);
  }
}
if (!briefEn.includes('Most useful')) failures.push('brief en help lost its Most useful heading');
if (!briefZh.includes('最常用')) failures.push('brief zh help lost its 最常用 heading');

const result = { ok: failures.length === 0, failures, commands: Object.keys(COMMANDS).length };
if (process.argv.includes('--json')) console.log(JSON.stringify(result));
else if (result.ok)
  console.log(`[help-surface] ${result.commands} commands listed in help (en+zh), aliases execute`);
else for (const failure of failures) console.error(`[help-surface] ${failure}`);
process.exit(result.ok ? 0 : 1);
