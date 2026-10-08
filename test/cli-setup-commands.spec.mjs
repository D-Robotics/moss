#!/usr/bin/env node
/**
 * Characterization tests for the `moss config` command family in cli/setup.ts.
 *
 * These lock the CURRENT behavior (probe-observed against dist/ on 2026-09-28)
 * ahead of the setup.ts split (cleanup plan Task 6.3). If a refactor changes
 * any assertion here, that is an accidental behavior change.
 *
 * Probe findings that differ from the plan skeleton (skeleton assumed
 * console.log capture and a config.yaml target — reality):
 *   - renderConfigUsage() RETURNS the usage text; it does not print.
 *   - runConfigSet/Unset with `--project` write `<startDir>/.moss/config.json`
 *     (JSON, 2-space indent, trailing newline, mode 0600) — not config.yaml.
 *   - Human-readable output goes to stderr (print() writes to process.stderr);
 *     `config validate --json` writes to stdout.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { test } from 'node:test';
import path from 'node:path';

import * as setup from '../dist/cli/setup.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Run fn with stdout/stderr captured and process.exitCode forced to 0. */
function withCapturedStreams(fn) {
  const captured = { out: '', err: '' };
  const prevOut = process.stdout.write;
  const prevErr = process.stderr.write;
  const prevExitCode = process.exitCode;
  process.stdout.write = (chunk) => {
    captured.out += String(chunk);
    return true;
  };
  process.stderr.write = (chunk) => {
    captured.err += String(chunk);
    return true;
  };
  process.exitCode = 0;
  try {
    fn();
    return { out: captured.out, err: captured.err, exitCode: process.exitCode };
  } finally {
    process.stdout.write = prevOut;
    process.stderr.write = prevErr;
    process.exitCode = prevExitCode ?? 0;
  }
}

/** Run fn with a fresh temp project dir, cleaned up afterwards. */
function withProjectDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-setup-spec-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const projectConfigPath = (dir) => path.join(dir, '.moss', 'config.json');

// Verbatim short usage (probe: renderConfigUsage() return value) — error paths
// print this; the full key list lives on `moss config --help`.
const EXPECTED_USAGE = [
  'Usage:',
  '  moss config                          show resolved values and sources',
  '  moss config init [--project] [--force]',
  '  moss config show [--json]',
  '  moss config validate [--strict] [--json]',
  '  moss config env                      every MOSS_* override moss reads',
  '  moss config set <key> <value>|<key>=<value> [--project]',
  '  moss config unset <key> [--project]',
  '',
  'Every settable key with examples: moss config --help',
].join('\n');

// Verbatim current "supported keys" help text (probe: unknown-key error path).
const EXPECTED_SUPPORTED_KEYS = [
  'Supported keys — model: provider, model, baseUrl, apiKey; operational: profile, workspace, safetyMode, approvalPolicy, trustedTools, deniedTools, permissions.defaultMode, permissions.allow, permissions.ask, permissions.deny, promptCache, promptCacheDebug, guardrails.input.blockPatterns, guardrails.input.redactPatterns, guardrails.output.blockPatterns, guardrails.output.redactPatterns, agent.maxTurns, agent.contextTokens, agent.compaction.reserveTokens, agent.compaction.keepRecentTokens',
  'Run `moss config --help` for supported keys and usage.',
  '',
].join('\n');

// ─── renderConfigUsage ───────────────────────────────────────────────────────

test('renderConfigUsage returns the full usage text without printing (characterization)', () => {
  const { out, err, exitCode } = withCapturedStreams(() => setup.renderConfigUsage());
  assert.equal(out, '', 'renderConfigUsage does not write to stdout');
  assert.equal(err, '', 'renderConfigUsage does not write to stderr');
  assert.equal(exitCode, 0);
  assert.equal(setup.renderConfigUsage(), EXPECTED_USAGE);
});

test('short usage stays short; the full reference lives on config --help alone', () => {
  assert.ok(
    setup.renderConfigUsage().split('\n').length <= 14,
    'error-path usage is at most 14 lines'
  );
  const full = setup.renderConfigHelp();
  assert.ok(
    full.includes('moss config init --project'),
    'full help keeps the smoke-parity example'
  );
  assert.ok(full.includes('Examples:'), 'full help keeps the examples section');
  assert.ok(
    full.split('\n').length > setup.renderConfigUsage().split('\n').length,
    'full help is strictly richer than the short usage'
  );
});

// ─── runConfigSet ────────────────────────────────────────────────────────────

test('runConfigSet --project <key> <value> writes .moss/config.json (characterization)', () => {
  withProjectDir((dir) => {
    const { err, exitCode } = withCapturedStreams(() =>
      setup.runConfigSet(['--project', 'model', 'glm-4.6'], dir)
    );
    assert.equal(exitCode, 0, 'success path leaves exitCode 0');
    assert.equal(err, `[config] project model updated in ${projectConfigPath(dir)}\n`);
    const written = fs.readFileSync(projectConfigPath(dir), 'utf8');
    assert.equal(written, '{\n  "model": "glm-4.6"\n}\n');
    // Windows chmod cannot produce POSIX permission bits (files report 0o666),
    // so the 0600 contract is only verifiable on POSIX platforms.
    if (process.platform !== 'win32') {
      assert.equal(
        fs.statSync(projectConfigPath(dir)).mode & 0o777,
        0o600,
        'config saved with 0600'
      );
    }
  });
});

test('runConfigSet batch key=value pairs write all keys (characterization)', () => {
  withProjectDir((dir) => {
    const { err, exitCode } = withCapturedStreams(() =>
      setup.runConfigSet(['--project', 'model=x-model', 'profile=autonomous'], dir)
    );
    assert.equal(exitCode, 0);
    // v0.26 (T04): setting the legacy profile key emits a deprecation note
    // (one release of grace, PRD 决策 5) alongside the update line.
    assert.equal(
      err,
      `[config] project updated 2 key(s) in ${projectConfigPath(dir)}: model, profile\n` +
        '[config] NOTE: profile is a legacy key (deprecated next release) — cautious→manual(+read-only ceiling), balanced→manual, autonomous→full. Prefer `permissions.defaultMode`.\n'
    );
    const written = fs.readFileSync(projectConfigPath(dir), 'utf8');
    assert.equal(written, '{\n  "model": "x-model",\n  "profile": "autonomous"\n}\n');
  });
});

test('runConfigSet unknown key prints supported keys, exits 1, saves nothing (characterization)', () => {
  withProjectDir((dir) => {
    const { err, exitCode } = withCapturedStreams(() =>
      setup.runConfigSet(['--project', 'bogusKey', 'v'], dir)
    );
    assert.equal(exitCode, 1);
    assert.equal(err, EXPECTED_SUPPORTED_KEYS);
    assert.equal(fs.existsSync(projectConfigPath(dir)), false, 'no config file written on error');
  });
});

test('runConfigSet without a value prints the empty-value error, exits 1 (characterization)', () => {
  withProjectDir((dir) => {
    const { err, exitCode } = withCapturedStreams(() =>
      setup.runConfigSet(['--project', 'model'], dir)
    );
    assert.equal(exitCode, 1);
    assert.equal(
      err,
      'config model: value must not be empty. Run `moss config --help` for supported keys and usage.\n'
    );
    assert.equal(fs.existsSync(projectConfigPath(dir)), false);
  });
});

test('runConfigSet with multiple words rejects the extra words, exits 1 (characterization)', () => {
  withProjectDir((dir) => {
    const { err, exitCode } = withCapturedStreams(() =>
      setup.runConfigSet(['--project', 'model', 'a', 'b'], dir)
    );
    assert.equal(exitCode, 1);
    assert.equal(
      err,
      'config set: "model" takes a single value (got 2). Quote it if it contains spaces: moss config set model "a b".\n'
    );
  });
});

test('runConfigSet batch with a non key=value arg aborts the batch (characterization)', () => {
  withProjectDir((dir) => {
    const { err, exitCode } = withCapturedStreams(() =>
      setup.runConfigSet(['--project', 'model=x-model', 'notapair'], dir)
    );
    assert.equal(exitCode, 1);
    assert.equal(err, 'Batch config set: each argument must be key=value, got "notapair"\n');
    assert.equal(fs.existsSync(projectConfigPath(dir)), false, 'nothing saved on batch error');
  });
});

test('runConfigSet invalid profile value prints the allowed values, saves nothing (characterization)', () => {
  withProjectDir((dir) => {
    setup.runConfigSet(['--project', 'profile', 'autonomous'], dir); // seed a valid value first
    const { err, exitCode } = withCapturedStreams(() =>
      setup.runConfigSet(['--project', 'profile', 'bogus'], dir)
    );
    assert.equal(exitCode, 1);
    assert.equal(err, 'Supported profile values: cautious, balanced, autonomous\n');
    const written = fs.readFileSync(projectConfigPath(dir), 'utf8');
    assert.equal(written, '{\n  "profile": "autonomous"\n}\n', 'existing config unchanged');
  });
});

// ─── runConfigUnset ──────────────────────────────────────────────────────────

test('runConfigUnset removes a set key and reports it (characterization)', () => {
  withProjectDir((dir) => {
    setup.runConfigSet(['--project', 'model=x-model', 'profile=autonomous'], dir);
    const { err, exitCode } = withCapturedStreams(() =>
      setup.runConfigUnset(['--project', 'profile'], dir)
    );
    assert.equal(exitCode, 0);
    assert.equal(err, `[config] project profile removed from ${projectConfigPath(dir)}\n`);
    const written = fs.readFileSync(projectConfigPath(dir), 'utf8');
    assert.equal(written, '{\n  "model": "x-model"\n}\n');
  });
});

test('runConfigUnset of a not-set key reports nothing to remove, keeps exitCode 0 (characterization)', () => {
  withProjectDir((dir) => {
    setup.runConfigSet(['--project', 'model=x-model'], dir);
    const { err, exitCode } = withCapturedStreams(() =>
      setup.runConfigUnset(['--project', 'profile'], dir)
    );
    assert.equal(exitCode, 0);
    assert.equal(err, `[config] project profile: not set (nothing to remove)\n`);
    const written = fs.readFileSync(projectConfigPath(dir), 'utf8');
    assert.equal(written, '{\n  "model": "x-model"\n}\n', 'config unchanged');
  });
});

test('runConfigUnset unknown key prints supported keys, exits 1, saves nothing (characterization)', () => {
  withProjectDir((dir) => {
    setup.runConfigSet(['--project', 'model=x-model'], dir);
    const { err, exitCode } = withCapturedStreams(() =>
      setup.runConfigUnset(['--project', 'bogusKey'], dir)
    );
    assert.equal(exitCode, 1);
    assert.equal(err, EXPECTED_SUPPORTED_KEYS);
    const written = fs.readFileSync(projectConfigPath(dir), 'utf8');
    assert.equal(written, '{\n  "model": "x-model"\n}\n', 'config unchanged on error');
  });
});

test('runConfigUnset with extra args prints usage, exits 1 (characterization)', () => {
  withProjectDir((dir) => {
    const { err, exitCode } = withCapturedStreams(() =>
      setup.runConfigUnset(['--project', 'model', 'extra'], dir)
    );
    assert.equal(exitCode, 1);
    assert.equal(err, `${EXPECTED_USAGE}\n`);
  });
});

// ─── runConfigValidate ───────────────────────────────────────────────────────

test('runConfigValidate with an unknown flag prints usage, exits 1 (characterization)', () => {
  withProjectDir((dir) => {
    const { err, exitCode } = withCapturedStreams(() => setup.runConfigValidate(['--bogus'], dir));
    assert.equal(exitCode, 1);
    assert.equal(err, `${EXPECTED_USAGE}\n`);
  });
});

test('runConfigValidate --json writes the validation report to stdout (characterization)', () => {
  withProjectDir((dir) => {
    setup.runConfigSet(['--project', 'model=x-model'], dir);
    const { out, err, exitCode } = withCapturedStreams(() =>
      setup.runConfigValidate(['--json'], dir)
    );
    assert.equal(exitCode, 0);
    assert.equal(err, '', 'JSON report goes to stdout, not stderr');
    const report = JSON.parse(out);
    assert.equal(report.schema, 'moss_cli_config_validation.v1');
    assert.equal(report.ok, true, 'non-strict validation is ok');
    assert.equal(report.strict, false);
    assert.equal(report.warningCount, report.configWarnings.length);
    assert.ok(Array.isArray(report.configWarnings));
    assert.equal(report.projectConfigPath, projectConfigPath(dir));
    assert.equal(typeof report.configPath, 'string');
  });
});
