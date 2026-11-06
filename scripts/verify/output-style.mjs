#!/usr/bin/env node
/**
 * D15 output-style probe: a voice-only prompt layer that never relaxes the
 * engineering contract.
 *
 * Model-free: parsing, config precedence, the real prompt-layer table (debug
 * report) and real CLI startup, all offline (`--mock`).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const cli = path.join(root, 'dist/cli.js');
const styleModule = await import(pathToFileURL(path.join(root, 'dist/cli/output-style.js')).href);
const configModule = await import(pathToFileURL(path.join(root, 'dist/cli/config.js')).href);
const promptModule = await import(pathToFileURL(path.join(root, 'dist/cli/prompt-setup.js')).href);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-style-home-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-style-ws-'));
const configDir = path.join(home, '.config/moss');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify(
    {
      provider: 'openai-compatible',
      model: 'mock-model',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sk-probe',
    },
    null,
    2
  )
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[output-style] ok ${name}`);
};

function run(args, env = {}) {
  return captureProcess(process.execPath, [cli, ...args], {
    cwd: workspace,
    // CI runners may export XDG_CONFIG_HOME; without pinning MOSS_CONFIG_DIR the
    // CLI would write/read a different config dir than this probe inspects and
    // the `config set` assertions fail on Linux only.
    env: {
      ...process.env,
      HOME: home,
      MOSS_CONFIG_DIR: configDir,
      MOSS_NO_RDK_DOCS: '1',
      MOSS_NO_TUI: '1',
      ...env,
    },
    timeoutMs: 120_000,
  });
}

function baseConfig(extra = {}) {
  return {
    provider: 'openai-compatible',
    model: 'mock-model',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'sk-probe',
    ...extra,
  };
}

// 1. Parser accepts exactly the documented names; unknown/empty are undefined.
assert.deepEqual([...styleModule.OUTPUT_STYLE_NAMES], ['default', 'explanatory', 'learning']);
for (const name of styleModule.OUTPUT_STYLE_NAMES) {
  assert.equal(styleModule.parseOutputStyle(name), name);
  assert.equal(styleModule.parseOutputStyle(` ${name.toUpperCase()} `), name);
}
assert.equal(styleModule.parseOutputStyle('bogus'), undefined);
assert.equal(styleModule.parseOutputStyle(''), undefined);
assert.equal(styleModule.parseOutputStyle(undefined), undefined);
ok('parser accepts the three styles and rejects unknown values');

// 2. `default` installs no text; the named styles keep the engineering contract.
assert.equal(styleModule.buildOutputStyleLayer('default'), '');
for (const name of ['explanatory', 'learning']) {
  const text = styleModule.buildOutputStyleLayer(name);
  assert.ok(text.length > 100, `${name} layer should be non-trivial`);
  assert.match(text, new RegExp(`\`${name}\` output style is active`));
  assert.match(text, /still apply unchanged/);
  assert.match(text, /voice, not your engineering standards/);
}
ok('layer text is voice-only and states the unchanged contract');

// 3. Config precedence: env > config > default.
assert.equal(configModule.resolveCliConfig({ HOME: home }, baseConfig()).outputStyle, 'default');
assert.equal(
  configModule.resolveCliConfig({ HOME: home }, baseConfig()).outputStyleSource,
  'default'
);
const fromConfig = configModule.resolveCliConfig(
  { HOME: home },
  baseConfig({ outputStyle: 'learning' })
);
assert.equal(fromConfig.outputStyle, 'learning');
assert.equal(fromConfig.outputStyleSource, 'config');
const fromEnv = configModule.resolveCliConfig(
  { HOME: home, MOSS_OUTPUT_STYLE: 'explanatory' },
  baseConfig({ outputStyle: 'learning' })
);
assert.equal(fromEnv.outputStyle, 'explanatory');
assert.equal(fromEnv.outputStyleSource, 'env');
// An invalid env value does not poison a valid config value.
const invalidEnv = configModule.resolveCliConfig(
  { HOME: home, MOSS_OUTPUT_STYLE: 'bogus' },
  baseConfig({ outputStyle: 'learning' })
);
assert.equal(invalidEnv.outputStyle, 'learning');
assert.equal(invalidEnv.outputStyleSource, 'config');
// An invalid config value falls back to default rather than crashing.
const invalidConfig = configModule.resolveCliConfig(
  { HOME: home },
  baseConfig({ outputStyle: 'loud' })
);
assert.equal(invalidConfig.outputStyle, 'default');
ok('precedence env > config > default, invalid values fall back');

// 4. The real prompt layer appears only while a named style is active.
styleModule.setOutputStyle('learning');
const setup = await promptModule.createCliPromptSetup({
  workspace,
  configDir,
  initialText: '',
});
const layer = setup.promptLayers.specs().find((entry) => entry.id === 'cli:output-style');
assert.ok(layer, 'learning layer must be installed');
assert.equal(layer.stability, 'dynamic');
assert.equal(layer.origin, 'style');
assert.match(layer.text, /learning/);
styleModule.setOutputStyle('default');
assert.equal(
  setup.promptLayers.specs().find((entry) => entry.id === 'cli:output-style'),
  undefined,
  'switching to default removes the layer'
);
ok('prompt layer installs for learning and is removed on default');

// 5. Real CLI: the debug layer table shows the style only when selected.
const withStyle = await run(['-p', '--mock', 'hi'], {
  MOSS_PROMPT_LAYERS: '1',
  MOSS_OUTPUT_STYLE: 'explanatory',
});
assert.equal(withStyle.status, 0, `mock run failed: ${withStyle.stderr}`);
assert.match(withStyle.stderr, /cli:output-style/);
const withoutStyle = await run(['-p', '--mock', 'hi'], { MOSS_PROMPT_LAYERS: '1' });
assert.equal(withoutStyle.status, 0, `mock run failed: ${withoutStyle.stderr}`);
assert.doesNotMatch(withoutStyle.stderr, /cli:output-style/);
ok('real CLI prompt table shows the layer only when selected');

// 6. `config set outputStyle` validation + persistence + unset.
const setOk = await run(['config', 'set', 'outputStyle', 'learning']);
assert.equal(setOk.status, 0, `config set failed: ${setOk.stderr}`);
assert.match(setOk.stderr, /outputStyle learning/);
const saved = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
assert.equal(saved.outputStyle, 'learning');
const setBad = await run(['config', 'set', 'outputStyle', 'bogus']);
assert.equal(setBad.status, 1);
assert.match(setBad.stderr, /default, explanatory, learning/);
const show = await run(['config', 'show']);
assert.equal(show.status, 0, `config show failed: ${show.stderr}`);
assert.match(show.stdout, /output style: learning/);
const unset = await run(['config', 'unset', 'outputStyle']);
assert.equal(unset.status, 0, `config unset failed: ${unset.stderr}`);
const afterUnset = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
assert.equal(afterUnset.outputStyle, undefined);
ok('config set/show/unset round-trips and rejects unknown values');

console.log(`[output-style] ${checks}/${checks} checks passed`);
