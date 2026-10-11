#!/usr/bin/env node
/**
 * O93: agent.reasoningBudget must be settable via `moss config set`, shown by
 * `moss config show` / `moss config env`, and resolved with the same
 * precedence as agent.maxTurns (MOSS_REASONING_BUDGET env > config file).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as setup from '../dist/cli/setup.js';
import { renderConfigEnv, renderConfigJson } from '../dist/cli/config-commands.js';
import { resolveCliConfig } from '../dist/cli/config.js';

function capture(fn) {
  const captured = { out: '', err: '' };
  const prevOut = process.stdout.write;
  const prevErr = process.stderr.write;
  const prevExit = process.exitCode;
  process.stdout.write = (c) => ((captured.out += String(c)), true);
  process.stderr.write = (c) => ((captured.err += String(c)), true);
  process.exitCode = 0;
  try {
    fn();
    return { ...captured, exitCode: process.exitCode };
  } finally {
    process.stdout.write = prevOut;
    process.stderr.write = prevErr;
    process.exitCode = prevExit ?? 0;
  }
}

function withProjectDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o93-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const cfgPath = (dir) => path.join(dir, '.moss', 'config.json');
const readCfg = (dir) => JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8'));

test('config set agent.reasoningBudget accepts off|adaptive|high and unset removes it', () => {
  withProjectDir((dir) => {
    for (const value of ['off', 'adaptive', 'high', 'HIGH']) {
      const r = capture(() =>
        setup.runConfigSet(['--project', 'agent.reasoningBudget', value], dir)
      );
      assert.equal(r.exitCode, 0, `${value} accepted: ${r.err}`);
      assert.equal(readCfg(dir).agent.reasoningBudget, value.toLowerCase());
    }
    const u = capture(() => setup.runConfigUnset(['--project', 'agent.reasoningBudget'], dir));
    assert.equal(u.exitCode, 0);
    assert.equal(readCfg(dir).agent?.reasoningBudget, undefined);
  });
});

test('config set agent.reasoningBudget rejects invalid values and lists the choices', () => {
  withProjectDir((dir) => {
    const r = capture(() => setup.runConfigSet(['--project', 'agent.reasoningBudget', 'max'], dir));
    assert.equal(r.exitCode, 1);
    assert.match(r.err, /agent\.reasoningBudget/);
    assert.match(r.err, /off/);
    assert.match(r.err, /adaptive/);
    assert.match(r.err, /high/);
    assert.equal(fs.existsSync(cfgPath(dir)), false, 'invalid value writes nothing');
  });
});

test('config show reports agent.reasoningBudget with its source; env wins over config', () => {
  withProjectDir((dir) => {
    capture(() => setup.runConfigSet(['--project', 'agent.reasoningBudget', 'high'], dir));
    const env = { MOSS_CONFIG_FILE: cfgPath(dir) };
    const shown = JSON.parse(renderConfigJson(undefined, env, dir, {}));
    assert.equal(shown.reasoningBudget, 'high');
    assert.notEqual(shown.reasoningBudgetSource, 'default');
    assert.notEqual(shown.reasoningBudgetSource, 'MOSS_REASONING_BUDGET');

    const withEnv = JSON.parse(
      renderConfigJson(undefined, { ...env, MOSS_REASONING_BUDGET: 'off' }, dir, {})
    );
    assert.equal(withEnv.reasoningBudget, 'off');
    assert.equal(withEnv.reasoningBudgetSource, 'MOSS_REASONING_BUDGET');

    // Invalid env falls back to config (same as before O93).
    const badEnv = JSON.parse(
      renderConfigJson(undefined, { ...env, MOSS_REASONING_BUDGET: 'bogus' }, dir, {})
    );
    assert.equal(badEnv.reasoningBudget, 'high');
  });
});

test('resolver ignores an invalid agent.reasoningBudget in the config file', () => {
  const r = resolveCliConfig({}, { agent: { reasoningBudget: 'turbo' } });
  assert.equal(r.reasoningBudget, undefined);
  assert.equal(r.reasoningBudgetSource, 'default');
});

test('config env documents MOSS_REASONING_BUDGET and its config key', () => {
  const text = renderConfigEnv();
  assert.match(text, /MOSS_REASONING_BUDGET[^\n]*off\|adaptive\|high[^\n]*agent\.reasoningBudget/);
});
