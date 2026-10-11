#!/usr/bin/env node
/**
 * O93: agent.reasoningBudget must be settable via `moss config set`, shown by
 * `moss config show` / `moss config env` / help, and resolved with the same
 * precedence as agent.maxTurns (MOSS_REASONING_BUDGET env > config file).
 * Untrusted projects may only lower reasoningBudget (off < adaptive < high);
 * a raise is ignored and listed on the untrusted-folder notice.
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
  assert.match(en, /adaptive-reasoning|do NOT escalate|tokens|cost/i);
  assert.match(en, /does not disable provider-native thinking|keeps the model's own/i);
  const zhHelp = renderConfigHelp(true);
  assert.match(zhHelp, /agent\.reasoningBudget/);
  assert.match(zhHelp, /off\|adaptive\|high/);
  assert.match(zhHelp, /可选值/);
  assert.match(zhHelp, /自适应推理|不升档|费用|越慢/);
  assert.match(zhHelp, /不是关掉模型自带思考/);
});

test('QA1: untrusted project off with user high applies off (source project)', () => {
  withHomeAndWs(({ configDir, ws }) => {
    put(path.join(configDir, 'config.json'), {
      provider: 'openai-compatible',
      model: 'user-model',
      baseUrl: 'https://user.example/v1',
      apiKey: 'user-key',
      agent: { reasoningBudget: 'high' },
    });
    put(path.join(ws, '.moss', 'config.json'), {
      agent: { reasoningBudget: 'off' },
    });
    const env = { HOME: path.dirname(configDir), MOSS_CONFIG_DIR: configDir };
    const loaded = loadCliConfigFile(env, [], ws, { trustProjectRouting: false });
    assert.ok(
      !(loaded.ignoredProjectRouting ?? []).includes('reasoningBudget'),
      `off must not be ignored: ${loaded.ignoredProjectRouting}`
    );
    assert.equal(loaded.config.agent?.reasoningBudget, 'off');
    assert.equal(loaded.fieldSources['agent.reasoningBudget'], 'project');
    const resolved = resolveCliConfig(env, loaded.config, {}, loaded);
    assert.equal(resolved.reasoningBudget, 'off');
    assert.match(resolved.reasoningBudgetSource ?? '', /project|agent\.reasoningBudget/);
  });
});

test('QA2: untrusted project high with user unset stays adaptive and is ignored', () => {
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
    const env = { HOME: path.dirname(configDir), MOSS_CONFIG_DIR: configDir };
    const loaded = loadCliConfigFile(env, [], ws, { trustProjectRouting: false });
    assert.ok(
      loaded.ignoredProjectRouting?.includes('reasoningBudget'),
      String(loaded.ignoredProjectRouting)
    );
    assert.equal(loaded.config.agent?.reasoningBudget, undefined);
    const resolved = resolveCliConfig(env, loaded.config, {}, loaded);
    assert.equal(resolved.reasoningBudget, undefined);
    assert.equal(resolved.reasoningBudgetSource, 'default');
  });
});

test('QA2b: -p run prints untrusted tip listing reasoningBudget when project raises', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { isolatedCliEnv } = await import('./helpers/isolated-cli-env.mjs');
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o93-p-'));
  const configDir = path.join(root, 'cfg');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(ws, '.moss'), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  put(path.join(configDir, 'config.json'), {
    provider: 'openai-compatible',
    model: 'stub-model',
    baseUrl: 'https://user.example/v1',
    apiKey: 'user-key',
  });
  put(path.join(ws, '.moss', 'config.json'), {
    agent: { reasoningBudget: 'high' },
  });
  const env = isolatedCliEnv({
    prefix: 'moss-o93-p-',
    overrides: {
      HOME: root,
      MOSS_CONFIG_DIR: configDir,
      MOSS_NO_TUI: '1',
      MOSS_NO_COLOR: '1',
    },
  });
  delete env.MOSS_TRUST_WORKSPACE;
  try {
    const printed = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, '--mock', '-p', 'hi', '--max-turns', '1'], {
        cwd: ws,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`timed out\n${stderr}`));
      }, 25000);
      child.stdout.on('data', (b) => (stdout += b.toString()));
      child.stderr.on('data', (b) => (stderr += b.toString()));
      child.on('error', reject);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    assert.match(
      printed.stderr,
      /This folder isn't trusted, so its project settings were skipped:/
    );
    assert.match(printed.stderr, /reasoningBudget/);
    assert.doesNotMatch(printed.stderr, /[\u4e00-\u9fff]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('QA2c: TUI/startup notice line lists reasoningBudget when it was raised', async () => {
  const { untrustedFolderLine } = await import('../dist/cli/workspace-trust.js');
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
    const env = { HOME: path.dirname(configDir), MOSS_CONFIG_DIR: configDir };
    const loaded = loadCliConfigFile(env, [], ws, { trustProjectRouting: false });
    assert.ok(loaded.ignoredProjectRouting?.includes('reasoningBudget'));
    // Same assembly as cli-main / TUI startup: ignored routing → untrustedFolderLine.
    const line = untrustedFolderLine(loaded.ignoredProjectRouting ?? [], false);
    assert.match(line, /isn't trusted/);
    assert.match(line, /reasoningBudget/);
    const zh = untrustedFolderLine(loaded.ignoredProjectRouting ?? [], true);
    assert.match(zh, /未信任|跳过/);
    assert.match(zh, /reasoningBudget/);
  });
});

test('QA3: trusted project high applies', () => {
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
    const env = { HOME: path.dirname(configDir), MOSS_CONFIG_DIR: configDir };
    const trusted = loadCliConfigFile(env, ['--trust-workspace'], ws);
    assert.ok(!(trusted.ignoredProjectRouting ?? []).includes('reasoningBudget'));
    assert.equal(trusted.config.agent?.reasoningBudget, 'high');
    const resolved = resolveCliConfig(env, trusted.config, {}, trusted);
    assert.equal(resolved.reasoningBudget, 'high');
  });
});

test('QA4: MOSS_REASONING_BUDGET still overrides project value', () => {
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
    const env = {
      HOME: path.dirname(configDir),
      MOSS_CONFIG_DIR: configDir,
      MOSS_REASONING_BUDGET: 'off',
      MOSS_TRUST_WORKSPACE: '1',
    };
    const trusted = loadCliConfigFile(env, ['--trust-workspace'], ws);
    assert.equal(trusted.config.agent?.reasoningBudget, 'high');
    const resolved = resolveCliConfig(env, trusted.config, {}, trusted);
    assert.equal(resolved.reasoningBudget, 'off');
    assert.equal(resolved.reasoningBudgetSource, 'MOSS_REASONING_BUDGET');
  });
});

test('config show stderr tips when untrusted project reasoningBudget raise is skipped', () => {
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
