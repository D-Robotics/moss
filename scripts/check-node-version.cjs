#!/usr/bin/env node
'use strict';

/**
 * `preinstall` gate. Plain CommonJS so a Node older than 22 prints the
 * upgrade steps instead of throwing while parsing the script.
 * npm installs dependencies before this hook. On Node >= 22.16 it exits 0.
 * The script imports nothing.
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
    'Upgrade Node, then run the install again:',
    '  nvm install 22',
    '  # NodeSource: https://github.com/nodesource/distributions',
    '  # China mirror (npmmirror):',
    '  NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node nvm install 22',
    '',
  ].join('\n');
}

if (require.main === module && !nodeIsSupported(process.versions.node)) {
  process.stderr.write(upgradeMessage(process.versions.node));
  process.exit(1);
}

module.exports = { nodeIsSupported, upgradeMessage };
