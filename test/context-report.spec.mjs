#!/usr/bin/env node
/**
 * First-request context report: section breakdown, and the fresh-session
 * budget for a small repo (headless, rdk-docs connected, no device).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  FRESH_SESSION_USER_MESSAGE,
  buildFreshSessionContextReport,
  formatContextReport,
} from '../dist/cli/context-report.js';

function smallRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-context-report-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(
    path.join(dir, 'src', 'parse.js'),
    'export function parse(text) {\n  return text.split(",").slice(1);\n}\n'
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'parse.test.js'),
    'import assert from "node:assert/strict";\nimport { parse } from "./parse.js";\nassert.deepEqual(parse("a,b"), ["b"]);\n'
  );
  return dir;
}

test('fresh session report names every first-request section and stays within budget', async () => {
  const dir = smallRepo();
  try {
    const report = await buildFreshSessionContextReport({
      workspaceDir: dir,
      rdkDocsConnected: true,
      now: new Date('2026-10-09T00:00:00.000Z'),
    });
    const names = report.sections.map((row) => row.name);
    for (const required of [
      'identity',
      'language policy',
      'software engineering',
      'agent behavior',
      'tool result handling',
      'environment',
      'AGENTS.md / project context',
      'MCP guide',
      'skills',
      'runtime capabilities',
      'context window',
    ]) {
      assert.ok(names.includes(required), `missing section ${required}`);
    }
    assert.equal(report.nudgeTokens, 0, 'nudges do not fire on a fresh user message');
    assert.equal(report.userMessage, FRESH_SESSION_USER_MESSAGE);
    assert.ok(report.tools.some((tool) => tool.name === 'read_file'));
    assert.ok(report.tools.some((tool) => tool.name === 'mcp__rdk-docs__search'));
    assert.ok(!report.tools.some((tool) => tool.name.startsWith('device_')));
    assert.ok(report.systemPrompt.includes('## Software Engineering'));
    assert.ok(report.systemPrompt.includes('rdk-docs'));
    assert.ok(!report.systemPrompt.includes(FRESH_SESSION_USER_MESSAGE));
    assert.ok(report.stablePrompt.includes('You are Moss'));
    assert.equal(report.stablePrompt.includes('## Context Window'), false);
    assert.equal(report.stablePrompt.includes('Working directory'), false);
    assert.ok(report.systemPrompt.includes('## Context Window'));
    assert.ok(report.stableTokens > 0 && report.dynamicTokens > 0);
    const text = formatContextReport(report);
    assert.match(text, /REQUEST TOTAL/);
    assert.ok(
      report.requestTokens <= 12_000,
      `fresh-session request is ${report.requestTokens} tokens, budget is 12000`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
