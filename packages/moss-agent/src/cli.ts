#!/usr/bin/env node




import { enforceNodeVersion } from './cli/node-version-check.js';

enforceNodeVersion();
const { installSafeProcessCwd } = await import('./utils/safe-cwd.js');
installSafeProcessCwd();
await import('./cli-main.js');
