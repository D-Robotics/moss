#!/usr/bin/env node
/**
 * Device link check — real board, no LLM.
 *
 * Answers one question with evidence: *is the device link working right now?*
 * It loads `.env` (if present), resolves the MOSS_DEVICE_* target, connects over
 * the same SSH path the device tools use, runs the read-only probes the agent
 * relies on, and prints a freshness stamp. Exit code is the contract.
 *
 *   node scripts/device-link-check.mjs [--json <path>] [--quiet]
 *
 * Credentials come from the environment / `.env` only — never printed, never
 * written to the evidence file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from '../dist/cli/config.js';
import { formatDeviceTarget, resolveDefaultDeviceTarget } from '../dist/device/device-target.js';
import { disconnectAllDevices, getDeviceConnection } from '../dist/device/device-registry.js';

const args = process.argv.slice(2);
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const quiet = args.includes('--quiet');
const jsonPath = flagValue('--json');

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  try {
    loadEnvFile(envPath);
  } catch {
    // A malformed .env must not mask the real error below.
  }
}

/** Read-only probes: each must exit 0 and produce output. */
const PROBES = [
  { name: 'kernel', command: 'uname -srm' },
  { name: 'os', command: 'cat /etc/os-release 2>/dev/null | head -2' },
  { name: 'uptime', command: 'uptime' },
  { name: 'arch', command: 'uname -m' },
];

const startedAt = new Date().toISOString();
const report = { startedAt, checks: [], ok: false };

function done() {
  report.finishedAt = new Date().toISOString();
  if (jsonPath) {
    fs.mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
    fs.writeFileSync(path.resolve(jsonPath), `${JSON.stringify(report, null, 2)}\n`);
  }
  if (!quiet) {
    console.log(`device-link-check ${report.ok ? 'OK' : 'FAILED'} @ ${report.finishedAt}`);
    for (const check of report.checks) {
      console.log(`  ${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`);
    }
  }
  process.exit(report.ok ? 0 : 1);
}

const target = resolveDefaultDeviceTarget();
if (!target) {
  report.checks.push({
    name: 'target',
    ok: false,
    detail: 'no MOSS_DEVICE_HOST in the environment or .env',
  });
  done();
}
report.target = {
  kind: target.kind,
  id: target.deviceId,
  host: target.host,
  port: target.port,
  user: target.user,
};
if (!quiet) console.log(`target: ${formatDeviceTarget(target)}`);

try {
  const connection = await getDeviceConnection(target);
  report.checks.push({ name: 'connect', ok: true, detail: `${connection.status}` });

  for (const probe of PROBES) {
    const result = await connection.exec(probe.command, { timeoutMs: 15000 });
    const stdout = (result.stdout ?? '').trim();
    const ok = result.exitCode === 0 && stdout.length > 0;
    report.checks.push({
      name: probe.name,
      ok,
      detail: ok ? stdout.split('\n')[0].slice(0, 120) : `exit ${result.exitCode}`,
    });
  }
  report.ok = report.checks.every((check) => check.ok);
} catch (error) {
  report.checks.push({
    name: 'connect',
    ok: false,
    detail: String(error?.message ?? error).slice(0, 200),
  });
} finally {
  await disconnectAllDevices().catch(() => {});
}
done();
