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

import('../dist/cli.js').catch(function (err) {
  var message = err && err.stack ? err.stack : String(err);
  process.stderr.write(message + '\n');
  process.exit(1);
});
