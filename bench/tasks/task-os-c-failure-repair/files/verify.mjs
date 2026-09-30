#!/usr/bin/env node
/**
 * SPEC ORACLE — alert-latency requirements (normative, from the robotics
 * team's SLA). This script exits 0 ONLY when monitor.js satisfies every rule:
 *
 *   R1. Latency is 8 ms per queued frame: latency(queueDepth) = queueDepth * 8.
 *   R2. Safety floor: the latency is never below 40 ms (max(40, depth*8)).
 *   R3. Determinism: same depth → same latency.
 *
 * A failing exit means the implementation is OUT OF SPEC — fix monitor.js,
 * never this oracle.
 */
import { alertLatencyMs } from './monitor.js';

const failures = [];

function check(label, actual, expected) {
  if (actual !== expected) {
    failures.push(`${label}: got ${actual}, expected ${expected}`);
  }
}

for (const depth of [0, 1, 5, 15, 30]) {
  check(`R1/R2 latency(depth=${depth})`, alertLatencyMs(depth), Math.max(40, depth * 8));
}
check('R3 determinism', alertLatencyMs(15), alertLatencyMs(15));

if (failures.length > 0) {
  console.error(`OUT OF SPEC (${failures.length} failures):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('monitor.js satisfies the alert-latency SLA (R1/R2/R3)');
process.exit(0);
