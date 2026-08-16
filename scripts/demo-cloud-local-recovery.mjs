#!/usr/bin/env node
import { runCloudLocalScenario } from './lib/cloud-local-scenario.mjs';

const result = await runCloudLocalScenario();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
