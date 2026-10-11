#!/usr/bin/env node
'use strict';

/**
 * Node gate for install scripts. Plain CommonJS so a Node older than 22
 * prints the upgrade steps instead of throwing while parsing the script.
 *
 * - `preinstall` runs on packed / registry installs (and local npm install).
 * - `prepare` also runs this before `npm run build`, so
 *   `npm install -g --install-links .` exits before linking a broken bin when
 *   Node is too old (npm `-g` does not apply a project engine-strict config).
 *
 * On Node >= 22.16 it exits 0. The script imports nothing.
 *
 * MOSS_TEST_FAKE_NODE_VERSION is a test-only override of the version this
 * process checks. Nothing else in Moss reads it.
 */

function nodeIsSupported(version) {
  var parts = String(version || '0.0.0')
    .replace(/^v/, '')
    .split('.');
  var major = Number(parts[0]);
  var minor = Number(parts[1]);
  return major > 22 || (major === 22 && minor >= 16);
}

function isNeutralLocale(value) {
  return /^(?:c|posix)(?:\.[^@]+)?(?:@.*)?$/i.test(String(value || ''));
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

function upgradeCommands() {
  return [
    '  # After Node >= 22.16, install Moss with:',
    '  npm install -g @rdk-moss/agent@latest',
    '',
    '  # macOS (Homebrew):',
    '  brew install node@22',
    '  # or nvm / fnm:',
    '  nvm install 22 && nvm use 22',
    '  fnm install 22 && fnm use 22',
    '',
    '  # Ubuntu / Debian (NodeSource):',
    '  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -',
    '  sudo apt-get install -y nodejs',
    '  # or nvm / fnm (same commands as above)',
    '',
    '  # Windows (PowerShell):',
    '  winget install OpenJS.NodeJS.LTS',
    '',
    '  # China mirror (nvm Node downloads):',
    '  NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node nvm install 22',
  ].join('\n');
}

function upgradeMessage(version, env) {
  var shown = String(version || '').replace(/^v/, '');
  var locale = preferredLocale(env || process.env);
  var zh = locale && /^zh/i.test(locale);
  var lead = zh
    ? [
        '检测到 Node ' + shown + '，Moss 需要 >= 22.16。',
        '请先升级 Node，再用下面的命令安装（可复制）：',
      ].join('\n')
    : [
        'Moss needs Node >= 22.16, but this is Node ' + shown + '.',
        'Upgrade Node, then install again with the copyable commands below:',
      ].join('\n');
  return lead + '\n' + upgradeCommands() + '\n';
}

function versionUnderTest() {
  var override = process.env.MOSS_TEST_FAKE_NODE_VERSION;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return process.versions.node;
}

if (require.main === module && !nodeIsSupported(versionUnderTest())) {
  process.stderr.write(upgradeMessage(versionUnderTest(), process.env));
  process.exit(1);
}

module.exports = { nodeIsSupported, upgradeMessage, upgradeCommands };
