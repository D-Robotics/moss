#!/usr/bin/env node
/**
 * O93: agent.reasoningBudget must be settable via `moss config set`, shown by
 * `moss config show` / `moss config env` / help, and resolved with the same
 * precedence as agent.maxTurns (MOSS_REASONING_BUDGET env > config file).
 * Untrusted projects cannot set reasoningBudget (dropped like modelTiers).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as setup from '../dist/cli/setup.js';
import {
  renderConfigEnv,
  renderConfigHelp,
  renderConfigJson,
} from '../dist/cli/config-commands.js';
import { loadCliConfigFile, resolveCliConfig } from '../dist/cli/config.js';
import { renderAuthStatus } from '../dist/cli/setup-wizard.js';

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

function withHomeAndWs(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o93-trust-'));
  const configDir = path.join(root, 'cfg');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(ws, '.moss'), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  try {
    return fn({ root, configDir, ws });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const cfgPath = (dir) => path.join(dir, '.moss', 'config.json');
const readCfg = (dir) => JSON.parse(fs.readFileSync(cfgPath(dir), 'utf8'));
const put = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
};

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

test('config set agent.reasoningBudget with empty value lists the choices', () => {
  withProjectDir((dir) => {
    const r = capture(() => setup.runConfigSet(['--project', 'agent.reasoningBudget'], dir));
    assert.equal(r.exitCode, 1);
    assert.match(r.err, /agent\.reasoningBudget/);
    assert.match(r.err, /off/);
    assert.match(r.err, /adaptive/);
    assert.match(r.err, /high/);
    assert.doesNotMatch(r.err, /moss config --help/);
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

    // Invalid env falls back to config and surfaces a config warning.
    const badEnv = { ...env, MOSS_REASONING_BUDGET: 'bogus' };
    const badShown = JSON.parse(renderConfigJson(undefined, badEnv, dir, {}));
    assert.equal(badShown.reasoningBudget, 'high');
    assert.ok(
      (badShown.configWarnings ?? []).some((w) => w.code === 'reasoningBudget.env_invalid'),
      JSON.stringify(badShown.configWarnings)
    );
  });
});

test('config show plain text includes reasoning budget value and source', () => {
  withProjectDir((dir) => {
    capture(() => setup.runConfigSet(['--project', 'agent.reasoningBudget', 'high'], dir));
    const prev = { ...process.env };
    process.env.MOSS_CONFIG_FILE = cfgPath(dir);
    try {
      const text = renderAuthStatus(undefined, process.env, dir, {}, '[config]');
      assert.match(text, /reasoning budget|推理强度/i);
      assert.match(text, /\bhigh\b/);
      assert.match(text, /agent\.reasoningBudget|project|user|MOSS_/i);
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in prev)) delete process.env[k];
      }
      Object.assign(process.env, prev);
    }
  });
});

test('resolver ignores an invalid agent.reasoningBudget in the config file', () => {
  const r = resolveCliConfig({}, { agent: { reasoningBudget: 'turbo' } });
  assert.equal(r.reasoningBudget, undefined);
  assert.equal(r.reasoningBudgetSource, 'default');
});

test('invalid MOSS_REASONING_BUDGET warns once on stderr and falls back', () => {
  const r = capture(() => {
    const resolved = resolveCliConfig(
      { MOSS_REASONING_BUDGET: 'turbo' },
      { agent: { reasoningBudget: 'off' } }
    );
    assert.equal(resolved.reasoningBudget, 'off');
    assert.equal(resolved.invalidReasoningBudgetEnv, 'turbo');
  });
  assert.match(r.err, /MOSS_REASONING_BUDGET/);
  assert.match(r.err, /off\|adaptive\|high|off、adaptive|high/);
  // second resolve with same value must not spam
  const r2 = capture(() => {
    resolveCliConfig({ MOSS_REASONING_BUDGET: 'turbo' }, { agent: { reasoningBudget: 'off' } });
  });
  assert.equal(r2.err, '');
});

test('config env documents MOSS_REASONING_BUDGET and its config key', () => {
  const text = renderConfigEnv();
  assert.match(text, /MOSS_REASONING_BUDGET[^\n]*off\|adaptive\|high[^\n]*agent\.reasoningBudget/);
});

test('en and zh config help mention agent.reasoningBudget and off|adaptive|high', () => {
  const en = renderConfigHelp(false);
  assert.match(en, /agent\.reasoningBudget/);
  assert.match(en, /off\|adaptive\|high/);
  assert.match(en, /how hard the model thinks|tokens|cost|longer/i);
  const zhHelp = renderConfigHelp(true);
  assert.match(zhHelp, /agent\.reasoningBudget/);
  assert.match(zhHelp, /off\|adaptive\|high/);
  assert.match(zhHelp, /可选值/);
  assert.match(zhHelp, /推理强度|费用|越慢/);
});

test('config show stderr tips when untrusted project reasoningBudget is skipped', () => {
  withHomeAndWs(({ configDir, ws }) => {
    put(path.join(configDir, 'config.json'), {
      provider: 'openai-compatible',
      model: 'user-model',
      baseUrl: 'https://user.example/v1',
      apiKey: 'user-key',
    });
    put(path.join(ws, '.moss', 'config.json'), {
      agent: { reasoningBudget: 'high' },
    });
    const prev = { ...process.env };
    Object.assign(process.env, {
      HOME: path.dirname(configDir),
      MOSS_CONFIG_DIR: configDir,
    });
    delete process.env.MOSS_TRUST_WORKSPACE;
    try {
      const r = capture(() => setup.runConfigShow(ws, {}));
      assert.match(r.err, /reasoningBudget/);
      assert.match(r.err, /isn't trusted|未信任|skipped|跳过|project settings/i);
      assert.match(r.out, /reasoning budget|推理强度/i);
      assert.doesNotMatch(r.out, /\bhigh\b/);
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in prev)) delete process.env[k];
      }
      Object.assign(process.env, prev);
    }
  });
});

test('untrusted project reasoningBudget is dropped; trusted project applies', () => {
  withHomeAndWs(({ configDir, ws }) => {
    put(path.join(configDir, 'config.json'), {
      provider: 'openai-compatible',
      model: 'user-model',
      baseUrl: 'https://user.example/v1',
      apiKey: 'user-key',
      agent: { reasoningBudget: 'off' },
    });
    put(path.join(ws, '.moss', 'config.json'), {
      agent: { reasoningBudget: 'high' },
    });
    const env = { HOME: path.dirname(configDir), MOSS_CONFIG_DIR: configDir };
    const ignored = loadCliConfigFile(env, [], ws, { trustProjectRouting: false });
    assert.ok(
      ignored.ignoredProjectRouting?.includes('reasoningBudget'),
      String(ignored.ignoredProjectRouting)
    );
    assert.equal(ignored.config.agent?.reasoningBudget, 'off');
    const resolvedIgnored = resolveCliConfig(env, ignored.config, {}, ignored);
    assert.equal(resolvedIgnored.reasoningBudget, 'off');

    // User default (no reasoningBudget) + untrusted project high → not high
    put(path.join(configDir, 'config.json'), {
      provider: 'openai-compatible',
      model: 'user-model',
      baseUrl: 'https://user.example/v1',
      apiKey: 'user-key',
    });
    const ignoredDefault = loadCliConfigFile(env, [], ws, { trustProjectRouting: false });
    assert.ok(ignoredDefault.ignoredProjectRouting?.includes('reasoningBudget'));
    assert.equal(ignoredDefault.config.agent?.reasoningBudget, undefined);
    assert.notEqual(
      resolveCliConfig(env, ignoredDefault.config, {}, ignoredDefault).reasoningBudget,
      'high'
    );

    const trusted = loadCliConfigFile(env, ['--trust-workspace'], ws);
    assert.equal(trusted.config.agent?.reasoningBudget, 'high');
    assert.equal(resolveCliConfig(env, trusted.config, {}, trusted).reasoningBudget, 'high');
  });
});
