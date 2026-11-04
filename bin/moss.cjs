#!/usr/bin/env node
'use strict';

/**
 * Package bin. This file is plain CommonJS so an old Node prints the upgrade
 * steps instead of throwing a SyntaxError while loading the ESM CLI.
 * The text comes from node-version-message.cjs (the same message the ESM
 * check prints, including Chinese). Ink requires Node 22; this build is
 * verified on Node >= 22.16.
 */
var nodeVersion = require('./node-version-message.cjs');
var problem = nodeVersion.nodeVersionProblem(process.version, process.env);
if (problem) {
  process.stderr.write(problem + '\n');
  process.exit(1);
}

// B12/H1: the TUI's first paint lands after ~700ms of module/config work, so the
// terminal sat blank while the process was already alive. Print one dim line
// before loading the ESM CLI. The heuristic is argv-only: interactive chat (no
// subcommand, no print/version/help flags), stdout is a TTY, TUI not disabled.
var wantsTui = process.stdout.isTTY === true && process.env.MOSS_NO_TUI !== '1';
if (wantsTui) {
  var argv = process.argv.slice(2);
  for (var i = 0; i < argv.length; i += 1) {
    var arg = argv[i];
    if (
      arg === '--print' ||
      arg === '-p' ||
      arg === '--version' ||
      arg === '-v' ||
      arg === '--help' ||
      arg === '-h'
    ) {
      wantsTui = false;
      break;
    }
    if (
      arg.charAt(0) !== '-' &&
      (arg === 'chat' ||
        arg === 'task' ||
        arg === 'review' ||
        arg === 'skill' ||
        arg === 'config' ||
        arg === 'device' ||
        arg === 'mcp' ||
        arg === 'loop' ||
        arg === 'superagent' ||
        arg === 'rules' ||
        arg === 'remember')
    ) {
      wantsTui = arg === 'chat';
      break;
    }
  }
}
if (wantsTui) {
  // The locale file is not parsed yet; honour the two environment switches that
  // already decide the language, and fall back to English.
  var envLocale = String(process.env.MOSS_LANG || process.env.LC_ALL || process.env.LANG || '');
  var bootLine =
    /^zh/i.test(process.env.MOSS_LANG || '') || (!process.env.MOSS_LANG && /zh/i.test(envLocale))
      ? 'moss 启动中…'
      : 'moss starting…';
  process.stderr.write('\u001b[2m' + bootLine + '\u001b[0m\n');
}

import('../dist/cli.js').catch(function (err) {
  var message = err && err.stack ? err.stack : String(err);
  process.stderr.write(message + '\n');
  process.exit(1);
});
