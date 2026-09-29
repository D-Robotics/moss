// Configuration parser. The public contract is documented in README.md:
// parseConfig returns EXACTLY the keys { ok, value }.
export function parseConfig(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, value: null };
  }
  const value = raw.trim().toLowerCase() === 'true' ? true : raw.trim();
  return { ok: true, value };
}
