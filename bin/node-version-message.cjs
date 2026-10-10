'use strict';

/**
 * The one Node-version message. bin/moss.cjs prints it before the ESM CLI
 * loads, and src/cli/node-version-check.ts re-exports the same function.
 * Locale matches preferredLocale: skip C/POSIX, then LC_MESSAGES, then LANG.
 */

var MIN_NODE_MAJOR = 22;
var MIN_NODE_MINOR = 16;

function isNeutralLocale(value) {
  return /^(?:c|posix)(?:\.[^@]+)?(?:@.*)?$/i.test(value);
}

function preferredLocale(env) {
  var values = [env.LC_ALL, env.LC_MESSAGES, env.LANG];
  for (var i = 0; i < values.length; i += 1) {
    var raw = values[i];
    var text = raw == null ? '' : String(raw).trim();
    if (!text || isNeutralLocale(text)) continue;
    return text;
  }
  return undefined;
}

function nodeVersionProblem(version, env) {
  var source = env || process.env;
  var match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || '').trim());
  if (!match) return null;
  var major = Number(match[1]);
  var minor = Number(match[2]);
  if (major > MIN_NODE_MAJOR) return null;
  if (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR) return null;
  var current = String(version || '').replace(/^v/, '');
  var need = MIN_NODE_MAJOR + '.' + MIN_NODE_MINOR + '.0';
  var commands = [
    '  nvm install 22',
    '  # NodeSource (Debian/Ubuntu):',
    '  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -',
    '  sudo apt-get install -y nodejs',
    '  # China mirror (npmmirror):',
    '  NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node nvm install 22',
  ].join('\n');
  var locale = preferredLocale(source);
  var lead =
    locale && /^zh/i.test(locale)
      ? 'Node ' +
        current +
        ' 版本过低，Moss 需要 >= ' +
        need +
        '。全屏 TUI 依赖 ink（Node >= 22）。本构建在 Node >= ' +
        need +
        ' 上验证。升级 Node 后再运行 moss：'
      : 'Moss needs Node >= ' +
        need +
        ', but this is Node ' +
        current +
        '. The full-screen TUI depends on ink, which requires Node >= 22. This build is verified on Node >= ' +
        need +
        '. Upgrade Node, then run moss again:';
  return lead + '\n' + commands;
}

module.exports = {
  MIN_NODE_MAJOR: MIN_NODE_MAJOR,
  MIN_NODE_MINOR: MIN_NODE_MINOR,
  nodeVersionProblem: nodeVersionProblem,
};
