// Compliance audit: contract-checks whatever the config layer returns.
// NOTE: auditContract is generic — it validates ANY object against the
// documented key set, so it keeps working when config evolves.
export function auditContract(result, documentedKeys) {
  const keys = Object.keys(result).sort();
  const expected = [...documentedKeys].sort();
  return keys.length === expected.length && keys.every((k, i) => k === expected[i]);
}
