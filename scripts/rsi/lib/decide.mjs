/**
 * Acceptance rule from the RSI plan §3.2.
 * `neutral` is an acceptance (cost drop ≥ 10% or a net line deletion) and exits 0.
 * `pending-holdout` is the ceiling when G6 was not run.
 */
export function decide(gates, { costDropPct = null, netDeletion = false } = {}) {
  const requiredPass = ['G0', 'G1', 'G2', 'G3', 'G4'].every(
    (name) => gates[name]?.status === 'pass'
  );
  const g5 = gates.G5?.status;
  const devOk = requiredPass && (g5 === 'pass' || g5 === 'not-applicable');
  const g6 = gates.G6?.status;
  if (!devOk) return { decision: 'reject', accepted: false };
  if (g6 === 'skipped') return { decision: 'pending-holdout', accepted: false };
  if (g6 === 'pass') return { decision: 'accept', accepted: true };
  if (g6 === 'flat') {
    const cheaper = typeof costDropPct === 'number' && costDropPct >= 10;
    if (cheaper || netDeletion) return { decision: 'neutral', accepted: true };
    return { decision: 'reject', accepted: false };
  }
  return { decision: 'reject', accepted: false };
}

export function exitCodeFor(decision) {
  if (decision === 'accept' || decision === 'neutral') return 0;
  if (decision === 'stopped') return 2;
  return 1;
}
