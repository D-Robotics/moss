#!/usr/bin/env node
'use strict';

/**
 * Node gate for install scripts. Plain CommonJS so a Node older than 22
 * prints the upgrade steps instead of throwing while parsing the script.
 * The repo-root `.npmrc` sets `engine-strict=true`. npm applies that only
 * to `npm ci` and `npm install` run inside the repo. `npm install -g`
 * ignores the project file. `npm install -g --install-links .` packs the
 * folder and runs `prepare` (this script, then `npm run build`) before it
 * links the global bin. A packed install does not ship `.npmrc`, so npm
 * also runs this script as `preinstall` after reifying dependencies.
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

function upgradeMessage(version) {
  var shown = String(version || '').replace(/^v/, '');
  return [
    'Moss needs Node >= 22.16, but this is Node ' + shown + '.',
    'Upgrade Node, then rerun npm ci:',
    '  # nvm — install nvm, reopen the shell, or: . ~/.nvm/nvm.sh',
    '  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash',
    '  . ~/.nvm/nvm.sh',
    '  nvm install 22 && nvm use 22',
    '  # fnm:',
    '  curl -fsSL https://fnm.vercel.app/install | bash',
    '  fnm install 22 && fnm use 22',
    '  # Windows (PowerShell):',
    '  winget install OpenJS.NodeJS.LTS',
    '  winget install Schniz.fnm',
    '  # China mirror (npmmirror):',
    '  NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node nvm install 22',
    '  npm ci',
    '',
  ].join('\n');
}

function versionUnderTest() {
  var override = process.env.MOSS_TEST_FAKE_NODE_VERSION;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return process.versions.node;
}

if (require.main === module && !nodeIsSupported(versionUnderTest())) {
  process.stderr.write(upgradeMessage(versionUnderTest()));
  process.exit(1);
}

module.exports = { nodeIsSupported, upgradeMessage };
