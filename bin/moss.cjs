#!/usr/bin/env node
'use strict';

/**
 * Package bin. This file is plain CommonJS so an old Node prints the upgrade
 * steps instead of throwing a SyntaxError while loading the ESM CLI.
 * Ink (the TUI) requires Node 22; this build is verified on Node >= 22.16.
 */
var parts = String(process.versions.node || '0.0.0').split('.');
var major = Number(parts[0]);
var minor = Number(parts[1]);
if (!(major > 22 || (major === 22 && minor >= 16))) {
  var version = String(process.version || '').replace(/^v/, '');
  process.stderr.write(
    [
      'Moss needs Node >= 22.16, but this is Node ' + version + '.',
      'The full-screen TUI depends on ink, which requires Node >= 22. This build is verified on Node >= 22.16.',
      'Upgrade Node, then run moss again:',
      '  nvm install 22',
      '  # NodeSource (Debian/Ubuntu):',
      '  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -',
      '  sudo apt-get install -y nodejs',
      '  # China mirror (npmmirror):',
      '  NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node nvm install 22',
      '',
    ].join('\n')
  );
  process.exit(1);
}

import('../dist/cli.js').catch(function (err) {
  var message = err && err.stack ? err.stack : String(err);
  process.stderr.write(message + '\n');
  process.exit(1);
});
