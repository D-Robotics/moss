/**
 * Perception pipeline alert-latency monitor.
 *
 * The verifier (verify.mjs) is the SPEC ORACLE — it defines the required
 * behavior. This implementation is suspected to be out of spec.
 */

export function alertLatencyMs(queueDepth) {
  // Current (suspect) formula: 6ms per queued frame, no floor.
  return queueDepth * 6;
}

export function monitorSummary(queueDepth) {
  return `depth=${queueDepth} latency=${alertLatencyMs(queueDepth)}ms`;
}
