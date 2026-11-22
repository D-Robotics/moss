export function parseConfig(raw) {
  const strict = typeof raw === 'string' && raw.startsWith('!strict ');
  const input = strict ? raw.slice(8) : raw;
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { ok: false, strict, value: null };
  }
  const trimmed = input.trim();
  return { ok: true, strict, value: trimmed.toLowerCase() === 'true' ? true : trimmed };
}
