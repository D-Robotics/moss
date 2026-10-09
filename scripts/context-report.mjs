#!/usr/bin/env node
/**
 * Token breakdown of the first model request for a fresh session.
 *
 *   node scripts/context-report.mjs
 *   node scripts/context-report.mjs --workspace <dir>
 *   node scripts/context-report.mjs --json
 *
 * `package.json` is a frozen path, so this is not wired as `npm run context:report`.
 * The one-line scripts entry for orchestrator approval is:
 *   "context:report": "npm run build && node scripts/context-report.mjs"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'dist',
  'cli',
  'context-report.js'
);

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function writeSmallRepo(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'parse.js'),
    'export function parse(text) {\n  return text.split(",").slice(1);\n}\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'parse.test.js'),
    'import assert from "node:assert/strict";\nimport { parse } from "./parse.js";\nassert.deepEqual(parse("a,b"), ["b"]);\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'small-bugfix', type: 'module', version: '0.0.0' }, null, 2) + '\n',
    'utf8'
  );
}

const { buildFreshSessionContextReport, formatContextReport } = await import(
  pathToFileURL(dist).href
);

const workspace = argValue('--workspace');
const owned = workspace ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'moss-context-report-'));
const dir = workspace ?? owned;
if (!workspace) writeSmallRepo(dir);

const connected = await buildFreshSessionContextReport({
  workspaceDir: dir,
  rdkDocsConnected: true,
});
const pending = await buildFreshSessionContextReport({
  workspaceDir: dir,
  rdkDocsConnected: false,
});
const interactive = await buildFreshSessionContextReport({
  workspaceDir: dir,
  rdkDocsConnected: true,
  taskFlow: false,
});

if (process.argv.includes('--json')) {
  const slim = (report) => ({
    rdkDocsConnected: report.rdkDocsConnected,
    taskFlow: report.taskFlow ?? null,
    systemTokens: report.systemTokens,
    toolTokens: report.toolTokens,
    userTokens: report.userTokens,
    nudgeTokens: report.nudgeTokens,
    requestTokens: report.requestTokens,
    sections: report.sections,
    tools: report.tools,
  });
  process.stdout.write(
    JSON.stringify(
      {
        connected: slim(connected),
        beforeRdkDocsConnect: slim(pending),
        interactiveTaskFlowFalse: slim(interactive),
      },
      null,
      2
    ) + '\n'
  );
} else {
  process.stdout.write(`${formatContextReport(connected)}\n`);
  process.stdout.write(
    `\nrdk-docs not connected yet: ${pending.requestTokens} tokens (system ${pending.systemTokens}, tools ${pending.toolTokens})\n`
  );
  process.stdout.write(
    `interactive taskFlow=false, rdk-docs connected: ${interactive.requestTokens} tokens (system ${interactive.systemTokens}, tools ${interactive.toolTokens})\n`
  );
}

if (owned) fs.rmSync(owned, { recursive: true, force: true });
